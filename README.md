# e621 Post Browser

Functional dark-themed e621 post browser using a single Node.js entry point (`server.js`).

## Run locally

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Render

Build command: `npm install`

Start command: `npm start`

The server listens on Render's supplied `PORT` environment variable.

## Environment variables

- `PORT` — supplied by Render; defaults to `3000` locally.
- `E621_BASE_URL` — optional, defaults to `https://e621.net`.
- `E621_USER_AGENT` — optional descriptive e621 User-Agent.
- `TRUST_PROXY` — set to `true` when running behind a trusted reverse proxy. It is automatically enabled when `RENDER=true`.
- `TRUST_PROXY_HOPS` — number of trusted proxy hops; defaults to `1`.

## Architecture

`server.js` serves the static frontend and proxies e621 API requests. The frontend keeps per-browser navigation state in `sessionStorage`, so users behind the same public NAT address do not share browsing state.

### API request pacing and cache

API requests are globally serialized and spaced at least 1100 ms apart. Identical in-flight e621 API URLs reuse the same promise, preventing simultaneous duplicate requests. Successful API/search/tag responses are cached for a short bounded period.

A genuine HTTP 429 is surfaced as a rate-limit error; the application does not immediately retry in a loop.

### Video/media pipeline

The browser loads post media from e621's CDN. When e621 supplies an H.264 MP4 alternate for an MP4 or WebM post, the browser uses that alternate rather than the original file so the video track is broadly supported by browsers.

The CDN supplies the normal HTTP byte-range response required for seeking and decoding.

Videos use native controls, autoplay, preload, inline playback, and `volume = 1.0` without an audio-unlock overlay. Audible autoplay is attempted normally; if the browser blocks it, the video remains usable for manual playback. Video elements also use the width/height supplied by e621 so they do not fall back to the browser's 300x150 default size while media metadata is unavailable.

### Search normalization

There is one authoritative search normalization function. The selected rating/order dropdowns override manually supplied `rating:`/`order:` tokens. `rating:any` adds no rating filter and `order:default` adds no explicit order tag.

### Logging and IPs

Server logs include the requested user/IP events. Localhost may appear as `127.0.0.1` or `::1`; this is normal because the Node process is receiving a local connection. Trusted forwarded headers are only used when proxy trust is explicitly enabled (or the deployment is marked `RENDER=true`).

## Main files

- `server.js` — server, e621 API proxy, bounded cache, request queue, logging, IP handling.
- `public/index.html` — UI shell; document title is exactly `Render`.
- `public/app.js` — controls, navigation, search, media lifecycle, tags panel, keyboard shortcuts.
- `public/styles.css` — dark responsive layout and media sizing.
- `package.json` — startup configuration.

## Optional e621 account sync

This build can run all e621 API requests as one configured account. The server keeps the account API key private and sends authenticated requests directly to e621.

Configure these **Render environment variables** (or equivalent server environment variables locally):

```text
E621_ACCOUNT_USERNAME=YOUR_E621_USERNAME
E621_ACCOUNT_API_KEY=YOUR_E621_API_KEY
```

`account.config.js` reads only from these environment variables; it contains no hard-coded credential fallback. The API key therefore stays on the server and is never sent to the browser.

Use an e621 **API key**, not your account password and not a browser-cookie export. The e621 API tooling documents authentication as a username plus API key pair, and the current API exposes `GET /users/me.json` for the authenticated account. citeturn608725search4turn946321search0

The browser never receives the API key. The server fetches `/users/me.json` and synchronizes the account profile/settings, including available preference fields, plus the account's `blacklisted_tags`. Search results are filtered against the synchronized blacklist before they are returned to the browser. The underlying e621 user model includes fields such as `theme`, `per_page`, `default_image_size`, and `blacklisted_tags`. citeturn861921search0

The existing browser remains dark regardless of the account's e621 theme setting so the application's existing dark-theme requirement is preserved.

### Security note

Do not commit real API credentials to a public repository. For Render, use the service's environment-variable settings and leave the placeholder values in `account.config.js`. If you hard-code a key locally, treat the resulting file as a secret.
