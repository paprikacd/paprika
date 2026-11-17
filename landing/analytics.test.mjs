import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('./analytics.js', import.meta.url), 'utf8');
const production = 'https://paprikacd.github.io/paprika/';
// All script elements, events and timers below are in-memory fakes. These
// tests never load the vendor script or send events to a real analytics site.
const fixtureSiteId = 'site_offline_fixture';

class Events {
  listeners = new Map();
  addEventListener(name, listener, options = {}) {
    const entries = this.listeners.get(name) || [];
    entries.push({ listener, once: Boolean(options.once) });
    this.listeners.set(name, entries);
  }
  removeEventListener(name, listener) {
    this.listeners.set(name, (this.listeners.get(name) || []).filter((entry) => entry.listener !== listener));
  }
  dispatchEvent(event) {
    for (const entry of [...(this.listeners.get(event.type) || [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.listener);
      entry.listener.call(this, event);
    }
    return true;
  }
}

function harness({ url = production, siteId = fixtureSiteId, dnt, iframe = false, existingSDK, appendFails = false } = {}) {
  const location = new URL(url);
  const window = new Events();
  const document = new Events();
  const inserted = [];
  const conversions = [];
  const timers = new Map();
  let nextTimer = 0;
  let now = 0;
  class CustomEvent {
    constructor(type, { detail } = {}) { this.type = type; this.detail = detail; }
  }
  window.self = window;
  window.top = iframe ? {} : window;
  window.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, due: now + delay });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.addEventListener('flaggr:conversion', (event) => conversions.push(JSON.parse(JSON.stringify(event.detail))));
  document.currentScript = { dataset: { siteId }, src: `${production}analytics.js` };
  document.scripts = [document.currentScript, ...(existingSDK ? [{ src: existingSDK }] : [])];
  document.createElement = (tag) => {
    assert.equal(tag, 'script');
    const script = new Events();
    script.attributes = new Map();
    script.setAttribute = (name, value) => script.attributes.set(name, value);
    script.getAttribute = (name) => script.attributes.get(name) ?? null;
    script.remove = () => { document.scripts = document.scripts.filter((item) => item !== script); };
    return script;
  };
  document.head = {
    appendChild(script) {
      if (appendFails) throw new Error('Script insertion refused');
      inserted.push(script);
      document.scripts.push(script);
    },
  };
  const context = { window, document, location, navigator: { doNotTrack: dnt }, URL, CustomEvent };
  return {
    window, document, inserted, conversions, timers,
    execute: () => runInNewContext(source, context, { timeout: 1000 }),
    load: () => inserted.at(-1).dispatchEvent({ type: 'load' }),
    fail: () => inserted.at(-1).dispatchEvent({ type: 'error' }),
    advance(ms) {
      now += ms;
      for (const [id, task] of [...timers]) if (task.due <= now) { timers.delete(id); task.callback(); }
    },
    signal(name, extra = {}) {
      window.dispatchEvent(new CustomEvent('paprika:analytics', { detail: { name, ...extra } }));
    },
    click(name, overrides = {}) {
      const element = {
        getAttribute: (attribute) => { assert.equal(attribute, 'data-analytics-event'); return name; },
        get textContent() { throw new Error('Conversion adapter must not inspect element text'); },
        get href() { throw new Error('Conversion adapter must not inspect link URLs'); },
      };
      document.dispatchEvent({
        type: 'click', button: 0, defaultPrevented: false,
        target: { closest: (selector) => { assert.equal(selector, '[data-analytics-event]'); return name == null ? null : element; } },
        ...overrides,
      });
    },
  };
}

test('no collection on previews, other properties, HTTP or embedded windows', () => {
  for (const options of [
    { url: 'http://localhost:4173/paprika/' },
    { url: 'https://paprikacd.github.io/another-project/' },
    { url: 'https://paprikacd.github.io/paprika-other/' },
    { url: 'https://preview.example/paprika/' },
    { url: 'http://paprikacd.github.io/paprika/' },
    { url: 'https://paprikacd.github.io:8443/paprika/' },
    { iframe: true },
    { dnt: '1' },
  ]) {
    const h = harness(options);
    h.execute(); h.click('get_started'); h.signal('docs_search');
    assert.equal(h.inserted.length, 0, JSON.stringify(options));
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.conversions, []);
  }
});

