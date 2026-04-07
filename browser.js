'use strict';

/**
 * HTML Browser — browser.js
 *
 * Two-step rendering strategy:
 *   Option 1 (preferred): load the URL in a bare <iframe>.
 *   Option 2 (fallback): if the iframe lands on about:blank after load
 *     (a reliable sign that X-Frame-Options / CSP frame-ancestors blocked it),
 *     fetch the HTML source via a CORS proxy, rewrite relative URLs with a
 *     <base href>, inject a link-interception script, and render the result
 *     in a sandboxed srcdoc iframe.
 */

// ─── Configuration ────────────────────────────────────────────────────────────

/**
 * CORS proxy used in fallback mode.
 *
 * ⚠️  SECURITY / PRIVACY WARNING: The default proxy (allorigins.win) is a
 * public third-party service.  Every URL you load in Fallback Mode is sent
 * to this proxy, which can log or inspect the requests and responses.
 * Do NOT use the default proxy to browse authenticated or sensitive pages.
 * Replace this with a trusted proxy before any production or shared use.
 * See README.md for instructions on running a local proxy.
 */
const CORS_PROXY = 'https://api.allorigins.win/raw?url=';

/** How long (ms) to wait for the direct iframe to load before timing out. */
const IFRAME_TIMEOUT_MS = 8000;

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  history: [],
  historyIndex: -1,
  currentUrl: '',
  loading: false,
};

// ─── DOM References ───────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const addressBar      = $('address-bar');
const backBtn         = $('back-btn');
const forwardBtn      = $('forward-btn');
const reloadBtn       = $('reload-btn');
const goBtn           = $('go-btn');
const statusIndicator = $('status-indicator');
const statusText      = $('status-text');
const welcomeScreen   = $('welcome-screen');
const errorScreen     = $('error-screen');
const errorMessage    = $('error-message');
const retryBtn        = $('retry-btn');
const directFrame     = $('direct-frame');
const fallbackFrame   = $('fallback-frame');

// ─── URL Utilities ────────────────────────────────────────────────────────────

/**
 * Normalise a raw user input into a full https:// URL, or return null if
 * the input cannot be interpreted as a valid URL.
 */
