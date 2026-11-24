import test from 'node:test';
import assert from 'node:assert/strict';
import { library } from '../lib/database.ts';
import { linkPreview } from '../lib/link-preview.ts';
import { textLinks, xPost } from '../shared/post-links.ts';
import { normalizePage } from '../lib/x.ts';

test('preserves expanded URLs, rejects unrelated IDs and reuses saved posts only in the owner library', async () => {
  const lib = library(':memory:'),
    url = 'https://twitter.com/writer/status/123/photo/1';
  try {
    const page = normalizePage({
      data: [
        {
          id: '100',
          note_tweet: {
            text: 'See https://t.co/abc',
            entities: { urls: [{ url: 'https://t.co/abc', expanded_url: url }] }
          }
        }
      ]
    });
    assert.equal(page.posts[0].links?.[0].expanded, url);
    assert.equal(xPost(url)?.id, '123');
    assert.equal(xPost('https://x.com.evil.test/writer/status/123'), undefined);
    assert.equal(textLinks('See (https://t.co/abc).')[0].raw, 'https://t.co/abc');
    lib.savePage('a', page.posts, '');
    lib.savePage('b', [{ ...page.posts[0], id: '123', body: 'private' }], '');
    const publicEmbed: typeof fetch = async (input, options) => {
      const u = new URL(String(input));
      assert.equal(u.origin, 'https://publish.x.com');
      assert.equal(options?.redirect, 'error');
      return Response.json({
        type: 'rich',
        author_name: 'Writer',
        html: '<blockquote><p>Public text</p></blockquote>'
      });
    };
    assert.equal((await linkPreview(lib.db, 'a', '100', 'https://t.co/abc', publicEmbed)).kind, 'public');
    assert.equal(
      (await linkPreview(lib.db, 'a', '100', url, async () => new Response(null, { status: 403 }))).kind,
      'unavailable'
    );
    await assert.rejects(linkPreview(lib.db, 'b', '100', url, publicEmbed), /not found/);
    await assert.rejects(linkPreview(lib.db, 'a', '100', 'https://t.co/other', publicEmbed), /not found/);
    lib.savePage('a', [{ ...page.posts[0], id: '123', body: 'my local copy' }], '');
    assert.equal((await linkPreview(lib.db, 'a', '100', url, () => assert.fail('unexpected fetch'))).kind, 'saved');
  } finally {
    lib.db.close();
  }
});

test('a short link resolves once without fetching external websites or treating self media as a quote', async () => {
  const lib = library(':memory:');
  try {
    lib.savePage('a', normalizePage({ data: [{ id: '100', text: 'https://t.co/abc' }] }).posts, '');
    for (const [location, kind] of [
      ['https://example.org/story', 'external'],
      ['https://x.com/writer/status/100/video/1', 'self']
    ]) {
      let calls = 0;
      const r = await linkPreview(lib.db, 'a', '100', 'https://t.co/abc', async (url, options) => {
        calls++;
        assert.equal(url, 'https://t.co/abc');
        assert.equal(options?.redirect, 'manual');
        return new Response(null, { status: 301, headers: { location } });
      });
      assert.equal(r.kind, kind);
      assert.equal(calls, 1);
    }
  } finally {
    lib.db.close();
  }
});

import { embeddedBody } from '../lib/linked-sources.ts';
import { scanLinkedPosts } from '../lib/link-preview.ts';
import { readPost, syncText } from '../lib/index-store.ts';
import { search } from '../lib/search.ts';
import { embedModel } from '../lib/models.ts';

test('a linked preview becomes attributed keyword and vector evidence and is pruned on unlink', async () => {
  const lib = library(':memory:'),
    db = lib.db,
    raw = 'https://twitter.com/writer/status/123/photo/1';
  const html =
    '<blockquote><p>Violet &amp; <a href="#">cobalt</a><br>sky<script>forbidden</script></p>Attribution</blockquote>';
  assert.equal(embeddedBody(html), 'Violet & cobalt\nsky');
  const post = normalizePage({ data: [{ id: '100', text: 'A link ' + raw }] }).posts[0];
  const transport: typeof fetch = async () => Response.json({ type: 'rich', author_name: 'Writer', html });
  try {
    for (const owner of ['a', 'b']) lib.savePage(owner, [post], '');
    syncText(db);
    assert.equal((await scanLinkedPosts(db, 'a', false, transport)).indexed, 1);
    const lookup = (owner: string, q: string, embed = async (): Promise<number[] | undefined> => undefined) =>
      search(db, owner, { q, filters: {} }, 0, 10, embed);
    const first = await lookup('a', '"cobalt sky"');
    assert.equal(first.total, 1);
    assert.equal(first.hits[0].id, '100');
    assert.equal(first.hits[0].evidence.author, 'Writer');
    assert.equal(first.hits[0].evidence.postId, '123');
    assert.equal(first.hits[0].evidence.source, 'linked');
    assert.equal((await lookup('b', 'cobalt')).total, 0);
    const vector = Buffer.from(new Float32Array([1, 0]).buffer);
    db.prepare("UPDATE passages SET vector=?,model=? WHERE source='linked'").run(vector, embedModel);
    assert.equal((await lookup('a', 'ultramarine', async () => [1, 0])).hits[0].evidence.source, 'linked');
    await linkPreview(db, 'a', '100', raw, transport);
    syncText(db);
    assert.equal(
      db.prepare("SELECT count(*) n FROM passages WHERE source='linked' AND model=?").get(embedModel)?.n,
      1
    );
    assert.equal(readPost(db, 'a', '100').linked[0].id, '123');
    await linkPreview(db, 'a', '100', raw, async () => new Response(null, { status: 403 }));
    assert.equal((await lookup('a', 'cobalt')).total, 0);
    await linkPreview(db, 'a', '100', raw, transport);
    lib.savePage('a', [{ ...post, body: 'no links' }], '');
    assert.equal((await lookup('a', 'cobalt')).total, 0);
    assert.equal(readPost(db, 'a', '100').linked.length, 0);
  } finally {
    db.close();
  }
});

test('a preview finishing after its source was removed cannot reinsert evidence', async () => {
  const lib = library(':memory:'),
    url = 'https://x.com/me/status/52';
  try {
    const post = normalizePage({ data: [{ id: '51', text: url }] }).posts[0];
    lib.savePage('a', [post], '');
    syncText(lib.db);
    await linkPreview(lib.db, 'a', '51', url, async () => {
      lib.savePage('a', [{ ...post, body: 'edited' }], '');
      return Response.json({ type: 'rich', html: '<blockquote><p>obsolete</p></blockquote>' });
    });
    syncText(lib.db);
    assert.equal(lib.db.prepare("SELECT count(*) n FROM passages WHERE source='linked'").get()?.n, 0);
  } finally {
    lib.db.close();
  }
});
