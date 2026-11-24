import { api, by } from './dom.js';

export function installLinkIndex(update: () => Promise<void>, refresh: () => Promise<void>) {
  const start = by<HTMLButtonElement>('index-links'),
    pause = by<HTMLButtonElement>('pause-links');
  const note = by('link-progress'),
    short = by<HTMLInputElement>('link-short');
  let stopped = false;
  pause.onclick = () => {
    stopped = true;
    pause.disabled = true;
  };
  by('retry-links').onclick = async () => {
    try {
      await api('/api/discover/retry-links', 'POST');
      await update();
    } catch (e) {
      note.textContent = e instanceof Error ? e.message : 'Retry failed.';
    }
  };
  start.onclick = async () => {
    if (start.disabled) return;
    stopped = false;
    start.disabled = true;
    short.disabled = true;
    pause.disabled = false;
    pause.hidden = false;
    let checked = 0,
      indexed = 0;
    try {
      do {
        note.textContent = 'Checking saved links…';
        const batch = await api<{ checked: number; indexed: number; remaining: number; paused: boolean }>(
          '/api/discover/index-links',
          'POST',
          { includeShort: short.checked }
        );
        checked += batch.checked;
        indexed += batch.indexed;
        stopped ||= batch.paused;
        note.textContent = checked + ' checked · ' + indexed + ' available in this run.';
        await update();
        if (!batch.remaining || !batch.checked) break;
      } while (!stopped);
      if (stopped) note.textContent += ' Paused.';
      await refresh();
    } catch (e) {
      note.textContent = e instanceof Error ? e.message : 'Link indexing interrupted.';
    } finally {
      start.disabled = false;
      short.disabled = false;
      pause.hidden = true;
    }
  };
}
