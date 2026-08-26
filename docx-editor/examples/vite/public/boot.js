/*
 * Boot shims, in a file rather than inline in index.html.
 *
 * These two used to be an inline <script>. Under the editor's
 * Content-Security-Policy (`script-src 'self'`) the browser refuses to execute
 * inline script, and the honest fix is to move the code to a file we serve --
 * not to add 'unsafe-inline', which would re-permit every injected <script> on
 * the page to buy back sixty lines of shim.
 *
 * This must stay a classic (non-module, non-defer) script in <head>: it runs
 * synchronously before the module bundle, which is the only reason the
 * chunk-recovery listener below is registered in time to catch the failure it
 * exists for. Serving it from `public/` keeps it same-origin and unhashed, so
 * editing it never requires touching the policy.
 */

// Detect when Material Symbols font is loaded
if (document.fonts) {
  document.fonts.ready.then(function () {
    document.documentElement.classList.add('fonts-loaded');
  });
  document.fonts.load('24px "Material Symbols Outlined"').then(function () {
    document.documentElement.classList.add('fonts-loaded');
  });
} else {
  setTimeout(function () {
    document.documentElement.classList.add('fonts-loaded');
  }, 500);
}

// Stale-deploy recovery — after a fresh build, the previous
// index.html still points at chunks with old hashes; the first
// navigation that lazy-loads one of those chunks gets a 404 and
// crashes the editor. We catch the typed Vite preloadError event
// (and the generic "Failed to fetch dynamically imported module"
// unhandledrejection from non-Vite chunks) and force-reload the
// page, which re-fetches index.html and the current hash refs.
// The session-storage guard stops us from looping if the reload
// itself fails for an unrelated reason.
(function () {
  var KEY = 'casual:chunk-reload-at';
  function shouldReload() {
    try {
      var last = parseInt(sessionStorage.getItem(KEY) || '0', 10);
      return Date.now() - last > 20000;
    } catch (_) {
      return true;
    }
  }
  function reloadOnce() {
    try {
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch (_) {}
    window.location.reload();
  }
  window.addEventListener('vite:preloadError', function (e) {
    if (!shouldReload()) return;
    e.preventDefault();
    reloadOnce();
  });
  window.addEventListener('unhandledrejection', function (e) {
    var msg = e && e.reason && (e.reason.message || String(e.reason));
    if (msg && /Failed to fetch dynamically imported module/i.test(msg) && shouldReload()) {
      reloadOnce();
    }
  });
})();
