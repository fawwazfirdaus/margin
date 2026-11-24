import type { Post, PostPart } from '../shared/contracts.ts';
import { contextFields, fetchPost, normalizePage, request, type XPage, type XAccount, type Transport } from './x.ts';

// Shared only within one import operation for one authenticated account.
export function contextRequests(transport: Transport): Transport {
  const responses = new Map<string, string>();
  let blocked = 0;
  return async (url, options) => {
    const known = responses.get(url);
    if (known !== undefined) return new Response(known);
    if (blocked) return new Response(null, {status: blocked});
    const response = await transport(url, options);
    if ([401, 402, 429].includes(response.status)) blocked = response.status;
    if (!response.ok) return response;
    const body = await response.text();
    if (responses.size >= 128) responses.delete(responses.keys().next().value!);
    responses.set(url, body);
    return new Response(body);
  };
}

function plain(post: Post): PostPart {
  const { context, fromTimeline, ...part } = post;
  return part;
}

// Only follow reply edges between posts by the bookmarked author. The same author
// can also reply to unrelated branches within the same X conversation.
function authorChain(seed: Post, candidates: Map<string, PostPart>): PostPart[] {
  const children = new Map<string, string[]>();
  for (const p of candidates.values()) {
    if (p.parentId) {
      const siblings = children.get(p.parentId) ?? [];
      siblings.push(p.id);
      children.set(p.parentId, siblings);
    }
  }
  const visited = new Set<string>(),
    pending = [seed.id];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    const p = candidates.get(id);
    if (!p || p.authorId !== seed.authorId || p.conversationId !== seed.conversationId) continue;
    visited.add(id);
    if (p.parentId) pending.push(p.parentId);
    for (const child of children.get(id) ?? []) pending.push(child);
  }
  visited.delete(seed.id);
  return [...visited]
    .map((id) => candidates.get(id)!)
    .sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
}

export async function enrichPost(seed: Post, user: XAccount, transport: Transport = fetch): Promise<Post> {
  const candidates = new Map<string, PostPart>([[seed.id, plain(seed)]]);
  const quotes = new Map<string, PostPart>();
  const warnings = new Set<string>();
  function remember(p: Post) {
    for (const q of p.context?.quotes ?? []) quotes.set(q.id, q);
  }
  remember(seed);
  const conversation = seed.conversationId;
  if (!conversation || !seed.authorId) warnings.add('X did not supply the conversation or author ID.');
  if (conversation && seed.authorId && (seed.parentId || seed.replyCount !== 0)) {
    try {
      if (!/^\d{1,20}$/.test(conversation) || !/^\w{1,15}$/.test(seed.handle))
        throw Error('Thread author unavailable.');
      const created = Number((BigInt(conversation) >> 22n) + 1288834974657n);
      const recent = Date.now() - created < 6.9 * 86400000;
      const params = new URLSearchParams({
        ...contextFields,
        query: 'conversation_id:' + conversation + ' from:' + seed.handle,
        max_results: '100'
      });
      if (!recent) params.set('start_time', new Date(Math.max(Date.UTC(2006, 2, 21), created - 1000)).toISOString());
      const cursors = new Set<string>();
      do {
        const raw = await request<XPage>(
          '/2/tweets/search/' + (recent ? 'recent' : 'all') + '?' + params,
          { headers: { Authorization: 'Bearer ' + user.token } },
          transport
        );
        const page = normalizePage(raw);
        for (const p of page.posts) {
          candidates.set(p.id, plain(p));
          remember(p);
        }
        if (page.partial) warnings.add('X omitted some thread results.');
        if (!page.next) break;
        if (cursors.has(page.next)) throw Error('X repeated a thread page.');
        cursors.add(page.next);
        params.set('next_token', page.next);
      } while (true);
    } catch (e) {
      warnings.add(e instanceof Error ? e.message : 'Thread search failed.');
    }
    try {
      // A denied archive search can still leave accessible ancestors via lookup.
      // Avoid additional requests once X reports quota or authentication failure.
      const blocked = [...warnings].some((w) => /HTTP (401|402|429)/.test(w));
      // Search usually returns replies only. Lookup also recovers missing links
      // between a bookmarked middle post and an accessible thread root.
      let parent = seed.parentId;
      const seen = new Set([seed.id]);
      while (parent && !seen.has(parent) && !blocked) {
        seen.add(parent);
        let p = candidates.get(parent);
        if (!p) {
          const fetched = await fetchPost(user, parent, transport);
          p = plain(fetched);
          remember(fetched);
          candidates.set(parent, p);
        }
        if (p.authorId !== seed.authorId) break;
        parent = p.parentId;
      }
    } catch (e) {
      warnings.add(e instanceof Error ? e.message : 'Thread lookup failed.');
    }
  }
  const thread = authorChain(seed, candidates);
  const ids = [seed, ...thread].flatMap((p) => (p.quoteId ? [p.quoteId] : []));
  const visited = new Set<string>(),
    ordered: PostPart[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (visited.has(id) || id === seed.id) continue;
    visited.add(id);
    let q = quotes.get(id) ?? candidates.get(id);
    if (!q || !q.handle || q.media.some(m => m.type === 'unavailable')) {
      try {
        const fetched = await fetchPost(user, id, transport);
        remember(fetched);
        q = plain(fetched);
      } catch (e) {
        const warning = e instanceof Error ? e.message : 'Quoted post unavailable.';
        warnings.add(warning);
        if (/HTTP (403|404|410)/.test(warning)) q = undefined;
      }
    }
    if (q) {
      ordered.push(q);
      if (q.quoteId) ids.push(q.quoteId);
    }
  }
  return {
    ...seed,
    context: { thread, quotes: ordered, checked: !warnings.size, warning: [...warnings].join(' ') || undefined }
  };
}

// Retain previous context across transient failures, but respect a fresh access denial.
export function preserveContext(post: Post, previous?: Post): Post {
  if (!post.context?.warning || !previous?.context || /HTTP (403|404|410)/.test(post.context.warning)) return post;
  const thread = new Map<string, PostPart>();
  if (previous.conversationId === post.conversationId) {
    for (const p of previous.context.thread) thread.set(p.id, p);
  }
  for (const p of post.context.thread) thread.set(p.id, p);
  const parts = [...thread.values()].sort((a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id));
  const available = new Map([...previous.context.quotes, ...post.context.quotes].map((p) => [p.id, p]));
  const quotes: PostPart[] = [],
    seen = new Set<string>();
  for (const part of [post, ...parts]) {
    let id = part.quoteId;
    while (id && !seen.has(id) && available.has(id)) {
      seen.add(id);
      const q = available.get(id)!;
      quotes.push(q);
      id = q.quoteId;
    }
  }
  return { ...post, context: { ...post.context, thread: parts, quotes } };
}
