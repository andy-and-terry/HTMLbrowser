(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────────────
  var addressBar = document.getElementById('address-bar');
  var goBtn      = document.getElementById('go-btn');
  var statusText = document.getElementById('status-text');
  var loading    = document.getElementById('loading');
  var errorBox   = document.getElementById('error-message');
  var container  = document.getElementById('browser-container');
  var frame      = document.getElementById('browser-frame');
  var lockIcon   = document.getElementById('lock-icon');

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Normalise a user-entered string into a full URL.
   * Throws an Error with a user-friendly message on failure.
   */
  function normaliseUrl(raw) {
    raw = (raw || '').trim();
    if (!raw) throw new Error('Please enter a URL.');
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    try {
      return new URL(raw).href;
    } catch (_) {
      throw new Error('Invalid URL: "' + raw + '".\nMake sure you include a valid domain (e.g. https://example.com).');
    }
  }

  /** Update the status-bar text and colour class. */
  function setStatus(text, cls) {
    statusText.textContent = text;
    statusText.className = cls || '';
  }

  /** Show/hide the loading overlay vs the iframe container. */
  function showLoading(on) {
    loading.classList.toggle('hidden', !on);
    container.classList.toggle('hidden', on);
    errorBox.classList.add('hidden');
  }

  /** Replace the iframe container with an error message. */
  function showError(msg) {
    loading.classList.add('hidden');
    container.classList.add('hidden');
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
    setStatus('Error', 'error');
  }

  /** Reset iframe to a clean state. */
  function resetFrame() {
    frame.onload  = null;
    frame.onerror = null;
    // Remove srcdoc first so setting src='about:blank' takes effect
    frame.removeAttribute('srcdoc');
    frame.src = 'about:blank';
  }

  // ── Option 1 – iframe ─────────────────────────────────────────────────────

  /**
   * Attempt to display `url` in an unsandboxed iframe.
   *
   * Resolves with 'iframe' on success.
   * Rejects with a specific sentinel error string when the iframe is blocked
   * (X-Frame-Options / CSP frame-ancestors) or times out.
   *
   * Detection logic:
   *   • If contentDocument access throws SecurityError  → cross-origin page
   *     loaded successfully (browser enforces same-origin policy, but the
   *     page IS displayed to the user).
   *   • If contentDocument is accessible but body is empty → browser refused
   *     to show the page (X-Frame-Options / CSP) → treat as blocked.
   */
  function tryIframe(url) {
    return new Promise(function (resolve, reject) {
      setStatus('Trying to display in iframe (Option 1)…', 'loading');
      resetFrame();
      // Remove sandbox so the real site is not artificially restricted.
      frame.removeAttribute('sandbox');

      var settled = false;

      function settle(fn) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        frame.onload  = null;
        frame.onerror = null;
        fn();
      }

      // Fallback timeout – some sites never fire load when blocked.
      var timer = setTimeout(function () {
        settle(function () { reject('iframe_timeout'); });
      }, 10000);

      frame.onerror = function () {
        settle(function () { reject('iframe_error'); });
      };

      frame.onload = function () {
        settle(function () {
          var blocked = false;
          try {
            var doc = frame.contentDocument;
            // Accessible contentDocument ⇒ same-origin load OR blocked frame.
            // When a browser enforces X-Frame-Options / CSP it refuses to render
            // the page and leaves an empty document (no body content, no title).
            // A legitimately blank same-origin page would also match, but that
            // edge-case is acceptable given the current heuristic approach.
            var title = (doc && doc.title) ? doc.title.trim() : '';
            var body  = (doc && doc.body)  ? doc.body.innerHTML.trim() : '';
            if (!doc || (!body && !title)) {
              blocked = true;
            }
          } catch (e) {
            // SecurityError: cross-origin page loaded fine; the user sees it.
            blocked = false;
          }

          if (blocked) {
            reject('iframe_blocked');
          } else {
            resolve('iframe');
          }
        });
      };

      frame.src = url;
    });
  }

  // ── Option 2 – fetch + render ─────────────────────────────────────────────

  /**
   * Fetch the HTML source of `url`, inject a <base> tag so relative URLs
   * resolve correctly, then display the result in a sandboxed srcdoc iframe.
   */
  function fallbackFetch(url) {
    setStatus('iframe blocked — fetching page source (Option 2)…', 'loading');

    return fetch(url)
      .then(function (response) {
        if (!response.ok) {
          throw new Error('Server returned ' + response.status + ' ' + response.statusText + '.');
        }
        var ct = response.headers.get('content-type') || '';
        if (!ct.includes('text/html') && !ct.includes('text/plain')) {
          throw new Error(
            'The resource at "' + url + '" does not appear to be an HTML page\n' +
            '(Content-Type: ' + ct + ').'
          );
        }
        return response.text();
      })
      .then(function (html) {
        renderFetchedHtml(html, url);
      })
      .catch(function (err) {
        // Distinguish CORS network errors from other failures.
        // TypeError with no HTTP status = network-level block (CORS, DNS, offline).
        // The exact message text varies by browser, so we check the error type.
        if (err instanceof TypeError) {
          throw new Error(
            'Cannot fetch "' + url + '" — the request was blocked by the browser\'s\n' +
            'CORS policy (the target server does not allow cross-origin requests).\n\n' +
            'To use Option 2 you need a CORS proxy.  See README.md for details.'
          );
        }
        throw err;
      });
  }

  /**
   * Parse `html`, inject/update a <base> tag to `baseUrl`, serialise back to
   * a string, and load it into a sandboxed srcdoc iframe.
   */
  function renderFetchedHtml(html, baseUrl) {
    var parser = new DOMParser();
    var doc    = parser.parseFromString(html, 'text/html');

    // Inject / update <base> so all relative URLs resolve against the origin.
    var base = doc.querySelector('base');
    if (!base) {
      base = doc.createElement('base');
      doc.head.insertBefore(base, doc.head.firstChild);
    }
    base.href = baseUrl;

    var serialised = '<!DOCTYPE html>' + doc.documentElement.outerHTML;

    resetFrame();
    // Sandbox allows scripts & forms while preventing the embedded page from
    // navigating the top frame.  allow-same-origin is required so that we can
    // intercept link clicks via contentDocument.
    // NOTE: combining allow-scripts + allow-same-origin means sandboxed scripts
    // share the parent origin; this is a deliberate trade-off to keep link
    // interception simple.  Malicious fetched content could theoretically
    // access the parent frame – this is documented in README.md.
    frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-same-origin allow-popups');
    frame.onload = function () {
      interceptLinks(baseUrl);
    };
    frame.srcdoc = serialised;
  }

  /**
   * After the srcdoc iframe loads, hook all `<a href>` clicks so that
   * navigation stays within the app rather than opening a new tab or failing.
   */
  function interceptLinks(pageUrl) {
    try {
      var doc = frame.contentDocument;
      if (!doc) return;

      doc.addEventListener('click', function (e) {
        var link = e.target.closest('a[href]');
        if (!link) return;

        var href = link.getAttribute('href');
        if (!href || href === '#' || /^javascript:/i.test(href)) return;

        e.preventDefault();

        var resolved;
        try {
          // link.baseURI honours the <base> tag we injected.
          resolved = new URL(href, link.baseURI || pageUrl).href;
        } catch (_) {
          return; // ignore malformed hrefs
        }

        navigate(resolved);
      });
    } catch (_) {
      // Cannot access contentDocument (e.g. sandbox without allow-same-origin).
    }
  }

  // ── Main navigation entry point ───────────────────────────────────────────

  function navigate(rawUrl) {
    var url;
    try {
      url = normaliseUrl(rawUrl);
    } catch (err) {
      showError(err.message);
      return;
    }

    addressBar.value = url;

    // Show/hide the lock icon for HTTPS.
    try {
      lockIcon.classList.toggle('hidden', new URL(url).protocol !== 'https:');
    } catch (_) {
      lockIcon.classList.add('hidden');
    }

    showLoading(true);

    tryIframe(url)
      .then(function () {
        showLoading(false);
        setStatus('✓ Displayed via iframe (Option 1) — full page experience', 'option1');
      })
      .catch(function (sentinel) {
        // Any sentinel value means the iframe was blocked / timed out / errored.
        return fallbackFetch(url)
          .then(function () {
            showLoading(false);
            setStatus(
              '⚠ Displayed via fetched source (Option 2) — ' +
              'some scripts / styles may not work; navigation intercepted',
              'option2'
            );
          })
          .catch(function (err) {
            showError(err.message);
          });
      });
  }

  // ── Event listeners ───────────────────────────────────────────────────────

  goBtn.addEventListener('click', function () {
    navigate(addressBar.value);
  });

  addressBar.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') navigate(addressBar.value);
  });

  // Allow clicking the address bar to select all text for easy replacement.
  addressBar.addEventListener('focus', function () {
    addressBar.select();
  });

}());
