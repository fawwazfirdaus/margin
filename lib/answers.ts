import type { DatabaseSync } from 'node:sqlite';
import type { Answer, SearchSpec } from '../shared/discovery.ts';
import { generateAnswer, hostedAvailable } from './models.ts';
import { includeThreadContext } from './thread-evidence.ts';
import { search } from './search.ts';

export async function answer(
  db: DatabaseSync,
  owner: string,
  spec: SearchSpec,
  question: string,
  hosted: boolean,
  vector: (q: string) => Promise<number[] | undefined>
): Promise<Answer> {
  if (hosted && !hostedAvailable())
    throw Object.assign(new Error('Hosted answers are not configured.'), { status: 400 });
  if (/^(?:how many|count|number of)\b/i.test(question)) {
    const f = { ...spec.filters };
    const topic = question.match(/\b(?:about|mentioning|matching|discuss)\s+(.+?)[?.!]*$/i);
    let words = (topic ? question.slice(0, topic.index) : question).toLowerCase();
    const media = /\b(videos?|gifs?|photos?|images?|text.only)\b/i.exec(words)?.[1];
    const kind =
      media?.startsWith('video') || media?.startsWith('gif')
        ? 'video'
        : media?.startsWith('text')
          ? 'text'
          : media
            ? 'photo'
            : undefined;
    const author = /@(\w{1,15})/.exec(words)?.[1];
    const year = /\b(?:19|20)\d{2}\b/.exec(words)?.[0];
    const state = /\b(archived|kept|inbox)\b/.exec(words)?.[1];
    const targetState =
      state === 'archived' ? 'archive' : state === 'kept' ? 'kept' : state === 'inbox' ? 'inbox' : undefined;
    words = words
      .replace(
        /@\w+|\b(?:19|20)\d{2}\b|\b(?:how|many|count|number|have|saved|bookmarked|is|were|did|do|i|my|the|are|posts?|bookmarks?|videos?|gifs?|photos?|images?|text.only|of|those|these|there|in|on|this|view|all|by|from|published|archived|kept|inbox)\b|[?.!,]/gi,
        ''
      )
      .trim();
    if (words)
      return {
        mode: 'empty',
        text: 'For an exact count, set your filters or search for the topic, then ask “How many in this view?”',
        citations: []
      };
    const conflict =
      (kind && f.media && kind !== f.media) ||
      (author && f.author && author !== f.author) ||
      (targetState && f.state && targetState !== f.state);
    if (kind) f.media = kind;
    if (author) f.author = author;
    if (targetState) f.state = targetState;
    if (year) {
      f.after = [f.after || '', year + '-01-01'].sort().at(-1);
      f.before = [f.before || '9999-12-31', year + '-12-31'].sort()[0];
    }
    const selected = await search(
      db,
      owner,
      { q: spec.q, filters: f },
      0,
      topic ? Number.MAX_SAFE_INTEGER : 0,
      vector
    );
    let total = selected.total;
    if (topic) {
      const ids = new Set(selected.hits.map((h) => h.id));
      const matches = await search(db, owner, { q: topic[1], filters: f }, 0, Number.MAX_SAFE_INTEGER, vector);
      total = matches.hits.filter((h) => ids.has(h.id)).length;
    }
    if (conflict) total = 0;
    const label = [
      kind || '',
      total === 1 ? 'bookmark' : 'bookmarks',
      state || '',
      author ? 'by @' + author : '',
      year ? 'published in ' + year : '',
      topic ? 'matching “' + topic[1] + '”' : '',
      'in this view'
    ]
      .filter(Boolean)
      .join(' ');
    return { mode: 'count', text: total + ' ' + label + '.', citations: [] };
  }
  // When asking within a search, only evidence from that result set is eligible.
  const scope = spec.q ? (await search(db, owner, spec, 0, Number.MAX_SAFE_INTEGER, vector)).hits : undefined;
  const scopeIds = scope && new Set(scope.map((h) => h.id));
  const { hits } = await search(db, owner, { q: question, filters: spec.filters }, 0, 6, vector, {
    within: scopeIds
  });
  const citations = includeThreadContext(db, owner, hits);
  if (!citations.length) return { mode: 'empty', text: 'No supporting passages found in this view.', citations: [] };
  try {
    const claims = await generateAnswer(
      question,
      citations.map((h) => (h.evidence.author || h.author) + ' · bookmark ' + h.id + ' · ' + h.evidence.source + ' ' + (h.evidence.postId || h.id) + ' · ' + h.evidence.text),
      hosted
    );
    if (!claims.length)
      return { mode: 'empty', text: 'The retrieved passages do not give a supported answer.', citations };
    return {
      mode: 'model',
      text: claims.map((c) => c.text + ' ' + c.sources.map((n) => '[' + n + ']').join(' ')).join('\n\n'),
      citations
    };
  } catch {
    return {
      mode: 'evidence',
      text: 'The answer model is unavailable. These are the closest passages in your library.',
      citations
    };
  }
}
