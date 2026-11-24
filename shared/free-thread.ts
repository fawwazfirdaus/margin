import { textLinks, xPost } from './post-links.ts';

export interface ThreadPartInput {
  id: string;
  url: string;
}
export interface SelectedPart extends ThreadPartInput {
  author: string;
  body: string;
  status: string;
}

// Keep post IDs as strings: X IDs exceed JavaScript's safe integer range.
export function postUrls(text: string): ThreadPartInput[] {
  const parts = new Map<string, ThreadPartInput>();
  for (const link of textLinks(text)) {
    const post = xPost(link.href);
    if (post && !parts.has(post.id)) parts.set(post.id, post);
  }
  return [...parts.values()];
}

export interface ReplyRecord {
  id: string;
  authorId: string;
  parentId?: string;
}
export function connectedReplies(anchor: string, records: ReplyRecord[]): ThreadPartInput[] {
  const nodes = new Map(records.map((r) => [r.id, r])),
    seed = nodes.get(anchor);
  if (!seed?.authorId) return [];
  const edges = new Map<string, string[]>();
  for (const node of nodes.values()) {
    if (!node.parentId || node.authorId !== seed.authorId || nodes.get(node.parentId)?.authorId !== seed.authorId)
      continue;
    for (const [a, b] of [
      [node.id, node.parentId],
      [node.parentId, node.id]
    ]) {
      const list = edges.get(a) ?? [];
      list.push(b);
      edges.set(a, list);
    }
  }
  const seen = new Set<string>(),
    todo = [anchor];
  while (todo.length) {
    const id = todo.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const n of edges.get(id) ?? []) todo.push(n);
  }
  seen.delete(anchor);
  return [...seen]
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .map((id) => ({ id, url: 'https://x.com/i/web/status/' + id }));
}
