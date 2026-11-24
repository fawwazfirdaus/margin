import type { DatabaseSync } from 'node:sqlite';
import type { Post } from '../shared/contracts.ts';
import type { Hit } from '../shared/discovery.ts';
import { withPublicThread } from './public-unroll.ts';

// Keep the strongest matches, and give an isolated thread hit some reading context.
export function includeThreadContext(db: DatabaseSync, owner: string, hits: Hit[]): Hit[] {
  const first = hits[0];
  if (!first || !['post', 'thread'].includes(first.evidence.source)) return hits;
  if (hits.slice(1).some(h => h.id === first.id && ['post', 'thread'].includes(h.evidence.source))) return hits;
  const row = db.prepare('SELECT seq,content FROM bookmarks WHERE owner=? AND id=?').get(owner, first.id);
  if (!row) return hits;
  const post = withPublicThread(db, Number(row.seq), JSON.parse(String(row.content)) as Post);
  const parts = post.context?.thread;
  if (!parts?.length) return hits;
  const chain = [{ post, slot: -1 }, ...parts.map((post, slot) => ({ post, slot }))]
    .sort((a, b) => a.post.id.length - b.post.id.length || a.post.id.localeCompare(b.post.id));
  const i = chain.findIndex(p => p.post.id === (first.evidence.postId || first.id));
  if (i < 0) return hits;
  const neighbors: Hit[] = [];
  const seen = new Set(hits.map(h => h.evidence.postId || h.id));
  for (const p of [chain[i + 1], chain[i - 1]]) {
    if (!p || seen.has(p.post.id)) continue;
    const source = p.slot < 0 ? 'post' : 'thread';
    const passage = db.prepare('SELECT body FROM passages WHERE book=? AND source=? AND slot=? ORDER BY part LIMIT 1')
      .get(row.seq, source, p.slot);
    if (passage) neighbors.push({ ...first, evidence: { source, slot: p.slot, text: String(passage.body),
      author: p.post.author, postId: source === 'thread' ? p.post.id : undefined } });
  }
  return [...hits.slice(0, 6 - neighbors.length), ...neighbors];
}
