import { createElement } from 'react';
import { renderToReadableStream, renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryResult, Widget } from '@insights/schema';
import { DashboardWorkbench, useDashboardPanels, widgetPanelMenu } from '../src/components/lab/DashboardWorkbench';
import { lensRoutes } from '../src/lenses/lens-routes';
import { App } from '../src/App';

// Exercise the actual route/panel tree. Geometry has separate renderer tests;
// recording host identity makes missing/duplicate editing surfaces observable.
vi.mock('@insights/charts', () => ({
  WidgetVisualization: ({ widget }: { widget: Widget }) => createElement('div', { 'data-rendered-widget': widget.id }),
}));

afterEach(() => vi.unstubAllGlobals());

describe('shared dashboard panel authoring coverage', () => {
  const routes = ['', '#edge', '#reliability', '#lab-edge', '#lab-reliability', '#baseline', '#charts', ...lensRoutes.map(lens => `#${lens.id}`)];
  for (const route of routes) {
    it(`${route || 'default'} mounts the workbench and an action menu for every canonical widget`, async () => {
      vi.stubGlobal('location', { hash: route });
      vi.stubGlobal('document', { documentElement: { clientWidth: 1440 } });
      const errors: unknown[] = [];
      const stream = await renderToReadableStream(createElement(App), { onError: error => { errors.push(error); } });
      await stream.allReady;
      const html = await new Response(stream).text();
      expect(errors).toEqual([]);
      expect(html).toContain('data-dashboard-workbench="true"');
      expect(html).toContain('Edit dashboard');
      const widgets = [...html.matchAll(/data-rendered-widget="([^"]+)"/g)].map(match => match[1]).sort();
      const actions = [...html.matchAll(/data-widget-panel-actions="([^"]+)"/g)].map(match => match[1]).sort();
      expect(widgets.length).toBeGreaterThan(0);
      expect(actions).toEqual(widgets);
      expect(new Set(actions).size).toBe(actions.length);
      expect(html.match(/aria-label="Actions for /g)?.length).toBe(widgets.length);
    });
  }

  it('routes Data and Configuration to real editor workspaces and only enables reset for applied edits', () => {
    const open = vi.fn(), reset = vi.fn();
    const menu = widgetPanelMenu(open, reset, false);
    menu.find(item => item.id === 'edit')!.onSelect();
    menu.find(item => item.id === 'data')!.onSelect();
    menu.find(item => item.id === 'config')!.onSelect();
    expect(open.mock.calls).toEqual([['data'], ['data'], ['config']]);
    expect(menu.find(item => item.id === 'reset')!.disabled).toBe(true);
    const resetItem = widgetPanelMenu(open, reset, true).find(item => item.id === 'reset')!;
    expect(resetItem.disabled).toBe(false);
    resetItem.onSelect();
    expect(reset).toHaveBeenCalledOnce();
  });

  it('keeps a stable effective widget for sibling action/plot renders and equivalent linked selections', () => {
    const source: Widget = { id: 'linked', title: 'Current source', type: 'plugin', pluginId: 'record-table', dataKind: 'records', providerId: 'fixture', query: 'current.scope', unit: '', config: { selectedId: 'a' }, layout: { x: 0, y: 0, w: 6, h: 4 } };
    const result: QueryResult = { records: { columns: [{ key: 'id', type: 'string' }], rows: [['a']] } };
    function Probe() {
      const panels = useDashboardPanels();
      const first = panels.current(source, { selectedId: 'b' });
      expect(panels.current(source, { selectedId: 'b' })).toBe(first);
      expect(first.config?.selectedId).toBe('b');
      const replacement = { ...source, query: 'replacement.scope' };
      expect(panels.current(replacement, { selectedId: 'b' }).query).toBe('replacement.scope');
      return panels.actions({ widget: source, result });
    }
    expect(renderToStaticMarkup(createElement(DashboardWorkbench, null, createElement(Probe)))).toContain('Actions for Current source');
  });
});
