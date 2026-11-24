export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
export function by<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
export function action(label: string, fn: () => void, cls = '') {
  const b = el('button', cls, label);
  b.type = 'button';
  b.onclick = fn;
  return b;
}
export function notice(s: string) {
  const box = by('notice');
  box.hidden = !s;
  box.textContent = s;
}
export function problem(e: unknown) {
  notice(e instanceof Error ? e.message : String(e));
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || 'Request failed.');
  return data as T;
}
export function marked(text: string, terms: string[]) {
  const frag = document.createDocumentFragment();
  const valid = terms.filter(Boolean);
  if (!valid.length) {
    frag.append(text);
    return frag;
  }
  const pattern = new RegExp(valid.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
  let pos = 0;
  for (const match of text.matchAll(pattern)) {
    frag.append(text.slice(pos, match.index), el('mark', '', match[0]));
    pos = match.index! + match[0].length;
  }
  frag.append(text.slice(pos));
  return frag;
}
export function dateText(date: string) {
  const d = new Date(date);
  return isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
