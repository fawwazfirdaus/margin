import { DatabaseSync } from 'node:sqlite';
import type { Post, Bookmark } from '../shared/contracts.ts';
import type { PhotoJob, ReaderData } from '../shared/discovery.ts';

export function setupIndex(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys=ON');
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version > 1) throw new Error('This library needs a newer version of Margin.');
  if (version === 1) return;
  db.exec(`BEGIN;
    CREATE TABLE dirty(book INTEGER PRIMARY KEY REFERENCES bookmarks(seq) ON DELETE CASCADE);
    CREATE TABLE passages(
      pid INTEGER PRIMARY KEY,book INTEGER NOT NULL REFERENCES bookmarks(seq) ON DELETE CASCADE,
      source TEXT NOT NULL,slot INTEGER NOT NULL,part INTEGER NOT NULL,body TEXT NOT NULL,
      model TEXT,vector BLOB, UNIQUE(book,source,slot,part));
    CREATE VIRTUAL TABLE phrases USING fts5(body,content='passages',content_rowid='pid',tokenize='unicode61');
    CREATE TRIGGER phrases_insert AFTER INSERT ON passages BEGIN
      INSERT INTO phrases(rowid,body) VALUES(new.pid,new.body); END;
    CREATE TRIGGER phrases_delete AFTER DELETE ON passages BEGIN
      INSERT INTO phrases(phrases,rowid,body) VALUES('delete',old.pid,old.body); END;
    CREATE TRIGGER phrases_update AFTER UPDATE OF body ON passages BEGIN
      INSERT INTO phrases(phrases,rowid,body) VALUES('delete',old.pid,old.body);
      INSERT INTO phrases(rowid,body) VALUES(new.pid,new.body); END;
    CREATE TABLE photos(book INTEGER REFERENCES bookmarks(seq) ON DELETE CASCADE,slot INTEGER,
      src TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',body TEXT NOT NULL DEFAULT '',words TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY(book,slot));
    CREATE INDEX photos_source ON photos(src);
    CREATE TABLE collections(id INTEGER PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL COLLATE NOCASE,UNIQUE(owner,name));
    CREATE TABLE members(collection INTEGER REFERENCES collections(id) ON DELETE CASCADE,
      book INTEGER REFERENCES bookmarks(seq) ON DELETE CASCADE,PRIMARY KEY(collection,book));
    CREATE TABLE searches(id INTEGER PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL COLLATE NOCASE,spec TEXT NOT NULL,UNIQUE(owner,name));
    CREATE TRIGGER index_new AFTER INSERT ON bookmarks BEGIN INSERT INTO dirty SELECT new.seq WHERE NOT EXISTS(SELECT 1 FROM dirty WHERE book=new.seq); END;
    CREATE TRIGGER index_changed AFTER UPDATE OF content,tags ON bookmarks BEGIN INSERT INTO dirty SELECT new.seq WHERE NOT EXISTS(SELECT 1 FROM dirty WHERE book=new.seq); END;
    INSERT INTO dirty SELECT seq FROM bookmarks;
    PRAGMA user_version=1; COMMIT;`);
}

// A long screenshot or post can contribute several results, each traceable to one attachment.
function chunks(text: string) {
  const words=text.trim().split(/\s+/u).filter(Boolean), pieces:string[]=[];
  for(let i=0;i<words.length;i+=90) {
    pieces.push(words.slice(i,i+110).join(' '));
    if(i+110>=words.length) break;
  }
  return pieces;
}

export function syncText(db: DatabaseSync) {
  const rows=db.prepare('SELECT b.seq,b.content,b.tags FROM dirty d JOIN bookmarks b ON b.seq=d.book').all();
  if(!rows.length) return;
  const put=db.prepare(`INSERT INTO passages(book,source,slot,part,body) VALUES(?,?,?,?,?)
    ON CONFLICT(book,source,slot,part) DO UPDATE SET body=excluded.body,model=NULL,vector=NULL WHERE body<>excluded.body`);
  const photo=db.prepare(`INSERT INTO photos(book,slot,src) VALUES(?,?,?) ON CONFLICT(book,slot) DO UPDATE SET
    src=excluded.src,status='pending',body='',words='[]' WHERE src<>excluded.src`);
  const remove=db.prepare('DELETE FROM passages WHERE pid=?');
  db.exec('BEGIN');
  try {
    for(const row of rows) {
      const book=Number(row.seq),p=JSON.parse(String(row.content)) as Post;
      const keys=new Set<string>(), slots=new Set<number>();
      function passage(source:string,slot:number,text:string) {
        chunks(text).forEach((body,part)=>{put.run(book,source,slot,part,body);keys.add([source,slot,part].join('/'));});
      }
      passage('post',-1,[p.author,'@'+p.handle,p.body,...JSON.parse(String(row.tags))].join(' '));
      for(const [slot,m] of p.media.entries()) {
        if(m.alt && !/^(image|photo)$/i.test(m.alt)) passage('alt',slot,m.alt);
        if(m.type==='photo' && m.src){slots.add(slot);photo.run(book,slot,m.src);}
      }
      for(const f of db.prepare('SELECT slot,body FROM photos WHERE book=?').all(book)) {
        if(!slots.has(Number(f.slot))) db.prepare('DELETE FROM photos WHERE book=? AND slot=?').run(book,f.slot);
        else if(f.body) passage('image',Number(f.slot),String(f.body));
      }
      for(const r of db.prepare('SELECT pid,source,slot,part FROM passages WHERE book=?').all(book)){
        if(!keys.has([r.source,r.slot,r.part].join('/'))) remove.run(r.pid);
      }
      db.prepare('DELETE FROM dirty WHERE book=?').run(book);
    }
    db.exec('COMMIT');
  } catch(e){db.exec('ROLLBACK');throw e;}
}

export function readPost(db:DatabaseSync,owner:string,id:string):ReaderData {
  const b=db.prepare('SELECT * FROM bookmarks WHERE owner=? AND id=?').get(owner,id);
  if(!b) throw Object.assign(new Error('Bookmark not found.'),{status:404});
  return {post:{...JSON.parse(String(b.content)),state:b.state,tags:JSON.parse(String(b.tags))} as Bookmark,
    collections:db.prepare('SELECT collection FROM members WHERE book=?').all(b.seq).map(m=>Number(m.collection)),
    photos:db.prepare("SELECT slot,body,words FROM photos WHERE book=? AND status='ready'").all(b.seq)
      .map(r=>({slot:Number(r.slot),text:String(r.body),words:JSON.parse(String(r.words))}))};
}

export function pendingPhotos(db:DatabaseSync,owner:string,limit:number): PhotoJob[] {
  return db.prepare(`SELECT b.id,p.slot,p.src FROM photos p JOIN bookmarks b ON b.seq=p.book
    WHERE b.owner=? AND p.status='pending' GROUP BY p.src ORDER BY min(b.seq),p.slot LIMIT ?`)
    .all(owner,limit).map(r=>({id:String(r.id),slot:Number(r.slot),src:String(r.src)}));
}