function normalizeUrl(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return null;

  // Already has a scheme
  if (/^https?:\/\//i.test(trimmed)) {
    try { new URL(trimmed); return trimmed; } catch (_) { return null; }
  }

  // Try prepending https://
  const withHttps = 'https://' + trimmed;
  try { new URL(withHttps); return withHttps; } catch (_) { return null; }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function showWelcome() {
  welcomeScreen.classList.remove('hidden');
  errorScreen.classList.add('hidden');
  directFrame.classList.add('hidden');
  fallbackFrame.classList.add('hidden');
}

function showError(msg) {
  errorScreen.classList.remove('hidden');
  welcomeScreen.classList.add('hidden');
  directFrame.classList.add('hidden');
  fallbackFrame.classList.add('hidden');
  errorMessage.textContent = msg;
  setStatus('Error loading page', 'error');
}

function setStatus(text, mode) {
  statusText.textContent = text;
  statusIndicator.className = 'indicator-dot' + (mode ? ' ' + mode : '');
}

function updateNavButtons() {
  backBtn.disabled = state.historyIndex <= 0;
  forwardBtn.disabled = state.historyIndex >= state.history.length - 1;
}

// ─── Core Navigation ──────────────────────────────────────────────────────────

/**
 * Navigate to a URL.  addToHistory=false is used for back/forward/reload.
 */
async function navigate(rawUrl, addToHistory = true) {
  if (state.loading) return;

  const url = normalizeUrl(rawUrl);
  if (!url) {
    showError(
      `"${rawUrl}" is not a valid URL.\n` +
      'Please include a domain name, e.g. https://example.com'
    );
    return;
  }

  state.currentUrl = url;
  addressBar.value = url;

  if (addToHistory) {
    // Truncate forward history when navigating to a new URL
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(url);
    state.historyIndex = state.history.length - 1;
  }
  updateNavButtons();

  state.loading = true;
  welcomeScreen.classList.add('hidden');
  errorScreen.classList.add('hidden');
  setStatus('Loading\u2026', 'loading');

  try {
    // ── Option 1: direct iframe ──────────────────────────────────────────────
    await tryIframe(url);
    setStatus('\u2713 Direct mode \u2014 page loaded in iframe', 'iframe-mode');
  } catch (iframeErr) {
    // ── Option 2: fetch fallback ─────────────────────────────────────────────
    console.info(
      '[HTMLBrowser] Direct iframe failed (%s), trying fetch fallback.',
      iframeErr.message
    );
    setStatus('Direct mode blocked \u2014 fetching page source\u2026', 'loading');

    try {
      await tryFetch(url);
      setStatus(
        '\u26a1 Fallback mode \u2014 page source fetched and re-rendered',
        'fetch-mode'
      );
    } catch (fetchErr) {
      showError(fetchErr.message);
    }
  } finally {
    state.loading = false;
  }
}

// ─── Option 1: Direct iframe ──────────────────────────────────────────────────

/**
 * Load url in the direct (unsandboxed) iframe.
 * Resolves when the page loads successfully; rejects when:
 *   - the iframe load event fires but location is about:blank (X-Frame-Options / CSP)
 *   - the iframe.onerror fires
 *   - IFRAME_TIMEOUT_MS elapses without a load event
 */
function tryIframe(url) {
  return new Promise((resolve, reject) => {
    // Show the direct frame, hide the fallback frame
    directFrame.classList.remove('hidden');
    fallbackFrame.classList.add('hidden');
    // Clear any srcdoc left over from a previous fallback navigation
    fallbackFrame.srcdoc = '';

    let settled = false;
    const settle = (fn, val) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        directFrame.onload = null;
        directFrame.onerror = null;
        fn(val);
      }
    };

    const timer = setTimeout(
      () => settle(reject, new Error(
        `Iframe load timed out after ${IFRAME_TIMEOUT_MS / 1000} s — ` +
        'the site may be blocking embedding.'
      )),
      IFRAME_TIMEOUT_MS
    );

    directFrame.onerror = () =>
      settle(reject, new Error('Iframe network error'));

    directFrame.onload = () => {
      try {
        const loc = directFrame.contentWindow.location.href;
        // If the frame resolved to about:blank (and we didn't navigate there),
        // the site is blocking embedding via X-Frame-Options or CSP.
        if (loc === 'about:blank' || loc === '') {
          settle(reject, new Error(
            'Iframe blocked by X-Frame-Options or CSP frame-ancestors \u2014 ' +
            'switching to fallback mode.'
          ));
        } else {
          // Same-origin page: loaded successfully.
          settle(resolve, 'same-origin');
        }
      } catch (_) {
        // SecurityError: cross-origin page — we cannot read its location,
        // but that means it loaded correctly.  Treat as success.
        settle(resolve, 'cross-origin');
      }
    };

    // Guard: only allow http / https URLs to be loaded in the iframe.
    // normalizeUrl() already enforces this, but we re-check here to
    // prevent javascript: or data: URLs from being set as the src.
    if (!/^https?:\/\//i.test(url)) {
      settle(reject, new Error('Only http:// and https:// URLs are supported'));
      return;
    }

    directFrame.src = url;
  });
}

// ─── Option 2: Fetch fallback ─────────────────────────────────────────────────

/**
 * Fetch the raw HTML of url via the CORS proxy, rewrite it so that relative
 * URLs resolve correctly and link clicks are forwarded to this app, then
 * render the result in the sandboxed fallback iframe.
 */
async function tryFetch(url) {
  let html;

  try {
    const res = await fetch(
      CORS_PROXY + encodeURIComponent(url),
      { cache: 'no-store' }
    );
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    html = await res.text();
  } catch (err) {
    throw new Error(
      `Could not fetch "${url}" via CORS proxy: ${err.message}.\n` +
      'Check your internet connection or see the README for proxy options.'
    );
  }

  const rendered = injectBrowserHooks(html, url);

  // Switch to fallback frame
  directFrame.classList.add('hidden');
  directFrame.src = 'about:blank';
  fallbackFrame.classList.remove('hidden');
  fallbackFrame.srcdoc = rendered;
}

// ─── HTML Rewriting for Fallback Mode ────────────────────────────────────────

/**
 * Given raw HTML and the page's base URL, return a modified HTML string that:
 *   1. Removes any existing <base> tags (they would override ours).
 *   2. Inserts <base href="baseUrl"> at the top of <head> so that relative
 *      URLs in the page (images, stylesheets, scripts, links) resolve correctly.
 *   3. Injects a small script that intercepts anchor clicks and form GET
 *      submissions and forwards them to the parent via postMessage so this
 *      app can handle in-app navigation.
 */
