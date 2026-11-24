import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { library } from '../lib/database.ts';
import { search } from '../lib/search.ts';
import { embedModel } from '../lib/models.ts';
import { syncText } from '../lib/index-store.ts';
import { makeServer } from '../server.ts';
import type { Post } from '../shared/contracts.ts';

const post = (id: string, body: string): Post => ({
  id,
  body,
  author: 'Field Studio',
  handle: 'field',
  date: '2026-03-14T00:00:00Z',
  media: []
});
const none = async () => undefined;

test('hybrid retrieval finds a paraphrase, honors quotes and counts each bookmark once', async () => {
  const lib = library(':memory:'),
    db = lib.db;
  try {
    lib.savePage('a', [post('1', 'An orbital trajectory around Earth'), post('2', 'A graphite pencil study')], '');
    lib.savePage('b', [post('3', 'Secret orbital document')], '');
    syncText(db);
    const put = db.prepare('UPDATE passages SET vector=?,model=? WHERE book=(SELECT seq FROM bookmarks WHERE id=?)');
    put.run(Buffer.from(Float32Array.from([1, 0]).buffer), embedModel, '1');
    put.run(Buffer.from(Float32Array.from([0, 1]).buffer), embedModel, '2');
    const semantic = await search(db, 'a', { q: 'flight path', filters: {} }, 0, 10, async () => [1, 0]);
    assert.deepEqual(
      semantic.hits.map((h) => h.id),
      ['1']
    );
    assert.equal(semantic.semantic, true);
    assert.equal((await search(db, 'a', { q: '"flight path"', filters: {} }, 0, 10, none)).total, 0);
    assert.equal((await search(db, 'a', { q: '@field', filters: { before: '2025-01-01' } }, 0, 10, none)).total, 0);
    assert.equal((await search(db, 'a', { q: 'secret', filters: {} }, 0, 10, none)).total, 0);
  } finally {
    db.close();
  }
});

test('video preparation follows the attachment opened by a search result', async () => {
  const lib = library(':memory:');
  try {
    const p = post('1', 'Mixed attachments');
    p.media = [
      { type: 'photo', src: '/photo' },
      { type: 'video', src: '/original', alt: 'winding staircase',
        variants: [{ src: '/original', bitrate: 500 }, { src: '/small', bitrate: 100 }] }
    ];
    lib.savePage('a', [p], '');
    const hits = async (q: string) => (await search(lib.db, 'a', { q, filters: {} }, 0, 1, none)).hits;
    assert.equal((await hits(''))[0].video, undefined);
    const [match] = await hits('staircase');
    assert.equal(match.evidence.slot, 1);
    assert.equal(p.media[1].type, 'video');
    assert.deepEqual(match.video, { src: '/original', variants: p.media[1].variants });
    p.quoteId = '2';
    p.context = {
      quotes: [{ ...post('2', 'Turbulent river'), media: [{ type: 'video', src: '/quoted' }] }],
      thread: []
    };
    lib.savePage('a', [p], '');
    const [quote] = await hits('turbulent');
    assert.equal(quote.evidence.postId, '2');
    assert.equal(quote.video?.src, '/quoted');
  } finally {
    lib.db.close();
  }
});

test('account-scoped OCR, collections, saved searches, exact counts, and derived-data cleanup', async (t) => {
  const lib = library(':memory:'),
    db = lib.db,
    config = { origin: '' };
  const server = makeServer(config, lib);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    db.close();
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  config.origin = 'http://127.0.0.1:' + addr.port;
  const init = async () => {
    const r = await fetch(config.origin + '/api/library?summary=1');
    assert.deepEqual(((await r.json()) as { posts: Post[] }).posts, []);
    return r.headers.get('set-cookie')!.split(';')[0];
  };
  const a = await init(),
    b = await init();
  const call = async (cookie: string, route: string, method = 'GET', body?: object) =>
    fetch(config.origin + '/api/discover/' + route, {
      method,
      headers: { cookie, origin: config.origin, 'Content-Type': 'application/json' },
      body: body && JSON.stringify(body)
    });
  const payload = async (cookie: string, route: string, body?: object) => {
    const r = await call(cookie, route, body ? 'POST' : 'GET', body);
    assert.equal(r.status, 200);
    return r.json() as Promise<Record<string, any>>;
  };
  const jobs = (await (await call(a, 'jobs')).json()) as { id: string; slot: number; src: string }[];
  const job = jobs.find((j) => j.id === 'sample-4')!;
  const digest = 'a'.repeat(64);
  const scan = { ...job, text: 'Hidden graphite resonance', words: [['graphite', 0.1, 0.1, 0.4, 0.2]], digest };
  assert.equal((await call(a, 'ocr', 'POST', { ...scan, src: 'https://example.com/changed' })).status, 409);
  await payload(a, 'ocr', scan);
  assert.equal((await payload(a, 'ocr-cache', { digest })).text, scan.text);
  assert.equal(await payload(b, 'ocr-cache', { digest }), null);
  let results = await payload(a, 'search', { q: '"graphite resonance"', filters: { media: 'photo' } });
  assert.equal(results.total, 1);
  assert.equal(results.hits[0].evidence.slot, 0);
  assert.equal(results.hits[0].evidence.source, 'image');
  assert.equal((await payload(b, 'search', { q: 'resonance' })).total, 0);
  const c = await payload(a, 'collections', { name: 'Research' });
  await payload(a, 'membership', { collection: c.id, id: job.id, member: true });
  assert.equal((await call(b, 'membership', 'POST', { collection: c.id, id: job.id, member: true })).status, 404);
  const spec = { q: '', filters: { collection: c.id } };
  await payload(a, 'saved', { ...spec, name: 'Research images' });
  assert.equal((await payload(b, 'catalog')).searches.length, 0);
  assert.equal((await payload(a, 'catalog')).collections[0].count, 1);
  const count = await payload(a, 'ask', { ...spec, question: 'How many of those are photos?' });
  assert.equal(count.mode, 'count');
  assert.match(count.text, /^1 photo bookmark/);
  assert.equal((await payload(a, 'ask', { ...spec, question: 'How many are from Argentina?' })).mode, 'empty');
  assert.equal(
    (await payload(a, 'ask', { q: '', question: 'How many bookmarks were published in 2025?' })).text.startsWith(
      '0 '
    ),
    true
  );
  const owner = String(db.prepare('SELECT owner FROM collections WHERE id=?').get(c.id)!.owner);
  const old = lib.list(owner).find((p) => p.id === job.id)!;
  lib.savePage(owner, [{ ...old, media: [{ type: 'photo', src: '/media/tide.jpg' }] }], '');
  results = await payload(a, 'search', { q: 'resonance' });
  assert.equal(results.total, 0);
  assert.equal((await payload(a, 'post?id=' + job.id)).photos.length, 0);
  db.prepare('DELETE FROM bookmarks WHERE owner=? AND id=?').run(owner, job.id);
  assert.equal((await payload(a, 'catalog')).collections[0].count, 0);
  assert.equal((await call(a, 'post?id=' + job.id)).status, 404);
  assert.equal((await call(a, 'image?id=' + job.id + '&slot=0')).status, 404);
  assert.equal((await payload(a, 'search', spec)).total, 0);
});
