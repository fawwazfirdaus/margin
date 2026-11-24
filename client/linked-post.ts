import type { PostPart, Preview } from '../shared/contracts.js';
import { shortLink, textLinks, xPost } from '../shared/post-links.js';
import { action, api, el, marked } from './dom.js';

function anchor(href: string, label: string) {
  const a = el('a', 'textlink', label);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}
function httpLink(value: string) {
  try {
    const u = new URL(value);
    return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}
export function linkedText(part: PostPart, terms: string[]) {
  const f = document.createDocumentFragment();
  let end = 0;
  for (const l of textLinks(part.body)) {
    f.append(marked(part.body.slice(end, l.start), terms));
    const expanded = part.links?.find((e) => e.url === l.href)?.expanded;
    f.append(anchor((expanded && httpLink(expanded)) || l.href, l.raw));
    end = l.start + l.raw.length;
  }
  f.append(marked(part.body.slice(end), terms));
  return f;
}

function publicText(html: string, terms: string[]) {
  // Extract from an inert template; only recreate text, line breaks and validated links.
  const template = el('template');
  template.innerHTML = html;
  const root = template.content.querySelector('blockquote p');
  const output = document.createDocumentFragment();
  function copy(node: Node, parent: DocumentFragment | HTMLElement) {
    if (node.nodeType === Node.TEXT_NODE) {
      parent.append(marked(node.textContent || '', terms));
      return;
    }
    if (!(node instanceof Element)) return;
    if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'TEMPLATE'].includes(node.tagName.toUpperCase())) return;
    if (node.tagName.toUpperCase() === 'BR') {
      parent.append(el('br'));
      return;
    }
    const href = node.tagName.toUpperCase() === 'A' ? httpLink(node.getAttribute('href') || '') : null;
    if (href) {
      parent.append(anchor(href, node.textContent || href));
      return;
    }
    node.childNodes.forEach((c) => copy(c, parent));
  }
  root?.childNodes.forEach((n) => copy(n, output));
  return output;
}

export function previewCard(bookmark: string, href: string, terms: string[], title: string) {
  const block = el('section', 'linked-preview');
  const link = anchor(href, xPost(href) ? 'Open on X ↗' : 'Open link ↗');
  const content = el('div');
  content.setAttribute('aria-live', 'polite');
  const button = action(
    title,
    async () => {
      if (button.dataset.ready) {
        content.hidden = !content.hidden;
        button.textContent = content.hidden ? title : 'Hide preview';
        return;
      }
      button.disabled = true;
      button.textContent = 'Loading…';
      try {
        const result = await api<Preview>('/api/link-preview', 'POST', { id: bookmark, href });
        link.href = httpLink(result.url) || href;
        link.textContent = xPost(link.href) ? 'Open on X ↗' : 'Open link ↗';
        content.replaceChildren();
        if (result.kind === 'public' || result.kind === 'saved') {
          const body = el('p');
          content.append(el('b', '', result.kind === 'public' ? result.author : result.post.author));
          if (result.kind === 'public') {
            body.append(publicText(result.html, terms));
            if (!body.textContent?.trim()) body.append('Open on X to view this post.');
          } else {
            body.append(linkedText(result.post, terms));
            for (const m of result.post.media) {
              if (m.type === 'photo') {
                const img = el('img');
                img.src = m.src;
                img.alt = m.alt || 'Photo';
                img.loading = 'lazy';
                body.append(img);
              } else if (m.type !== 'unavailable' && m.src) {
                const v = el('video');
                v.src = m.src;
                v.controls = true;
                v.playsInline = true;
                v.preload = 'none';
                body.append(v);
              }
            }
          }
          content.append(body);
        } else content.append(el('small', 'muted', result.message));
        button.dataset.ready = '1';
        button.textContent = 'Hide preview';
      } catch {
        content.replaceChildren(el('small', 'muted', 'Preview unavailable. You can still open the link.'));
        button.textContent = 'Retry preview';
      } finally {
        button.disabled = false;
      }
    },
    'textlink'
  );
  block.append(button, link, content);
  return block;
}
export function linkPreviews(bookmark: string, part: PostPart, terms: string[]) {
  const output = document.createDocumentFragment(),
    urls = new Set<string>();
  const mapped = new Map((part.links || []).map((l) => [l.url, l.expanded]));
  for (const l of textLinks(part.body)) urls.add(mapped.get(l.href) || l.href);
  for (const link of mapped.values()) urls.add(link);
  const seen = new Set<string>();
  const previews = [...urls].filter((url) => {
    const target = xPost(url);
    if (target && (target.id === part.id || target.id === part.quoteId || seen.has(target.id))) return false;
    if (target) seen.add(target.id);
    return Boolean(target) || shortLink(url);
  });
  previews.forEach((url, i) =>
    output.append(
      previewCard(
        bookmark,
        url,
        terms,
        (xPost(url) ? 'Preview linked post' : 'Preview short link') + (previews.length > 1 ? ' ' + (i + 1) : '')
      )
    )
  );
  return output;
}
