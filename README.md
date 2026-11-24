# Margin

Margin is a local, searchable library for your X bookmarks. Search the wording or meaning of a post, find text inside images, and ask questions with links to the passages that support each answer.

## Run locally

Use Node.js 24 or newer and npm. From the project directory:

```sh
npm ci
npm start
```

Open <http://127.0.0.1:4173>. The sample posts, reader, keyword search, collections, and browser OCR work without an X account. Startup compiles the TypeScript UI. Models are optional for the sample.

## Search and Ask

- Search with a phrase, a description, or an `@handle`. Double quotes require a literal phrase. Combine the results with author, media, tag, review state, collection, and publication date filters.
- Open a result to read the post, browse its media, and see the matching passage. Image-text matches open the matching attachment. Closing the reader returns to the result list.
- A **collection** contains bookmarks you choose. A **saved search** reruns a query and filters over the current library. The review queue, tags, Archive, and Keep remain account-specific.
- For local semantic search, install [Ollama](https://ollama.com/) and run `ollama pull all-minilm`. Keep Ollama running on its default local port (11434). Margin builds normalized passage embeddings in the background, persists them in SQLite, and combines vector similarity with FTS5 keyword rankings. **Index coverage** reports progress. Keyword search works while the index is building.
- For generated answers, run `ollama pull gpt-oss:20b` or set `MARGIN_CHAT_MODEL` to an installed local chat model that fits your machine. **Ask library** retrieves passages from the current view, returns citations, and opens each source in the reader. Exact counts like “How many of those are videos?” use the matching records. Without a chat model, Ask can show supporting excerpts. Video audio and the contents of external articles are outside the index.
- To use OpenAI for both semantic search and Ask, set `MARGIN_AI_PROVIDER=openai` and `OPENAI_API_KEY` in the server’s ignored `.env`, then restart. Margin embeds searchable passage text and queries with `text-embedding-3-large` at 1,024 dimensions. Ask uses `gpt-6.2-sol` by default (override with `MARGIN_OPENAI_ASK_MODEL`) and sends only the question and selected text excerpts with `store: false`. Account data stays partitioned in Margin. Reindexing uses API credits. OCR still runs in the browser; any extracted **text** you index also becomes embedding input. Images and word-position boxes are not uploaded to OpenAI.
- Optional hosted synthesis uses [Ollama Cloud](https://docs.ollama.com/cloud). Set `MARGIN_OLLAMA_CLOUD_KEY` and `MARGIN_CLOUD_MODEL` on your own server. Selecting the hosted option in Ask sends the question and up to six retrieved excerpts with author attribution to Ollama. Provider pricing and terms apply. Leave the option unchecked for local inference.

## Index text inside photos

Open **Index coverage**, select a batch size, and click **Scan photos**. English OCR runs in a browser worker using Tesseract.js, with the engine and language files served by your own Margin instance. The server fetches the selected bookmarked images from X's media CDN. OCR makes no X API or hosted AI calls.

The tab saves extracted text and word positions to the account's SQLite library after each image. You can pause between images, close the tab, and resume with **Scan photos**. Empty and failed images are tracked separately, with explicit retry for failures. Content hashes allow reuse within the same account. A removed bookmark drops its associated search passages, vectors, collection memberships, and photo text.

## Import your bookmarks

1. Create an app in the [X Developer Console](https://console.x.com/) and enable OAuth 2.0 user authentication. Register the exact callback URL `http://127.0.0.1:4173/auth/callback`.
2. Copy `.env.example` to `.env`. Enter your OAuth 2.0 client ID as `X_CLIENT_ID`. For a confidential web app, also set `X_CLIENT_SECRET`.
3. Restart the server, choose **Connect X**, and authorize read access. Choose **Import from X** to fetch up to 20 bookmarks. **Import next page** continues from the saved position.
4. Select a bookmark to review it. **Keep**, **Archive**, and **Edit tags** organize your local copy. **Return to queue** reverses a review decision.

X charges for API reads. Photos, videos, and author details can add to the number of resources returned. Review the [X API pricing](https://docs.x.com/x-api/getting-started/pricing) before importing a large library.

Imports update posts by ID and preserve tags and review decisions. Margin offers another page when X supplies a continuation token. X can stop supplying pages even when more posts are visible on its website. The included importer uses the official X API. For posts already recovered from a browser timeline, **Load full post and media from X** requests the individual post using API credits. Removing a bookmark directly on X leaves its previously imported copy in Margin.

### Quoted posts and threads

Ordinary bookmark imports retain the quote and reply metadata in the bookmark response. Known same-author parent permalinks are queued for free public preview indexing. Separate paid conversation searches run only from the explicit X context controls. When requested, Margin follows the available search pages and keeps the bookmarked author’s connected self-replies. The reader places the bookmark in thread order and links each related post to X. Quotes and thread text are indexed with their original authors and remain attached to the saved bookmark rather than becoming separate bookmarks.

Older imports may lack these relationships. Open a bookmark and choose **Load quotes, author thread and media from X**, or use **Index coverage → Load context from X** for the next five unchecked bookmarks. X charges for post lookups and thread search. Older conversations can require full-archive search access. Unavailable references and failed lookups are shown as partial context; a single-bookmark refresh retries them. OpenAI credits cannot pay for X API calls.

### Remove a bookmark from X

Choose **Remove from X…** on the post. The first use requests the additional OAuth permission `bookmark.write`. After authorizing, select the post again and confirm. Margin removes its local copy after X confirms the bookmark was removed. X API charges may apply.

## Storage and access

- The database is `data/margin.sqlite`. Set `MARGIN_DATA_DIR` to change its location. To back it up, stop the server and copy the entire data directory.
- Each connected X account has a separate library. Access tokens live in server memory. Reconnect after a server restart or token expiry to make further X API calls. An existing signed-in session can still review stored posts.
- Media streams while its source is available. An unavailable attachment links to the original post.
- The server listens on the Mac or PC's loopback interface, using port 4173 by default. For phone access, put the same instance behind a private HTTPS reverse proxy, set `MARGIN_ORIGIN` to the HTTPS origin, preserve its Host header, and register its `/auth/callback` URL with X.

## Development

Install development dependencies with `npm ci`. Run `npm run check` for strict type checking, syntax checks, and integration tests. Tests simulate the X API and use a temporary local server. Node 24 runs the TypeScript backend directly. HTTP routes live in `server.ts`, and `lib/` contains the X integration, SQLite storage, and sample library.

The UI lives in `client/` with its HTML and styles in `public/`. Shared TypeScript contracts live in `shared/`. Run `npm run typecheck` to check server and browser code. Index tables are derived from the bookmark library and migrate on startup.

## License

[MIT](LICENSE).

### Preview linked posts

Post text in the reader contains clickable links. **Preview linked post** displays a saved copy from your account when available, or asks X’s public oEmbed endpoint for the post text and author. **Preview short link** checks where a t.co link points before requesting a post preview. A short link may lead to the bookmark’s own media or an external website. **Open on X** opens the post in your browser if public embedding is unavailable. Available linked-post text is indexed under the bookmark that contains the link. Search results label the linked author, and opening a match or Ask citation shows the saved source passage. Margin automatically checks direct X post URLs in the background. Previewing an individual short link also indexes any available post text.

Use **Index coverage → Linked posts** for batch indexing. Select **Also resolve t.co short links** to include links whose destinations are unknown. The queue saves progress between batches. External websites, links to a bookmark's own media, and restricted or empty previews contribute no text. Link lookups use no X developer credits. Embeddings use the configured provider and can use OpenAI credits.

### Unroll a public thread from one bookmark

Open a real bookmark and click **Unroll thread**. Margin sends that single post ID to [FxEmbed’s documented thread endpoint](https://github.com/FxEmbed/FxEmbed/blob/main/docs/specs/fxtwitter-openapi.json). It works from a root, middle, or final post when the provider returns the chain. The action requires no FxEmbed key or X developer credits. Margin keeps only posts by the bookmarked author connected by reply edges, saves their text and supported media, and indexes the parts under the original bookmark for search and Ask. Existing manual selections and API-derived context are preserved. Use **Refresh public thread** to check again.

**Index coverage → Whole threads → Index unchecked bookmarks** runs the same lookup across your library. It checkpoints each post, limits concurrent lookups and honors provider backoff. You can close the tab, pause the scan, or restart the server. A successful lookup with zero returned self-replies is recorded, so subsequent scans skip it. Transient failures retry and unavailable posts are counted separately. Full post text and the available author chain are searchable; embedding coverage is shown separately from discovery progress.

This is a third-party lookup triggered by your click. FxEmbed receives the public post ID. Margin sends no X login or API credentials. A library-wide scan sends one post ID per request. Returned coverage depends on provider availability and accessible posts. The configured embedding provider may charge for indexing the text.

### Manual thread-part import

Open a bookmark and expand **Import thread parts · no X credits**. Copy a selection of posts from the thread on X and paste it into the reader, or paste their post permalinks. Review the URLs in reading order and choose **Fetch and index these parts**. Margin fetches the available public post text, keeps it attached to the bookmark, and makes it searchable and citable. Opening a search match jumps to that part. **Clear selection** removes the grouping and any search evidence that has no other source.

**Find connected replies in library** uses stored parent-post and author IDs. You can also supply X API JSON containing `id`, `author_id`, and `referenced_tweets` to discover a connected same-author chain. Replies from third parties and quote relationships do not establish a self-thread. Manually selected parts are labeled separately. X’s own oEmbed endpoint fetches known post URLs. Margin’s one-click discovery uses FxEmbed. A clipboard selection may omit links on some clients. Review the selected URLs before importing.

Link indexing follows one additional hop from a linked post. Only X/Twitter status URLs or t.co redirects ending at a status are eligible to contribute text. External sites are never fetched. This does not trigger paid X thread search. Embeddings follow your configured provider's pricing.
