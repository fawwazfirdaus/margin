import { createHash, randomBytes } from 'node:crypto';
import type { MediaAttachment, Post, PostPart } from '../shared/contracts.ts';

export interface AppConfig {
  origin: string;
  clientId?: string;
  secret?: string;
}

export interface XAccount {
  account: string;
  name: string;
  token: string;
  canRemove: boolean;
}

export type Transport = (url: string, options: RequestInit) => Promise<Response>;

type LinkEntities = { urls?: {url:string; expanded_url?:string}[] };
interface XPost {
  entities?: LinkEntities;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: {type:string; id:string}[];
  public_metrics?: {reply_count?:number};
  id: string;
  author_id?: string;
  text?: string;
  note_tweet?: { text?: string; entities?: LinkEntities };
  note_post?: { text?: string; entities?: LinkEntities };
  created_at?: string;
  attachments?: { media_keys?: string[] };
}

interface XMedia {
  media_key: string;
  type: string;
  url?: string;
  preview_image_url?: string;
  alt_text?: string;
  variants?: { content_type: string; bit_rate?: number; url: string }[];
}

export interface XPage {
  data?: XPost[];
  includes?: { tweets?: XPost[]; posts?: XPost[]; users?: { id: string; name: string; username: string }[]; media?: XMedia[] };
  meta?: { result_count?: number; next_token?: string };
  errors?: unknown[];
}

type SinglePost = Omit<XPage, 'data'> & { data?: XPost };

function attachment(media?: XMedia): MediaAttachment {
  if (!media) return {type:'unavailable'};
  const alt = media.alt_text || '';
  const poster = media.preview_image_url;
  if (media.type === 'photo' && media.url) return {type:'photo', src:media.url, poster, alt};
  if (media.type === 'video' || media.type === 'animated_gif') {
    const mp4 = media.variants?.filter(v => v.content_type === 'video/mp4')
      .sort((a,b) => (b.bit_rate || 0) - (a.bit_rate || 0))[0];
    return {type:media.type, src:mp4?.url, poster, alt};
  }
  return {type:'unavailable', poster, alt};
}

export function authorization(clientId: string, origin: string, manageBookmarks = false) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code', client_id: clientId, redirect_uri: origin + '/auth/callback',
    scope: 'tweet.read users.read bookmark.read' + (manageBookmarks ? ' bookmark.write' : ''), state,
    code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url')
  });
  return { state, verifier, url: 'https://x.com/i/oauth2/authorize?' + query };
}

export async function request<T>(path: string, options: RequestInit, transport: Transport): Promise<T> {
  const response = await transport('https://api.x.com' + path, { ...options, signal: AbortSignal.timeout(25000) });
  if (!response.ok) {
    const hints: Record<number,string> = { 401: 'Reconnect your X account.', 402: 'Check your X API credit balance.',
      403: 'Check the permissions granted to Margin.', 429: 'X rate limit reached. Try again later.' };
    throw new Error('X returned HTTP ' + response.status + '. ' + (hints[response.status] || 'Try again or check your X app settings.'));
  }
  return await response.json() as T;
}

export async function exchange(code: string, verifier: string, config: AppConfig, transport: Transport = fetch): Promise<XAccount> {
  if (!config.clientId) throw new Error('Configure an X OAuth client first.');
  const body = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier,
    redirect_uri: config.origin + '/auth/callback', client_id: config.clientId });
  const headers: Record<string,string> = {};
  if (config.secret) headers.Authorization = 'Basic ' + Buffer.from(config.clientId + ':' + config.secret).toString('base64');
  const token = await request<{ access_token?: string; scope?: string }>('/2/oauth2/token', { method: 'POST', headers, body }, transport);
  if (!token.access_token) throw new Error('X did not return an access token.');
  const user = await request<{ data?: { id: string; username: string } }>('/2/users/me', { headers: { Authorization: 'Bearer ' + token.access_token } }, transport);
  if (!user.data || !/^\d+$/.test(user.data.id)) throw new Error('X did not return an account ID.');
  return { account: user.data.id, name: user.data.username, token: token.access_token, canRemove: (token.scope || '').split(' ').includes('bookmark.write') };
}

