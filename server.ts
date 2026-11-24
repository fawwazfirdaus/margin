import { enrichPost, preserveContext } from './lib/post-context.ts';
import type { Post } from './shared/contracts.ts';
import { scriptAsset } from './lib/assets.ts';
import { discovery, jsonBody } from './lib/discovery-api.ts';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { library } from './lib/database.ts';
import { authorization, exchange, fetchPage, removeBookmark, fetchPost } from './lib/x.ts';
import { samples } from './lib/sample.ts';
import type { AppConfig, Transport, XAccount } from './lib/x.ts';
import type {
  AuthorizationResponse, BookmarkEdit, LibraryResponse, SuccessResponse, SyncResponse
} from './shared/contracts.ts';

type Reply = LibraryResponse | AuthorizationResponse | SyncResponse | SuccessResponse | { error: string } | {processed:number;pending:number;warning?:string};
type Session = { id: string; owner: string; name: string };
type PendingAuthorization = { state: string; verifier: string; expires: number; owner?: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const root = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map(Object.entries({
  '/':'index.html', '/style.css':'style.css',
  ...Object.fromEntries(['tide.jpg','shore.jpg','drift.jpg','drift.mp4','field-note.png'].map(n=>['/media/'+n,'media/'+n]))
}));
const mime: Record<string,string> = { html:'text/html; charset=utf-8', js:'text/javascript', css:'text/css', jpg:'image/jpeg', png:'image/png', mp4:'video/mp4' };
const random = () => randomBytes(32).toString('base64url');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

function parseBookmarkEdit(value: unknown): BookmarkEdit {
  if (!value || typeof value !== 'object') throw fail(400,'Expected bookmark edits.');
  const state = 'state' in value ? value.state : undefined;
  const tags = 'tags' in value ? value.tags : undefined;
  if (state !== undefined && state !== 'inbox' && state !== 'kept' && state !== 'archive') {
    throw fail(400,'Unknown review state.');
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.length > 30 ||
      !tags.every((tag: unknown) => typeof tag === 'string' && tag.length <= 48))) {
    throw fail(400,'Use up to 30 tags, each under 49 characters.');
  }
  return {state, tags};
}

