// Each lifecycle tab emphasizes the same records in its isometric overview.
// The diagrams remain an illustrative configuration; no fleet calls are made.
(() => {
  'use strict';
  const workbench = document.querySelector('#deployment [data-gamma-tabs]');
  const picture = workbench?.querySelector('.deployment-diagram picture');
  const image = picture?.querySelector('img');
  const mobile = picture?.querySelector('source');
  if (!workbench || !image || !mobile) return;

  const focusByPanel = {
    'deploy-source': 'source',
    'deploy-build': 'build',
    'deploy-apply': 'apply',
    'deploy-observe': 'observe',
  };
  function emphasize(panel) {
    const focus = focusByPanel[panel];
    if (!focus) return;
    mobile.srcset = `./diagrams/deployment-${focus}-mobile.svg`;
    image.src = `./diagrams/deployment-${focus}.svg`;
  }
  workbench.addEventListener('gamma:tabchange', (event) => emphasize(event.detail?.panel));
  if (workbench.hasAttribute('data-gamma-ready')) {
    emphasize(workbench.querySelector('[role="tab"][aria-selected="true"]')?.getAttribute('aria-controls'));
  }
})();
