import { contextLabel } from './post-context.js';
import type { AuthorizationResponse, LibraryResponse, SyncResponse } from '../shared/contracts.js';
import type { Answer, Catalog, Coverage, Filters, Hit, Results, SearchSpec } from '../shared/discovery.js';
import { action, api, by, dateText, el, marked, notice, problem } from './dom.js';
import { reader } from './reader.js';
import { installOCR } from './ocr.js';

let account: LibraryResponse,
  catalog: Catalog,
  spec: SearchSpec = { q: '', filters: {} },
  list: Hit[] = [];
let serial = 0,
  delay: ReturnType<typeof setTimeout>,
  activeSaved = 0;
const input = by<HTMLInputElement>('query'),
  searchBtn = by<HTMLButtonElement>('more');
const fkeys = ['author', 'tag', 'media', 'state', 'after', 'before'] as const;
const states = { all: 'All bookmarks', inbox: 'Review queue', kept: 'Kept', archive: 'Archive' };
const reading = reader(
  () => account,
  () => catalog,
  refresh,
  async (id) => {
    const i = list.findIndex((h) => h.id === id);
    if (i === list.length - 1 && !searchBtn.hidden) await find(true);
    const h = list[(i + 1) % list.length];
    if (h) void reading.open(h);
  }
);
function buttonNav(label: string, count: number | undefined, selected: boolean, fn: () => void) {
  const b = action('', fn, 'nav-item');
  b.append(el('span', '', label));
  if (count !== undefined) b.append(el('small', '', count.toLocaleString()));
  b.setAttribute('aria-current', String(selected));
  return b;
}
function apply(newSpec: SearchSpec, saved = 0) {
  activeSaved = saved;
  spec = { q: newSpec.q, filters: { ...newSpec.filters } };
  input.value = spec.q;
  for (const k of fkeys) by<HTMLInputElement>(k).value = spec.filters[k] || '';
  by('sidebar').classList.remove('expanded');
  by('mobile-nav').setAttribute('aria-expanded', 'false');
  nav();
  void find();
}
function nav() {
  by<HTMLSelectElement>('state').value = spec.filters.state || '';
  by('views').replaceChildren(
    ...(Object.keys(states) as (keyof typeof states)[]).map((k) =>
      buttonNav(
        states[k],
        catalog[k],
        (spec.filters.state || 'all') === k && !spec.filters.collection && !activeSaved,
        () =>
          apply({
            q: spec.q,
            filters: { ...spec.filters, collection: undefined, state: k === 'all' ? undefined : k }
          })
      )
    )
  );
  by('collections').replaceChildren(
    ...catalog.collections.map((c) =>
      buttonNav(c.name, c.count, spec.filters.collection === c.id, () =>
        apply({ q: '', filters: { collection: c.id } })
      )
    )
  );
  by('saved').replaceChildren(
    ...catalog.searches.map((s) => buttonNav(s.name, undefined, activeSaved === s.id, () => apply(s, s.id)))
  );
  by('delete-view').hidden = !activeSaved && !spec.filters.collection;
  by('delete-view').textContent = activeSaved ? 'Delete saved search' : 'Delete collection';
  by('title').textContent =
    catalog.searches.find((s) => s.id === activeSaved)?.name ||
    catalog.collections.find((c) => c.id === spec.filters.collection)?.name ||
    states[spec.filters.state || 'all'];
}
function fillOptions() {
  const tags = by<HTMLSelectElement>('tag');
  tags.replaceChildren(new Option('All tags', ''), ...catalog.tags.map((t) => new Option(t, t)));
  tags.value = spec.filters.tag || '';
  by('authors').replaceChildren(...catalog.authors.map((a) => new Option(a, a)));
}
function card(h: Hit) {
  const b = action('', () => void reading.open(h), 'result');
  b.dataset.post = h.id;
  const left = el('span', 'entry');
  const meta = el('span', 'entry-meta');
  meta.append(
    el('b', '', h.author),
    el('span', '', h.handle ? '@' + h.handle : ''),
    el('span', '', dateText(h.date))
  );
  left.append(meta);
  const text = el('span', 'snippet');
  let copy = h.evidence.text;
  const prefix = h.author + ' @' + h.handle + ' ';
  if (h.evidence.source === 'post' && copy.startsWith(prefix)) copy = copy.slice(prefix.length);
  text.append(marked(copy || 'Media bookmark', h.terms));
  left.append(text);
  if (h.evidence.slot >= 0)
    left.append(
      el(
        'small',
        'origin',
        contextLabel(h.evidence)
      )
    );
  b.append(left);
  if (h.preview) {
    const im = el('img', 'thumbnail');
    im.alt = '';
    im.loading = 'lazy';
    im.src = h.preview;
    b.append(im);
  }
  b.append(el('span', 'chevron', '↗'));
  return b;
}
async function find(append = false) {
  clearTimeout(delay);
  const n = ++serial,
    offset = append ? list.length : 0;
  searchBtn.disabled = true;
  try {
    const r = await api<Results>('/api/discover/search', 'POST', { ...spec, offset });
    if (n !== serial) return;
    if (!append) {
      list = [];
      by('results').replaceChildren();
      by('results').scrollTop = 0;
    }
    list.push(...r.hits);
    by('results').append(...r.hits.map(card));
    if (!list.length) {
      const empty = el('div', 'empty');
      empty.append(
        el('h3', '', 'No bookmarks here yet'),
        el(
          'p',
          'muted',
          spec.q ? 'Try another phrase or broaden your filters.' : 'Import bookmarks or adjust this view.'
        )
      );
      by('results').append(empty);
    }
    by('result-count').textContent = r.total.toLocaleString() + (r.total === 1 ? ' bookmark' : ' bookmarks');
    by('rank').textContent = spec.q ? (r.semantic ? 'Keyword + meaning' : 'Keyword matches') : 'Library order';
    const active = fkeys.filter((k) => spec.filters[k]).map((k) => k + ' · ' + spec.filters[k]);
    by('scope').textContent = active.join('  /  ');
    by('clear').hidden = !spec.q && !Object.values(spec.filters).some(Boolean) && !activeSaved;
    searchBtn.hidden = list.length >= r.total;
  } catch (e) {
    if (n === serial) problem(e);
  } finally {
    if (n === serial) searchBtn.disabled = false;
  }
}
async function refresh() {
  by('answer').replaceChildren();
  [account, catalog] = await Promise.all([
    api<LibraryResponse>('/api/library?summary=1'),
    api<Catalog>('/api/discover/catalog')
  ]);
  by('account').textContent = account.demo ? 'Sample library' : '@' + account.name;
  by('callback').textContent = account.callback;
  by('connect').textContent = account.connected
    ? account.resume
      ? 'Import next page'
      : 'Import from X'
    : account.demo
      ? 'Connect X ↗'
      : 'Reconnect X ↗';
  by('signout').hidden = account.demo;by('context-controls').hidden=account.demo;
  fillOptions();
  nav();
  await find();
}
async function coverage() {
  const s = await api<Coverage & { hosted: boolean; embeddingProvider:string; askProvider:string }>('/api/discover/status');
  by('vectors').textContent = s.embedded.toLocaleString() + ' / ' + s.passages.toLocaleString();
  by('model-note').textContent =
    s.modelError ||
    (s.embedded < s.passages
      ? 'Building embeddings with '+s.embeddingProvider+'. Keyword search is available.'
      : 'Semantic index ready · '+s.embeddingProvider);
  by('ocr-count').textContent = s.ready + s.empty + ' / ' + s.total;
  by('ocr-detail').textContent =
    s.ready +
    ' with text · ' +
    s.empty +
    ' no text · ' +
    s.failed +
    ' failed · ' +
    (s.total - s.ready - s.empty - s.failed) +
    ' pending';
  by('retry-ocr').hidden = !s.failed;
  by('hosted-label').hidden = !s.hosted;
  by('ask-provider').textContent=s.askProvider.startsWith('OpenAI')?'OpenAI receives this question and retrieved text excerpts. Images stay in browser OCR.':'Answers use Ollama on this Mac.';
}
installOCR(coverage);
by('load-context').onclick=async()=>{
  const btn=by<HTMLButtonElement>('load-context');btn.disabled=true;
  try{
    if(!account.connected){if(!account.demo)location.assign((await api<AuthorizationResponse>('/auth/start','POST')).url);return;}
    const r=await api<{processed:number;pending:number;warning?:string}>('/api/context/backfill','POST');
    by('context-note').textContent=r.processed+' loaded · '+r.pending+' unchecked. '+(r.warning||'');
    await find();
  }catch(e){by('context-note').textContent=e instanceof Error?e.message:String(e);}finally{btn.disabled=false;}
};
input.oninput = () => {
  spec.q = input.value;
  activeSaved = 0;
  serial++;
  clearTimeout(delay);
  delay = setTimeout(() => {
    nav();
    void find();
  }, 200);
};
by('search-form').onsubmit = (e) => {
  e.preventDefault();
  spec.q = input.value;
  void find();
};
by('filters').onchange = () => {
  for (const k of fkeys) {
    const v = by<HTMLInputElement>(k).value;
    Object.assign(spec.filters, { [k]: v || undefined });
  }
  activeSaved = 0;
  nav();
  void find();
};
by('clear').onclick = () => apply({ q: '', filters: {} });
by('toggle-filters').onclick = () => {
  const f = by('filters');
  f.hidden = !f.hidden;
  by('toggle-filters').setAttribute('aria-expanded', String(!f.hidden));
};
by('mobile-nav').onclick = () => {
  const on = by('sidebar').classList.toggle('expanded');
  by('mobile-nav').setAttribute('aria-expanded', String(on));
};
searchBtn.onclick = () => void find(true);
by('new-collection').onclick = async () => {
  const name = prompt('New collection name');
  if (!name) return;
  try {
    const c = await api<{ id: number }>('/api/discover/collections', 'POST', { name });
    await refresh();
    apply({ q: '', filters: { collection: c.id } });
  } catch (e) {
    problem(e);
  }
};
by('delete-view').onclick = async () => {
  const id = activeSaved || spec.filters.collection;
  if (!id) return;
  const kind = activeSaved ? 'saved search' : 'collection';
  if (!confirm('Delete this ' + kind + '? Your bookmarks will stay in the library.')) return;
  try {
    await api('/api/discover/' + (activeSaved ? 'saved' : 'collections') + '?id=' + id, 'DELETE');
    await refresh();
    apply({ q: '', filters: {} });
  } catch (e) {
    problem(e);
  }
};
by('save-search').onclick = async () => {
  const name = prompt('Name this saved search', spec.q);
  if (!name) return;
  try {
    await api('/api/discover/saved', 'POST', { ...spec, name });
    await refresh();
    const s = catalog.searches.find((v) => v.name.toLowerCase() === name.trim().toLowerCase());
    if (s) apply(s, s.id);
  } catch (e) {
    problem(e);
  }
};
by('coverage').onclick = () => {
  by<HTMLDialogElement>('index').showModal();
  void coverage().catch(problem);
};
setInterval(() => {
  if (by<HTMLDialogElement>('index').open) void coverage().catch(problem);
}, 5000);
for (const b of document.querySelectorAll<HTMLButtonElement>('button[data-close]'))
  b.onclick = () => by<HTMLDialogElement>(b.dataset.close!).close();