test('missing and malformed public IDs never load a collector', () => {
  for (const siteId of ['', null, 'project-id', 'site_', 'site_has spaces', 'site_\"invalid', 'site_test\n', `site_${'x'.repeat(124)}`]) {
    const h = harness({ siteId }); h.execute();
    assert.equal(h.inserted.length, 0, String(siteId));
  }
  const h = harness();
  h.document.currentScript = null;
  h.execute();
  assert.equal(h.inserted.length, 0);
});

test('loads the pinned classic script once with integrity and explicit collection settings', () => {
  const h = harness({ url: `${production}docs/?q=arbitrary-search-text` });
  h.execute(); h.execute();
  assert.equal(h.inserted.length, 1);
  const script = h.inserted[0];
  assert.equal(script.src, 'https://cdn.flaggr.dev/a-0.1.9.js');
  assert.equal(script.integrity, 'sha384-UbokEwOv+WfuKvg33yULNZRqXEMFKfrK39J4QItWznOG1IXviooN+w65ec5D6izH');
  assert.equal(script.crossOrigin, 'anonymous');
  assert.equal(script.async, true);
  assert.notEqual(script.type, 'module');
  assert.deepEqual(Object.fromEntries(script.attributes), {
    'data-site-id': fixtureSiteId,
    'data-track-clicks': 'false',
    'data-track-errors': 'true',
    'data-track-scroll': 'true',
    'data-respect-dnt': 'true',
  });
  h.load(); h.click('docs_open');
  assert.deepEqual(h.conversions, [{ name: 'docs_open' }]);
  assert.equal(h.timers.size, 0);
});

test('does not add a second collector when another vendor tag is present', () => {
  for (const existingSDK of ['https://cdn.flaggr.dev/a.js', 'https://cdn.flaggr.dev/a-0.1.8.js?v=1']) {
    const h = harness({ existingSDK }); h.execute();
    assert.equal(h.inserted.length, 0);
    assert.equal(h.timers.size, 0);
  }
});

test('only fixed conversion names are forwarded, without text, URLs or extra detail', () => {
  const h = harness(); h.execute(); h.load();
  for (const name of ['get_started', 'cli_download', 'docs_open', 'demo_open', 'blog_open', 'mcp_install']) h.click(name);
  for (const name of ['mcp_copy', 'code_copy', 'docs_search']) h.signal(name, { query: 'do-not-forward', properties: { secret: 'do-not-forward' }, value: 100 });
  h.click(null); h.click('unknown_event'); h.signal('unknown_event'); h.signal({ name: 'docs_search' });
  h.click('get_started', { defaultPrevented: true }); h.click('get_started', { button: 1 });
  assert.deepEqual(h.conversions, ['get_started', 'cli_download', 'docs_open', 'demo_open', 'blog_open', 'mcp_copy', 'code_copy', 'docs_search'].map((name) => ({ name })));
});

test('queues at most twenty conversions, then flushes once the SDK has loaded', () => {
  const h = harness(); h.execute();
  for (let i = 0; i < 30; i += 1) h.signal('docs_search');
  assert.equal(h.conversions.length, 0);
  h.load(); h.load();
  assert.equal(h.conversions.length, 20);
  h.signal('code_copy');
  assert.equal(h.conversions.length, 21);
});

test('blocked or slow SDK drops queued conversions and removes listeners without retries', () => {
  for (const failure of ['error', 'timeout']) {
    const h = harness(); h.execute(); h.signal('code_copy');
    if (failure === 'error') h.fail(); else h.advance(10000);
    h.load(); h.signal('docs_search'); h.click('get_started'); h.execute();
    assert.deepEqual(h.conversions, []);
    assert.equal(h.timers.size, 0);
    assert.equal(h.inserted.length, 1);
    assert.equal(h.document.scripts.length, 1);
    assert.equal(h.document.listeners.get('click').length, 0);
    assert.equal(h.window.listeners.get('paprika:analytics').length, 0);
  }
});

test('insertion and conversion-listener failures do not escape into product actions', () => {
  const refused = harness({ appendFails: true });
  assert.doesNotThrow(() => refused.execute());
  assert.equal(refused.timers.size, 0);
  const h = harness(); h.execute(); h.load();
  h.window.addEventListener('flaggr:conversion', () => { throw new Error('Collector failed'); });
  assert.doesNotThrow(() => h.signal('code_copy'));
  assert.doesNotThrow(() => h.click('get_started'));
});
