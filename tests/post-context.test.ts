import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichPost,preserveContext} from '../lib/post-context.ts';
import {normalizePage,type XAccount,type Transport} from '../lib/x.ts';
import {library} from '../lib/database.ts';
import {search} from '../lib/search.ts';

const user:XAccount={account:'101',name:'test',token:'fixture',canRemove:false};
const users=[{id:'1',name:'Writer',username:'writer'},{id:'2',name:'Other',username:'other'}];
const ref=(type:string,id:string)=>({type,id});
const raw=(id:string,text:string,parent?:string,quote?:string,author='1')=>({id,text,author_id:author,conversation_id:'100',
  referenced_tweets:[...(parent?[ref('replied_to',parent)]:[]),...(quote?[ref('quoted',quote)]:[])]});

test('collects author thread across pages, looks up the missing root, follows nested quotes and indexes attribution',async()=>{
  const seed=normalizePage({data:[raw('102','Middle','101','201')],includes:{users,tweets:[raw('201','Original words',undefined,'202','2')]}}).posts[0];
  const calls:string[]=[];
  const transport:Transport=async url=>{
    const u=new URL(url);calls.push(u.pathname);
    if(u.pathname.endsWith('/search/all')){
      assert.equal(u.searchParams.get('query'),'conversation_id:100 from:writer');assert.ok(u.searchParams.get('start_time'));
      const next=u.searchParams.get('next_token');
      return Response.json({data:next?[raw('103','Third post','102')]:[raw('101','Second post','100'),raw('130','Off topic reply','129')],meta:next?{}:{next_token:'page-two'},includes:{users}});
    }
    const data=url.includes('/tweets/100?')?raw('100','Thread root'):raw('202','Nested sapphire citation',undefined,'201','2');
    return Response.json({data,includes:{users}});
  };
  const full=await enrichPost(seed,user,transport);
  assert.deepEqual(full.context?.thread.map(p=>p.id),['100','101','103']);
  assert.deepEqual(full.context?.quotes.map(p=>p.id),['201','202']);assert.equal(full.context?.checked,true);
  assert.equal(calls.length,4);
  const lib=library(':memory:');
  try{
    lib.savePage('owner',[full],'');
    const results=await search(lib.db,'owner',{q:'"sapphire citation"',filters:{}},0,5,async()=>undefined);
    assert.equal(results.total,1);assert.equal(results.hits[0].evidence.source,'quote');
    assert.equal(results.hits[0].evidence.author,'Other');assert.equal(results.hits[0].evidence.postId,'202');
    assert.equal((await search(lib.db,'else',{q:'sapphire',filters:{}},0,5,async()=>undefined)).total,0);
    assert.equal(lib.list('owner').length,1);
  }finally{lib.db.close();}
  const partial=await enrichPost(seed,user,async()=>Response.json({},{status:403}));
  assert.equal(partial.context?.checked,false);
  assert.equal(preserveContext(partial,full).context?.quotes.length,2);
});

test('an ordinary post with no replies needs no extra X requests',async()=>{
  const seed=normalizePage({data:[{...raw('100','Standalone'),public_metrics:{reply_count:0}}],includes:{users}}).posts[0];
  const result=await enrichPost(seed,user,async()=>{assert.fail('unexpected X request');});
  assert.deepEqual(result.context?.thread,[]);assert.equal(result.context?.checked,true);
});
