/* Paprika's dependency-free adaptations of Gamma MorphTabs and SpotlightSurface.
   See ../docs/design/gamma-provenance.md for maintained-source provenance. */
(() => {
  'use strict';

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  function initTabs(root) {
    if (root.hasAttribute('data-gamma-ready')) return;
    const owned = (element) => element.closest('[data-gamma-tabs]') === root;
    const list = [...root.querySelectorAll('[role="tablist"]')].find(owned);
    if (!list) return;
    const tabs = [...list.querySelectorAll('button[role="tab"]')].filter(owned);
    const enabled = tabs.filter((tab) => !tab.disabled && tab.getAttribute('aria-disabled') !== 'true');
    const records = tabs.map((tab) => ({
      tab,
      panel: document.getElementById(tab.getAttribute('aria-controls') || ''),
    }));
    // A broken or partial contract keeps all server-rendered content visible.
    if (!enabled.length || records.some(({ tab, panel }) => !tab.id || !panel ||
      !root.contains(panel) || !owned(panel) || panel.getAttribute('role') !== 'tabpanel') ||
      new Set(records.map(({ panel }) => panel)).size !== records.length) return;

    let active = enabled.find((tab) => tab.getAttribute('aria-selected') === 'true') || enabled[0];
    let pointerTab = null;
    let panelAnimation = null;
    const underline = document.createElement('span');
    underline.className = 'gamma-tabs-underline';
    underline.setAttribute('aria-hidden', 'true');
    list.append(underline);

    function placeUnderline(animate) {
      underline.style.transition = animate && !reducedMotion.matches ? '' : 'none';
      const listBounds = list.getBoundingClientRect();
      const bounds = active.getBoundingClientRect();
      underline.style.width = `${bounds.width}px`;
      underline.style.transform = `translateX(${bounds.left - listBounds.left + list.scrollLeft}px)`;
    }

    function select(next, animate = false) {
      if (!enabled.includes(next)) return;
      const previous = active;
      active = next;
      panelAnimation?.cancel();
      panelAnimation = null;
      records.forEach(({ tab, panel }) => {
        const selected = tab === active;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        panel.hidden = !selected;
        panel.setAttribute('aria-labelledby', tab.id);
        if (!panel.hasAttribute('tabindex')) panel.tabIndex = 0;
      });
      placeUnderline(animate);
      if (previous === active) return;
      const panel = records.find(({ tab }) => tab === active).panel;
      if (animate && !reducedMotion.matches && typeof panel.animate === 'function') {
        const direction = tabs.indexOf(active) > tabs.indexOf(previous) ? 1 : -1;
        panelAnimation = panel.animate([
          { opacity: .6, transform: `translateX(${direction * 12}px)` },
          { opacity: 1, transform: 'translateX(0)' },
        ], { duration: 240, easing: 'cubic-bezier(.2,.75,.25,1)' });
      }
      root.dispatchEvent(new CustomEvent('gamma:tabchange', {
        bubbles: true,
        detail: { tab: active.id, panel: panel.id },
      }));
    }

    list.addEventListener('pointerdown', (event) => {
      pointerTab = event.target.closest('button[role="tab"]');
    });
    list.addEventListener('pointercancel', () => { pointerTab = null; });
    list.addEventListener('click', (event) => {
      const next = event.target.closest('button[role="tab"]');
      if (!tabs.includes(next)) return;
      select(next, event.detail > 0);
      pointerTab = null;
    });
    list.addEventListener('focusin', (event) => {
      const next = event.target.closest('button[role="tab"]');
      if (tabs.includes(next) && next !== pointerTab) select(next);
    });
    list.addEventListener('focusout', (event) => {
      if (!list.contains(event.relatedTarget)) pointerTab = null;
    });
    list.addEventListener('keydown', (event) => {
      const current = enabled.indexOf(document.activeElement);
      if (current < 0) return;
      let target;
      if (event.key === 'ArrowRight') target = (current + 1) % enabled.length;
      else if (event.key === 'ArrowLeft') target = (current - 1 + enabled.length) % enabled.length;
      else if (event.key === 'Home') target = 0;
      else if (event.key === 'End') target = enabled.length - 1;
      else return;
      event.preventDefault();
      pointerTab = null;
      select(enabled[target]);
      enabled[target].focus({ preventScroll: true });
      // Keep the focused tab visible without moving the surrounding page.
      const tabBounds = enabled[target].getBoundingClientRect();
      const listBounds = list.getBoundingClientRect();
      if (tabBounds.left < listBounds.left) list.scrollLeft -= listBounds.left - tabBounds.left;
      else if (tabBounds.right > listBounds.right) list.scrollLeft += tabBounds.right - listBounds.right;
    });
    reducedMotion.addEventListener('change', () => {
      panelAnimation?.cancel();
      placeUnderline(false);
    });
    if ('ResizeObserver' in window) new ResizeObserver(() => placeUnderline(false)).observe(list);
    else window.addEventListener('resize', () => placeUnderline(false), { passive: true });
    document.fonts?.ready.then(() => placeUnderline(false));
    root.setAttribute('data-gamma-ready', '');
    select(active);
  }

  function initSpotlight(surface) {
    if (surface.hasAttribute('data-spotlight-ready')) return;
    const size = Number(surface.getAttribute('data-spotlight-size') || 320);
    surface.style.setProperty('--spotlight-size', `${Number.isFinite(size) ? Math.max(80, Math.min(1000, size)) : 320}px`);
    const center = () => {
      surface.style.setProperty('--spotlight-x', '50%');
      surface.style.setProperty('--spotlight-y', '50%');
    };
    surface.addEventListener('pointermove', (event) => {
      if (event.defaultPrevented || event.pointerType === 'touch' || reducedMotion.matches ||
        surface.getAttribute('data-spotlight-disabled') === 'true' || surface.matches(':focus-within')) return;
      const bounds = surface.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const clamp = (value) => Math.max(0, Math.min(100, value));
      surface.style.setProperty('--spotlight-x', `${clamp((event.clientX - bounds.left) / bounds.width * 100)}%`);
      surface.style.setProperty('--spotlight-y', `${clamp((event.clientY - bounds.top) / bounds.height * 100)}%`);
    }, { passive: true });
    surface.addEventListener('pointerleave', center, { passive: true });
    surface.addEventListener('pointercancel', center, { passive: true });
    surface.addEventListener('focusin', center);
    reducedMotion.addEventListener('change', center);
    surface.setAttribute('data-spotlight-ready', '');
  }

  function init() {
    document.querySelectorAll('[data-gamma-tabs]').forEach(initTabs);
    document.querySelectorAll('[data-spotlight]').forEach(initSpotlight);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
