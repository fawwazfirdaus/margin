import { recordPreview, reachableLinks } from './linked-sources.ts';
import type { DatabaseSync } from 'node:sqlite';
import type { Post, Preview } from '../shared/contracts.ts';
import { shortLink, xPost } from '../shared/post-links.ts';

export async function linkPreview(
  db: DatabaseSync,
  owner: string,
  bookmark: string,
  href: string,
  transport: typeof fetch = fetch
): Promise<Preview> {
  const row = db.prepare('SELECT seq,content FROM bookmarks WHERE owner=? AND id=?').get(owner, bookmark);
  if (!row) throw Object.assign(Error('Bookmark not found.'), { status: 404 });
  const post = JSON.parse(String(row.content)) as Post;
  const mapped=reachableLinks(db,Number(row.seq),post).get(href);
  if (!mapped) throw Object.assign(Error('Link not found on this bookmark.'), { status: 404 });
  const result = await resolveLink(db, owner, post, href, mapped, transport);
  recordPreview(db, owner, Number(row.seq), href, mapped, result);
  return result;
}
async function resolveLink(
  db: DatabaseSync,
  owner: string,
  post: Post,
  href: string,
  mapped: string,
  transport: typeof fetch
): Promise<Preview> {
  const bookmark = post.id;
  const parts = [post, ...(post.context?.quotes || []), ...(post.context?.thread || [])];
  let url=mapped;
  if (shortLink(url)) {
    // Read only X's redirect. Never fetch an arbitrary destination from the server.
    const res = await transport('https://t.co/' + new URL(url).pathname.slice(1), {
      redirect: 'manual',
      method: 'GET',
      signal: AbortSignal.timeout(8000)
    });
    await res.body?.cancel();
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location)
      return {
        kind: 'unavailable',
        url,
        retryable: res.status === 429 || res.status >= 500,
        message: 'The short link has no public preview.'
      };
    try {
      const dest = new URL(location, url);
      if (!['http:', 'https:'].includes(dest.protocol) || dest.username || dest.password) throw Error();
      url = dest.href;
    } catch {
      return { kind: 'unavailable', url: href, message: 'Could not resolve this short link.' };
    }
  }
  const target = xPost(url);
  if (!target) return { kind: 'external', url: href, message: 'This link opens a website outside the post reader.' };
  if (target.id === bookmark)
    return { kind: 'self', url, message: 'This link points back to the post you’re reading.' };
  const local = db.prepare('SELECT content FROM bookmarks WHERE owner=? AND id=?').get(owner, target.id);
  const known = parts.find((p) => p.id === target.id);
  if (local || known)
    return { kind: 'saved', url: target.url, post: local ? JSON.parse(String(local.content)) : known! };
  // The embed endpoint accepts /i/status/:id even when /i/web/status/:id
  // returns an HTML 404 for the same public post.
  const embedUrl=target.url.replace('https://x.com/i/web/status/','https://x.com/i/status/');
  const query = new URLSearchParams({ url: embedUrl, omit_script: 'true', dnt: 'true' });
  const res = await transport('https://publish.x.com/oembed?' + query, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok)
    return {
      kind: 'unavailable',
      url: target.url,
      retryable: res.status !== 403 && res.status !== 404 && res.status !== 410,
      message:
        res.status === 403 || res.status === 404
          ? 'X does not offer a public preview for this post.'
          : 'X could not load this preview. Try again later.'
    };
  const data = (await res.json()) as { html?: string; url?:string; author_name?: string; type?: string };
  if (data.type !== 'rich' || typeof data.html !== 'string')
    return { kind: 'unavailable', url: target.url, message: 'X returned no post preview.' };
  const canonical=data.url && xPost(data.url);
  return { kind: 'public', url: canonical && canonical.id===target.id ? canonical.url : target.url, author: data.author_name || 'X post', html: data.html };
}

// Small resumable batches use only URLs present on this owner's bookmarks.
async function scanBatch(db: DatabaseSync, owner: string, includeShort: boolean, transport: typeof fetch = fetch) {
  const filter = includeShort ? '' : " AND l.href NOT LIKE 'https://t.co/%' AND l.href NOT LIKE 'http://t.co/%'";
  const scope =
    " FROM linked_sources l JOIN bookmarks b ON b.seq=l.book WHERE b.owner=? AND l.status='pending'" + filter;
  const jobs = db.prepare('SELECT l.lid,l.href,b.id' + scope + ' ORDER BY l.lid LIMIT 12').all(owner);
  let checked = 0,
    indexed = 0,
    paused = false;
  async function processJob(job: (typeof jobs)[number]) {
    try {
      const result = await linkPreview(db, owner, String(job.id), String(job.href), transport);
      checked++;
      const row = db.prepare('SELECT status FROM linked_sources WHERE lid=?').get(job.lid);
      if (row?.status === 'indexed') indexed++;
      if (result.kind === 'unavailable' && result.retryable) {
        paused = true;
      }
    } catch {
      db.prepare("UPDATE linked_sources SET status='failed' WHERE lid=? AND status='pending'").run(job.lid);
      checked++;
    }
  }
  for(let i=0;i<jobs.length&&!paused;i+=3){
    await Promise.all(jobs.slice(i,i+3).map(processJob));
  }
  return { checked, indexed, remaining: Number(db.prepare('SELECT count(*) n' + scope).get(owner)?.n), paused };
}

const activeScans = new WeakMap<DatabaseSync, Set<string>>();
export async function scanLinkedPosts(
  db: DatabaseSync,
  owner: string,
  includeShort: boolean,
  transport: typeof fetch = fetch
) {
  const active = activeScans.get(db) ?? new Set<string>();
  if (active.has(owner))
    throw Object.assign(Error('Link indexing is already running. Try again shortly.'), { status: 409 });
  activeScans.set(db, active);
  active.add(owner);
  try {
    return await scanBatch(db, owner, includeShort, transport);
  } finally {
    active.delete(owner);
  }
}

// Direct post links can be indexed without browsing arbitrary short-link destinations.
export function directLinkWorker(db: DatabaseSync) {
  let running = false,
    backoffUntil = 0;
  const timer = setInterval(async () => {
    if (running || Date.now() < backoffUntil) return;
    running = true;
    try {
      const next = db
        .prepare(
          `SELECT b.owner FROM linked_sources l JOIN bookmarks b ON b.seq=l.book
        WHERE l.status='pending' AND l.href LIKE 'https://x.com/%' ORDER BY lid LIMIT 1`
        )
        .get();
      if (next && (await scanLinkedPosts(db, String(next.owner), false)).paused) backoffUntil = Date.now() + 60000;
    } catch {
      backoffUntil = Date.now() + 60000;
    } finally {
      running = false;
    }
  }, 10000);
  timer.unref();
  return () => clearInterval(timer);
}
