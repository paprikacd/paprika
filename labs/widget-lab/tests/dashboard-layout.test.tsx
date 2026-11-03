// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardWorkbench, DashboardEditControls } from '../src/components/lab/DashboardWorkbench';
import { updatePanelLayout } from '../src/components/lab/dashboard-layout';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('route-local layout editing', () => {
  let host: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = undefined;
    host = undefined;
  });

  it('preserves the previous layout while replacing a panel and deletes a zero offset', () => {
    const before = { alpha: { x: 8, y: 16 }, beta: { x: 24, y: 0 } };
    const moved = updatePanelLayout(before, 'alpha', { x: 40, y: -8 });
    expect(moved).toEqual({ alpha: { x: 40, y: -8 }, beta: { x: 24, y: 0 } });
    expect(before.alpha.x).toBe(8);
    expect(updatePanelLayout(moved, 'alpha', { x: 0, y: 0 })).toEqual({ beta: { x: 24, y: 0 } });
    expect(updatePanelLayout(before, 'missing', { x: 0, y: 0 })).toBe(before);
  });

  it('reveals controls only in editing mode, moves by keyboard, resizes, and retains edits after Done', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(DashboardWorkbench, null,
        createElement(DashboardEditControls),
        createElement('div', { className: 'ref-edge' },
          createElement('section', { className: 'ref-edge-metric', 'aria-label': 'Ingress traffic' }, 'Traffic'),
          createElement('section', { className: 'ref-panel' },
            createElement('header', null, createElement('h2', null, 'Network requests')),
            createElement('div', null, 'Observations'),
          ),
        ),
      ));
    });

    const buttonWithText = (text: string) => Array.from(host!.querySelectorAll('button')).find(button => button.textContent?.includes(text)) as HTMLButtonElement | undefined;
    const metric = host.querySelector<HTMLElement>('.ref-edge-metric')!;
    expect(host.querySelectorAll('[data-layout-control]')).toHaveLength(0);

    await act(async () => {
      buttonWithText('Edit dashboard')!.click();
      await Promise.resolve();
    });
    expect(host.querySelectorAll('[data-layout-control="move"]')).toHaveLength(2);
    expect(host.querySelectorAll('[data-layout-control="resize"]')).toHaveLength(2);

    const move = metric.querySelector<HTMLButtonElement>('[data-layout-control="move"]')!;
    await act(async () => {
      move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(metric.style.translate).toBe('8px 0px');
    expect(host.textContent).toContain('1 session edit');

    await act(async () => {
      move.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
    });
    expect(metric.style.translate).toBe('8px 32px');

    const resize = metric.querySelector<HTMLButtonElement>('[data-layout-control="resize"]')!;
    await act(async () => {
      resize.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(metric.style.width).not.toBe('');
    expect(metric.style.translate).toBe('8px 32px');

    await act(async () => buttonWithText('Done editing')!.click());
    expect(host.querySelectorAll('[data-layout-control]')).toHaveLength(0);
    expect(metric.style.translate).toBe('8px 32px');

    await act(async () => {
      buttonWithText('Edit dashboard')!.click();
      await Promise.resolve();
    });
    expect(metric.querySelector('[data-layout-control="move"]')).not.toBeNull();
    expect(metric.style.translate).toBe('8px 32px');
  });

  it('supports actual pointer dragging and a dashboard-wide layout reset', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(DashboardWorkbench, null,
        createElement(DashboardEditControls),
        createElement('div', { className: 'ref-edge' },
          createElement('section', { className: 'ref-edge-metric', 'aria-label': 'Ingress traffic' }, 'Traffic'),
        ),
      ));
    });
    const findButton = (text: string) => Array.from(host!.querySelectorAll('button')).find(button => button.textContent?.includes(text)) as HTMLButtonElement;
    await act(async () => {
      findButton('Edit dashboard').click();
      await Promise.resolve();
    });
    const metric = host.querySelector<HTMLElement>('.ref-edge-metric')!;
    const handle = metric.querySelector<HTMLButtonElement>('[data-layout-control="move"]')!;
    let captured = false;
    handle.setPointerCapture = () => { captured = true; };
    handle.hasPointerCapture = () => captured;
    handle.releasePointerCapture = () => { captured = false; };
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, { bubbles: true, pointerId: 4, isPrimary: true, button: 0, clientX: x, clientY: y });

    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', 20, 20));
      handle.dispatchEvent(pointer('pointermove', 53, 44));
      handle.dispatchEvent(pointer('pointerup', 53, 44));
    });
    expect(metric.style.translate).toBe('32px 24px');
    expect(host!.textContent).toContain('1 session edit');

    const menu = host.querySelector<HTMLButtonElement>('button[aria-label="Dashboard actions"]')!;
    expect(menu).not.toBeNull();
    await act(async () => { menu.click(); });
    const reset = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
      .find(node => node.textContent?.includes('Reset session edits'));
    expect(reset).toBeDefined();
    await act(async () => { reset!.click(); });
    expect(metric.style.translate || '').toBe('');
  });

});

