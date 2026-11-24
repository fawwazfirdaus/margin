import type { DatabaseSync } from 'node:sqlite';
import type { MediaAttachment, Post, PostPart } from '../shared/contracts.ts';
import { connectedReplies } from '../shared/free-thread.ts';

const snowflake = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}$/.test(v);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const fail = (status: number, message: string) => Object.assign(Error(message), { status });
const unavailableCodes = new Set([401, 403, 404, 410]);

function retryDelay(header: string | null) {
  if (!header) return 0;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
}

function mediaUrl(value: unknown, host: string): string | undefined {
  if (typeof value !== 'string') return;
  try {
    const u = new URL(value);
    if (u.protocol === 'https:' && u.hostname === host && !u.username && !u.password && !u.port) return u.href;
  } catch {}
}
function attachments(value: unknown): MediaAttachment[] {
  const media = obj(value);
  const items = Array.isArray(media.all)
    ? media.all
    : [...(Array.isArray(media.photos) ? media.photos : []), ...(Array.isArray(media.videos) ? media.videos : [])];
  const result: MediaAttachment[] = [];
  for (const item of items) {
    const m = obj(item),
      alt = typeof m.altText === 'string' ? m.altText : '';
    if (m.type === 'photo') {
      const src = mediaUrl(m.url, 'pbs.twimg.com');
      if (src) result.push({ type: 'photo', src, alt });
    } else if (m.type === 'video' || m.type === 'gif') {
      const variants = Array.isArray(m.formats) ? m.formats.map(obj) : [];
      const mp4 = variants
        .filter((v) => v.container === 'mp4' && mediaUrl(v.url, 'video.twimg.com'))
        .sort((a, b) => Number(b.bitrate || 0) - Number(a.bitrate || 0))[0];
      const direct = mediaUrl(m.url, 'video.twimg.com');
      result.push({
        type: m.type === 'gif' ? 'animated_gif' : 'video',
        src: mediaUrl(mp4?.url, 'video.twimg.com') || (direct && /\.mp4(?:\?|$)/i.test(direct) ? direct : undefined),
        poster: mediaUrl(m.thumbnail_url, 'pbs.twimg.com'),
        alt
      });
    }
  }
  return result;
}
function asPart(value: unknown): PostPart | undefined {
  const p = obj(value),
    author = obj(p.author),
    parent = obj(p.replying_to).status;
  if (
    p.type !== 'status' ||
    p.provider !== 'twitter' ||
    !snowflake(p.id) ||
    !snowflake(author.id) ||
    author.protected === true ||
    typeof author.screen_name !== 'string' ||
    !/^\w{1,15}$/.test(author.screen_name) ||
    typeof p.text !== 'string'
  )
    return;
  const date =
    typeof p.created_timestamp === 'number' ? new Date(p.created_timestamp * 1000) : new Date(String(p.created_at));
  return {
    id: p.id,
    authorId: author.id,
    handle: author.screen_name,
    author: typeof author.name === 'string' ? author.name : author.screen_name,
    date: Number.isFinite(date.getTime()) ? date.toISOString() : '',
    body: p.text,
    media: attachments(p.media),
    parentId: snowflake(parent) ? parent : undefined
  };
}

export async function unrollBookmark(db: DatabaseSync, owner: string, id: string, transport: typeof fetch = fetch) {
  if (!snowflake(id)) throw fail(400, 'Choose a real X bookmark to unroll.');
  const before = db.prepare('SELECT seq FROM bookmarks WHERE owner=? AND id=?').get(owner, id);
  if (!before) throw fail(404, 'Bookmark not found.');
  let response: Response;
  try {
    response = await transport('https://api.fxtwitter.com/2/thread/' + id, {
      headers: { Accept: 'application/json', 'User-Agent': 'Margin/1.0 (public thread reader)' },
      redirect: 'error',
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw fail(502, 'FxEmbed could not be reached. Try again later.');
  }
  if (!response.ok) {
    const code = response.status;
    const unavailable = unavailableCodes.has(code);
    const message = unavailable ? 'FxEmbed could not return this public post.' : `FxEmbed returned HTTP ${code}. Try again later.`;
    throw Object.assign(fail(code === 429 ? 429 : 502, message), {
      unavailable,
      retryAfterMs: retryDelay(response.headers.get('retry-after'))
    });
  }
  const data = obj(await response.json()), anchor = asPart(data.status);
  const status = obj(data.status);
  if (!anchor && (unavailableCodes.has(Number(data.code)) || status.type === 'tombstone' || obj(status.author).protected === true))
    throw Object.assign(fail(502, 'FxEmbed could not return this public post.'), { unavailable: true });
  if (data.code !== 200 || anchor?.id !== id || (data.thread !== null && !Array.isArray(data.thread)))
    throw fail(502, 'FxEmbed returned an unavailable or incomplete thread response.');
  const nodes = new Map<string, PostPart>();
  for (const raw of data.thread || []) {
    const part = asPart(raw);
    if (part) nodes.set(part.id, part);
  }
  nodes.set(id, anchor);
  const chain = connectedReplies(
    id,
    [...nodes.values()].map((p) => ({ id: p.id, authorId: p.authorId!, parentId: p.parentId }))
  ).map((ref) => nodes.get(ref.id)!);
  const fetchedAt = new Date().toISOString();
  db.exec('BEGIN');
  try {
    const row = db.prepare('SELECT seq FROM bookmarks WHERE seq=? AND owner=? AND id=?').get(before.seq, owner, id);
    if (!row) throw fail(404, 'Bookmark removed during lookup.');
    db.prepare(
      `INSERT INTO public_unrolls(book,parts,fetched_at,focal) VALUES(?,?,?,?)
      ON CONFLICT(book) DO UPDATE SET parts=excluded.parts,fetched_at=excluded.fetched_at,focal=excluded.focal`
    ).run(row.seq, JSON.stringify(chain), fetchedAt, JSON.stringify(anchor));
    db.prepare('DELETE FROM thread_jobs WHERE book=?').run(row.seq);
    db.prepare('INSERT OR IGNORE INTO dirty VALUES(?)').run(row.seq);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { related: chain.length, fetchedAt };
}

// Keep a provider refresh separate from X sync and manual selections. Use the same
// merged ordering for indexing, rendering and resolving citations.
export function withPublicThread(db: DatabaseSync, book: number, post: Post): Post {
  const row = db.prepare('SELECT parts,fetched_at,focal FROM public_unrolls WHERE book=?').get(book);
  if (!row) return post;
  const parts = JSON.parse(String(row.parts)) as PostPart[];
  const focal = row.focal ? JSON.parse(String(row.focal)) as PostPart : undefined;
  const thread = new Map(parts.map((p) => [p.id, p]));
  for (const p of post.context?.thread || []) thread.set(p.id, p);
  return {
    ...post,
    // Timeline imports often saved a shortened or empty caption.
    body: focal && focal.body.length > post.body.length ? focal.body : post.body,
    context: {
      ...post.context,
      quotes: post.context?.quotes || [],
      thread: [...thread.values()].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id)),
      unroll: { related: parts.length, fetchedAt: String(row.fetched_at) }
    }
  };
}