function injectBrowserHooks(html, baseUrl) {
  // 1. Remove any existing <base> tags so they don't compete with ours.
  html = html.replace(/<base[^>]*>/gi, '');

  // Escape the base URL for safe HTML attribute insertion.
  const safeBase = baseUrl
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const baseTag = `<base href="${safeBase}">`;

  // 2. Insert <base href> immediately after the opening <head> tag.
  //    Fall back to prepending a minimal <head> block if <head> is missing.
  if (/<head(\s[^>]*)?>/.test(html)) {
    html = html.replace(/(<head(\s[^>]*)?>)/i, `$1${baseTag}`);
  } else if (/<html(\s[^>]*)?>/.test(html)) {
    html = html.replace(/(<html(\s[^>]*)?>)/i, `$1<head>${baseTag}</head>`);
  } else {
    html = `<head>${baseTag}</head>` + html;
  }

  // 3. Inject the link-interception hook just before </body>.
  //    The hook runs in the sandboxed iframe (null origin) and communicates
  //    with this app exclusively via postMessage.
  const hookScript = buildHookScript();

  if (/<\/body>/i.test(html)) {
    html = html.replace(/<\/body>/i, `${hookScript}</body>`);
  } else {
    html += hookScript;
  }

  return html;
}

/**
 * Build the inline <script> block that is injected into fetched pages.
 * It intercepts anchor clicks and GET form submissions and notifies the
 * parent window via postMessage so this app can navigate in-app.
 */
function buildHookScript() {
  /* NOTE: The closing </script> tag is split to avoid terminating the
     template literal early when the string is embedded in HTML. */
  return `<script>
(function () {
  'use strict';

  // Intercept all anchor clicks and forward the resolved (absolute) href.
  document.addEventListener('click', function (e) {
    var el = e.target;
    // Walk up the DOM in case the click landed on a child element inside <a>.
    while (el && el.tagName !== 'A') {
      el = el.parentElement;
    }
    if (
      el &&
      el.tagName === 'A' &&
      el.href &&
      !el.href.startsWith('javascript:') &&
      !el.href.startsWith('mailto:') &&
      !el.href.startsWith('tel:')
    ) {
      e.preventDefault();
      // el.href is already absolute thanks to the <base> tag.
      window.parent.postMessage({ type: 'navigate', url: el.href }, '*');
    }
  }, true);

  // Intercept GET form submissions.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if ((form.method || 'get').toLowerCase() !== 'get') return;
    e.preventDefault();
    var action = form.action || window.location.href;
    var params = new URLSearchParams(new FormData(form)).toString();
    var dest   = params
      ? action + (action.indexOf('?') === -1 ? '?' : '&') + params
      : action;
    window.parent.postMessage({ type: 'navigate', url: dest }, '*');
  }, true);
}());
<\\/script>`.replace('<\\/script>', '</script>');
}

// ─── Event Listeners ──────────────────────────────────────────────────────────

goBtn.addEventListener('click', () => navigate(addressBar.value));

addressBar.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') navigate(addressBar.value);
});

backBtn.addEventListener('click', () => {
  if (state.historyIndex > 0) {
    state.historyIndex--;
    navigate(state.history[state.historyIndex], false);
  }
});

forwardBtn.addEventListener('click', () => {
  if (state.historyIndex < state.history.length - 1) {
    state.historyIndex++;
    navigate(state.history[state.historyIndex], false);
  }
});

reloadBtn.addEventListener('click', () => {
  if (state.currentUrl) navigate(state.currentUrl, false);
});

retryBtn.addEventListener('click', () => {
  if (state.currentUrl) navigate(state.currentUrl, false);
});

// Handle navigation messages posted by the fallback iframe's hook script.
// Validate both the message source (must be our fallback iframe) and the
// URL scheme (must be http or https) before acting on the message.
window.addEventListener('message', (e) => {
  if (
    e.source !== fallbackFrame.contentWindow ||
    !e.data ||
    e.data.type !== 'navigate' ||
    typeof e.data.url !== 'string' ||
    !/^https?:\/\//i.test(e.data.url)
  ) {
    return;
  }
  navigate(e.data.url);
});

// Preset URL buttons on the welcome screen.
document.querySelectorAll('.preset-url').forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.url));
});

// ─── Initialise ───────────────────────────────────────────────────────────────

updateNavButtons();
addressBar.focus();
