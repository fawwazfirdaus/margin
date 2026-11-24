// Preserve punctuation outside links when rendering text from imported posts.
export function textLinks(text: string): { start: number; raw: string; href: string }[] {
  const links = [];
  for (const match of text.matchAll(
    /(?:https?:\/\/|\b(?:www\.)?(?:x\.com|twitter\.com|t\.co)\/)[^\s<>"'\u2026]+/giu
  )) {
    const raw = match[0].replace(/[),.;:!?\]}]+$/u, '');
    try {
      const u = new URL(/^https?:/i.test(raw) ? raw : 'https://' + raw);
      if (!u.username && !u.password) links.push({ start: match.index!, raw, href: u.href });
    } catch {
      /* Leave incomplete URLs as ordinary text. */
    }
  }
  return links;
}

export function xPost(url: string) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (
    !/^https?:$/.test(u.protocol) ||
    u.username ||
    u.password ||
    u.port ||
    !/^(?:(?:www|mobile)\.)?(?:x|twitter)\.com$/i.test(u.hostname)
  )
    return undefined;
  const m = /^\/(\w{1,15}|i\/web)\/status(?:es)?\/(\d{1,20})(?:\/(?:photo|video)\/\d+)?\/?$/.exec(u.pathname);
  return m ? { id: m[2], url: 'https://x.com/' + m[1] + '/status/' + m[2] } : undefined;
}
export function shortLink(url: string) {
  return /^https?:\/\/t\.co\/[a-zA-Z0-9]+\/?$/.test(url);
}
