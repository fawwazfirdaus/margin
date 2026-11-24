import { DatabaseSync } from 'node:sqlite';

export function library(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS bookmarks (
      seq INTEGER PRIMARY KEY, owner TEXT NOT NULL, id TEXT NOT NULL, content TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'inbox', tags TEXT NOT NULL DEFAULT '[]', UNIQUE(owner,id));
    CREATE TABLE IF NOT EXISTS cursors(owner TEXT PRIMARY KEY, cursor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL);`);
  const save = db.prepare('INSERT INTO bookmarks(owner,id,content) VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET content=excluded.content');
  return {
    db,
    savePage(owner, posts, next) {
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
    cursor(owner) { return db.prepare('SELECT cursor FROM cursors WHERE owner=?').get(owner)?.cursor || ''; },
    list(owner) {
      return db.prepare('SELECT content,state,tags FROM bookmarks WHERE owner=? ORDER BY seq').all(owner)
        .map(p => ({ ...JSON.parse(p.content), state:p.state, tags:JSON.parse(p.tags) }));
    },
    edit(owner, id, {state, tags}) {
      if (state !== undefined && !['inbox','kept','archive'].includes(state)) throw new Error('Unknown review state.');
      if (tags !== undefined && (!Array.isArray(tags) || tags.length > 30 || tags.some(t => typeof t !== 'string' || t.length > 48))) throw new Error('Use up to 30 tags, each under 49 characters.');
      const normalized = tags && JSON.stringify([...new Set(tags.map(t => t.trim().toLowerCase()).filter(Boolean))]);
      return db.prepare('UPDATE bookmarks SET state=coalesce(?,state), tags=coalesce(?,tags) WHERE owner=? AND id=?')
        .run(state ?? null, normalized ?? null, owner, id).changes;
    }
  };
}
