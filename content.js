// Inject inject.js into the page context so we can monkey-patch window.fetch/XHR.
(() => {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inject.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();