import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { library } from '../lib/database.js';
import { normalizePage, authorization } from '../lib/x.js';
import { makeServer } from '../server.js';

test('media keeps attachment order and selects the highest bitrate playable MP4', () => {
  const page=normalizePage({data:[{id:'123',attachments:{media_keys:['b','a','z','c']}}],includes:{media:[
    {media_key:'b',type:'photo',url:'photo',alt_text:'Ocean'},
    {media_key:'a',type:'video',preview_image_url:'poster',variants:[
      {content_type:'video/mp4',bit_rate:500,url:'high'},{content_type:'video/mp4',bit_rate:100,url:'low'}]},
    {media_key:'c',type:'animated_gif',variants:[{content_type:'video/mp4',url:'gif'}]}]}});
  assert.deepEqual(page.posts[0].media.map(m=>m.src),['photo','high',undefined,'gif']);
  assert.equal(page.posts[0].media[1].poster,'poster');
  assert.equal(page.posts[0].media[2].type,'unavailable');
  assert.throws(()=>normalizePage({errors:[{}]}),/incomplete/);
  assert.equal(normalizePage({meta:{result_count:0}}).posts.length,0);
});

test('re-import preserves review state, tags and per-owner isolation; failed batch rolls back', () => {
  const lib=library(':memory:');
  try {
    lib.savePage('a',[{id:'42',body:'before'}],'page1');
    lib.edit('a','42',{state:'kept',tags:[' A ','a']});
    assert.equal(lib.savePage('a',[{id:'42',body:'after'}],''),0);
    assert.deepEqual(lib.list('a'),[{id:'42',body:'after',state:'kept',tags:['a']}]);
    assert.equal(lib.edit('b','42',{state:'archive'}),0);
    assert.throws(()=>lib.savePage('a',[{id:'43'},{id:null}],'bad'));
    assert.equal(lib.list('a').length,1);
    assert.equal(lib.cursor('a'),'');
  } finally {lib.db.close();}
});

test('OAuth login, private library, pagination, token expiry and logout through HTTP',async t=>{
  const lib=library(':memory:');
  const config={origin:'',clientId:'client',secret:'secret'};
  let calls=0, write=false, confirmed=false, removalCalls=0;
  const transport=async (url, options)=>{
    if(url.endsWith('/token')){
      assert.ok(options.body.get('code_verifier')); assert.ok(options.headers.Authorization.startsWith('Basic '));
      return Response.json({access_token:'fixture',scope:write?'bookmark.read bookmark.write':'bookmark.read'});
    }
    assert.equal(options.headers.Authorization,'Bearer fixture');
    if(url.endsWith('/me'))return Response.json({data:{id:'77',username:'test'}});
    const request=new URL(url);
    if (request.pathname==='/2/tweets/1') return Response.json({data:{id:'1',text:'full post'}});
    if (options.method==='DELETE') {
      assert.equal(request.pathname,'/2/users/77/bookmarks/1'); removalCalls++;
      return Response.json({data:{bookmarked:!confirmed}});
    }
    assert.equal(request.pathname,'/2/users/77/bookmarks');
    assert.equal(request.searchParams.get('max_results'),'20');
    if (++calls===3) return Response.json({}, {status:401});
    assert.equal(request.searchParams.get('pagination_token'),calls===1?null:'more');
    return Response.json({data:[{id:String(calls),author_id:'8',text:'post'}],meta:calls===1?{next_token:'more'}:{}});
  };
  const server=makeServer(config,lib,transport);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{await new Promise(r=>server.close(r));lib.db.close();});
  config.origin='http://127.0.0.1:'+server.address().port;
  let cookie='';
  const req=(path,method='GET',body)=>fetch(config.origin+path,{method,redirect:'manual',
    headers:{cookie,origin:config.origin},body:body && JSON.stringify(body)});
  let res=await req('/api/library');
  const demoCookie=res.headers.get('set-cookie').split(';')[0];
  cookie=demoCookie; assert.equal((await res.json()).demo,true);
  const {url}=await (await req('/auth/start','POST')).json();
  assert.equal(new URL(url).searchParams.get('scope'),'tweet.read users.read bookmark.read');
  assert.equal((await req('/auth/callback?code=x&state=false')).headers.get('location'),'/?auth=expired');
  res=await req('/auth/callback?code=x&state='+new URL(url).searchParams.get('state'));
  assert.equal(res.status,303); cookie=res.headers.get('set-cookie').split(';')[0];
  assert.notEqual(cookie,demoCookie);
  assert.deepEqual((await (await req('/api/library')).json()).posts,[]);
  assert.equal((await (await req('/api/sync','POST')).json()).more,true);
  assert.equal((await req('/api/posts/1','PATCH',{state:'kept',tags:['science']})).status,200);
  assert.equal((await (await req('/api/sync','POST')).json()).more,false);
  const state=await (await req('/api/library')).json();
  assert.equal(state.posts.length,2);assert.equal(state.posts[0].state,'kept');
  assert.equal((await fetch(config.origin+'/api/sync',{method:'POST',headers:{cookie}})).status,403);
  assert.equal((await req('/api/posts/1','DELETE')).status,403);
  assert.equal(removalCalls,0);
  assert.equal((await req('/api/posts/1/media','POST')).status,200);
  assert.equal((await (await req('/api/library')).json()).posts[0].state,'kept');
  const manage=new URL((await (await req('/auth/manage','POST')).json()).url);
  assert.ok(manage.searchParams.get('scope').includes('bookmark.write')); write=true;
  res=await req('/auth/callback?code=x&state='+manage.searchParams.get('state'));
  cookie=res.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/api/posts/1','DELETE')).status,502);
  assert.equal((await (await req('/api/library')).json()).posts.length,2);
  confirmed=true;
  assert.equal((await req('/api/posts/1','DELETE')).status,200);
  assert.deepEqual((await (await req('/api/library')).json()).posts.map(p=>p.id),['2']);
  assert.equal(removalCalls,2);
  assert.equal((await req('/api/sync','POST')).status,502);
  assert.equal((await (await req('/api/library')).json()).connected,false);
  await req('/auth/signout','POST');
  assert.equal((await req('/api/posts/1','PATCH',{state:'archive'})).status,401);
  assert.equal((await (await req('/api/library')).json()).demo,true);
});

test('each authorization uses fresh PKCE and state',()=>{
  const a=authorization('client','http://127.0.0.1:4173'),b=authorization('client','http://127.0.0.1:4173');
  assert.notEqual(a.state,b.state); assert.notEqual(a.verifier,b.verifier);
  assert.equal(new URL(a.url).searchParams.get('code_challenge_method'),'S256');
});
