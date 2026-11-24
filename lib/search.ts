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
  embedding: (q: string) => Promise<number[] | undefined>
): Promise<Results> {
  syncText(db);
  const q = spec.q.trim().slice(0, 600);
  const handle = q.match(/(?:^|\s)@(\w{1,15})(?=\s|$)/);
  const f = { ...spec.filters, ...(handle ? { author: handle[1].toLowerCase() } : {}) };
  const { where, args } = scope(owner, f);
  const text = (handle ? q.replace(handle[0], ' ') : q).trim();
  const base = db
    .prepare('SELECT b.seq,b.content,b.state FROM bookmarks b WHERE ' + where + ' ORDER BY b.seq')
    .all(...args);
  const books = new Map(base.map((b) => [Number(b.seq), b]));
  const terms = matchingTerms(text);
  function hit(seq: number, e?: Evidence): Hit {
    const row = books.get(seq)!,
      p = JSON.parse(String(row.content)) as Post,
      m = p.media[0];
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
      total: base.length,
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
      `SELECT p.pid,p.book,p.source,p.slot,p.body,p.model,p.vector FROM passages p
    JOIN bookmarks b ON b.seq=p.book WHERE ${where}`
    )
    .all(...args);
  const order = new Map(lexical.map((r, i) => [Number(r.pid), i]));
  const scores = new Map<number, number>();
  const semantic: { pid: number; score: number }[] = [];
  for (const row of rows) {
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
      const bytes = Buffer.from(row.vector);
      let dot = 0;
      for (let i = 0; i < query.length; i++) dot += bytes.readFloatLE(i * 4) * query[i];
      if (dot >= 0.34) semantic.push({ pid, score: dot });
    }
  }
  semantic
    .sort((a, b) => b.score - a.score)
    .forEach(({ pid }, i) => scores.set(pid, (scores.get(pid) || 0) + 1 / (40 + i)));
  const winners = new Map<number, { score: number; e: Evidence }>();
  for (const row of rows) {
    const b = Number(row.book),
      score = scores.get(Number(row.pid));
    if (books.has(b) && score !== undefined && (!winners.has(b) || score > winners.get(b)!.score)) {
      winners.set(b, {
        score,
        e: {
          source: row.source as Evidence['source'],
          slot: Number(row.slot),
          text: excerpt(String(row.body), terms)
        }
      });
    }
  }
  const ranked = [...winners].sort((a, b) => b[1].score - a[1].score || a[0] - b[0]);
  return {
    hits: ranked.slice(offset, offset + limit).map(([b, r]) => hit(b, r.e)),
    total: ranked.length,
    semantic: Boolean(query)
  };
}
