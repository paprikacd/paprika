(() => {
  'use strict';

  const iframe = document.querySelector('#chart-showcase-frame');
  const links = Array.from(document.querySelectorAll('[data-chart-route]'));
  const openLinks = document.querySelectorAll('[data-chart-open], [data-chart-open-mobile]');
  const caption = document.querySelector('[data-chart-caption]');
  if (!iframe || !links.length || !caption) return;

  // The landing owns navigation; the public gallery owns rendering and fixtures.
  // Keep exact deep links functional with JavaScript disabled or a new-tab click.
  function activate(link) {
    const route = link.dataset.chartRoute;
    if (!route || !/^[a-z][a-z0-9-]*$/.test(route)) return;
    const url = new URL('./charts/', document.baseURI);
    url.hash = route;
    if (iframe.src !== url.href) iframe.src = url.href;
    iframe.title = 'Paprika chart showcase: ' + link.textContent.trim() + ' (synthetic data)';
    for (const item of links) {
      if (item === link) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    }
    for (const item of openLinks) item.setAttribute('href', url.href);
    caption.textContent = link.dataset.chartDescription || 'Explore the public chart showcase using synthetic fixtures.';
  }

  for (const link of links) {
    link.addEventListener('click', (event) => {
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      event.preventDefault();
      activate(link);
    });
  }
})();

