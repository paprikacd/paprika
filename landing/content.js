/* Progressive enhancement only: documentation remains readable without JavaScript. */
(() => {
  'use strict';
  const script = document.currentScript;
  const siteRoot = new URL('.', script.src);
  const contents = document.querySelector('.article-toc details');
  if (contents && window.matchMedia('(min-width: 781px)').matches) contents.open = true;
  const search = document.querySelector('[data-docs-search]');

  if (search) {
    const form = search.querySelector('form');
    const input = search.querySelector('input');
    const clear = search.querySelector('[data-search-clear]');
    const status = search.querySelector('.search-status');
    const results = search.querySelector('.search-results');
    const directory = document.querySelector('.docs-directory');
    let indexPromise;
    let revision = 0;
    let composing = false;
    let inputTimer;
    input.maxLength = 200;
    search.hidden = false;

    const clean = (value) => value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
    const urlQuery = () => (new URL(location.href).searchParams.get('q') || '').slice(0, input.maxLength);

    function commitQuery(query) {
      const url = new URL(location.href);
      if (query) url.searchParams.set('q', query);
      else url.searchParams.delete('q');
      if (url.href !== location.href) history.pushState(null, '', url);
    }

    async function loadIndex() {
      if (!indexPromise) {
        indexPromise = (async () => {
          const controller = new AbortController();
          const timeout = window.setTimeout(() => controller.abort(), 8000);
          try {
            const response = await fetch(new URL('search-index.json', siteRoot), { signal: controller.signal, credentials: 'same-origin' });
            if (!response.ok) throw new Error('Search index unavailable');
            const entries = await response.json();
            if (!Array.isArray(entries)) throw new Error('Invalid search index');
            return entries.filter((entry) => {
              if (!entry || !['title', 'description', 'section', 'href', 'text'].every((key) => typeof entry[key] === 'string')) return false;
              const url = new URL(entry.href, siteRoot);
              return url.origin === siteRoot.origin && url.pathname.startsWith(`${siteRoot.pathname}docs/`);
            }).map((entry) => ({ ...entry, url: new URL(entry.href, siteRoot).href, haystack: clean(`${entry.title} ${entry.description} ${entry.section} ${entry.text}`), titleSearch: clean(entry.title), descriptionSearch: clean(entry.description) }));
          } finally {
            window.clearTimeout(timeout);
          }
        })().catch((error) => {
          indexPromise = undefined;
          throw error;
        });
      }
      return indexPromise;
    }

    function textElement(tag, text, className) {
      const element = document.createElement(tag);
      element.textContent = text;
      if (className) element.className = className;
      return element;
    }

    async function runSearch() {
      const current = ++revision;
      const query = input.value.trim();
      const terms = clean(query).split(' ').filter(Boolean);
      clear.hidden = !input.value;
      results.replaceChildren();
      results.hidden = !query;
      if (!query) {
        status.textContent = '';
        directory.hidden = false;
        search.removeAttribute('aria-busy');
        return;
      }
      status.textContent = 'Searching documentation…';
      search.setAttribute('aria-busy', 'true');
      try {
        const entries = await loadIndex();
        if (current !== revision) return;
        const matches = entries.filter((entry) => terms.every((term) => entry.haystack.includes(term)))
          .map((entry) => ({ entry, score: terms.reduce((total, term) => total + (entry.titleSearch.includes(term) ? 5 : 0) + (entry.descriptionSearch.includes(term) ? 2 : 0), 0) }))
          .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, 'en'));
        directory.hidden = true;
        status.textContent = `${matches.length} ${matches.length === 1 ? 'guide' : 'guides'} found for “${query}”.`;
        if (matches.length) {
          const list = document.createElement('ul');
          list.className = 'doc-list search-result-list';
          for (const { entry } of matches) {
            const li = document.createElement('li');
            const link = document.createElement('a');
            link.className = 'doc-link';
            link.href = entry.url;
            link.dataset.analyticsEvent = new URL(entry.url).pathname === '/paprika/docs/getting-started/' ? 'get_started' : 'docs_open';
            link.append(textElement('h3', entry.title), textElement('p', entry.description), textElement('span', entry.section, 'search-result-section'));
            li.append(link);
            list.append(li);
          }
          results.append(list);
        } else {
          results.append(textElement('p', 'Try a broader term such as “release”, “metrics”, or “MCP”, or browse all guides.'));
          const reset = textElement('button', 'Show all guides', 'search-reset');
          reset.type = 'button';
          reset.addEventListener('click', clearSearch);
          results.append(reset);
        }
      } catch {
        if (current !== revision) return;
        directory.hidden = false;
        status.textContent = 'Search could not load. Browse the guides below or try again.';
        const retry = textElement('button', 'Try search again', 'search-reset');
        retry.type = 'button';
        retry.addEventListener('click', () => runSearch());
        results.append(retry);
      } finally {
        if (current === revision) search.removeAttribute('aria-busy');
      }
    }

    function clearSearch() {
      window.clearTimeout(inputTimer);
      input.value = '';
      commitQuery('');
      runSearch();
      input.focus();
    }

    function scheduleSearch() {
      window.clearTimeout(inputTimer);
      clear.hidden = !input.value;
      // Invalidates an in-flight search immediately; its response cannot overwrite new input.
      revision += 1;
      if (!input.value.trim()) runSearch();
      else inputTimer = window.setTimeout(() => runSearch(), 150);
    }

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (composing) return;
      window.clearTimeout(inputTimer);
      // Typing changes the displayed draft; submitting creates a navigable search.
      commitQuery(input.value.trim());
      runSearch();
      if (input.value.trim()) window.dispatchEvent(new CustomEvent('paprika:analytics', { detail: { name: 'docs_search' } }));
    });
    input.addEventListener('input', () => { if (!composing) scheduleSearch(); });
    input.addEventListener('compositionstart', () => { composing = true; window.clearTimeout(inputTimer); revision += 1; });
    input.addEventListener('compositionend', () => { composing = false; scheduleSearch(); });
    clear.addEventListener('click', clearSearch);
    window.addEventListener('popstate', () => {
      window.clearTimeout(inputTimer);
      composing = false;
      input.value = urlQuery();
      runSearch();
    });
    input.value = urlQuery();
    runSearch();
  }

  document.querySelectorAll('[data-code-block]').forEach((block, index) => {
    const toolbar = block.querySelector('.code-toolbar');
    const code = block.querySelector('pre code');
    if (!toolbar || !code) return;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy-code';
    button.textContent = 'Copy code';
    button.setAttribute('aria-label', `Copy code example ${index + 1}`);
    const feedback = document.createElement('span');
    feedback.className = 'code-copy-status';
    feedback.setAttribute('role', 'status');
    feedback.setAttribute('aria-live', 'polite');
    toolbar.append(feedback, button);
    let attempt = 0;
    let resetTimer;
    button.addEventListener('click', async () => {
      const current = ++attempt;
      window.clearTimeout(resetTimer);
      button.disabled = true;
      button.textContent = 'Copying…';
      feedback.textContent = '';
      let timeout;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await Promise.race([
          navigator.clipboard.writeText(code.textContent),
          new Promise((_, reject) => { timeout = window.setTimeout(() => reject(new Error('Clipboard timed out')), 4000); }),
        ]);
        if (attempt !== current) return;
        button.textContent = 'Copied';
        feedback.textContent = `Code example ${index + 1} copied.`;
        window.dispatchEvent(new CustomEvent('paprika:analytics', { detail: { name: 'code_copy' } }));
      } catch {
        if (attempt !== current) return;
        button.textContent = 'Copy code';
        feedback.textContent = 'Copy unavailable. Select the code and copy it manually.';
      } finally {
        window.clearTimeout(timeout);
        if (attempt === current) button.disabled = false;
      }
      resetTimer = window.setTimeout(() => {
        if (attempt !== current) return;
        button.textContent = 'Copy code';
        feedback.textContent = '';
      }, 5000);
    });
  });

  const menu = document.querySelector('.mobile-menu');
  if (menu) {
    menu.addEventListener('click', (event) => {
      if (event.target.closest('.mobile-menu-links a')) menu.open = false;
    });
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && menu.open) {
        menu.open = false;
        menu.querySelector('summary').focus();
      }
    });
  }
})();
