import { articleSections } from '../shared/articles.ts';
import { withPublicThread } from './public-unroll.ts';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Bookmark, Post } from '../shared/contracts.ts';
import type { Evidence, Filters, Hit, Results, SearchSpec } from '../shared/discovery.ts';
import { embedModel } from './models.ts';
import { syncText } from './index-store.ts';

export function filters(value: unknown): Filters {
  if (!value || typeof value !== 'object') return {};
  const v = value as Record<string, unknown>,
    f: Filters = {};
  if (v.state === 'kept' || v.state === 'archive' || v.state === 'inbox') f.state = v.state;
  if (v.media === 'photo' || v.media === 'video' || v.media === 'text') f.media = v.media;
  for (const k of ['author', 'tag'] as const)
    if (typeof v[k] === 'string' && v[k].trim()) f[k] = v[k].trim().toLowerCase().slice(0, 150);
  if (f.author) f.author = f.author.replace(/^@/, '');
  for (const k of ['before', 'after'] as const)
    if (typeof v[k] === 'string' && /^\d{4}-\d\d-\d\d$/.test(v[k])) f[k] = v[k];
  if (typeof v.collection === 'number' && Number.isSafeInteger(v.collection) && v.collection > 0)
    f.collection = v.collection;
  return f;
}

function scope(owner: string, f: Filters) {
  const conditions = ['b.owner=?'],
    args: SQLInputValue[] = [owner];
  function add(sql: string, v: SQLInputValue) {
    conditions.push(sql);
    args.push(v);
  }
  if (f.state) add('b.state=?', f.state);
  if (f.author) add("lower(json_extract(b.content,'$.handle'))=?", f.author);
  if (f.tag) add('EXISTS(SELECT 1 FROM json_each(b.tags) WHERE value=?)', f.tag);
  if (f.collection)
    add(
      'EXISTS(SELECT 1 FROM members m JOIN collections c ON c.id=m.collection WHERE m.book=b.seq AND c.owner=b.owner AND c.id=?)',
      f.collection
    );
  if (f.after) add("substr(json_extract(b.content,'$.date'),1,10)>=?", f.after);
  if (f.before) add("substr(json_extract(b.content,'$.date'),1,10) BETWEEN '0001' AND ?", f.before);
  const attachments = "json_each(b.content,'$.media')";
  if (f.media === 'text') conditions.push("json_array_length(b.content,'$.media')=0");
  if (f.media === 'video')
    conditions.push(
      `EXISTS(SELECT 1 FROM ${attachments} WHERE json_extract(value,'$.type') IN ('animated_gif','video'))`
    );
  if (f.media === 'photo')
    conditions.push(`EXISTS(SELECT 1 FROM ${attachments} WHERE json_extract(value,'$.type')='photo')`);
  return { where: conditions.join(' AND '), args };
}

export function matchingTerms(q: string) {
  return Array.from(new Set(q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []))
    .filter(
      (t) =>
        ![
          'what',
          'which',
          'how',
          'the',
          'that',
          'with',
          'about',
          'from',
          'and',
          'for',
          'are',
          'my',
          'of',
          'in',
          'to',
          'a',
          'i',
          'is'
        ].includes(t)
    )
    .slice(0, 25);
}

function excerpt(body: string, terms: string[]) {
  const pos = terms.map((t) => body.toLowerCase().indexOf(t)).filter((i) => i >= 0);
  const start = pos.length ? Math.max(0, Math.min(...pos) - 55) : 0;
  return (start ? '…' : '') + body.slice(start, start + 380) + (body.length > start + 380 ? '…' : '');
}