export function normalizePage(payload: XPage) {
  if (!Array.isArray(payload.data) && payload.meta?.result_count !== 0) throw new Error('X returned an incomplete bookmark page.');
  const users = new Map((payload.includes?.users || []).map(u => [u.id, u]));
  const media = new Map((payload.includes?.media || []).map(m => [m.media_key, m]));
  function part(p:XPost):PostPart {
    const author = p.author_id ? users.get(p.author_id) : undefined;
    if (!/^\d+$/.test(p.id)) throw new Error('X returned an invalid bookmark ID.');
    const entities=[...(p.entities?.urls||[]),...(p.note_tweet?.entities?.urls||[]),...(p.note_post?.entities?.urls||[])];
    const links=new Map(entities.filter(e=>e.expanded_url && /^https?:\/\//i.test(e.expanded_url)).map(e=>[e.url,e.expanded_url!]));
    return { ...(links.size ? {links:[...links].map(([url,expanded])=>({url,expanded}))} : {}),id:p.id, authorId:p.author_id, conversationId:p.conversation_id,
      parentAuthorId:p.in_reply_to_user_id,parentId:p.referenced_tweets?.find(r=>r.type==='replied_to')?.id,
      quoteId:p.referenced_tweets?.find(r=>r.type==='quoted')?.id,replyCount:p.public_metrics?.reply_count, author: author?.name || 'X author', handle: author?.username || '',
      body: p.note_tweet?.text || p.note_post?.text || p.text || '', date: p.created_at || '',
      media: (p.attachments?.media_keys || []).map(key => attachment(media.get(key))) };
  }
  const included = new Map((payload.includes?.tweets || payload.includes?.posts || []).map(p=>[p.id,part(p)]));
  const posts:Post[]=(payload.data||[]).map(raw=>{
    const post:Post=part(raw), quotes:PostPart[]=[], seen=new Set([post.id]);
    let id=post.quoteId;
    while(id && !seen.has(id) && included.has(id)){
      const quoted=included.get(id)!;quotes.push(quoted);seen.add(id);id=quoted.quoteId;
    }
    if(post.quoteId)post.context={quotes,thread:[]};
    return post;
  });
  return { posts, next: payload.meta?.next_token || '', partial: Boolean(payload.errors?.length) };
}

export const contextFields = {
  'tweet.fields':'created_at,attachments,author_id,note_tweet,conversation_id,in_reply_to_user_id,referenced_tweets,public_metrics,entities',
  expansions:'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id',
  'media.fields':'url,preview_image_url,type,variants,alt_text'
};
export async function fetchPage(user: XAccount, cursor: string, transport: Transport = fetch) {
  const query = new URLSearchParams({ max_results:'20', ...contextFields });
  if (cursor) query.set('pagination_token', cursor);
  return normalizePage(await request<XPage>('/2/users/' + user.account + '/bookmarks?' + query,
    { headers: { Authorization: 'Bearer ' + user.token } }, transport));
}

export async function removeBookmark(user: XAccount, postId: string, transport: Transport = fetch) {
  const result = await request<{ data?: { bookmarked: boolean } }>('/2/users/' + user.account + '/bookmarks/' + postId,
    { method: 'DELETE', headers: { Authorization: 'Bearer ' + user.token } }, transport);
  if (result.data?.bookmarked !== false) throw new Error('X did not confirm bookmark removal.');
}

export async function fetchPost(user: XAccount, id: string, transport: Transport = fetch) {
  const query = new URLSearchParams(contextFields);
  const result = await request<SinglePost>('/2/tweets/' + id + '?' + query, {headers:{Authorization:'Bearer '+user.token}},transport);
  if (result.data?.id !== id) throw new Error('X could not return this post.');
  return normalizePage({...result,data:[result.data]}).posts[0];
}
