import { contextReader } from './post-context.js';
import type { Catalog, Hit, ReaderData } from '../shared/discovery.js';
import type { LibraryResponse } from '../shared/contracts.js';
import { action, api, by, dateText, el, marked, notice, problem } from './dom.js';
import { releaseVideo, videoLoader } from './video.js';

export function reader(
  account: () => LibraryResponse,
  catalog: () => Catalog,
  refresh: () => Promise<void>,
  next: (id: string) => void
) {
  const dlg = by<HTMLDialogElement>('reader'),
    content = by('reading');
  const videos = videoLoader();
  let data: ReaderData,
    hit: Hit,
    slot = 0,
    version = 0;
  let opener: HTMLElement | null = null;
  by('close-reader').onclick = () => dlg.close();
  dlg.addEventListener('close', () => {
    version++;
    videos.clear();
    releaseVideo(content.querySelector('video'));
    content.replaceChildren();
    opener?.focus({ preventScroll: true });
  });
  async function open(h: Hit) {
    const n = ++version;
    videos.opening(h.video);
    try {
      const loaded = await api<ReaderData>('/api/discover/post?id=' + encodeURIComponent(h.id));
      if (n !== version) return;
      data = loaded;
      hit = h;
      slot = h.evidence.postId ? 0 : Math.max(0, h.evidence.slot);
      draw();
      if (!dlg.open) {
        opener = document.activeElement as HTMLElement;
        dlg.showModal();
      }
      dlg.scrollTop = 0;
      if(h.evidence.postId)content.querySelector<HTMLElement>('[data-context-id="'+CSS.escape(h.evidence.postId)+'"]')?.scrollIntoView({block:'center'});
    } catch (e) {
      if (n !== version) return;
      videos.clear();
      problem(e);
    }
  }
  async function mutate(fn: () => Promise<unknown>, close = false) {
    content.inert = true;
    try {
      await fn();
      await refresh();
      if (close) dlg.close();
      else await open(hit);
    } catch (e) {
      const msg = el('p', 'error', e instanceof Error ? e.message : String(e));
      msg.setAttribute('role', 'alert');
      content.prepend(msg);
    } finally {
      content.inert = false;
    }
  }
  function source() {
    const link = el('a', 'textlink', 'Original post ↗');
    link.href = 'https://x.com/i/web/status/' + data.post.id;
    link.target = '_blank';
    link.rel = 'noopener';
    return link;
  }
  function draw() {
    const p = data.post;
    releaseVideo(content.querySelector('video'));
    content.replaceChildren();
    const byline = el('div', 'byline');
    byline.append(
      el('div', 'avatar', p.author[0]),
      el('b', '', p.author),
      el('small', '', p.handle ? '@' + p.handle : '')
    );
    content.append(byline, el('small', 'date', dateText(p.date)));
    const body = el('p', 'post-body');
    body.append(marked(p.body, hit.terms));
    content.append(body);
    const m = p.media[slot],
      photo = data.photos.find((f) => f.slot === slot);
    const playable = (m?.type === 'video' || m?.type === 'animated_gif') && m.src;
    if (!playable) videos.clear();
    if (m) {
      const fig = el('figure', 'figure'),
        frame = el('div', 'image-frame');
      fig.append(frame);
      if (m.type === 'photo') {
        const img = el('img');
        img.alt = m.alt || 'Bookmarked image';
        img.src = m.src;
        frame.append(img);
        if (photo && hit.evidence.slot === slot && hit.evidence.source === 'image') {
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
      } else if (playable) {
        frame.append(videos.take(m));
      } else {
        if (m.poster) {
          const img = el('img');
          img.src = m.poster;
          img.alt = 'Video preview';
          frame.append(img);
        }
        frame.append(el('small', '', 'Full attachment unavailable.'));
      }
      const bar = el('figcaption');
      bar.append(
        el('span', '', (m.type === 'photo' ? 'Image' : 'Attachment') + ' ' + (slot + 1) + ' of ' + p.media.length)
      );
      if (playable && frame.querySelector('video source')) {
        const original = el('a', 'textlink', 'Original quality ↗');
        original.href = m.src!;
        original.target = '_blank';
        original.rel = 'noopener';
        bar.append(original);
      }
      if (p.media.length > 1) {
        const nav = el('span');
        for (const [label, d] of [
          ['←', -1],
          ['→', 1]
        ] as const) {
          const b = action(label, () => {
            slot = (slot + d + p.media.length) % p.media.length;
            draw();
          });
          b.ariaLabel = d === 1 ? 'Next attachment' : 'Previous attachment';
          nav.append(b);
        }
        bar.append(nav);
      }
      fig.append(bar);
      content.append(fig);
    }
    if (photo?.text) {
      const details = el('details');
      details.open = hit.evidence.source === 'image' && hit.evidence.slot === slot;
      details.append(el('summary', '', 'Text in this image'));
      const t = el('p', 'transcript');
      t.append(marked(photo.text, hit.terms));
      details.append(t);
      content.append(details);
    }
    content.append(contextReader(p,hit.terms,account().demo));
    if (!account().demo)
      content.append(
        action(
          'Load quotes, author thread and media from X',
          () =>
            void mutate(async () => {
              if (!account().connected) {
                const r = await api<{ url: string }>('/auth/start', 'POST');
                location.assign(r.url);
                return;
              }
              await api('/api/posts/' + p.id + '/media', 'POST');
            }),
          'textlink'
        )
      );
    const tags = el('form', 'tag-editor'),
      label = el('label', '', 'Tags'),
      input = el('input');
    input.value = p.tags.join(', ');
    input.placeholder = 'Add tags, separated by commas';
    label.append(input);
    const save = el('button', '', 'Save tags');
    tags.append(label, save);
    tags.onsubmit = (e) => {
      e.preventDefault();
      void mutate(() =>
        api('/api/posts/' + p.id, 'PATCH', {
          tags: input.value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        })
      );
    };
    content.append(tags);
    const coll = el('details');
    coll.append(el('summary', '', 'Collections · ' + data.collections.length));
    for (const c of catalog().collections) {
      const lbl = el('label', 'choice'),
        cb = el('input');
      cb.type = 'checkbox';
      cb.checked = data.collections.includes(c.id);
      cb.onchange = () =>
        void mutate(() =>
          api('/api/discover/membership', 'POST', { id: p.id, collection: c.id, member: cb.checked })
        );
      lbl.append(cb, c.name);
      coll.append(lbl);
    }
    const add = action(
      'New collection…',
      () => {
        const name = prompt('Collection name');
        if (name)
          void mutate(async () => {
            const c = await api<{ id: number }>('/api/discover/collections', 'POST', { name });
            await api('/api/discover/membership', 'POST', { id: p.id, collection: c.id, member: true });
          });
      },
      'textlink'
    );
    coll.append(add);
    content.append(coll);
    const decisions = el('div', 'decisions');
    for (const [state, label] of [
      ['kept', 'Keep'],
      ['archive', 'Archive'],
      ['inbox', 'Return to queue']
    ] as const)
      if (p.state !== state)
        decisions.append(
          action(
            label,
            () => void mutate(() => api('/api/posts/' + p.id, 'PATCH', { state }), true),
            state === 'kept' ? 'primary' : ''
          )
        );
    decisions.append(action('Next →', () => next(p.id)));
    content.append(decisions);
    if (!account().demo) {
      const foot = el('div', 'reader-foot');
      foot.append(
        source(),
        action(
          'Remove from X…',
          () =>
            void mutate(async () => {
              if (!account().canRemove) {
                if (confirm('Authorize Margin to remove bookmarks? Select the post again after authorization.'))
                  location.assign((await api<{ url: string }>('/auth/manage', 'POST')).url);
                return;
              }
              if (confirm('Remove this bookmark by ' + p.author + ' from X and Margin?')) {
                await api('/api/posts/' + p.id, 'DELETE');
                dlg.close();
                notice('Bookmark removed.');
              }
            }),
          'textlink'
        )
      );
      content.append(foot);
    }
  }
  return { open, bindVideo: videos.bind, cancelVideoIntent: videos.cancelIntent };
}
