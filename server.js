import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { library } from './lib/database.js';
import { authorization, exchange, fetchPage, removeBookmark, fetchPost } from './lib/x.js';
import { samples } from './lib/sample.js';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map(Object.entries({
  '/':'index.html', '/app.js':'app.js', '/style.css':'style.css',
  ...Object.fromEntries(['tide.jpg','shore.jpg','drift.jpg','drift.mp4'].map(n=>['/media/'+n,'media/'+n]))
}));
const mime = { html:'text/html; charset=utf-8', js:'text/javascript', css:'text/css', jpg:'image/jpeg', mp4:'video/mp4' };
const random = () => randomBytes(32).toString('base64url');
const hash = s => createHash('sha256').update(s).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), { status });

async function jsonBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (Buffer.byteLength(data) > 10000) throw fail(413,'Request too large.');
  }
  try { return JSON.parse(data); } catch { throw fail(400,'Invalid JSON.'); }
}

export function makeServer(config, lib, transport = fetch) {
  const pending = new Map(), tokens = new Map(), syncing = new Set();
  const {db} = lib;
  const ttl = 30 * 86400000;
  return createServer(async (req,res) => {
    const send = (status,body) => {
      res.writeHead(status, { 'Content-Type':'application/json' });
      res.end(JSON.stringify(body));
    };
    const redirect = url => { res.writeHead(303, { Location:url }); res.end(); };
    const sessionCookie = (value, age) => res.setHeader('Set-Cookie', 'margin_sid=' + value +
      '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + age + (config.origin.startsWith('https:') ? '; Secure' : ''));
    function newSession(owner,name) {
      const key = random(), id = hash(key);
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(id,owner,name,Date.now()+ttl);
      sessionCookie(key, ttl/1000);
      return {id,owner,name};
    }
    try {
      res.setHeader('Cache-Control','no-store');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' https://*.twimg.com; media-src 'self' https://*.twimg.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
      if (req.headers.host !== new URL(config.origin).host) throw fail(403,'Open the configured Margin address.');
      if (req.method !== 'GET' && req.headers.origin !== config.origin) throw fail(403,'Request origin mismatch.');
      const url = new URL(req.url, config.origin);
      const path = url.pathname;
      if (req.method === 'GET' && assets.has(path)) {
        const file = assets.get(path), bytes = await readFile(join(root,file));
        res.setHeader('Content-Type', mime[file.split('.').at(-1)]);
        if (file.endsWith('.mp4')) {
          res.setHeader('Accept-Ranges','bytes');
          if (req.headers.range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
            const start = Number(match?.[1]), end = Math.min(Number(match?.[2] || bytes.length-1), bytes.length-1);
            if (!match || start > end || start >= bytes.length) {
              res.writeHead(416,{'Content-Range':'bytes */'+bytes.length}); return res.end();
            }
            res.writeHead(206, {'Content-Range':`bytes ${start}-${end}/${bytes.length}`, 'Content-Length':end-start+1});
            return res.end(bytes.subarray(start,end+1));
          }
        }
        return res.end(bytes);
      }
      const key = /(?:^|;\s*)margin_sid=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
      let session = key && db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(hash(key),Date.now());
      if (req.method === 'GET' && path === '/api/library') {
        if (!session) {
          const owner = 'demo-' + random();
          session = newSession(owner,'Sample library');
          lib.savePage(owner, samples, '');
          for (const p of samples) lib.edit(owner,p.id,{tags:p.tags});
        }
        return send(200,{ posts:lib.list(session.owner), name:session.name, demo:session.owner.startsWith('demo-'),
          configured:Boolean(config.clientId), connected:tokens.has(session.id), canRemove:Boolean(tokens.get(session.id)?.canRemove), resume:Boolean(lib.cursor(session.owner)),
          callback:config.origin+'/auth/callback' });
      }
      if (!session) throw fail(401,'Open your library and try again.');
      if (req.method === 'POST' && ['/auth/start','/auth/manage'].includes(path)) {
        if (!config.clientId) throw fail(409,'Configure an X OAuth client first.');
        const manage = path === '/auth/manage';
        if (manage && session.owner.startsWith('demo-')) throw fail(403,'Connect your X library first.');
        const flow = authorization(config.clientId,config.origin,manage);
        if (manage) flow.owner = session.owner;
        pending.set(session.id,{...flow,expires:Date.now()+600000});
        return send(200,{url:flow.url});
      }
      if (req.method === 'GET' && path === '/auth/callback') {
        const flow = pending.get(session.id);
        if (!flow || flow.expires < Date.now() || flow.state !== url.searchParams.get('state')) return redirect('/?auth=expired');
        pending.delete(session.id);
        if (!url.searchParams.get('code')) return redirect('/?auth=cancelled');
        try {
          const user = await exchange(url.searchParams.get('code'),flow.verifier,config,transport);
          if (flow.owner && user.account !== flow.owner) throw new Error('Choose the X account that owns this library.');
          tokens.delete(session.id);
          db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
          const active = newSession(user.account,user.name);
          tokens.set(active.id,user);
          return redirect('/');
        } catch (error) { return redirect('/?auth=error&message='+encodeURIComponent(error.message)); }
      }
      if (req.method === 'POST' && path === '/auth/signout') {
        tokens.delete(session.id); pending.delete(session.id);
        db.prepare('DELETE FROM sessions WHERE id=?').run(session.id); sessionCookie('',0);
        return send(200,{ok:true});
      }
      if (req.method === 'POST' && path === '/api/sync') {
        const user = tokens.get(session.id);
        if (!user) throw fail(401,'Reconnect X before importing.');
        if (syncing.has(session.owner)) throw fail(409,'An import is already running for this account.');
        syncing.add(session.owner);
        try {
          const cursor = lib.cursor(session.owner);
          const page = await fetchPage(user,cursor,transport);
          if (cursor && cursor === page.next) throw fail(502,'X repeated a page. Try importing later.');
          const added = lib.savePage(session.owner,page.posts,page.next);
          return send(200,{added,more:Boolean(page.next),partial:page.partial});
        } catch (e) {
          if (e.message.includes('HTTP 401')) tokens.delete(session.id);
          throw e;
        } finally { syncing.delete(session.owner); }
      }
      const postRoute = /^\/api\/posts\/(\d{1,20})(\/media)?$/.exec(path);
      if (postRoute && ((req.method === 'DELETE' && !postRoute[2]) || (req.method === 'POST' && postRoute[2]))) {
        const user = tokens.get(session.id);
        if (!user) throw fail(401,'Reconnect your X account.');
        const id = postRoute[1], removing = req.method === 'DELETE';
        if (removing && !user.canRemove) throw fail(403,'Enable bookmark removal with X first.');
        if (!db.prepare('SELECT 1 FROM bookmarks WHERE owner=? AND id=?').get(session.owner,id)) throw fail(404,'Bookmark not found.');
        if (syncing.has(session.owner)) throw fail(409,'Another library update is running. Try again.');
        syncing.add(session.owner);
        try {
          if (removing) {
            await removeBookmark(user,id,transport);
            db.prepare('DELETE FROM bookmarks WHERE owner=? AND id=?').run(session.owner,id);
          } else {
            const post = await fetchPost(user,id,transport);
            db.prepare('UPDATE bookmarks SET content=? WHERE owner=? AND id=?').run(JSON.stringify(post),session.owner,id);
          }
          return send(200,{ok:true});
        } catch (e) {
          if (e.message.includes('HTTP 401')) tokens.delete(session.id);
          throw e;
        } finally { syncing.delete(session.owner); }
      }
      if (req.method === 'PATCH' && path.startsWith('/api/posts/')) {
        const fields = await jsonBody(req);
        if (!fields || typeof fields !== 'object') throw fail(400,'Expected bookmark edits.');
        try {
          if (!lib.edit(session.owner,path.slice('/api/posts/'.length),fields)) throw fail(404,'Bookmark not found.');
        } catch (error) { throw fail(error.status || 400,error.message); }
        return send(200,{ok:true});
      }
      throw fail(404,'Page not found.');
    } catch (e) { send(e.status || 502,{error:e.message}); }
  });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT || 4173);
  const origin = new URL(process.env.MARGIN_ORIGIN || 'http://127.0.0.1:'+port).origin;
  const directory = process.env.MARGIN_DATA_DIR || fileURLToPath(new URL('./data/',import.meta.url));
  await mkdir(directory,{recursive:true,mode:0o700});
  const server = makeServer({origin,clientId:process.env.X_CLIENT_ID,secret:process.env.X_CLIENT_SECRET},
    library(join(directory,'margin.sqlite')));
  server.listen(port,'127.0.0.1',()=>console.log('Margin is ready at '+origin));
}
