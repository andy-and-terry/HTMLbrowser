# HTML Browser

A simple in-browser navigation tool built with plain HTML, CSS, and vanilla JavaScript.  
Open `index.html` in any modern browser — no build step, no dependencies.

---

## How to Run

### Option A — Open directly
Double-click `index.html` or drag it into a browser window.  
Everything works except **Option 2 fetching** (see CORS limitations below).

### Option B — Local static server (recommended for full functionality)
A local server avoids some mixed-content restrictions and is required if you add a CORS proxy.

```bash
# Python 3
python -m http.server 8080
# then open http://localhost:8080

# Node.js (npx)
npx http-server -p 8080
# then open http://localhost:8080
```

---

## Usage

1. Type a URL in the address bar (the `https://` prefix is added automatically if omitted).
2. Press **Go** or hit **Enter**.
3. The app tries two strategies in order:

### Option 1 — iframe (preferred)
The URL is loaded directly in an `<iframe>`.  
A green status message confirms success:  
> ✓ Displayed via iframe (Option 1) — full page experience

If the page sends an `X-Frame-Options: DENY/SAMEORIGIN` or `Content-Security-Policy: frame-ancestors` header that blocks embedding, the app automatically falls back to Option 2.

### Option 2 — Fetched source (fallback)
The app fetches the page's raw HTML, injects a `<base href="…">` tag so that relative URLs (images, stylesheets, scripts, links) resolve correctly, and displays the result in a sandboxed `<iframe srcdoc="…">`.  
An amber status message confirms the mode:  
> ⚠ Displayed via fetched source (Option 2) — some scripts / styles may not work; navigation intercepted

Clicking links in Option 2 mode updates the address bar and re-runs the two-step strategy.

---

## Known Limitations

### CORS (most important for Option 2)
Modern browsers block cross-origin `fetch()` requests unless the **target server** includes permissive `Access-Control-Allow-Origin` headers.  
Most public websites do **not** include these headers, so Option 2 will fail with a CORS error for the majority of sites.

**Workaround — CORS proxy**

A CORS proxy forwards your request server-side and adds the required headers.  
You can run one locally:

```bash
# corsproxy (Node.js)
npx corsproxy
# listens on http://localhost:8010/proxy

# allorigins (Docker) — use port 8081 to avoid conflict with the dev server
docker run -p 8081:8080 ghcr.io/gnuns/allorigins
```

Then prefix the target URL with your proxy, e.g.:  
`http://localhost:8010/proxy?url=https://example.com`

> ⚠️ **Never** route sensitive/authenticated URLs through a public third-party CORS proxy.

### Mixed Content
If you open `index.html` over HTTPS, the browser will block fetches to plain `http://` URLs (mixed content).  
Use a local server served over HTTP, or upgrade target URLs to HTTPS.

### JavaScript-Heavy Sites (Option 2)
Single-page apps (React, Vue, Angular, etc.) rely heavily on JavaScript executed in their own origin context.  
In Option 2, many such sites will render incompletely because:
- Scripts that make same-origin API calls will fail (the iframe's origin is the proxy/local server, not the target domain).
- Service workers are not propagated.

### Security Note (Option 2 sandbox)
The sandboxed iframe uses `allow-scripts + allow-same-origin` so that the app can intercept link clicks.  
This means scripts in the fetched page share the parent page's origin.  
**Do not use this app to browse untrusted or malicious pages.**

### Other Limitations
- No browser history (back/forward buttons).
- No cookie or session persistence for browsed sites in Option 2.
- No support for sites that require authentication cookies set by a real browser.
- Pages using `<meta http-equiv="refresh">` or JavaScript redirects may behave differently.
