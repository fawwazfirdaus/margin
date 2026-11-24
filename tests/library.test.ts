import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { library } from '../lib/database.ts';
import { normalizePage, authorization, type Transport } from '../lib/x.ts';
import { makeServer } from '../server.ts';
import type { AuthorizationResponse, LibraryResponse, Post, SyncResponse } from '../shared/contracts.ts';

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';')[0];
}

test('media keeps attachment order and selects the highest bitrate playable MP4', () => {
  const page=normalizePage({data:[{id:'123',attachments:{media_keys:['b','a','z','c','preview']}}],includes:{media:[
    {media_key:'b',type:'photo',url:'photo',alt_text:'Ocean'},
    {media_key:'a',type:'video',preview_image_url:'poster',variants:[
      {content_type:'video/mp4',bit_rate:500,url:'high'},{content_type:'video/mp4',bit_rate:100,url:'low'}]},
    {media_key:'c',type:'animated_gif',variants:[{content_type:'video/mp4',url:'gif'}]},
    {media_key:'preview',type:'video',preview_image_url:'still'}]}});
  assert.deepEqual(page.posts[0].media.map(m=>'src' in m ? m.src : undefined),['photo','high',undefined,'gif',undefined]);
  assert.equal(page.posts[0].media[1].poster,'poster');
  assert.equal(page.posts[0].media[2].type,'unavailable');
  assert.equal(page.posts[0].media[4].poster,'still');
  assert.throws(()=>normalizePage({errors:[{}]}),/incomplete/);
  assert.equal(normalizePage({meta:{result_count:0}}).posts.length,0);
});

test('re-import preserves review state, tags and per-owner isolation; failed batch rolls back', () => {
  const lib=library(':memory:');
  try {
    const post: Post = {id:'42',handle:'test',author:'Test',date:'',body:'before',media:[]};
    lib.savePage('a',[post],'page1');
    lib.edit('a','42',{state:'kept',tags:[' A ','a']});
    assert.equal(lib.savePage('a',[{...post,body:'after'}],''),0);
    assert.deepEqual(lib.list('a'),[{...post,body:'after',state:'kept',tags:['a']}]);
    assert.equal(lib.edit('b','42',{state:'archive'}),0);
    lib.db.exec("CREATE TRIGGER reject_row BEFORE INSERT ON bookmarks WHEN NEW.id='44' BEGIN SELECT RAISE(ABORT,'interrupted'); END;");
    assert.throws(()=>lib.savePage('a',[{...post,id:'43'},{...post,id:'44'}],'bad'),/interrupted/);
    assert.equal(lib.list('a').length,1);
    assert.equal(lib.cursor('a'),'');
  } finally {lib.db.close();}
});

test('OAuth login, private library, pagination, token expiry and logout through HTTP',async t=>{
  const lib=library(':memory:');
  const config={origin:'',clientId:'client',secret:'secret'};
  let calls=0, write=false, confirmed=false, removalCalls=0;
  const transport: Transport=async (url, options)=>{
    const headers=new Headers(options.headers);
    if(url.endsWith('/token')){
      assert.ok(options.body instanceof URLSearchParams && options.body.get('code_verifier'));
      assert.ok(headers.get('Authorization')?.startsWith('Basic '));
      return Response.json({access_token:'fixture',scope:write?'bookmark.read bookmark.write':'bookmark.read'});
    }
    assert.equal(headers.get('Authorization'),'Bearer fixture');
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
  t.after(async()=>{await new Promise<void>((resolve,reject)=>server.close(err=>err ? reject(err) : resolve()));lib.db.close();});
  const address=server.address();
  assert.ok(address && typeof address === 'object');
  config.origin='http://127.0.0.1:'+address.port;
  let cookie='';
  const req=(path: string,method='GET',body?: object)=>fetch(config.origin+path,{method,redirect:'manual',
    headers:{cookie,origin:config.origin},body:body && JSON.stringify(body)});
  const getLibrary=async()=>json<LibraryResponse>(await req('/api/library'));
  let res=await req('/api/library');
  const demoCookie=sessionCookie(res);
  cookie=demoCookie; assert.equal((await json<LibraryResponse>(res)).demo,true);
  const {url}=await json<AuthorizationResponse>(await req('/auth/start','POST'));
  assert.equal(new URL(url).searchParams.get('scope'),'tweet.read users.read bookmark.read');
  assert.equal((await req('/auth/callback?code=x&state=false')).headers.get('location'),'/?auth=expired');
  res=await req('/auth/callback?code=x&state='+new URL(url).searchParams.get('state'));
  assert.equal(res.status,303); cookie=sessionCookie(res);
  assert.notEqual(cookie,demoCookie);
  assert.deepEqual((await getLibrary()).posts,[]);
  assert.equal((await json<SyncResponse>(await req('/api/sync','POST'))).more,true);
  assert.equal((await req('/api/posts/1','PATCH',{state:'invalid'})).status,400);
  assert.equal((await req('/api/posts/1','PATCH',{tags:[1]})).status,400);
  assert.equal((await req('/api/posts/1','PATCH',{state:'kept',tags:['science']})).status,200);
  assert.equal((await json<SyncResponse>(await req('/api/sync','POST'))).more,false);
  const state=await getLibrary();
  assert.equal(state.posts.length,2);assert.equal(state.posts[0].state,'kept');
  assert.equal((await fetch(config.origin+'/api/sync',{method:'POST',headers:{cookie}})).status,403);
  assert.equal((await req('/api/posts/1','DELETE')).status,403);
  assert.equal(removalCalls,0);
  assert.equal((await req('/api/posts/1/media','POST')).status,200);
  assert.equal((await getLibrary()).posts[0].state,'kept');
  const manage=new URL((await json<AuthorizationResponse>(await req('/auth/manage','POST'))).url);
  assert.ok(manage.searchParams.get('scope')?.includes('bookmark.write')); write=true;
  res=await req('/auth/callback?code=x&state='+manage.searchParams.get('state'));
  cookie=sessionCookie(res);
  assert.equal((await req('/api/posts/1','DELETE')).status,502);
  assert.equal((await getLibrary()).posts.length,2);
  confirmed=true;
  assert.equal((await req('/api/posts/1','DELETE')).status,200);
  assert.deepEqual((await getLibrary()).posts.map(p=>p.id),['2']);
  assert.equal(removalCalls,2);
  assert.equal((await req('/api/sync','POST')).status,502);
  assert.equal((await getLibrary()).connected,false);
  await req('/auth/signout','POST');
  assert.equal((await req('/api/posts/1','PATCH',{state:'archive'})).status,401);
  assert.equal((await getLibrary()).demo,true);
});

test('each authorization uses fresh PKCE and state',()=>{
  const a=authorization('client','http://127.0.0.1:4173'),b=authorization('client','http://127.0.0.1:4173');
  assert.notEqual(a.state,b.state); assert.notEqual(a.verifier,b.verifier);
  assert.equal(new URL(a.url).searchParams.get('code_challenge_method'),'S256');
});
