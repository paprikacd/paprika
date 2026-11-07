/*
 * Flaggr analytics for the public Paprika site. The issued site ID is public;
 * credentials never belong in this file or its script tag.
 *
 * a.js owns pageviews, Web Vitals, errors and scroll depth. It collects the
 * current URL, including documentation ?q= searches. This adapter adds only
 * fixed conversion names; it does not make the vendor's collection path-only.
 */
(() => {
  'use strict';

  const siteId = document.currentScript?.dataset?.siteId;
  if (typeof siteId !== 'string' || siteId !== siteId.trim() || !/^site_[A-Za-z0-9_-]{1,123}$/.test(siteId)) return;

  try {
    if (location.origin !== 'https://paprikacd.github.io' || !location.pathname.startsWith('/paprika/')) return;
    if (window.top !== window.self || navigator.doNotTrack === '1') return;
  } catch {
    return;
  }

  const installed = '__paprikaFlaggrAdapter';
  if (window[installed] || !document.head) return;
  // A separately installed vendor tag already owns collection. Do not inject
  // another instance or assume that its loading/configuration belongs to us.
  if (Array.from(document.scripts).some((script) => {
    if (!script.src) return false;
    try {
      const url = new URL(script.src, location.href);
      return url.origin === 'https://cdn.flaggr.dev' && /^\/a(?:-[^/]+)?\.js$/.test(url.pathname);
    } catch {
      return false;
    }
  })) return;
  window[installed] = true;

  const allowed = new Set([
    'get_started', 'cli_download', 'docs_open', 'demo_open', 'blog_open',
    'mcp_copy', 'code_copy', 'docs_search',
  ]);
  const queued = [];
  const maxQueued = 20;
  let state = 'loading';
  let timeout;
  const sdk = document.createElement('script');

  function emit(name) {
    try {
      window.dispatchEvent(new CustomEvent('flaggr:conversion', { detail: { name } }));
    } catch {
      // Analytics cannot interrupt navigation or a successful product action.
    }
  }

  function record(name) {
    if (typeof name !== 'string' || !allowed.has(name) || state === 'stopped') return;
    if (state === 'ready') emit(name);
    else if (queued.length < maxQueued) queued.push(name);
  }

  function onClick(event) {
    if (event.defaultPrevented || (typeof event.button === 'number' && event.button !== 0)) return;
    const target = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
    const element = target?.closest?.('[data-analytics-event]');
    record(element?.getAttribute('data-analytics-event'));
  }

  function onSignal(event) {
    // Explicit actions (successful copy/search submission) use paprika:analytics. Extra detail,
    // search terms, code text and arbitrary DOM text/URLs are never forwarded.
    record(event.detail?.name);
  }

  function stop() {
    if (state !== 'loading') return;
    state = 'stopped';
    queued.length = 0;
    window.clearTimeout(timeout);
    document.removeEventListener('click', onClick);
    window.removeEventListener('paprika:analytics', onSignal);
    sdk.remove();
  }

  sdk.src = 'https://cdn.flaggr.dev/a-0.1.9.js';
  sdk.integrity = 'sha384-UbokEwOv+WfuKvg33yULNZRqXEMFKfrK39J4QItWznOG1IXviooN+w65ec5D6izH';
  sdk.crossOrigin = 'anonymous';
  sdk.async = true;
  sdk.setAttribute('data-site-id', siteId);
  sdk.setAttribute('data-track-clicks', 'false');
  sdk.setAttribute('data-track-errors', 'true');
  sdk.setAttribute('data-track-scroll', 'true');
  sdk.setAttribute('data-respect-dnt', 'true');
  sdk.addEventListener('load', () => {
    if (state !== 'loading') return;
    state = 'ready';
    window.clearTimeout(timeout);
    for (const name of queued.splice(0)) emit(name);
  }, { once: true });
  sdk.addEventListener('error', stop, { once: true });
  document.addEventListener('click', onClick);
  window.addEventListener('paprika:analytics', onSignal);
  // A slow or blocked CDN gets no retries and retains at most 20 conversions.
  // Navigation never waits for it; late load events cannot flush a timed-out queue.
  timeout = window.setTimeout(stop, 10000);
  try {
    document.head.appendChild(sdk);
  } catch {
    stop();
  }
})();
