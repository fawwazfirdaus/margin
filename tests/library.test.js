import test from 'node:test';
import assert from 'node:assert/strict';
import { library } from '../lib/database.js';
import { normalizePage, authorization } from '../lib/x.js';

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

test('each authorization uses fresh PKCE and state',()=>{
  const a=authorization('client','http://127.0.0.1:4173'),b=authorization('client','http://127.0.0.1:4173');
  assert.notEqual(a.state,b.state); assert.notEqual(a.verifier,b.verifier);
  assert.equal(new URL(a.url).searchParams.get('code_challenge_method'),'S256');
});
