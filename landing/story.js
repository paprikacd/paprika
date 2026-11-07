// Each lifecycle tab emphasizes the same records in its isometric overview.
// The diagrams remain an illustrative configuration; no fleet calls are made.
(() => {
  'use strict';
  const workbench = document.querySelector('#deployment [data-gamma-tabs]');
  const picture = workbench?.querySelector('.deployment-diagram picture');
  const image = picture?.querySelector('img');
  const mobile = picture?.querySelector('source');
  if (!workbench || !image || !mobile) return;

  const overview = { desktop: image.getAttribute('src'), mobile: mobile.getAttribute('srcset') };
  let selection = 0;
  function show(sources) {
    if (mobile.getAttribute('srcset') !== sources.mobile) mobile.srcset = sources.mobile;
    if (image.getAttribute('src') !== sources.desktop) image.src = sources.desktop;
  }
  async function prepare(src) {
    const candidate = new Image();
    candidate.src = src;
    await candidate.decode();
  }

  const focusByPanel = {
    'deploy-source': 'source',
    'deploy-build': 'build',
    'deploy-apply': 'apply',
    'deploy-observe': 'observe',
  };
  async function emphasize(panel) {
    const focus = focusByPanel[panel];
    if (!focus) return;
    const current = ++selection;
    const sources = {
      desktop: `./diagrams/deployment-${focus}.svg`,
      mobile: `./diagrams/deployment-${focus}-mobile.svg`,
    };
    // The neutral overview stays available during slow or failed phase requests.
    // Prepare both sizes so a later viewport change cannot expose a broken source.
    show(overview);
    try {
      await Promise.all([prepare(sources.desktop), prepare(sources.mobile)]);
    } catch {
      return;
    }
    // A slower earlier request must not replace the currently selected phase.
    if (current === selection) show(sources);
  }
  image.addEventListener('error', () => {
    if (image.getAttribute('src') === overview.desktop && mobile.getAttribute('srcset') === overview.mobile) return;
    selection += 1;
    show(overview);
  });
  workbench.addEventListener('gamma:tabchange', (event) => emphasize(event.detail?.panel));
  if (workbench.hasAttribute('data-gamma-ready')) {
    emphasize(workbench.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-controls'));
  }
})();
