import type { Post } from './contracts.ts';

export function articleSections(post: Post) {
  const sections: { postId: string; author: string; paragraph: number; text: string }[] = [];
  const seen = new Set<string>();
  for (const p of [post, ...(post.context?.thread || []), ...(post.context?.quotes || [])]) {
    if (!p.article || seen.has(p.id)) continue;
    seen.add(p.id);
    const add = (text: string, paragraph: number) => sections.push({ postId: p.id, author: p.author, paragraph, text });
    if (p.article.title) add(p.article.title, -1);
    p.article.paragraphs.forEach(add);
  }
  return sections;
}
