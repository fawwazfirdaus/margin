import type { ReaderData } from '../shared/discovery.js';
import { postUrls, type ThreadPartInput } from '../shared/free-thread.js';
import { xPost } from '../shared/post-links.js';
import { api, el, action, marked } from './dom.js';

export function freeThread(data: ReaderData, terms: string[], refresh: () => Promise<void>) {
  const { post, selectedThread } = data;
  const section = el('section', 'free-thread');
  if (selectedThread.length) {
    section.append(el('h3', '', 'Selected thread parts'));
    selectedThread.forEach((p, i) => {
      const item = el('article', 'related-post');
      item.dataset.contextId = p.id;
      const link = el('a', 'textlink', 'Open on X ↗');
      link.href = p.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const body = el('p');
      body.append(
        marked(
          p.body ||
            {
              pending: 'Waiting to fetch.',
              unavailable: 'No public preview.',
              failed: 'Fetch failed. Try again later.'
            }[p.status] ||
            'No text available.',
          terms
        )
      );
      item.append(
        el('small', 'origin', i + 1 + ' / ' + selectedThread.length),
        el('b', '', p.author || 'X post'),
        body,
        link
      );
      section.append(item);
    });
  }
  const controls = el('details'),
    summary = el('summary', '', selectedThread.length ? 'Edit thread parts' : 'Import thread parts · no X credits');
  const label = el('label', '', 'Post links in reading order'),
    input = el('textarea');
  input.rows = 4;
  input.placeholder = 'Paste a copied thread selection or its X post links';
  label.append(input);
  input.value = selectedThread.map((p) => p.url).join('\n');
  const note = el('p', 'muted');
  note.setAttribute('role', 'status');
  const fileLabel = el('label', '', 'Or find replies in an X API JSON export'),
    file = el('input');
  file.type = 'file';
  file.accept = 'application/json,.json';
  fileLabel.append(file);
  const local = action('Find connected replies in library', () => void find());
  const save = action('Fetch and index these parts', () => void submit());
  const unique = () => postUrls(input.value).filter((p) => p.id !== post.id);
  function count() {
    const n = unique().length;
    note.textContent = n + ' other X post link' + (n === 1 ? '' : 's') + ' selected.';
    save.disabled = !n;
  }
  count();
  input.oninput = count;
  input.onpaste = (e) => {
    const html = e.clipboardData?.getData('text/html');
    if (!html) return;
    const template = el('template');
    template.innerHTML = html;
    const urls = [...template.content.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href') || '')
      .filter((h) => xPost(h));
    if (!urls.length) return;
    e.preventDefault();
    input.setRangeText(urls.join('\n') + '\n', input.selectionStart, input.selectionEnd, 'end');
    count();
  };
  const inputs = [input, local, file, save];
  function lock(busy: boolean) {
    for (const element of inputs) element.disabled = busy;
  }
  async function find(replyData?: unknown) {
    lock(true);
    try {
      const r = await api<{ parts: ThreadPartInput[] }>('/api/discover/thread-parts', 'POST', {
        id: post.id,
        mode: 'discover',
        replyData
      });
      if (!r.parts.length) {
        note.textContent = 'No connected same-author reply IDs found. Paste the thread selection or its post links.';
        return;
      }
      input.value = postUrls([input.value, ...r.parts.map((p) => p.url)].join('\n'))
        .map((p) => p.url)
        .join('\n');
      note.textContent =
        r.parts.length +
        (r.parts.length === 1 ? ' connected reply found.' : ' connected replies found.') +
        ' Review the links before fetching.';
    } catch (e) {
      note.textContent = e instanceof Error ? e.message : 'Could not read reply data.';
    } finally {
      lock(false);
      save.disabled = !unique().length;
    }
  }
  file.onchange = async () => {
    try {
      const f = file.files?.[0];
      if (!f) return;
      if (f.size > 1_900_000) throw Error('Choose a JSON reply export smaller than 1.9 MB.');
      await find(JSON.parse(await f.text()));
    } catch (e) {
      note.textContent = e instanceof Error ? e.message : 'Could not read the file.';
    }
  };
  async function submit() {
    const parts = unique();
    if (!parts.length) return;
    lock(true);
    let completed = 0;
    try {
      await api('/api/discover/thread-parts', 'POST', { id: post.id, urls: parts.map((p) => p.url) });
      for (const p of parts) {
        note.textContent = 'Checking part ' + ++completed + ' of ' + parts.length + '…';
        const already = selectedThread.find((s) => s.id === p.id);
        if (already?.status === 'indexed') continue;
        const result = await api<{ retryable?: boolean }>('/api/link-preview', 'POST', { id: post.id, href: p.url });
        if (result.retryable) break;
      }
      await refresh();
    } catch (e) {
      note.textContent = e instanceof Error ? e.message : 'Could not import these parts.';
    } finally {
      lock(false);
    }
  }
  controls.append(
    summary,
    el(
      'p',
      'muted',
      'On X, select the thread posts and copy them. Paste here, review the links, then fetch their public text. Only X post links are accepted.'
    ),
    label,
    local,
    fileLabel,
    note,
    save
  );
  if (selectedThread.length)
    controls.append(
      action(
        'Clear selection',
        async () => {
          if (!confirm('Remove this thread selection from Margin?')) return;
          try {
            await api('/api/discover/thread-parts', 'POST', { id: post.id, urls: [] });
            await refresh();
          } catch (e) {
            note.textContent = e instanceof Error ? e.message : 'Could not clear selection.';
          }
        },
        'textlink'
      )
    );
  section.append(controls);
  return section;
}
