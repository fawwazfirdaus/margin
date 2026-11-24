import type { DatabaseSync } from 'node:sqlite';
import { unrollBookmark } from './public-unroll.ts';

export function startThreads(db: DatabaseSync, owner: string, retry = false) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO thread_jobs(book) SELECT b.seq FROM bookmarks b LEFT JOIN public_unrolls u ON u.book=b.seq
      WHERE owner=? AND id<>'' AND id NOT GLOB '*[^0-9]*' AND u.book IS NULL ON CONFLICT DO NOTHING`
    ).run(owner);
    if (retry)
      db.prepare(
        "UPDATE thread_jobs SET state='waiting',attempts=0,ready=0,reason=NULL WHERE state='failed' AND book IN(SELECT seq FROM bookmarks WHERE owner=?)"
      ).run(owner);
    db.prepare('INSERT INTO thread_runs(owner,active) VALUES(?,1) ON CONFLICT(owner) DO UPDATE SET active=1').run(
      owner
    );
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function threadProgress(db: DatabaseSync, owner: string) {
  const rows = db
    .prepare(
      'SELECT j.state,count(*) n FROM thread_jobs j JOIN bookmarks b ON b.seq=j.book WHERE b.owner=? GROUP BY j.state'
    )
    .all(owner);
  const n = (state: string) => Number(rows.find((r) => r.state === state)?.n || 0);
  const saved = db
    .prepare(
      `SELECT count(*) checked,count(CASE WHEN json_array_length(parts)>0 THEN 1 END) threads
    FROM public_unrolls u JOIN bookmarks b ON b.seq=u.book WHERE b.owner=?`
    )
    .get(owner)!;
  return {
    active: Boolean(db.prepare('SELECT active FROM thread_runs WHERE owner=?').get(owner)?.active),
    waiting: n('waiting'),
    unavailable: n('unavailable'),
    failed: n('failed'),
    checked: Number(saved.checked),
    threads: Number(saved.threads)
  };
}

export async function threadStep(db: DatabaseSync, transport: typeof fetch = fetch): Promise<boolean> {
  const now = Date.now();
  const claim = db
    .prepare(
      `UPDATE thread_jobs SET ready=?, attempts=attempts+1 WHERE book=(
    SELECT j.book FROM thread_jobs j JOIN bookmarks b ON b.seq=j.book JOIN thread_runs r ON r.owner=b.owner
    WHERE r.active=1 AND r.not_before<=? AND j.state='waiting' AND j.ready<=? ORDER BY j.ready,j.book LIMIT 1)
    RETURNING book,attempts,ready`
    )
    .get(now + 90000, now, now);
  if (!claim) return false;
  const b = db.prepare('SELECT owner,id FROM bookmarks WHERE seq=?').get(claim.book);
  if (!b) return true;
  try {
    await unrollBookmark(db, String(b.owner), String(b.id), transport);
  } catch (e) {
    const error = e as { message?: string; unavailable?: boolean; status?: number; retryAfterMs?: number };
    const backoff = Math.max(error.retryAfterMs || 0, error.status === 429 ? 60000 : 10000 * Number(claim.attempts));
    if (error.status === 429)
      db.prepare('UPDATE thread_runs SET not_before=max(not_before,?)').run(Date.now() + backoff);
    const state = error.unavailable ? 'unavailable' : Number(claim.attempts) >= 3 ? 'failed' : 'waiting';
    db.prepare('UPDATE thread_jobs SET state=?,reason=?,ready=? WHERE book=? AND ready=?').run(
      state,
      error.message || 'Lookup failed',
      Date.now() + backoff,
      claim.book,
      claim.ready
    );
  }
  return true;
}

export function threadWorker(db: DatabaseSync) {
  let inflight = 0,
    idleUntil = 0;
  const timer = setInterval(async () => {
    if (inflight >= 12 || Date.now() < idleUntil) return;
    inflight++;
    try {
      if (!(await threadStep(db))) {
        idleUntil = Date.now() + 1200;
        db.prepare(
          `UPDATE thread_runs SET active=0 WHERE active=1 AND NOT EXISTS(
          SELECT 1 FROM thread_jobs j JOIN bookmarks b ON b.seq=j.book WHERE b.owner=thread_runs.owner AND j.state='waiting')`
        ).run();
      }
    } catch {
      idleUntil = Date.now() + 3000;
    } finally {
      inflight--;
    }
  }, 90); // At most ~667 starts/minute, below FxEmbed's 1,000/minute/IP allowance.
  timer.unref();
  return () => clearInterval(timer);
}
