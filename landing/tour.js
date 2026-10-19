/* Captured-console navigation only. Images contain synthetic fleet data;
   no backend calls, authentication, live telemetry or console actions occur. */
(() => {
  'use strict';
  const root = document.querySelector('[data-tour]');
  if (!root) return;
  const panels = Array.from(root.querySelectorAll('[data-tour-panel]'));
  const steps = Array.from(root.querySelectorAll('[data-tour-step]'));
  const previous = root.querySelector('[data-tour-previous]');
  const forward = root.querySelector('[data-tour-forward]');
  const replay = root.querySelector('[data-tour-replay]');
  const counter = root.querySelector('[data-step-counter]');
  const announcement = root.querySelector('[data-tour-announcement]');
  const progress = Array.from(root.querySelectorAll('[data-progress-step]'));
  if (panels.length !== 5 || steps.length !== panels.length || !previous || !forward || !replay || !counter || !announcement) return;
  if (!steps.every((step, index) => step.dataset.tourStep === panels[index].id && panels[index].querySelector('h2') && panels[index].querySelector('img'))) return;

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let current = Math.max(0, panels.findIndex(panel => `#${panel.id}` === window.location.hash));
  let animationTimer;

  function select(index, { focus = false, writeHash = true, animate = false } = {}) {
    const next = Math.max(0, Math.min(panels.length - 1, index));
    const direction = next >= current ? '10px' : '-10px';
    current = next;
    clearTimeout(animationTimer);
    panels.forEach((panel, panelIndex) => {
      panel.hidden = panelIndex !== current;
      panel.classList.remove('tour-stage-enter');
    });
    steps.forEach((step, stepIndex) => {
      if (stepIndex === current) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    });
    progress.forEach((segment, segmentIndex) => {
      segment.dataset.state = segmentIndex === current ? 'current' : segmentIndex < current ? 'done' : 'pending';
    });
    previous.disabled = current === 0;
    forward.innerHTML = current === panels.length - 1 ? 'Replay tour <span aria-hidden="true">↺</span>' : 'Next step <span aria-hidden="true">→</span>';
    counter.textContent = `${String(current + 1).padStart(2, '0')} / ${String(panels.length).padStart(2, '0')}`;
    const panel = panels[current];
    const heading = panel.querySelector('h2');
    if (writeHash && window.history?.replaceState) {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${panel.id}`);
    }
    if (animate && !reducedMotion.matches) {
      panel.style.setProperty('--tour-direction', direction);
      panel.classList.add('tour-stage-enter');
      animationTimer = window.setTimeout(() => panel.classList.remove('tour-stage-enter'), 300);
    }
    announcement.textContent = `Step ${current + 1} of ${panels.length}: ${steps[current].querySelector('strong').textContent}.`;
    if (focus) {
      heading.focus({ preventScroll: true });
      const bounds = heading.getBoundingClientRect();
      if (bounds.top < 12 || bounds.top > window.innerHeight * .6) {
        heading.scrollIntoView({ block: 'start', behavior: reducedMotion.matches ? 'instant' : 'smooth' });
      }
    }
  }

  steps.forEach((step, index) => step.addEventListener('click', () => select(index, { animate: true })));
  previous.addEventListener('click', () => select(current - 1, { focus: true, animate: true }));
  forward.addEventListener('click', () => select(current === panels.length - 1 ? 0 : current + 1, { focus: true, animate: true }));
  replay.addEventListener('click', () => select(0, { focus: true, animate: true }));
  root.querySelectorAll('[data-tour-next]').forEach(button => button.addEventListener('click', () => select(current + 1, { focus: true, animate: true })));

  root.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.defaultPrevented) return;
    if (event.target.closest('input, textarea, select, summary, [contenteditable="true"]')) return;
    const destinations = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: panels.length - 1 };
    if (!Object.prototype.hasOwnProperty.call(destinations, event.key)) return;
    event.preventDefault();
    const fromStepNavigation = Boolean(event.target.closest('[data-tour-step]'));
    select(destinations[event.key], { focus: !fromStepNavigation });
    if (fromStepNavigation) steps[current].focus({ preventScroll: true });
  });
  window.addEventListener('hashchange', () => {
    const index = panels.findIndex(panel => `#${panel.id}` === window.location.hash);
    if (index !== -1) select(index, { writeHash: false });
  });

  const dialog = document.querySelector('[data-tour-dialog]');
  const zoomImage = dialog?.querySelector('[data-zoom-image]');
  const zoomTitle = dialog?.querySelector('#zoom-title');
  const closeZoom = dialog?.querySelector('[data-close-zoom]');
  let zoomTrigger = null;
  if (dialog && typeof dialog.showModal === 'function' && zoomImage && zoomTitle && closeZoom) {
    root.querySelectorAll('[data-tour-zoom]').forEach(button => button.addEventListener('click', () => {
      const panel = button.closest('[data-tour-panel]');
      const image = panel.querySelector('.tour-image-wrap > img');
      zoomTrigger = button;
      zoomImage.src = image.currentSrc || image.src;
      zoomImage.alt = image.alt;
      zoomTitle.textContent = steps[panels.indexOf(panel)].querySelector('strong').textContent;
      dialog.showModal();
      document.documentElement.style.overflow = 'hidden';
      closeZoom.focus();
    }));
    closeZoom.addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      document.documentElement.style.overflow = '';
      zoomTrigger?.focus({ preventScroll: true });
    });
  } else {
    root.querySelectorAll('[data-tour-zoom]').forEach(button => { button.hidden = true; });
  }

  select(current, { writeHash: false });
  root.setAttribute('data-tour-ready', '');
})();
