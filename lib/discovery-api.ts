import { startThreads, threadProgress, threadWorker } from './thread-jobs.ts';
import {unrollBookmark} from './public-unroll.ts';
import { localThread,setThreadSelection } from './free-thread.ts';
import { directLinkWorker, scanLinkedPosts } from './link-preview.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import type { Catalog, Coverage, SearchSpec, WordBox } from '../shared/discovery.ts';
import { pendingPhotos, readPost, syncText } from './index-store.ts';
import { askProvider, embedModel, hostedAvailable, indexWorker } from './models.ts';
import { answer } from './answers.ts';
import { filters, search } from './search.ts';

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });
export async function jsonBody(req: IncomingMessage, limit = 10000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.from(part);
    size += chunk.length;
    if (size > limit) throw fail(413, 'Request too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw fail(400, 'Invalid JSON.');
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'Expected an object.');
  return value as Record<string, unknown>;
}
function specification(v: Record<string, unknown>): SearchSpec {
  return { q: typeof v.q === 'string' ? v.q.trim().slice(0, 600) : '', filters: filters(v.filters) };
}
function title(value: unknown) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 80)
    throw fail(400, 'Use a name of 1–80 characters.');
  return value.trim();
}

export function discovery(db: DatabaseSync, live: boolean) {
  const stopThreads=live?threadWorker(db):undefined;
  const stopLinks=live?directLinkWorker(db):undefined;
  const worker = live ? indexWorker(db) : undefined;
  const queryVector = worker?.query || (async () => undefined);
  async function dispatch(req: IncomingMessage, res: ServerResponse, owner: string, path: string, url: URL) {
    const send = (v: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(v));
    };
    const get = req.method === 'GET',
      post = req.method === 'POST';
    syncText(db);
    if (get && path === '/api/discover/catalog') {
      const counts = db.prepare('SELECT state,count(*) n FROM bookmarks WHERE owner=? GROUP BY state').all(owner);
      const count = (s: string) => Number(counts.find((r) => r.state === s)?.n || 0);
      const c: Catalog = {
        all: counts.reduce((a, r) => a + Number(r.n), 0),
        inbox: count('inbox'),
        kept: count('kept'),
        archive: count('archive'),
        collections: db
          .prepare(
            'SELECT c.id,c.name,count(m.book) count FROM collections c LEFT JOIN members m ON m.collection=c.id WHERE owner=? GROUP BY c.id ORDER BY c.name'
          )
          .all(owner) as unknown as Catalog['collections'],
        searches: db
          .prepare('SELECT * FROM searches WHERE owner=? ORDER BY name')
          .all(owner)
          .map((r) => ({ ...JSON.parse(String(r.spec)), id: r.id, name: r.name })),
        authors: db
          .prepare(
            "SELECT DISTINCT json_extract(content,'$.handle') handle FROM bookmarks WHERE owner=? ORDER BY handle COLLATE NOCASE"
          )
          .all(owner)
          .map((r) => String(r.handle))
          .filter(Boolean),
        tags: db
          .prepare('SELECT DISTINCT t.value FROM bookmarks b,json_each(b.tags) t WHERE owner=? ORDER BY t.value')
          .all(owner)
          .map((r) => String(r.value))
      };
      return send(c);
    }
    if(post && path==='/api/discover/thread-index'){
      if(owner.startsWith('demo-'))throw fail(400,'Connect your library first.');
      const v=object(await jsonBody(req));
      if(v.action==='pause')db.prepare('UPDATE thread_runs SET active=0,paused=1 WHERE owner=?').run(owner);
      else if(v.action==='start'||v.action==='retry')startThreads(db,owner,v.action==='retry');
      else throw fail(400,'Unknown thread index action.');
      return send(threadProgress(db,owner));
    }
    if(post && path==='/api/discover/unroll'){
      const v=object(await jsonBody(req));
      const result=await unrollBookmark(db,owner,String(v.id||''));
      syncText(db);
      return send(result);
    }
    if(post && path==='/api/discover/thread-parts'){
      const v=object(await jsonBody(req,2_000_000)),id=String(v.id||'');
      if(!db.prepare('SELECT 1 FROM bookmarks WHERE owner=? AND id=?').get(owner,id))throw fail(404,'Bookmark not found.');
      if(v.mode==='discover')return send({parts:localThread(db,owner,id,v.replyData)});
      const parts=setThreadSelection(db,owner,id,v.urls);syncText(db);
      return send({queued:parts.length});
    }
    if(post && path==='/api/discover/index-links') {
      const v=object(await jsonBody(req));
      return send(await scanLinkedPosts(db,owner,v.includeShort===true));
    }
    if(post && path==='/api/discover/retry-links') {
      db.prepare("UPDATE linked_sources SET status='pending' WHERE status='failed' AND book IN(SELECT seq FROM bookmarks WHERE owner=?)").run(owner);
      return send({ok:true});
    }
    if (get && path === '/api/discover/status') {
      const counts = db
        .prepare(
          'SELECT status,count(*) n FROM photos JOIN bookmarks b ON b.seq=book WHERE b.owner=? GROUP BY status'
        )
        .all(owner);
      const n = (s: string) => Number(counts.find((r) => r.status === s)?.n || 0);
      const em = db
        .prepare(
          'SELECT count(*) n,count(CASE WHEN p.model=? AND vector IS NOT NULL THEN 1 END) ready FROM passages p JOIN bookmarks b ON b.seq=p.book WHERE owner=?'
        )
        .get(embedModel, owner)!;
      const linkCounts=db.prepare(`SELECT l.status,count(*) n FROM linked_sources l JOIN bookmarks b ON b.seq=l.book
        WHERE b.owner=? GROUP BY l.status`).all(owner);
      const linkCount=(status:string)=>Number(linkCounts.find(r=>r.status===status)?.n??0);
      return send({
        threads: threadProgress(db,owner),
        links: {indexed:linkCount('indexed'),pending:linkCount('pending'),failed:linkCount('failed'),
          skipped:linkCount('skipped'),unavailable:linkCount('unavailable')},
        total: counts.reduce((sum, r) => sum + Number(r.n), 0),
        ready: n('ready'),
        empty: n('empty'),
        failed: n('failed'),
        passages: Number(em.n),
        embedded: Number(em.ready),
        modelError: worker?.error() || '',
        hosted: hostedAvailable(),embeddingProvider:embedModel,askProvider
      } satisfies Coverage & { hosted: boolean; embeddingProvider:string; askProvider:string });
    }
    if (post && path === '/api/discover/search') {
      const v = object(await jsonBody(req));
      return send(
        await search(db, owner, specification(v), Math.max(0, Math.floor(Number(v.offset) || 0)), 50, queryVector)
      );
    }
    if (get && path === '/api/discover/post') return send(readPost(db, owner, url.searchParams.get('id') || ''));
    if (post && path === '/api/discover/collections') {
      const name = title(object(await jsonBody(req)).name);
      db.prepare('INSERT INTO collections(owner,name) VALUES(?,?) ON CONFLICT DO NOTHING').run(owner, name);
      return send(db.prepare('SELECT id,name FROM collections WHERE owner=? AND name=?').get(owner, name));
    }
    if (post && path === '/api/discover/membership') {
      const v = object(await jsonBody(req)),
        c = db.prepare('SELECT id FROM collections WHERE owner=? AND id=?').get(owner, Number(v.collection));
      const b = db.prepare('SELECT seq FROM bookmarks WHERE owner=? AND id=?').get(owner, String(v.id));
      if (!c || !b) throw fail(404, 'Bookmark or collection not found.');
      if (v.member === true) db.prepare('INSERT OR IGNORE INTO members VALUES(?,?)').run(c.id, b.seq);
      else if (v.member === false) db.prepare('DELETE FROM members WHERE collection=? AND book=?').run(c.id, b.seq);
      else throw fail(400, 'Choose a membership state.');
      return send({ ok: true });
    }
    if (post && path === '/api/discover/saved') {
      const v = object(await jsonBody(req)),
        name = title(v.name);
      db.prepare(
        'INSERT INTO searches(owner,name,spec) VALUES(?,?,?) ON CONFLICT(owner,name) DO UPDATE SET spec=excluded.spec'
      ).run(owner, name, JSON.stringify(specification(v)));
      return send({ ok: true });
    }
    if (req.method === 'DELETE' && ['/api/discover/saved', '/api/discover/collections'].includes(path)) {
      const table = path.endsWith('saved') ? 'searches' : 'collections';
      db.prepare('DELETE FROM ' + table + ' WHERE owner=? AND id=?').run(owner, Number(url.searchParams.get('id')));
      return send({ ok: true });
    }
    if (get && path === '/api/discover/jobs') return send(pendingPhotos(db, owner, 10));
    if (post && path === '/api/discover/retry') {
      db.prepare(
        "UPDATE photos SET status='pending' WHERE status='failed' AND book IN(SELECT seq FROM bookmarks WHERE owner=?)"
      ).run(owner);
      return send({ ok: true });
    }
    if (get && path === '/api/discover/image') {
      const p = db
        .prepare('SELECT src FROM photos JOIN bookmarks b ON book=b.seq WHERE owner=? AND b.id=? AND slot=?')
        .get(owner, url.searchParams.get('id') || '', Number(url.searchParams.get('slot')));
      if (!p) throw fail(404, 'Image no longer in library.');
      const src = String(p.src);
      if (['/media/tide.jpg', '/media/shore.jpg', '/media/drift.jpg', '/media/field-note.png'].includes(src)) {
        res.setHeader('Content-Type', src.endsWith('.png') ? 'image/png' : 'image/jpeg');
        return res.end(await readFile(new URL('../public' + src, import.meta.url)));
      }
      const media = new URL(src);
      if (
        media.origin !== 'https://pbs.twimg.com' ||
        media.username ||
        media.password ||
        !media.pathname.startsWith('/media/')
      )
        throw fail(400, 'Unsupported image source.');
      const upstream = await fetch(media, { redirect: 'error', signal: AbortSignal.timeout(20000) });
      const type = upstream.headers.get('content-type')?.split(';')[0] || '';
      if (!upstream.ok || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type) || !upstream.body)
        throw fail(422, 'Source image unavailable.');
      const parts: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > 20_000_000) throw fail(413, 'Source image too large.');
        parts.push(chunk);
      }
      res.setHeader('Content-Type', type);
      return res.end(Buffer.concat(parts));
    }
    if (post && path === '/api/discover/ocr-cache') {
      const v = object(await jsonBody(req));
      const cached = db
        .prepare(
          `SELECT p.body,p.words FROM photos p JOIN bookmarks b ON b.seq=p.book
        WHERE b.owner=? AND p.digest=? AND status IN ('ready','empty') LIMIT 1`
        )
        .get(owner, String(v.digest));
      return send(cached ? { text: cached.body, words: JSON.parse(String(cached.words)) } : null);
    }
    if (post && path === '/api/discover/ocr') {
      const v = object(await jsonBody(req, 3_000_000));
      const photo = db
        .prepare('SELECT p.src FROM photos p JOIN bookmarks b ON b.seq=p.book WHERE owner=? AND b.id=? AND p.slot=?')
        .get(owner, String(v.id), Number(v.slot));
      if (!photo || photo.src !== v.src) throw fail(409, 'Image changed. Refresh the queue.');
      const text = typeof v.text === 'string' ? v.text.trim().slice(0, 100000) : '';
      const words = Array.isArray(v.words)
        ? v.words
            .slice(0, 20000)
            .filter(
              (w): w is WordBox =>
                Array.isArray(w) &&
                w.length === 5 &&
                typeof w[0] === 'string' &&
                w[0].length <= 300 &&
                w.slice(1).every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1)
            )
        : [];
      const digest = typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest) ? v.digest : null;
      const status = v.failed === true ? 'failed' : text ? 'ready' : 'empty';
      db.exec('BEGIN');
      try {
        const updated = db
          .prepare(
            `UPDATE photos SET status=?,body=?,words=?,digest=? WHERE src=? AND status='pending' AND book IN(SELECT seq FROM bookmarks WHERE owner=?) RETURNING book`
          )
          .all(status, text, JSON.stringify(words), digest, photo.src, owner);
        const dirty = db.prepare('INSERT OR IGNORE INTO dirty VALUES(?)');
        updated.forEach((r) => dirty.run(r.book));
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      return send({ ok: true });
    }
    if (post && path === '/api/discover/ask') {
      const v = object(await jsonBody(req)),
        spec = specification(v),
        question = String(v.question || '')
          .trim()
          .slice(0, 600);
      if (!question) throw fail(400, 'Enter a question.');
      const a = await answer(db, owner, spec, question, v.hosted === true, queryVector);
      return send(a);
    }
    throw fail(404, 'Unknown library action.');
  }
  return { dispatch, close: () => {stopThreads?.();stopLinks?.();worker?.stop();} };
}
