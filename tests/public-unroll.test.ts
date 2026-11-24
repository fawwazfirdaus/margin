import test from 'node:test';
import assert from 'node:assert/strict';
import { library } from '../lib/database.ts';
import { unrollBookmark } from '../lib/public-unroll.ts';
import { syncText, readPost } from '../lib/index-store.ts';
import { search } from '../lib/search.ts';

const fx = (id: string, text: string, parent?: string, author = '81') => ({
  id,
  type: 'status',
  provider: 'twitter',
  text,
  author: { id: author, name: 'Field Studio', screen_name: 'field', protected: false },
  replying_to: parent ? { status: parent } : null
});
const root = fx('100', 'Root azimuth'),
  middle = fx('101', 'Selected post', '100'),
  end = fx('102', 'Last impression', '101');
const saved = { id: '101', body: 'Original bookmark', author: 'Field Studio', handle: 'field', media: [], date: '' };
test('one bookmark ID imports only its connected public self-replies, searchable with attribution', async () => {
  const lib = library(':memory:'),
    db = lib.db;
  try {
    lib.savePage('a', [saved], '');
    lib.savePage('b', [saved], '');
    let calls = 0;
    const transport: typeof fetch = async (url, init) => {
      calls++;
      assert.equal(url, 'https://api.fxtwitter.com/2/thread/101');
      assert.equal(new Headers(init?.headers).get('authorization'), null);
      return Response.json({
        code: 200,
        status: middle,
        thread: [
          end,
          fx('104', 'disconnected', '999'),
          root,
          middle,
          end,
          fx('105', 'other user', '101', '99'),
          { type: 'tombstone' }
        ]
      });
    };
    assert.equal((await unrollBookmark(db, 'a', '101', transport)).related, 2);
    syncText(db);
    assert.deepEqual(
      readPost(db, 'a', '101').post.context?.thread.map((p) => p.id),
      ['100', '102']
    );
    const hits = await search(db, 'a', { q: '"last impression"', filters: {} }, 0, 5, async () => undefined);
    assert.equal(hits.total, 1);
    assert.equal(hits.hits[0].id, '101');
    assert.equal(hits.hits[0].evidence.postId, '102');
    assert.equal(hits.hits[0].evidence.source, 'thread');
    assert.equal((await search(db, 'b', { q: 'azimuth', filters: {} }, 0, 5, async () => undefined)).total, 0);
    lib.savePage(
      'a',
      [{ ...saved, context: { quotes: [], thread: [{ ...saved, id: '100', body: 'Official root' }] } }],
      ''
    );
    await unrollBookmark(db, 'a', '101', transport);
    syncText(db);
    assert.equal(readPost(db, 'a', '101').post.context?.thread.length, 2);
    assert.equal(readPost(db, 'a', '101').post.context?.thread[0].body, 'Official root');
    assert.equal(calls, 2);
    assert.equal(lib.list('a').length, 1);
    db.prepare('DELETE FROM bookmarks WHERE owner=?').run('a');
    assert.equal(db.prepare('SELECT count(*) n FROM public_unrolls').get()?.n, 0);
  } finally {
    db.close();
  }
});

test('invalid, private, or mismatched posts and provider failures cannot overwrite a saved unroll', async () => {
  const lib = library(':memory:'),
    db = lib.db;
  try {
    lib.savePage('a', [saved], '');
    await assert.rejects(
      unrollBookmark(db, 'b', '101', async () => assert.fail('external call')),
      /not found/
    );
    await assert.rejects(
      unrollBookmark(db, 'a', 'https://example.org', async () => assert.fail('external call')),
      /real X bookmark/
    );
    await unrollBookmark(db, 'a', '101', async () => Response.json({ code: 200, status: middle, thread: [root] }));
    for (const response of [
      Response.json({ code: 200, status: end, thread: [] }),
      Response.json({ code: 200, status: { ...middle, author: { ...middle.author, protected: true } }, thread: [] }),
      new Response(null, { status: 429 })
    ]) {
      await assert.rejects(unrollBookmark(db, 'a', '101', async () => response));
      assert.equal(readPost(db, 'a', '101').post.context?.thread[0].id, '100');
    }
    const transport: typeof fetch = async () => {
      db.prepare("DELETE FROM bookmarks WHERE owner='a'").run();
      return Response.json({ code: 200, status: middle, thread: [end] });
    };
    await assert.rejects(unrollBookmark(db, 'a', '101', transport), /removed during lookup/);
    assert.equal(db.prepare('SELECT count(*) n FROM public_unrolls').get()?.n, 0);
  } finally {
    db.close();
  }
});
