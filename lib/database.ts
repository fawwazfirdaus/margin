import { setupIndex } from './index-store.ts';
import { DatabaseSync } from 'node:sqlite';
import type { Bookmark, BookmarkEdit, Post, ReviewState } from '../shared/contracts.ts';

interface BookmarkRow {
  content: string;
  state: ReviewState;
  tags: string;
}

export function library(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS bookmarks (
      seq INTEGER PRIMARY KEY, owner TEXT NOT NULL, id TEXT NOT NULL, content TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'inbox', tags TEXT NOT NULL DEFAULT '[]', UNIQUE(owner,id));
    CREATE TABLE IF NOT EXISTS cursors(owner TEXT PRIMARY KEY, cursor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL);`);
  setupIndex(db);
  const save = db.prepare('INSERT INTO bookmarks(owner,id,content) VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET content=excluded.content');
  return {
    db,
    savePage(owner: string, posts: Post[], next: string) {
      db.exec('BEGIN');
      try {
        let added = 0;
        for (const p of posts) {
          if (!db.prepare('SELECT 1 FROM bookmarks WHERE owner=? AND id=?').get(owner,p.id)) added++;
          save.run(owner, p.id, JSON.stringify(p));
        }
        db.prepare('INSERT OR REPLACE INTO cursors VALUES(?,?)').run(owner,next);
        db.exec('COMMIT');
        return added;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    cursor(owner: string): string {
      const row = db.prepare('SELECT cursor FROM cursors WHERE owner=?').get(owner);
      return typeof row?.cursor === 'string' ? row.cursor : '';
    },
    list(owner: string): Bookmark[] {
      // These columns and JSON shapes also cover libraries created before the TS migration.
      const rows = db.prepare('SELECT content,state,tags FROM bookmarks WHERE owner=? ORDER BY seq')
        .all(owner) as unknown as BookmarkRow[];
      return rows.map(row => ({
        ...JSON.parse(row.content) as Post,
        state: row.state,
        tags: JSON.parse(row.tags) as string[]
      }));
    },
    edit(owner: string, id: string, {state, tags}: BookmarkEdit) {
      const normalized = tags && JSON.stringify([...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))]);
      return db.prepare('UPDATE bookmarks SET state=coalesce(?,state), tags=coalesce(?,tags) WHERE owner=? AND id=?')
        .run(state ?? null, normalized ?? null, owner, id).changes;
    }
  };
}
