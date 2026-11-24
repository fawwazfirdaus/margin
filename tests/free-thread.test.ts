import test from 'node:test';
import assert from 'node:assert/strict';
import { library } from '../lib/database.ts';
import { syncText, readPost } from '../lib/index-store.ts';
import { linkPreview, scanLinkedPosts } from '../lib/link-preview.ts';
import { setThreadSelection, localThread } from '../lib/free-thread.ts';
import { search } from '../lib/search.ts';
import { postUrls } from '../shared/free-thread.ts';

const url = (id: string) => 'https://x.com/writer/status/' + id;
const bookmark = (id: string, body: string) => ({
  id,
  author: 'Writer',
  handle: 'writer',
  body,
  date: '',
  media: []
});
const embed = (html: string) =>
  Response.json({ type: 'rich', author_name: 'Writer', html: '<blockquote><p>' + html + '</p></blockquote>' });

test('indexes only two hops of post links, excludes external destinations, and prunes detached descendants', async () => {
  const l = library(':memory:'),
    { db } = l;
  try {
    l.savePage('a', [bookmark('10', url('20'))], '');
    syncText(db);
    await linkPreview(db, 'a', '10', url('20'), async () =>
      embed('<a href="' + url('30') + '">continued</a> <a href="https://example.com/notes">notes</a>')
    );
    syncText(db);
    const checked: string[] = [];
    await scanLinkedPosts(db, 'a', true, async (input) => {
      const target = new URL(String(input)).searchParams.get('url');
      assert.equal(target, url('30'));
      checked.push(target);
      return embed('Indigo pigment <a href="' + url('40') + '">another</a> <a href="' + url('10') + '">back</a>');
    });
    assert.equal(checked.length, 1);
    syncText(db);
    assert.equal((await search(db, 'a', { q: 'indigo', filters: {} }, 0, 10, async () => undefined)).total, 1);
    const hrefs = db
      .prepare('SELECT href FROM linked_sources ORDER BY href')
      .all()
      .map((r) => r.href);
    assert.deepEqual(hrefs, [url('20'), url('30')]);
    await linkPreview(db, 'a', '10', url('20'), async () => new Response(null, { status: 403 }));
    syncText(db);
    assert.equal((await search(db, 'a', { q: 'indigo', filters: {} }, 0, 10, async () => undefined)).total, 0);
  } finally {
    db.close();
  }
});

test('finds native connected self-replies from reply metadata without X calls, and fetches only selected X posts', async () => {
  const l = library(':memory:'),
    { db } = l;
  try {
    l.savePage('a', [{ ...bookmark('20', 'Saved middle'), authorId: '1', parentId: '10' }], '');
    l.savePage('b', [{ ...bookmark('77', 'Private'), authorId: '1', parentId: '20' }], '');
    const data = [
      { id: '10', author_id: '1' },
      { id: '30', author_id: '1', referenced_tweets: [{ type: 'replied_to', id: '20' }] },
      { id: '31', author_id: '9', referenced_tweets: [{ type: 'replied_to', id: '20' }] },
      { id: '32', author_id: '1', referenced_tweets: [{ type: 'quoted', id: '20' }] }
    ];
    const found = localThread(db, 'a', '20', { data });
    assert.deepEqual(
      found.map((p) => p.id),
      ['10', '30']
    );
    assert.throws(() => setThreadSelection(db, 'b', '20', [url('30')]), /not found/);
    assert.throws(() => setThreadSelection(db, 'a', '20', ['https://example.net/']), /Only X/);
    assert.deepEqual(
      postUrls(url('10') + ' ' + url('10') + '/photo/1 https://example.org').map((p) => p.id),
      ['10']
    );
    setThreadSelection(db, 'a', '20', [url('30'), url('20'), url('10'), url('30')]);
    syncText(db);
    await scanLinkedPosts(db, 'a', false, async (input) =>
      embed(new URL(String(input)).searchParams.get('url') === url('30') ? 'Ultraviolet pigment' : 'First reply')
    );
    syncText(db);
    assert.deepEqual(
      readPost(db, 'a', '20').selectedThread.map((p) => p.id),
      ['30', '10']
    );
    const hit = (await search(db, 'a', { q: 'ultraviolet', filters: {} }, 0, 10, async () => undefined)).hits[0];
    assert.equal(hit.evidence.source, 'selected');
    assert.equal(hit.evidence.postId, '30');
    assert.equal((await search(db, 'b', { q: 'ultraviolet', filters: {} }, 0, 10, async () => undefined)).total, 0);
    setThreadSelection(db, 'a', '20', []);
    syncText(db);
    assert.equal(readPost(db, 'a', '20').linked.length, 0);
  } finally {
    db.close();
  }
});

import { mergeBookmarkPage } from '../lib/post-context.ts';
test('bookmarked self-reply can fetch its explicitly identified parent without conversation search', async () => {
  const l = library(':memory:');
  try {
    const child = {
      ...bookmark('20', 'Middle'),
      authorId: '1',
      parentId: '10',
      parentAuthorId: '1',
      conversationId: '10'
    };
    const saved = {
      ...child,
      context: {
        quotes: [],
        thread: [{ ...bookmark('10', 'Previously loaded parent'), authorId: '1', conversationId: '10' }],
        checked: true
      }
    };
    assert.equal(mergeBookmarkPage(child, saved).context?.thread.length, 1);
    l.savePage('a', [child], '');
    syncText(l.db);
    const fetched: string[] = [];
    await scanLinkedPosts(l.db, 'a', false, async (input) => {
      const u = new URL(String(input));
      fetched.push(u.host);
      assert.equal(u.searchParams.get('url'), url('10'));
      return embed('Root azimuth');
    });
    assert.deepEqual(fetched, ['publish.x.com']);
    syncText(l.db);
    assert.equal((await search(l.db, 'a', { q: 'azimuth', filters: {} }, 0, 5, async () => undefined)).total, 1);
  } finally {
    l.db.close();
  }
});

test('public indexing works for a verified reply ID whose author handle is missing', async () => {
  const l = library(':memory:');
  try {
    const href = 'https://x.com/i/web/status/123';
    l.savePage('a', [bookmark('20', href)], '');
    syncText(l.db);
    const p = await linkPreview(l.db, 'a', '20', href, async (input) => {
      assert.equal(new URL(String(input)).searchParams.get('url'), 'https://x.com/i/status/123');
      return Response.json({
        type: 'rich',
        url: 'https://twitter.com/writer/status/123',
        html: '<blockquote><p>Parent text</p></blockquote>'
      });
    });
    assert.equal(p.url, url('123'));
  } finally {
    l.db.close();
  }
});
