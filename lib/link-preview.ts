import type { DatabaseSync } from 'node:sqlite';
import type { Post, Preview } from '../shared/contracts.ts';
import { shortLink, textLinks, xPost } from '../shared/post-links.ts';

export async function linkPreview(
  db: DatabaseSync,
  owner: string,
  bookmark: string,
  href: string,
  transport: typeof fetch = fetch
): Promise<Preview> {
  const row = db.prepare('SELECT content FROM bookmarks WHERE owner=? AND id=?').get(owner, bookmark);
  if (!row) throw Object.assign(Error('Bookmark not found.'), { status: 404 });
  const post = JSON.parse(String(row.content)) as Post;
  const parts = [post, ...(post.context?.quotes || []), ...(post.context?.thread || [])];
  const allowed = new Map<string, string>();
  for (const part of parts) {
    for (const l of textLinks(part.body)) allowed.set(l.href, l.href);
    for (const l of part.links || []) {
      allowed.set(l.url, l.expanded);
      allowed.set(l.expanded, l.expanded);
    }
    if (part.quoteId) {
      const u = 'https://x.com/i/web/status/' + part.quoteId;
      allowed.set(u, u);
    }
  }
  let url = allowed.get(href);
  if (!url) throw Object.assign(Error('Link not found on this bookmark.'), { status: 404 });
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
      return { kind: 'unavailable', url, message: 'The short link has no public preview.' };
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
  const query = new URLSearchParams({ url: target.url, omit_script: 'true', dnt: 'true' });
  const res = await transport('https://publish.x.com/oembed?' + query, {
    redirect: 'error',
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok)
    return {
      kind: 'unavailable',
      url: target.url,
      message:
        res.status === 403 || res.status === 404
          ? 'X does not offer a public preview for this post.'
          : 'X could not load this preview. Try again later.'
    };
  const data = (await res.json()) as { html?: string; author_name?: string; type?: string };
  if (data.type !== 'rich' || typeof data.html !== 'string')
    return { kind: 'unavailable', url: target.url, message: 'X returned no post preview.' };
  return { kind: 'public', url: target.url, author: data.author_name || 'X post', html: data.html };
}
