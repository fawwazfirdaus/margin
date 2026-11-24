import assert from 'node:assert/strict';
import test from 'node:test';
import { library } from '../lib/database.ts';
import { answer } from '../lib/answers.ts';
import { readPost, pendingPhotos, syncText } from '../lib/index-store.ts';
import { unrollBookmark } from '../lib/public-unroll.ts';
import { search } from '../lib/search.ts';
import { startThreads, threadProgress } from '../lib/thread-jobs.ts';

const none = async () => undefined;
const bookmark = { id: '100', body: 'Edition table', author: 'Printer', handle: 'press', date: '', media: [] };
const fx = (id: string, text: string, parent = '', author = '9') => ({
  type: 'status', provider: 'twitter', id, text,
  author: { id: author, name: 'Author ' + author, screen_name: 'user' + author },
  replying_to: { status: parent }
});
const photo = (name: string) => ({ type: 'photo', url: 'https://pbs.twimg.com/media/' + name });
const focus = fx('100', 'Edition table');
const paper = { title: 'Inking a plate', content: {
  blocks: [{ text: 'Ink absorbs pressure.' }, { text: ' ', entityRanges: [{ key: 0 }] }],
  entityMap: [{ key: '0', value: { type: 'MARKDOWN', data: { markdown: 'Cobalt aquatint dries overnight.' } } }]
} };
const deeper = { ...fx('201', 'Etching pigments', '', '22'), article: paper, media: { all: [photo('quote')] } };
const quoted = { ...fx('200', 'Patina method', '', '21'), quote: deeper };
const reply = { ...fx('103', 'Lower pressure for relief prints.', '100'), quote: quoted, media: { all: [photo('reply')] } };
const fetched = (thread: unknown[]) => async () => Response.json({code: 200, status: focus, thread});

test('indexes reachable native articles, markdown and nested quotes; OCR and citations survive reply reordering', async t => {
  const lib = library(':memory:'), db = lib.db;
  t.after(() => db.close());
  for (const owner of ['a','b']) lib.savePage(owner, [bookmark], '');
  await unrollBookmark(db, 'a', '100', fetched([{ ...fx('101','Earlier reply','100'), quote: { ...quoted, quote: undefined } }, reply, { ...fx('410','Other person','100','35'), quote: fx('411','Offtopic') }]));
  syncText(db);
  const query = (q: string, owner = 'a') => search(db,owner,{q,filters:{}},0,6,none);
  const article = (await query('aquatint')).hits[0].evidence;
  assert.deepEqual([article.source, article.postId, article.paragraph, article.author], ['article','201',1,'Author 22']);
  assert.equal((await query('patina')).hits[0].evidence.postId,'200');
  assert.equal((await query('offtopic')).total,0);
  assert.equal((await query('aquatint','b')).total,0);
  const jobs = pendingPhotos(db,'a',20);
  assert.equal(jobs.length,2);
  assert.equal(pendingPhotos(db,'b',20).length,0);
  for (const job of jobs) assert.ok(job.slot < 0);
  const job = jobs.find(j => j.src.endsWith('/quote'))!;
  db.prepare("UPDATE photos SET body='Graphite fraction',status='ready' WHERE slot=?").run(job.slot);
  await unrollBookmark(db,'a','100',fetched([reply,fx('101','Earlier reply','100'),fx('102','Interleaved reply','101')]));
  syncText(db);
  const image = (await query('Graphite')).hits[0].evidence;
  assert.deepEqual([image.source,image.postId,image.slot,image.attachment,image.author],['image','201',job.slot,0,'Author 22']);
  assert.equal(readPost(db,'a','100').photos[0].postId,'201');
  await unrollBookmark(db,'a','100',fetched([]));
  syncText(db);
  for (const q of ['aquatint','graphite','patina']) assert.equal((await query(q)).total,0);
  assert.equal(pendingPhotos(db,'a',10).length,0);
});

test('Ask can cite separate replies from the same scoped bookmark; search still returns one bookmark', async t => {
  const lib = library(':memory:'), db = lib.db;
  t.after(() => db.close());
  lib.savePage('a',[bookmark,{...bookmark,id:'400',body:'Linseed in an unrelated bookmark'}],'');
  await unrollBookmark(db,'a','100',fetched([fx('102','Linseed dries slowly.','100'),fx('109','Linseed dries faster with heat.','102')]));
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    const body = String(init.body);
    assert.match(body,/dries slowly/);
    assert.match(body,/faster with heat/);
    assert.doesNotMatch(body,/unrelated bookmark/);
    const content = JSON.stringify({claims:[{text:'Heat speeds drying.',sources:[1,2]}]});
    return Response.json({ message: {content}, status:'completed',output:[{type:'message',content:[{type:'output_text',text:content}]}] });
  });
  const a = await answer(db,'a',{q:'edition',filters:{}},'How does linseed dry?',false,none);
  assert.equal(a.mode,'model');
  assert.deepEqual(a.citations.map(h => h.evidence.postId).sort(),['102','109']);
  assert.match(a.text,/\[1\] \[2\]/);
  const regular = await search(db,'a',{q:'dries',filters:{}},0,10,none);
  assert.equal(regular.total,1);
});

test('new imports queue only for opted-in libraries, and respect pause', t => {
  const lib=library(':memory:'), db=lib.db;
  t.after(()=>db.close());
  startThreads(db,'a');
  db.exec("UPDATE thread_runs SET active=0,paused=1");
  for (const owner of ['a','b']) lib.savePage(owner,[bookmark],'');
  assert.equal(threadProgress(db,'a').waiting,1);
  assert.equal(threadProgress(db,'a').active,false);
  assert.equal(threadProgress(db,'b').waiting,0);
  startThreads(db,'a');
  assert.equal(threadProgress(db,'a').active,true);
});
