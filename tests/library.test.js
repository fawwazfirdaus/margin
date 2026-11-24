import test from 'node:test';
import assert from 'node:assert/strict';
import { authorization } from '../lib/x.js';
import { library } from '../lib/database.js';

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
