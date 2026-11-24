import type { DatabaseSync } from 'node:sqlite';
import { connectedReplies, type ReplyRecord, type SelectedPart } from '../shared/free-thread.ts';
import { xPost } from '../shared/post-links.ts';
import type { Post, PostPart } from '../shared/contracts.ts';

export function threadSelection(db: DatabaseSync, book: number): SelectedPart[] {
  return db
    .prepare(
      `SELECT s.target id,s.url,coalesce(l.body,'') body,coalesce(l.author,'') author,
    coalesce(l.status,'pending') status FROM thread_selections s LEFT JOIN linked_sources l ON s.book=l.book AND s.url=l.href
    WHERE s.book=? ORDER BY s.position`
    )
    .all(book) as unknown as SelectedPart[];
}

// Reconstruct only documented reply edges in account-owned records or an explicitly supplied X response.
export function localThread(db: DatabaseSync, owner: string, anchor: string, upload?: unknown) {
  const records = new Map<string, ReplyRecord>();
  const handles = new Map<string, string>();
  let anchorHandle = '';
  const add = (r: ReplyRecord) => {
    if (!/^\d{1,20}$/.test(r.id) || !/^\d{1,20}$/.test(r.authorId)) return;
    const prior = records.get(r.id);
    if (!prior || (!prior.parentId && r.parentId)) records.set(r.id, r);
  };
  function addPart(p: PostPart) {
    if (p.id === anchor && /^\w{1,15}$/.test(p.handle)) anchorHandle = p.handle;
    if (p.authorId) {
      add({ id: p.id, authorId: p.authorId, parentId: p.parentId });
      if (p.handle) handles.set(p.authorId, p.handle);
    }
    if (p.parentId && p.parentAuthorId) add({ id: p.parentId, authorId: p.parentAuthorId });
  }
  for (const row of db.prepare('SELECT content FROM bookmarks WHERE owner=?').all(owner)) {
    const p = JSON.parse(String(row.content)) as Post;
    addPart(p);
    p.context?.thread.forEach(addPart);
    p.context?.quotes.forEach(addPart);
  }
  if (upload !== undefined) {
    if (!upload || typeof upload !== 'object' || !('data' in upload))
      throw Object.assign(Error('Use X API JSON containing data and reply references.'), { status: 400 });
    const extra =
      'includes' in upload && upload.includes && typeof upload.includes === 'object' && 'tweets' in upload.includes
        ? upload.includes.tweets
        : [];
    const rows = [
      ...(Array.isArray(upload.data) ? upload.data : [upload.data]),
      ...(Array.isArray(extra) ? extra : [])
    ];
    for (const r of rows) {
      if (!r || typeof r.id !== 'string' || typeof r.author_id !== 'string') continue;
      const parent = Array.isArray(r.referenced_tweets)
        ? r.referenced_tweets.find(
            (v: unknown) => v && typeof v === 'object' && 'type' in v && v.type === 'replied_to'
          )?.id
        : undefined;
      add({ id: r.id, authorId: r.author_id, parentId: typeof parent === 'string' ? parent : undefined });
      if (typeof parent === 'string' && typeof r.in_reply_to_user_id === 'string')
        add({ id: parent, authorId: r.in_reply_to_user_id });
    }
  }
  const handle = anchorHandle || handles.get(records.get(anchor)?.authorId || '');
  return connectedReplies(anchor, [...records.values()]).map((part) =>
    handle && /^\w{1,15}$/.test(handle) ? { ...part, url: 'https://x.com/' + handle + '/status/' + part.id } : part
  );
}

export function setThreadSelection(db: DatabaseSync, owner: string, id: string, urls: unknown) {
  const b = db.prepare('SELECT seq FROM bookmarks WHERE owner=? AND id=?').get(owner, id);
  if (!b) throw Object.assign(Error('Bookmark not found.'), { status: 404 });
  if (!Array.isArray(urls) || urls.length > 500)
    throw Object.assign(Error('Use at most 500 X post links per selection.'), { status: 400 });
  const parts = new Map<string, string>();
  for (const url of urls) {
    const part = typeof url === 'string' ? xPost(url) : undefined;
    if (!part) throw Object.assign(Error('Only X or Twitter post URLs can be imported.'), { status: 400 });
    if (part.id !== id && !parts.has(part.id)) parts.set(part.id, part.url);
  }
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM thread_selections WHERE book=?').run(b.seq);
    const insert = db.prepare('INSERT INTO thread_selections(book,target,url,position) VALUES(?,?,?,?)');
    let n = 0;
    for (const [target, url] of parts) insert.run(b.seq, target, url, n++);
    db.prepare('INSERT OR IGNORE INTO dirty VALUES(?)').run(b.seq);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return [...parts.values()];
}
