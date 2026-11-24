# Margin

Margin is a local web app for reviewing your X bookmarks one post at a time. Browse photos, play videos, and search by author, text, or tag. Your library and review decisions live in SQLite on your machine.

## Try the sample library

From the project directory, run the following with Node.js 24 or newer.

```sh
npm start
```

Open <http://127.0.0.1:4173> to try the sample posts, images, and video. The sample runs without X credentials or package installation.

## Import your bookmarks

1. Create an app in the [X Developer Console](https://console.x.com/) and enable OAuth 2.0 user authentication. Register the exact callback URL `http://127.0.0.1:4173/auth/callback`.
2. Copy `.env.example` to `.env`. Enter your OAuth 2.0 client ID as `X_CLIENT_ID`. For a confidential web app, also set `X_CLIENT_SECRET`.
3. Restart the server, choose **Connect X**, and authorize read access. Choose **Import from X** to fetch up to 20 bookmarks. **Import next page** continues from the saved position.
4. Select a bookmark to review it. **Keep**, **Archive**, and **Edit tags** organize your local copy. **Return to queue** reverses a review decision.

X charges for API reads. Photos, videos, and author details can add to the number of resources returned. Review the [X API pricing](https://docs.x.com/x-api/getting-started/pricing) before importing a large library.

Imports update posts by ID and preserve tags and review decisions. Margin offers another page when X supplies a continuation token. X can stop supplying pages even when more posts are visible on its website. The included importer uses the official X API. For posts already recovered from a browser timeline, **Load full post and media from X** requests the individual post using API credits. Removing a bookmark directly on X leaves its previously imported copy in Margin.

### Remove a bookmark from X

Choose **Remove from X…** on the post. The first use requests the additional OAuth permission `bookmark.write`. After authorizing, select the post again and confirm. Margin removes its local copy after X confirms the bookmark was removed. X API charges may apply.

## Storage and access

- The database is `data/margin.sqlite`. Set `MARGIN_DATA_DIR` to change its location. To back it up, stop the server and copy the entire data directory.
- Each connected X account has a separate library. Access tokens live in server memory. Reconnect after a server restart or token expiry to make further X API calls. An existing signed-in session can still review stored posts.
- Media streams while its source is available. An unavailable attachment links to the original post.
- The server listens on the Mac or PC's loopback interface, using port 4173 by default. For phone access, put the same instance behind a private HTTPS reverse proxy, set `MARGIN_ORIGIN` to the HTTPS origin, preserve its Host header, and register its `/auth/callback` URL with X.

## Development

Install development dependencies with `npm ci`. Run `npm run check` for strict type checking, syntax checks, and integration tests. Tests simulate the X API and use a temporary local server. Node 24 runs the TypeScript backend directly. HTTP routes live in `server.ts`, and `lib/` contains the X integration, SQLite storage, and sample library.

The current UI is plain JavaScript in `public/`. Its API client (`public/api.js`) and the backend share bookmark, media, and response types from `shared/contracts.ts`. Run `npm run typecheck` to check both the Node and browser contracts.

## License

[MIT](LICENSE).