by('ask-open').onclick = () => {
  by('ask-scope').textContent =
    'Searching ' + by('title').textContent + (spec.q ? ' for “' + spec.q + '”' : '') + ' with the current filters.';
  by('answer').replaceChildren();
  by<HTMLInputElement>('hosted').checked = false;
  by<HTMLDialogElement>('ask').showModal();
  void coverage().catch(problem);
};
by('ask-form').onsubmit = async (e) => {
  e.preventDefault();
  const submit = by<HTMLButtonElement>('ask-submit'),
    box = by('answer');
  submit.disabled = true;
  box.textContent = 'Finding supporting passages…';
  try {
    const ans = await api<Answer>('/api/discover/ask', 'POST', {
      ...spec,
      question: by<HTMLTextAreaElement>('question').value,
      hosted: by<HTMLInputElement>('hosted').checked
    });
    const copy = el('p', 'answer-copy');
    for (const piece of ans.text.split(/(\[\d+\])/g)) {
      const number = /^\[(\d+)\]$/.exec(piece);
      const cited = number && ans.citations[Number(number[1]) - 1];
      if (cited) {
        const link = action(piece, () => void reading.open(cited), 'inline-citation');
        link.ariaLabel = 'Read source ' + number[1];
        copy.append(link);
      } else copy.append(piece);
    }
    box.replaceChildren(copy);
    ans.citations.forEach((h, i) => {
      const b = action(
        '[' + (i + 1) + '] ' + h.author + ' · ' + contextLabel(h.evidence),
        () => void reading.open(h),
        'citation'
      );
      b.append(el('span', '', h.evidence.text));
      box.append(b);
    });
  } catch (err) {
    box.textContent = err instanceof Error ? err.message : 'Ask failed.';
  } finally {
    submit.disabled = false;
  }
};
by('connect').onclick = async () => {
  const btn = by<HTMLButtonElement>('connect');
  btn.disabled = true;
  try {
    if (!account.configured) {
      by<HTMLDialogElement>('setup').showModal();
      return;
    }
    if (!account.connected) {
      location.assign((await api<AuthorizationResponse>('/auth/start', 'POST')).url);
      return;
    }
    const r = await api<SyncResponse>('/api/sync', 'POST');
    await refresh();
    notice(
      r.added +
        ' new bookmarks. ' +
        (r.more ? 'More pages available.' : 'X supplied no next page.') +
        (r.partial ? ' Some data was unavailable.' : '')
    );
  } catch (e) {
    problem(e);
    await refresh().catch(() => {});
  } finally {
    btn.disabled = false;
  }
};
by('signout').onclick = async () => {
  try {
    await api('/auth/signout', 'POST');
    location.reload();
  } catch (e) {
    problem(e);
  }
};
async function init() {
  // Establish the session cookie before requesting any account-scoped resources.
  await api('/api/library?summary=1');
  const params = new URLSearchParams(location.search);
  if (params.has('auth')) {
    notice(params.get('message') || 'X authorization did not complete.');
    history.replaceState(null, '', '/');
  }
  await refresh();
}
void init().catch(problem);
