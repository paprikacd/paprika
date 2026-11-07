// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardWorkbench, DashboardEditControls } from '../src/components/lab/DashboardWorkbench';
import { movePanel, snapColumnSpan, updatePanelLayout } from '../src/components/lab/dashboard-layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const rect = (left: number, top: number, width: number, height: number): DOMRect => ({
  x: left, y: top, left, top, width, height,
  right: left + width, bottom: top + height, toJSON: () => ({}),
} as DOMRect);

describe('collision-free grid layout editing', () => {
  let host: HTMLDivElement | undefined;
  let root: Root | undefined;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove(); host = undefined; root = undefined;
    vi.unstubAllGlobals();
  });

  it('inserts next to the target without losing or duplicating siblings', () => {
    const initial = ['a', 'b', 'c', 'd'];
    expect(movePanel(initial, 'a', 'c')).toEqual(['b', 'a', 'c', 'd']);
    expect(movePanel(initial, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(movePanel(initial, 'c', 'a')).toEqual(['c', 'a', 'b', 'd']);
    expect(movePanel(initial, 'x', 'a')).toEqual(initial);
    expect(movePanel(initial, 'a', 'a')).toEqual(initial);
    expect(initial).toEqual(['a', 'b', 'c', 'd']);
  });
  it('snaps to integer columns, caps overflow, and preserves explicit overrides on update', () => {
    expect(snapColumnSpan(310, 100, 10, 12)).toBe(3);
    expect(snapColumnSpan(9999, 100, 10, 12)).toBe(12);
    expect(snapColumnSpan(0, 100, 10, 12)).toBe(1);
    expect(snapColumnSpan(450, 100, 10, 3)).toBe(3);
    const original = { alpha: { order: 2, columns: 3 }, beta: { minHeight: 256 } };
    expect(updatePanelLayout(original, 'alpha', { order: 1, columns: 4 })).toEqual({
      alpha: { order: 1, columns: 4 }, beta: { minHeight: 256 },
    });
    expect(updatePanelLayout(original, 'alpha', {})).toEqual({ beta: { minHeight: 256 } });
    expect(original.alpha.order).toBe(2);
  });

  async function fixture() {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(DashboardWorkbench, null,
      createElement(DashboardEditControls),
      createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', columnGap: 10 } },
        createElement('section', { className: 'lab-panel', 'aria-label': 'Alpha' }, 'Alpha chart'),
        createElement('section', { className: 'lab-panel', 'aria-label': 'Beta' }, 'Beta chart'),
        createElement('section', { className: 'lab-panel', 'aria-label': 'Gamma' }, 'Gamma chart'),
      ),
    )));
    const parent = host.querySelector<HTMLElement>('div[style*="grid"]')!;
    const panels = [...parent.querySelectorAll<HTMLElement>('section')];
    parent.getBoundingClientRect = () => rect(0, 0, 660, 280);
    parent.style.gridTemplateColumns = 'repeat(3, 1fr)';
    panels.forEach((node, i) => {
      node.getBoundingClientRect = () => rect(i * 220, 0, 200, 180);
      Object.defineProperty(node, 'offsetWidth', { configurable: true, value: 200 });
      Object.defineProperty(node, 'offsetHeight', { configurable: true, value: 180 });
    });
    const findButton = (text: string) => [...host!.querySelectorAll('button')]
      .find(button => button.textContent?.includes(text)) as HTMLButtonElement;
    await act(async () => { findButton('Edit dashboard').click(); await Promise.resolve(); });
    expect(host.querySelectorAll('[data-layout-control="move"]')).toHaveLength(3);
    expect(host.querySelectorAll('[data-layout-control="resize"]')).toHaveLength(3);
    return { parent, panels, findButton };
  }

  it('reorders as a compact CSS grid, retains the result after Done, and restores on Reset', async () => {
    const { parent, panels, findButton } = await fixture();
    const [alpha, beta, gamma] = panels;
    const move = alpha.querySelector<HTMLButtonElement>('[data-layout-control="move"]')!;
    const initialOrder = alpha.style.order;
    const key = (name: string) => new KeyboardEvent('keydown', { bubbles: true, key: name });
    await act(async () => { move.dispatchEvent(key('ArrowRight')); });
    expect(parent.style.gridAutoFlow).toBe('row dense');
    expect(Number(beta.style.order)).toBeLessThan(Number(alpha.style.order));
    expect(Number(alpha.style.order)).toBeLessThan(Number(gamma.style.order));
    expect(host!.textContent).toContain('session edit');

    await act(async () => findButton('Done editing').click());
    expect(host!.querySelectorAll('[data-layout-control]')).toHaveLength(0);
    expect(Number(beta.style.order)).toBeLessThan(Number(alpha.style.order));
    await act(async () => { findButton('Edit dashboard').click(); await Promise.resolve(); });
    expect(alpha.querySelector('[data-layout-control="move"]')).not.toBeNull();

    const menu = host!.querySelector<HTMLButtonElement>('button[aria-label="Dashboard actions"]')!;
    await act(async () => menu.click());
    const reset = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find(node => node.textContent?.includes('Reset session edits'))!;
    expect(reset).toBeDefined();
    await act(async () => reset.click());
    expect(alpha.style.order).toBe(initialOrder);
    expect(Number(alpha.style.order)).toBeLessThan(Number(beta.style.order));
  });

  it('previews a pointer snap target and commits automatic reflow on pointer release', async () => {
    const { parent, panels } = await fixture();
    const [alpha, beta, gamma] = panels;
    const handle = alpha.querySelector<HTMLButtonElement>('[data-layout-control="move"]')!;
    let captured = false;
    handle.setPointerCapture = () => { captured = true; };
    handle.hasPointerCapture = () => captured;
    handle.releasePointerCapture = () => { captured = false; };
    const event = (type: string, x: number, y: number) => new PointerEvent(type,
      { bubbles: true, pointerId: 5, isPrimary: true, button: 0, clientX: x, clientY: y });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      queueMicrotask(() => cb(0));
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    await act(async () => {
      handle.dispatchEvent(event('pointerdown', 30, 20));
      window.dispatchEvent(event('pointermove', 460, 70));
      await Promise.resolve();
      window.dispatchEvent(event('pointerup', 460, 70));
    });
    expect(parent.style.gridAutoFlow).toBe('row dense');
    expect(Number(beta.style.order)).toBeLessThan(Number(alpha.style.order));
    expect(Number(alpha.style.order)).toBeLessThan(Number(gamma.style.order));
    expect(document.querySelectorAll('.dashboard-layout-drag-ghost')).toHaveLength(0);
    expect(alpha.dataset.layoutSource).toBeUndefined();
    expect(gamma.dataset.layoutDropTarget).toBeUndefined();
  });

  it('resizes in whole columns and vertical increments without leaving grid bounds', async () => {
    const { parent, panels } = await fixture();
    const beta = panels[1];
    const resize = beta.querySelector<HTMLButtonElement>('[data-layout-control="resize"]')!;
    await act(async () => {
      resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(beta.style.gridColumn).toMatch(/^span [1-3]$/);
    expect(parseInt(beta.style.minHeight)).toBeGreaterThan(0);
    expect(parent.style.gridAutoFlow).toBe('row dense');
  });
  it('treats display:contents support wrappers as part of the same visual grid', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(DashboardWorkbench, null,
      createElement(DashboardEditControls),
      createElement('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)' } },
        createElement('section', { className: 'lab-panel', 'aria-label': 'Traffic' }, 'Primary'),
        createElement('div', { style: { display: 'contents' } },
          createElement('section', { className: 'lab-panel', 'aria-label': 'Map' }, 'Supporting map'),
          createElement('section', { className: 'lab-panel', 'aria-label': 'Risk' }, 'Supporting risk'),
        ),
        createElement('section', { className: 'lab-panel', 'aria-label': 'Events' }, 'Records'),
      ),
    )));
    const button = [...host.querySelectorAll('button')].find(el => el.textContent?.includes('Edit dashboard'))!;
    await act(async () => { button.click(); await Promise.resolve(); });
    expect(host.querySelectorAll('[data-layout-control="move"]')).toHaveLength(4);
    const map = host.querySelector<HTMLElement>('[aria-label="Map"]')!;
    const events = host.querySelector<HTMLElement>('[aria-label="Events"]')!;
    await act(async () => map.querySelector<HTMLButtonElement>('[data-layout-control="move"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true })));
    expect(Number(map.style.order)).toBeGreaterThan(Number(events.style.order));
  });

  it('previews grid-snapped pointer resizing, then removes the ghost without overlaps', async () => {
    const { parent, panels } = await fixture();
    const beta = panels[1];
    const handle = beta.querySelector<HTMLButtonElement>('[data-layout-control="resize"]')!;
    let captured = false;
    handle.setPointerCapture = () => { captured = true; };
    handle.hasPointerCapture = () => captured;
    handle.releasePointerCapture = () => { captured = false; };
    const event = (type: string, x: number, y: number) => new PointerEvent(type,
      { bubbles: true, pointerId: 7, isPrimary: true, button: 0, clientX: x, clientY: y });
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queueMicrotask(() => cb(0)); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    await act(async () => {
      handle.dispatchEvent(event('pointerdown', 0, 0));
      window.dispatchEvent(event('pointermove', 245, 66));
      await Promise.resolve();
      expect(beta.style.gridColumn).toBe('span 2');
      expect(beta.style.minHeight).toBe('256px');
      window.dispatchEvent(event('pointerup', 245, 66));
    });
    expect(beta.style.gridColumn).toBe('span 2');
    expect(parent.style.gridAutoFlow).toBe('row dense');
    expect(document.querySelectorAll('.dashboard-layout-drag-ghost')).toHaveLength(0);
  });

});

