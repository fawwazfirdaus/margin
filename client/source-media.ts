import type { Hit, ReaderData } from '../shared/discovery.js';
import type { MediaAttachment, PostPart } from '../shared/contracts.js';
import { el, marked } from './dom.js';

type Photo = ReaderData['photos'][number];

export function photoFrame(m: Extract<MediaAttachment, {type: 'photo'}>, photo: Photo | undefined, hit: Hit) {
  const frame = el('div', 'image-frame');
  const img = el('img');
  img.alt = m.alt || 'Attached photo';
  img.src = m.src;
  frame.append(img);
  if (photo?.postId) frame.dataset.photoKey = photo.postId + '/' + photo.attachment;
  if (photo && hit.evidence.source === 'image' && hit.evidence.slot === photo.slot) {
    const overlay = el('canvas', 'overlay');
    overlay.setAttribute('aria-hidden', 'true');
    frame.append(overlay);
    const paint = () => {
      overlay.width = img.naturalWidth;
      overlay.height = img.naturalHeight;
      const ctx = overlay.getContext('2d');
      if (!ctx) return;
      const terms = hit.terms.filter(Boolean);
      const normalized = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      const exact = photo.words.filter(([word]) => terms.some((t) => normalized(word).includes(t)));
      let boxes = exact;
      if (!exact.length) {
        // A paraphrase may share no query words. Locate the source passage in OCR reading order.
        const quote = normalized(hit.evidence.text);
        const words = photo.words.map(([word]) => normalized(word));
        const start = quote ? words.join('').indexOf(quote) : -1;
        if (start >= 0) {
          let cursor = 0;
          boxes = photo.words.filter((_, idx) => {
            const left = cursor;
            cursor += words[idx].length;
            return cursor > start && left < start + quote.length;
          });
        }
      }
      for (const [, x, y, r, b] of boxes) {
        ctx.fillStyle = 'rgba(255,202,47,.43)';
        ctx.fillRect(x * overlay.width, y * overlay.height, (r - x) * overlay.width, (b - y) * overlay.height);
      }
    };
    img.onload = paint;
    if (img.complete) paint();
  }
  img.onerror = () => frame.replaceChildren(el('p', 'muted', 'Image unavailable.'));
  return frame;
}

export function transcript(photo: Photo, hit: Hit) {
  const selected = hit.evidence.source === 'image' && hit.evidence.slot === photo.slot;
  const details = el('details');
  details.open = selected;
  details.append(el('summary', '', 'Text in this image'));
  const t = el('p', 'transcript');
  t.append(marked(photo.text, hit.terms));
  details.append(t);
  return details;
}

export function articleView(p: PostPart, terms: string[]) {
  const section = el('section', 'native-article');
  if (!p.article) return section;
  section.append(el('small', 'origin', 'X Article'));
  function add(text: string, paragraph: number) {
    const block = el(paragraph === -1 ? 'h3' : 'p');
    block.dataset.articleKey = p.id + '/' + paragraph;
    block.append(marked(text, terms));
    section.append(block);
  }
  if (p.article.title) add(p.article.title, -1);
  p.article.paragraphs.forEach(add);
  return section;
}