export async function search(
  db: DatabaseSync,
  owner: string,
  spec: SearchSpec,
  offset: number,
  limit: number,
  embedding: (q: string) => Promise<number[] | undefined>,
  evidenceMode?: { within?: Set<string> }
): Promise<Results> {
  syncText(db);
  const q = spec.q.trim().slice(0, 600);
  const handle = q.match(/(?:^|\s)@(\w{1,15})(?=\s|$)/);
  const f = { ...spec.filters, ...(handle ? { author: handle[1].toLowerCase() } : {}) };
  const scoped = scope(owner, f);
  const where = evidenceMode?.within ? scoped.where + ' AND b.id IN (SELECT value FROM json_each(?))' : scoped.where;
  const args = evidenceMode?.within ? [...scoped.args, JSON.stringify([...evidenceMode.within])] : scoped.args;
  const text = (handle ? q.replace(handle[0], ' ') : q).trim();
  const base = db
    .prepare('SELECT b.seq,b.id,b.content,b.state FROM bookmarks b WHERE ' + where + ' ORDER BY b.seq')
    .all(...args);
  const books = new Map(base.map(b => [Number(b.seq), b]));
  const terms = matchingTerms(text);
  function hit(seq: number, e?: Evidence): Hit {
    const row = books.get(seq)!,
      p = JSON.parse(String(row.content)) as Post,
      m = p.media[0];
    const detailed = e && (e.source === 'thread' || e.source === 'quote' || e.source === 'article' || e.postId && e.source === 'image')
      ? withPublicThread(db,seq,p) : p;
    const context = detailed.context;
    if (e?.source === 'article') {
      const a = articleSections(detailed)[e.slot];
      if (a) e = { ...e, postId: a.postId, author: a.author, paragraph: a.paragraph };
    }
    if (e?.source === 'image' && e.postId) {
      const sourceId = e.postId;
      const part = [...(context?.thread || []), ...(context?.quotes || [])].find(part => part.id === sourceId);
      if (part) e = { ...e, author: part.author };
    }
    const related=e?.source==='quote'?context?.quotes[e.slot]:e?.source==='thread'?context?.thread[e.slot]:undefined;
    if(e && related)e={...e,author:related.author,postId:related.id};
    return {
      id: p.id,
      author: p.author,
      handle: p.handle,
      date: p.date,
      state: row.state as Bookmark['state'],
      preview: m?.type === 'photo' ? m.src : m?.poster,
      evidence: e || { source: 'post', slot: -1, text: excerpt(p.body, terms) },
      terms
    };
  }
  if (!text)
    return {
      hits: [...books.keys()].slice(offset, offset + limit).map((b) => hit(b)),
      total: books.size,
      semantic: false
    };
  if (!books.size) return { hits: [], total: 0, semantic: false };
  const strict = [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase());
  const words = terms.length ? terms : text.match(/[\p{L}\p{N}_]+/gu) || [];
  const lexical = words.length
    ? db
        .prepare(
          `SELECT p.pid FROM phrases JOIN passages p ON p.pid=phrases.rowid
    JOIN bookmarks b ON b.seq=p.book WHERE phrases MATCH ? AND ${where} ORDER BY bm25(phrases),p.pid`
        )
        .all(words.map((t) => '"' + t + '"').join(' OR '), ...args)
    : [];
  const query =
    !strict.length &&
    db
      .prepare('SELECT 1 FROM passages p JOIN bookmarks b ON b.seq=p.book WHERE b.owner=? AND p.model=? LIMIT 1')
      .get(owner, embedModel)
      ? await embedding(text)
      : undefined;
  const rows = db
    .prepare(
      `SELECT p.pid,p.book,p.source,p.slot,p.body,p.model,${query ? 'p.vector' : 'NULL'} AS vector,f.post_id AS photoPost,f.attachment,l.target AS linkedId,l.author AS linkedAuthor FROM passages p
    LEFT JOIN photos f ON p.source='image' AND p.book=f.book AND p.slot=f.slot
    LEFT JOIN linked_sources l ON p.source IN ('linked','selected') AND p.slot=l.lid AND p.book=l.book
    JOIN bookmarks b ON b.seq=p.book WHERE ${where}`
    )
    .all(...args);
  const order = new Map(lexical.map((r, i) => [Number(r.pid), i]));
  const scores = new Map<number, number>();
  const semantic: { pid: number; score: number }[] = [];
  for (const row of rows) {
    if (!books.has(Number(row.book))) continue;
    const body = String(row.body).toLowerCase(),
      pid = Number(row.pid);
    if (strict.some((phrase) => !body.includes(phrase))) continue;
    const rank = order.get(pid);
    if (rank !== undefined) scores.set(pid, 1 / (40 + rank));
    if (body.includes(text.replaceAll('"', '').toLowerCase())) scores.set(pid, (scores.get(pid) || 0) + 0.05);
    if (
      query &&
      row.model === embedModel &&
      row.vector instanceof Uint8Array &&
      row.vector.byteLength === query.length * 4
    ) {
      const bytes = Buffer.from(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
      let dot = 0;
      for (let i = 0; i < query.length; i++) dot += bytes.readFloatLE(i * 4) * query[i];
      if (dot >= 0.34) semantic.push({ pid, score: dot });
    }
  }
  semantic
    .sort((a, b) => b.score - a.score)
    .forEach(({ pid }, i) => scores.set(pid, (scores.get(pid) || 0) + 1 / (40 + i)));
  const winners = new Map<string, { book: number; score: number; e: Evidence }>();
  for (const row of rows) {
    const b = Number(row.book),
      score = scores.get(Number(row.pid));
    const key = evidenceMode ? [b, row.source, row.slot].join('/') : String(b);
    if (books.has(b) && score !== undefined && (!winners.has(key) || score > winners.get(key)!.score)) {
      winners.set(key, {
        book: b,
        score,
        e: {
          source: row.source as Evidence['source'],
          ...(row.linkedId?{postId:String(row.linkedId),author:String(row.linkedAuthor)}:{}),
          ...(row.photoPost ? {postId: String(row.photoPost), attachment: Number(row.attachment)} : {}),
          slot: Number(row.slot),
          text: evidenceMode ? String(row.body) : excerpt(String(row.body), terms)
        }
      });
    }
  }
  const ranked = [...winners.values()].sort((a, b) => b.score - a.score || a.book - b.book);
  if (evidenceMode) {
    const seen = new Set<string>(), hits: Hit[] = [];
    for (const row of ranked) {
      const h = hit(row.book, row.e), e = h.evidence;
      // One post can appear under multiple bookmarks. Keep distinct article paragraphs and images.
      const id = e.postId || h.id;
      const key = e.source === 'article' ? id + '/article/' + e.paragraph :
        e.source === 'image' || e.source === 'alt' ? id + '/' + e.source + '/' + (e.attachment ?? e.slot) : id;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(h);
      if (hits.length >= limit) break;
    }
    return { hits, total: hits.length, semantic: Boolean(query) };
  }
  return {
    hits: ranked.slice(offset, offset + limit).map(r => hit(r.book, r.e)),
    total: ranked.length,
    semantic: Boolean(query)
  };
}
