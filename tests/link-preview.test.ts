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
