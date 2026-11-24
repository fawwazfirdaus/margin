import test from 'node:test';
import assert from 'node:assert/strict';
import {dimensions,openAIEmbed,openAIAnswer} from '../lib/openai.ts';

test('OpenAI adapter preserves embedding order, validates shape, and sends only text to Ask',async t=>{
  const prior=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';
  t.after(()=>{if(prior===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=prior;});
  const v=Array(dimensions).fill(0);
  const vectors=await openAIEmbed(['one','two'],async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/embeddings');
    const body=JSON.parse(String(init?.body));assert.deepEqual(body.input,['one','two']);assert.equal(body.dimensions,dimensions);
    return Response.json({data:[{index:1,embedding:v.map(()=>2)},{index:0,embedding:v}]});
  });
  assert.equal(vectors[0][0],0);assert.equal(vectors[1][0],2);
  await assert.rejects(openAIEmbed(['one'],async()=>Response.json({data:[{index:0,embedding:[1]}]})),/Invalid OpenAI embedding/);
  const claims=await openAIAnswer('Question',['A supplied fact'],async(url,init)=>{
    assert.equal(url,'https://api.openai.com/v1/responses');
    const body=JSON.parse(String(init?.body));assert.equal(body.store,false);
    assert.deepEqual(JSON.parse(body.input),{question:'Question',excerpts:[{number:1,text:'A supplied fact'}]});
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({
      claims:[{text:'Supported.',sources:[1]},{text:'Invalid citation.',sources:[9]}]})}]}]});
  });
  assert.deepEqual(claims,[{text:'Supported.',sources:[1]}]);
});
