import {withPublicThread} from './public-unroll.ts';
import type { DatabaseSync } from 'node:sqlite';
import { parseFragment, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import type { Post, Preview } from '../shared/contracts.ts';
import { textLinks, shortLink, xPost } from '../shared/post-links.ts';

export function sourceLinks(post: Post) {
  const allowed = new Map<string, string>();
  for (const part of [post, ...(post.context?.quotes || []), ...(post.context?.thread || [])]) {
    for (const l of textLinks(part.body)) allowed.set(l.href, l.href);
    for (const l of part.links || []) {
      allowed.set(l.url, l.expanded);
      allowed.set(l.expanded, l.expanded);
    }
    if (part.parentId && part.authorId && part.authorId === part.parentAuthorId && /^\w{1,15}$/.test(part.handle)) {
      const parent = 'https://x.com/'+part.handle+'/status/'+part.parentId;
      if (xPost(parent)) allowed.set(parent,parent);
    }
    if (part.quoteId) {
      const url = 'https://x.com/i/web/status/' + part.quoteId;
      allowed.set(url, url);
    }
  }
  for (const value of [...allowed.values()]) {
    const target = xPost(value);
    if (target) allowed.set(target.url, target.url);
  }
  return allowed;
}
export function candidate(bookmark: string, href: string) {
  const target = xPost(href);
  return target && target.id !== bookmark ? target.url : shortLink(href) ? href : undefined;
}

// Only the paragraphs inside the embed's blockquote are source text.
// Attribution, executable elements, and surrounding widget markup stay out of the index.
export function embeddedBody(html: string) {
  function paragraphs(node: Tree.Node, inside = false): string[] {
    if ('tagName' in node) {
      if (['script', 'style', 'iframe', 'object', 'template'].includes(node.tagName)) return [];
      if (node.tagName === 'blockquote') inside = true;
      if (inside && node.tagName === 'p') return [text(node)];
    }
    return 'childNodes' in node ? node.childNodes.flatMap((n) => paragraphs(n, inside)) : [];
  }
  function text(node: Tree.Node): string {
    if (node.nodeName === '#text' && 'value' in node) return node.value;
    if ('tagName' in node) {
      if (node.tagName === 'br') return '\n';
      if (['script', 'style', 'iframe', 'object', 'template'].includes(node.tagName)) return '';
    }
    return 'childNodes' in node ? node.childNodes.map(text).join('') : '';
  }
  return paragraphs(parseFragment(html)).join('\n').trim();
}

// Resolve one additional hop from a direct source. Recompute reachability from the
// bookmark each time so a cycle or a removed parent cannot keep a child alive.
export function reachableLinks(db: DatabaseSync, book: number, post: Post) {
  const allowed = sourceLinks(post);
  for (const row of db.prepare('SELECT url FROM thread_selections WHERE book=?').all(book)) {
    const url = String(row.url);
    allowed.set(url, url);
  }
  const first = new Set([...allowed.values()].map((url) => candidate(post.id, url)));
  for (const row of db
    .prepare("SELECT href,target,body,outgoing FROM linked_sources WHERE book=? AND body<>''")
    .all(book)) {
    if (!first.has(String(row.href))) continue;
    const links: string[] = [...JSON.parse(String(row.outgoing)), ...textLinks(String(row.body)).map((l) => l.href)];
    for (const href of links) {
      const url = candidate(post.id, href);
      if (!url || xPost(url)?.id === row.target) continue;
      allowed.set(href, url);
      allowed.set(url, url);
    }
  }
  return allowed;
}

function embedLinks(html: string) {
  const links = new Set<string>();
  function visit(node: Tree.Node, quote = false, paragraph = false) {
    if ('tagName' in node) {
      if (['script', 'style', 'template', 'iframe', 'object'].includes(node.tagName)) return;
      quote ||= node.tagName === 'blockquote';
      paragraph ||= quote && node.tagName === 'p';
      if (paragraph && node.tagName === 'a') {
        const href = node.attrs.find((a) => a.name === 'href')?.value;
        if (href && (xPost(href) || shortLink(href))) links.add(href);
      }
    }
    if ('childNodes' in node) node.childNodes.forEach((n) => visit(n, quote, paragraph));
  }
  visit(parseFragment(html));
  return [...links];
}

export function reconcileLinks(db: DatabaseSync, book: number, post: Post) {
  const wanted = new Set(
    [...reachableLinks(db, book, post).values()].map((h) => candidate(post.id, h)).filter((h) => h !== undefined)
  );
  const insert = db.prepare('INSERT INTO linked_sources(book,href) VALUES(?,?) ON CONFLICT DO NOTHING');
  for (const href of wanted) insert.run(book, href);
  const remove = db.prepare('DELETE FROM linked_sources WHERE lid=?');
  for (const row of db.prepare('SELECT lid,href FROM linked_sources WHERE book=?').all(book)) {
    if (!wanted.has(String(row.href))) remove.run(row.lid);
  }
}

// Re-check the source after the network request: a bookmark can be refreshed or removed in flight.
export function recordPreview(
  db: DatabaseSync,
  owner: string,
  book: number,
  href: string,
  expected: string,
  result: Preview
) {
  const row = db.prepare('SELECT id,content FROM bookmarks WHERE owner=? AND seq=?').get(owner, book);
  if (!row) return;
  const mapped = reachableLinks(db, book, withPublicThread(db,book,JSON.parse(String(row.content)))).get(href);
  const key = mapped && candidate(String(row.id), mapped);
  if (!key || mapped !== expected) return;
  const target = xPost(result.url);
  const body =
    result.kind === 'public' ? embeddedBody(result.html) : result.kind === 'saved' ? result.post.body.trim() : '';
  const author = result.kind === 'public' ? result.author : result.kind === 'saved' ? result.post.author : '';
  const outgoing =
    result.kind === 'public'
      ? embedLinks(result.html)
      : result.kind === 'saved'
        ? [...sourceLinks(result.post).values()].filter((u) => xPost(u) || shortLink(u))
        : [];
  const transient = result.kind === 'unavailable' && result.retryable;
  db.exec('BEGIN');
  try {
    if (transient) {
      db.prepare(
        "INSERT INTO linked_sources(book,href,status) VALUES(?,?,'failed') ON CONFLICT(book,href) DO UPDATE SET status='failed'"
      ).run(book, key);
    } else {
      const status = target && body ? 'indexed' : result.kind === 'unavailable' ? 'unavailable' : 'skipped';
      db.prepare(
        `INSERT INTO linked_sources(book,href,target,url,author,body,status,outgoing) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(book,href) DO UPDATE SET target=excluded.target,url=excluded.url,author=excluded.author,body=excluded.body,status=excluded.status,outgoing=excluded.outgoing`
      ).run(book, key, target?.id || '', target?.url || '', author, body, status, JSON.stringify(outgoing));
      // Invalidate any aliases of a post X has explicitly stopped making available.
      if (target && result.kind === 'unavailable') {
        db.prepare(
          `INSERT OR IGNORE INTO dirty SELECT l.book FROM linked_sources l JOIN bookmarks b ON b.seq=l.book
          WHERE b.owner=? AND l.target=?`
        ).run(owner, target.id);
        db.prepare(
          "UPDATE linked_sources SET status='unavailable',body='',author='' WHERE target=? AND book IN(SELECT seq FROM bookmarks WHERE owner=?)"
        ).run(target.id, owner);
      }
    }
    db.prepare('INSERT OR IGNORE INTO dirty VALUES(?)').run(book);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
