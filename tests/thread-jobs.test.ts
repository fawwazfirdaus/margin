import test from 'node:test';
import assert from 'node:assert/strict';
import { library } from '../lib/database.ts';
import { startThreads, threadProgress, threadStep } from '../lib/thread-jobs.ts';
import { readPost, syncText } from '../lib/index-store.ts';
import { search } from '../lib/search.ts';

const saved = (id: string) => ({ id, handle: 'field', author: 'Field', body: 'Short', date: '', media: [] });
const part = (id: string, text: string, parent?: string) => ({
  id,
  type: 'status',
  provider: 'twitter',
  text,
  author: { id: '80', screen_name: 'field', name: 'Field' },
  replying_to: parent ? { status: parent } : null
});

test('bulk scan is account-scoped and idempotent; indexes the complete anchor, earlier and later replies', async () => {
  const l = library(':memory:'),
    d = l.db;
  try {
    l.savePage('a', [saved('201'), saved('300')], '');
    l.savePage('b', [saved('201')], '');
    startThreads(d, 'a');
    startThreads(d, 'a');
    d.prepare("UPDATE thread_runs SET active=0 WHERE owner='a'").run();
    assert.equal(await threadStep(d, async () => assert.fail('paused')), false);
    startThreads(d, 'a');
    const found = part('201', 'Expanded anchor with marbling', '200');
    const fake: typeof fetch = async (input) =>
      String(input).endsWith('300')
        ? new Response(null, { status: 404 })
        : Response.json({
            code: 200,
            status: found,
            thread: [part('200', 'Root aquatint'), found, part('202', 'Final mezzotint', '201')]
          });
    await Promise.all([threadStep(d, fake), threadStep(d, fake)]);
    syncText(d);
    const coverage = threadProgress(d, 'a');
    assert.equal(coverage.checked, 1);
    assert.equal(coverage.threads, 1);
    assert.equal(coverage.unavailable, 1);
    assert.equal(coverage.waiting, 0);
    assert.equal(readPost(d, 'a', '201').post.body, found.text);
    for (const word of ['marbling', 'aquatint', 'mezzotint']) {
      assert.equal((await search(d, 'a', { q: word, filters: {} }, 0, 5, async () => undefined)).hits[0].id, '201');
      assert.equal((await search(d, 'b', { q: word, filters: {} }, 0, 5, async () => undefined)).total, 0);
    }
    startThreads(d, 'a');
    assert.equal(await threadStep(d, fake), false);
  } finally {
    d.close();
  }
});

test('honors Retry-After, resumes transient failures, and excludes deleted bookmarks', async () => {
  const l = library(':memory:'),
    d = l.db;
  try {
    l.savePage('a', [saved('100'), saved('101')], '');
    startThreads(d, 'a');
    await threadStep(d, async () => new Response(null, { status: 429, headers: { 'Retry-After': '120' } }));
    assert.ok(
      Number(d.prepare("SELECT not_before FROM thread_runs WHERE owner='a'").get()?.not_before) > Date.now() + 115000
    );
    assert.equal(await threadStep(d, async () => assert.fail('too soon')), false);
    d.exec("UPDATE thread_runs SET not_before=0;UPDATE thread_jobs SET ready=0;DELETE FROM bookmarks WHERE id='101'");
    const fake: typeof fetch = async () => new Response(null, { status: 503 });
    for (let i = 0; i < 3; i++) {
      d.exec('UPDATE thread_jobs SET ready=0');
      await threadStep(d, fake);
    }
    assert.equal(threadProgress(d, 'a').failed, 1);
    startThreads(d, 'a', true);
    assert.equal(threadProgress(d, 'a').waiting, 1);
    await threadStep(d, async () => Response.json({ code: 200, status: part('100', 'Standalone'), thread: null }));
    assert.equal(threadProgress(d, 'a').checked, 1);
    assert.equal(threadProgress(d, 'a').threads, 0);
  } finally {
    d.close();
  }
});
