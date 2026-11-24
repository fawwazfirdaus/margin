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

New API imports request quoted posts and follow nested quotes. For a bookmarked thread, Margin follows every available search page, then keeps the bookmarked author’s connected self-replies. The reader places the bookmark in thread order and links each related post to X. Quotes and thread text are indexed with their original authors and remain attached to the saved bookmark rather than becoming separate bookmarks.

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
