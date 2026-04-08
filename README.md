# HTML Browser

A lightweight in-browser web navigation tool built with vanilla HTML, CSS, and JavaScript — no build step, no dependencies, no server required (for basic use).

## Features

- **Direct Mode (Option 1):** Loads any URL directly in an embedded `<iframe>` — fastest option with full page fidelity.
- **Fallback Mode (Option 2):** When a site blocks embedding (via `X-Frame-Options` or `Content-Security-Policy: frame-ancestors`), the app **automatically** fetches the page source through a CORS proxy, rewrites relative URLs with `<base href>`, and re-renders the HTML in a sandboxed `srcdoc` iframe with working links.
- Address bar with URL entry (bare domains like `example.com` are accepted).
- Back / Forward / Reload navigation controls.
- Visual status indicator showing which mode is active.
- In-app link interception in fallback mode (clicks stay inside the browser app).

## Usage

1. Open `index.html` in any modern web browser.
2. Type a URL in the address bar and press **Enter** or click **Go**.
3. The app tries Direct Mode first; if blocked, it automatically falls back.

### Quick start — open locally

```bash
# macOS
open index.html

# Linux
xdg-open index.html

# Or serve via any static file server to avoid browser file:// restrictions:
python3 -m http.server 8080
# then open http://localhost:8080
```

## Architecture

| File         | Purpose                                                      |
|--------------|--------------------------------------------------------------|
| `index.html` | App shell — toolbar, status bar, iframe containers           |
| `style.css`  | Browser chrome styles (dark theme)                           |
| `browser.js` | Core logic: URL handling, iframe loading, CORS-proxy fetch, HTML rewriting, navigation history |

### How iframe-blocking is detected

After setting `iframe.src`, the app waits for the `load` event and then checks `contentWindow.location.href`:

| Result | Interpretation |
|--------|----------------|
| Throws `SecurityError` | Cross-origin page — loaded successfully in iframe ✓ |
| Returns the page URL | Same-origin page — loaded successfully ✓ |
| Returns `about:blank` | Blocked by `X-Frame-Options` / CSP — trigger fallback ✗ |

A configurable 8-second timeout also triggers the fallback if the `load` event never fires.

### HTML rewriting (Fallback Mode)

`injectBrowserHooks()` in `browser.js`:
1. Removes any existing `<base>` tags from the fetched HTML.
2. Inserts `<base href="<original URL>">` at the top of `<head>` so all relative URLs (images, stylesheets, scripts, links) resolve against the original host.
3. Injects a small inline script that intercepts `<a>` clicks and GET form submissions and forwards the resolved absolute URL to the parent app via `postMessage`.

The fallback iframe uses `sandbox="allow-scripts allow-forms allow-popups allow-modals"` **without** `allow-same-origin`, so the fetched content has a null/opaque origin and cannot access this app's cookies, `localStorage`, or `sessionStorage`.

## Known Limitations

### CORS in Fallback Mode

Browsers enforce the **same-origin policy**, which prevents `fetch()` calls from this app's page directly to other domains. Fallback Mode routes requests through a public CORS proxy ([api.allorigins.win](https://api.allorigins.win)) configured in `browser.js`:

```js
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';
```

This means:
- An internet connection is required for Fallback Mode.
- The proxy service can see requested URLs — **avoid browsing sensitive or authenticated pages in Fallback Mode**.
- The proxy may be rate-limited or temporarily unavailable.

#### Running your own local CORS proxy

For privacy or reliability, replace the `CORS_PROXY` constant with a local proxy:

```bash
# Option A — Node.js (npx, no install required)
npx local-cors-proxy --proxyUrl http://localhost:8010/proxy
```

Then update `browser.js`:
```js
const CORS_PROXY = 'http://localhost:8010/proxy?url=';
```

### Other Limitations

| Limitation | Detail |
|------------|--------|
| **Mixed content** | Browsers block HTTP sub-resources inside an HTTPS page. If you serve this app over HTTPS, loading HTTP-only sites via Fallback Mode may fail. |
| **JavaScript-heavy SPAs** | Fallback Mode sandboxes the iframe (no `allow-same-origin`), so cookies, `localStorage`, and `sessionStorage` are unavailable inside the rendered page. Complex SPAs may not function fully. |
| **Authentication** | Login sessions depend on cookies, which are blocked in the sandboxed fallback iframe. |
| **iframe detection heuristic** | The `about:blank` check works for most sites, but a small number of pages may navigate their iframe content to `about:blank` intentionally, triggering an unnecessary fallback switch. |
| **Relative `src` rewriting** | The `<base href>` approach handles the most common assets automatically. Dynamically generated URLs in JavaScript (e.g., `fetch('/api/data')`) are not rewritten and will still hit the fetched page's original origin — these requests will typically fail due to CORS. |
| **Media** | Video/audio embeds may fail due to CORS headers or mixed-content restrictions. |
