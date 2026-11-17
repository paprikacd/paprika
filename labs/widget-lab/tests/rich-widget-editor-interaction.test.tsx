// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WidgetEditor } from '../src/editor/WidgetEditor';
import { WidgetPanelActions } from '../src/components/lab/DashboardWorkbench';
import { makeCatalogFixture } from '../src/catalog/chart-fixtures';
import type { Widget } from '@insights/schema';

vi.mock('@insights/charts', () => ({
  WidgetVisualization: ({ widget }: {widget: Widget}) => createElement('div', {'data-preview-widget': widget.id}),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('richer panel and tooltip authoring interactions', () => {
  let host: HTMLDivElement | undefined;
  let root: Root | undefined;
  afterEach(async () => {
    if(root) await act(async () => root?.unmount());
    host?.remove();
    host = undefined; root = undefined;
  });

  async function mountEditor(initialTab: 'tooltip' | 'appearance' = 'tooltip') {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const source = makeCatalogFixture('timeseries');
    const onApply = vi.fn();
    const onClose = vi.fn();
    await act(async () => root?.render(createElement(WidgetEditor, {
      widget:source.widget,result:source.result,onApply,onClose,initialTab,
    })));
    return { ...source,onApply,onClose };
  }

  it('opens directly on tooltip settings from a panel-menu shortcut', async () => {
    await mountEditor('tooltip');
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search chart options"]');
    expect(search?.value).toBe('tooltip');
    expect(document.querySelector('[aria-label="Tooltip heading"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Tooltip mini-chart type"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Tooltip placement"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Panel background"]')).toBeNull();
  });

  it('opens appearance settings without replacing the selected metric query', async () => {
    await mountEditor('appearance');
    const search = document.querySelector<HTMLInputElement>('[aria-label="Search chart options"]');
    expect(search?.value).toBe('appearance');
    expect(document.querySelector('[aria-label="Panel background"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Tooltip heading"]')).toBeNull();
  });

  it('applies a tooltip heading using the real editor validation path', async () => {
    const { onApply } = await mountEditor('tooltip');
    const heading = document.querySelector<HTMLInputElement>('[aria-label="Tooltip heading"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set;
    expect(setter).toBeDefined();
    await act(async () => {
      setter?.call(heading, 'Latency observation');
      heading.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const apply = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent?.includes('Apply changes'))!;
    expect(apply).toBeDefined();
    expect(apply.disabled).toBe(false);
    await act(async () => apply.click());
    expect(onApply).toHaveBeenCalledOnce();
    expect((onApply.mock.calls[0][0] as Widget).options?.tooltipTitle).toBe('Latency observation');
  });

  it('applies background and text overrides to the real panel host and cleans them on reset', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const {widget,result} = makeCatalogFixture('timeseries');
    const apply = (next:Widget) => root?.render(createElement('section', {className:'lab-panel'},
      createElement(WidgetPanelActions, {widget:next,result,onApply:apply,onReset:()=>{},modified:true,onEdit:()=>undefined})));
    const changed={...widget,options:{...widget.options,background:'#142338',textColor:'#eef3f8'}};
    await act(async () => root?.render(createElement('section',{className:'lab-panel'},
      createElement(WidgetPanelActions,{widget:changed,result,onApply:apply,onReset:()=>{},modified:true,onEdit:()=>undefined}))));
    const panel=host.querySelector<HTMLElement>('.lab-panel')!;
    expect(panel.style.backgroundColor).toMatch(/#142338|rgb\(20,\s*35,\s*56\)/);
    expect(panel.style.color).toMatch(/#eef3f8|rgb\(238,\s*243,\s*248\)/);
    await act(async () => root?.render(createElement('section',{className:'lab-panel'},
      createElement(WidgetPanelActions,{widget,result,onApply:apply,onReset:()=>{},onEdit:()=>undefined}))));
    expect(panel.style.backgroundColor).toBe('');
    expect(panel.style.color).toBe('');
  });
});

