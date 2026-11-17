// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { ObservationTooltip } from '@insights/observation-tooltip';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('pinned observation inspector scroll ownership', () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;
  afterEach(async () => {
    if(root) await act(async () => root?.unmount());
    host?.remove(); root = undefined; host = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps PageDown scrolling inside the inspector without rescheduling placement', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const anchor = document.createElement('button');
    anchor.textContent = 'Inspect metric';
    host.appendChild(anchor);
    const schedule = vi.fn(() => 1);
    const cancel = vi.fn();
    vi.stubGlobal('requestAnimationFrame', schedule);
    vi.stubGlobal('cancelAnimationFrame', cancel);
    vi.stubGlobal('innerWidth', 390);
    vi.stubGlobal('innerHeight', 844);
    const frame = document.createElement('div');
    host.append(frame);
    root = createRoot(frame);
    await act(async () => root?.render(createElement(
      ObservationTooltip,
      { id: 'pinned-regression', anchor, pinned:true, role:'region', ariaLabel:'Observation details', tabIndex:0, onDismiss:()=>{},
        children: createElement('p', null, 'A long series of source labels') },
    )));
    const inspector = document.getElementById('pinned-regression') as HTMLElement;
    expect(inspector).toBeTruthy();
    Object.defineProperties(inspector, {
      clientHeight: { configurable:true, value:258 },
      scrollHeight: { configurable:true, value:476 },
    });
    inspector.scrollTop = 0;
    const before = schedule.mock.calls.length;
    inspector.focus();
    const key = new KeyboardEvent('keydown', { key:'PageDown', bubbles:true, cancelable:true });
    inspector.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(inspector.scrollTop).toBe(206);
    // Browser scroll events are captured by Window, but MUST NOT remeasure this
    // inspector. Remeasuring its capped max-height resets scrollTop in Chromium.
    inspector.dispatchEvent(new Event('scroll', { bubbles:false }));
    expect(schedule.mock.calls.length).toBe(before);
    expect(inspector.scrollTop).toBe(206);
    window.dispatchEvent(new Event('scroll'));
    expect(schedule.mock.calls.length).toBeGreaterThan(before);
  });
});

