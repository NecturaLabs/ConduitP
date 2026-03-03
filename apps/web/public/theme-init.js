// Synchronous theme initializer — loaded as a blocking <script> in <head>
// to prevent FOUC (Flash of Unstyled Content) when the user's persisted
// theme differs from the static default (midnight/dark) in index.html.
//
// Reads the Zustand-persisted theme from localStorage ('conduit-theme')
// and applies data-theme + dark/light class to <html> before first paint.
//
// IMPORTANT: Keep the light-theme list in sync with useApplyTheme() in App.tsx.
// Light themes: frost, sakura
(function () {
  try {
    var raw = localStorage.getItem('conduit-theme');
    if (!raw) return;
    var parsed = JSON.parse(raw);
    var theme = parsed && parsed.state && parsed.state.theme;
    if (!theme || typeof theme !== 'string') return;

    var root = document.documentElement;
    root.setAttribute('data-theme', theme);

    if (theme === 'frost' || theme === 'sakura') {
      root.className = root.className.replace(/\bdark\b/, '').trim() + ' light';
    } else {
      root.className = root.className.replace(/\blight\b/, '').trim();
      if (root.className.indexOf('dark') === -1) {
        root.className = root.className.trim() + ' dark';
      }
    }
  } catch (e) {
    // Malformed JSON or SecurityError — keep the static default
    // (data-theme="midnight" class="dark") from index.html.
  }
})();