export function makeServer(config: AppConfig, lib: ReturnType<typeof library>, transport: Transport = fetch, liveModels = false) {
  const pending = new Map<string, PendingAuthorization>();
  const tokens = new Map<string, XAccount>();
  const syncing = new Set<string>();
  const {db} = lib;
  const ttl = 30 * 86400000;
  const explore=discovery(db,liveModels);
  return createServer(async (req,res) => {
    const send = (status: number, body: Reply) => {
      res.writeHead(status, { 'Content-Type':'application/json' });
      res.end(JSON.stringify(body));
    };
    const redirect = (url: string) => { res.writeHead(303, { Location:url }); res.end(); };
    const sessionCookie = (value: string, age: number) => res.setHeader('Set-Cookie', 'margin_sid=' + value +
      '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + age + (config.origin.startsWith('https:') ? '; Secure' : ''));
    function newSession(owner: string, name: string): Session {
      const key = random(), id = hash(key);
      db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(id,owner,name,Date.now()+ttl);
      sessionCookie(key, ttl/1000);
      return {id,owner,name};
    }
    try {
      res.setHeader('Cache-Control','no-store');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Referrer-Policy','no-referrer');
      res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' https://*.twimg.com; media-src 'self' https://*.twimg.com; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
      if (req.headers.host !== new URL(config.origin).host) throw fail(403,'Open the configured Margin address.');
      if (req.method !== 'GET' && req.headers.origin !== config.origin) throw fail(403,'Request origin mismatch.');
      const url = new URL(req.url || '/', config.origin);
      const path = url.pathname;
      const script=scriptAsset(path);
      if(req.method==='GET' && script){
        const bytes=await readFile(script.file);res.setHeader('Content-Type',script.type);
        if(path.startsWith('/ocr/'))res.setHeader('Cache-Control','private, max-age=3600');
        return res.end(bytes);
      }
      const file = assets.get(path);
      if (req.method === 'GET' && file) {
        const bytes = await readFile(join(root,file));
        res.setHeader('Content-Type', mime[file.slice(file.lastIndexOf('.')+1)]);
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
      const row = key ? db.prepare('SELECT id,owner,name FROM sessions WHERE id=? AND expires>?')
        .get(hash(key),Date.now()) : undefined;
      let session = row as Session | undefined;
      if (req.method === 'GET' && path === '/api/library') {
        if (!session) {
          const owner = 'demo-' + random();
          session = newSession(owner,'Sample library');
          lib.savePage(owner, samples, '');
          for (const p of samples) lib.edit(owner,p.id,{tags:p.tags});
        }
        return send(200,{ posts:url.searchParams.has('summary') ? [] : lib.list(session.owner), name:session.name, demo:session.owner.startsWith('demo-'),
          configured:Boolean(config.clientId), connected:tokens.has(session.id), canRemove:Boolean(tokens.get(session.id)?.canRemove), resume:Boolean(lib.cursor(session.owner)),
          callback:config.origin+'/auth/callback' });
      }
      if (!session) throw fail(401,'Open your library and try again.');
      if(path.startsWith('/api/discover/')) return await explore.dispatch(req,res,session.owner,path,url);
      if (req.method === 'POST' && ['/auth/start','/auth/manage'].includes(path)) {
        if (!config.clientId) throw fail(409,'Configure an X OAuth client first.');
        const manage = path === '/auth/manage';
        if (manage && session.owner.startsWith('demo-')) throw fail(403,'Connect your X library first.');
        const flow = authorization(config.clientId,config.origin,manage);
        pending.set(session.id,{...flow,owner:manage ? session.owner : undefined,expires:Date.now()+600000});
        return send(200,{url:flow.url});
      }
      if (req.method === 'GET' && path === '/auth/callback') {
        const flow = pending.get(session.id);
        if (!flow || flow.expires < Date.now() || flow.state !== url.searchParams.get('state')) return redirect('/?auth=expired');
        pending.delete(session.id);
        const code = url.searchParams.get('code');
        if (!code) return redirect('/?auth=cancelled');
        try {
          const user = await exchange(code,flow.verifier,config,transport);
          if (flow.owner && user.account !== flow.owner) throw new Error('Choose the X account that owns this library.');
          tokens.delete(session.id);
          db.prepare('DELETE FROM sessions WHERE id=?').run(session.id);
          const active = newSession(user.account,user.name);
          tokens.set(active.id,user);
          return redirect('/');
        } catch (error) { return redirect('/?auth=error&message='+encodeURIComponent(errorMessage(error))); }
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
          const posts:Post[]=[];
          for(const p of page.posts){
            const old=db.prepare('SELECT content FROM bookmarks WHERE owner=? AND id=?').get(session.owner,p.id);
            const full=await enrichPost(p,user,transport);
            posts.push(preserveContext(full,old?JSON.parse(String(old.content)):undefined));
          }
          const added = lib.savePage(session.owner,posts,page.next);
          page.partial ||= posts.some(p=>p.context?.warning);
          return send(200,{added,more:Boolean(page.next),partial:page.partial});
        } catch (e) {
          if (errorMessage(e).includes('HTTP 401')) tokens.delete(session.id);
          throw e;
        } finally { syncing.delete(session.owner); }
      }
      if(req.method==='POST' && path==='/api/context/backfill'){
        const user=tokens.get(session.id);
        if(!user)throw fail(401,'Reconnect X before loading context.');
        if(syncing.has(session.owner))throw fail(409,'Another library update is running.');
        syncing.add(session.owner);
        const pending="owner=? AND json_extract(content,'$.context.checked') IS NULL";
        let processed=0,warning='';
        try{
          const rows=db.prepare('SELECT id,content FROM bookmarks WHERE '+pending+' ORDER BY seq LIMIT 5').all(session.owner);
          for(const row of rows){
            try{
              const post=await enrichPost(await fetchPost(user,String(row.id),transport),user,transport);
              const merged=preserveContext(post,JSON.parse(String(row.content)));
              db.prepare('UPDATE bookmarks SET content=? WHERE owner=? AND id=?').run(JSON.stringify(merged),session.owner,row.id);
              processed++;warning=merged.context?.warning||'';
              if(warning)break;
            }catch(e){
              warning=errorMessage(e);
              if(warning.includes('HTTP 401'))tokens.delete(session.id);
              if(/HTTP (404|410)/.test(warning)){
                const old=JSON.parse(String(row.content)) as Post;
                old.context={quotes:[],thread:[],...old.context,checked:false,warning};
                db.prepare('UPDATE bookmarks SET content=? WHERE owner=? AND id=?').run(JSON.stringify(old),session.owner,row.id);
              }
              break;
            }
          }
          return send(200,{processed,warning,pending:Number(db.prepare('SELECT count(*) n FROM bookmarks WHERE '+pending).get(session.owner)?.n)});
        }finally{syncing.delete(session.owner);}
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
            const previous=db.prepare('SELECT content FROM bookmarks WHERE owner=? AND id=?').get(session.owner,id);
            const post = preserveContext(await enrichPost(await fetchPost(user,id,transport),user,transport),
              previous?JSON.parse(String(previous.content)):undefined);
            db.prepare('UPDATE bookmarks SET content=? WHERE owner=? AND id=?').run(JSON.stringify(post),session.owner,id);
          }
          return send(200,{ok:true});
        } catch (e) {
          if (errorMessage(e).includes('HTTP 401')) tokens.delete(session.id);
          throw e;
        } finally { syncing.delete(session.owner); }
      }
      if (req.method === 'PATCH' && path.startsWith('/api/posts/')) {
        const fields = parseBookmarkEdit(await jsonBody(req));
        if (!lib.edit(session.owner,path.slice('/api/posts/'.length),fields)) throw fail(404,'Bookmark not found.');
        return send(200,{ok:true});
      }
      throw fail(404,'Page not found.');
    } catch (error) {
      const status = error instanceof Error && 'status' in error && typeof error.status === 'number'
        ? error.status : 502;
      send(status,{error:errorMessage(error)});
    }
  }).on('close',explore.close);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const port = Number(process.env.PORT || 4173);
  const origin = new URL(process.env.MARGIN_ORIGIN || 'http://127.0.0.1:'+port).origin;
  const directory = process.env.MARGIN_DATA_DIR || fileURLToPath(new URL('./data/',import.meta.url));
  await mkdir(directory,{recursive:true,mode:0o700});
  const server = makeServer({origin,clientId:process.env.X_CLIENT_ID,secret:process.env.X_CLIENT_SECRET},
    library(join(directory,'margin.sqlite')),fetch,true);
  server.listen(port,'127.0.0.1',()=>console.log('Margin is ready at '+origin));
}
