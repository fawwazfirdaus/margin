import { articleView, photoFrame, transcript } from './source-media.js';
import { linkedText, linkPreviews, previewCard } from './linked-post.js';
import type { Post, PostPart } from '../shared/contracts.js';
import type { Evidence, Hit, ReaderData } from '../shared/discovery.js';
import { el } from './dom.js';

export function contextLabel(e: Evidence) {
  if (e.source === 'article') return 'X Article · ' + (e.author || '');
  if (e.source === 'image' && e.postId) return 'Text in image ' + ((e.attachment ?? 0) + 1) + ' · ' + (e.author || '');
  if (e.source === 'selected') return 'Selected thread part · '+(e.author||'');
  if (e.source === 'linked') return 'Linked post · '+(e.author||'');
  if (e.source === 'quote') return 'Quoted post · ' + (e.author || '');
  if (e.source === 'thread') return 'Author thread · ' + (e.author || '');
  if (e.source === 'post') return 'Post';
  return (e.source === 'image' ? 'Text in image ' : 'Alt text · attachment ') + (e.slot + 1);
}

export function contextReader(post: Post, hit: Hit, photos: ReaderData['photos'], demo: boolean) {
  const terms = hit.terms;
  const section = el('section', 'post-context');
  const quotes = new Map(post.context?.quotes.map((p) => [p.id, p]));
  function link(id: string) {
    const a = el('a', 'textlink', 'View on X ↗');
    a.href = 'https://x.com/i/web/status/' + encodeURIComponent(id);
    a.target = '_blank';
    a.rel = 'noopener';
    return a;
  }
  function card(p: PostPart, kind: string) {
    const block = el('article', 'related-post');
    block.dataset.contextId = p.id;
    block.append(el('small', 'origin', kind), el('b', '', p.author + (p.handle ? ' · @' + p.handle : '')));
    const text = el('p');
    text.append(linkedText(p, terms));
    block.append(text);
    if (p.article) block.append(articleView(p, terms));
    for (const [attachment, m] of p.media.entries()) {
      if (m.type === 'photo') {
        const photo = photos.find(f => f.postId === p.id && f.attachment === attachment);
        const frame = photoFrame(m, photo, hit);
        frame.querySelector('img')!.loading = 'lazy';
        block.append(frame);
        if (photo?.text) block.append(transcript(photo, hit));
      } else if (m.type !== 'unavailable' && m.src) {
        const v = el('video');
        v.controls = true;
        v.playsInline = true;
        v.preload = 'none';
        v.src = m.src;
        if (m.poster) v.poster = m.poster;
        block.append(v);
      }
    }
    if (!demo) block.append(linkPreviews(post.id,p,terms),link(p.id));
    return block;
  }
  function appendQuotes(target: HTMLElement, id?: string) {
    const seen = new Set([post.id]);
    let depth = 0;
    while (id && !seen.has(id)) {
      seen.add(id);
      const p = quotes.get(id);
      if (!p) {
        if (!demo) target.append(previewCard(post.id,'https://x.com/i/web/status/'+id,terms,'Preview quoted post'));
        else target.append(el('p','muted','Quoted post unavailable.'));
        break;
      }
      target.append(card(p, depth++ ? 'Nested quote' : 'Quoted post'));
      id = p.quoteId;
    }
  }
  appendQuotes(section, post.quoteId);
  if (post.context?.thread.length) {
    section.append(el('h3', '', 'Author thread'));
    const ordered = [post, ...post.context.thread].sort(
      (a, b) => a.id.length - b.id.length || a.id.localeCompare(b.id)
    );
    ordered.forEach((p, i) => {
      if (p.id === post.id) {
        section.append(el('p', 'muted', i + 1 + ' / ' + ordered.length + ' · This bookmark'));
        return;
      }
      const block = card(p, i + 1 + ' / ' + ordered.length);
      appendQuotes(block, p.quoteId);
      section.append(block);
    });
  }
  if (post.context?.warning) section.append(el('p', 'muted', 'Partial context. ' + post.context.warning));
  return section;
}
