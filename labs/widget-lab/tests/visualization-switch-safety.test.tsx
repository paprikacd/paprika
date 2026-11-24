// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { widgetKind, type Widget } from '@insights/schema';
import { getWidgetDefinition, getWidgetPlugins, widgetDefinitions } from '@insights/widget-registry';
import { WidgetEditor } from '../src/editor/WidgetEditor';
import { WidgetPreviewBoundary } from '../src/editor/WidgetPreviewBoundary';
import {
  editorVisualizations, isSafeVisualizationTransition, MAX_CONVERTED_RECORD_COLUMNS,
  MAX_CONVERTED_RECORD_ROWS, validateEditorWidget, visualizationCandidate,
} from '../src/editor/editor-model';
import { kubernetesFixtures } from '../src/lenses/kubernetes/fixtures';
import { registerLabCharts } from '../src/charts/register-lab-charts';
import { makeCatalogFixture } from '../src/catalog/chart-fixtures';

vi.mock('@insights/charts', () => ({
  WidgetVisualization: ({ widget, naturalHeight }: { widget: Widget; naturalHeight?: boolean }) =>
    createElement('div', { 'data-rendered-family': widget.pluginId ?? widget.type, 'data-natural-height': String(naturalHeight) }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
registerLabCharts();

describe('fail-safe visualization switching', () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = undefined; host = undefined;
  });

  it('does not offer a record table as a conversion from Kubernetes workload placement', () => {
    const { placement } = kubernetesFixtures();
    const { widget, result } = placement;
    // The production placement reads metric series, so there are no records to convert into a table.
    expect(result.records).toBeUndefined();
    expect(result.series!.length).toBeGreaterThan(0);
    const table = getWidgetDefinition('plugin', 'record-table')!;
    const choices = editorVisualizations(widget, result, [...widgetDefinitions, ...getWidgetPlugins()]);
    expect(choices.some(option => option.id === 'record-table')).toBe(false);
    expect(choices.some(option => option.id === 'kubernetes-placement')).toBe(true);
    expect(choices.every(option => !!validateEditorWidget(visualizationCandidate(widget, option), widgetKind(widget), result).widget)).toBe(true);
    void table;
  });

  it('keeps valid small-record table transitions without dropping source identity', () => {
    const { widget, result } = makeCatalogFixture('connection-map');
    const table = getWidgetDefinition('plugin', 'record-table')!;
    expect(result.records!.columns.length).toBeLessThanOrEqual(MAX_CONVERTED_RECORD_COLUMNS);
    expect(result.records!.rows.length).toBeLessThanOrEqual(MAX_CONVERTED_RECORD_ROWS);
    expect(isSafeVisualizationTransition(widget, result, table)).toBe(true);
    const choices = editorVisualizations(widget, result, [...widgetDefinitions, ...getWidgetPlugins()]);
    expect(choices.some(option => option.id === 'record-table')).toBe(true);
    const converted = visualizationCandidate(widget, table);
    expect(validateEditorWidget(converted, widgetKind(widget), result).widget).not.toBeNull();
    expect(converted.providerId).toBe(widget.providerId);
    expect(converted.query).toBe(widget.query);
    expect(converted.layout).toEqual(widget.layout);
    expect(converted.config).not.toEqual(widget.config);
  });

  it('keeps the chart editor intact and disables the unsafe selector for the wide fixture', async () => {
    const { widget, result } = kubernetesFixtures().placement;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root?.render(createElement(WidgetEditor, {
        widget, result, onApply: vi.fn(), onClose: vi.fn(),
      }));
    });
    const select = document.querySelector<HTMLButtonElement>('[aria-label="Visualization type"]')!;
    expect(select).not.toBeNull();
    expect(document.querySelector('[aria-label="Live chart preview"]')).not.toBeNull();
    const available = editorVisualizations(widget, result, [...widgetDefinitions, ...getWidgetPlugins()]);
    if (available.length === 1) {
      expect(select.disabled).toBe(true);
      expect(document.body.textContent).toContain('No safe alternative visualization');
    }
    expect(document.querySelector('[data-rendered-family="kubernetes-placement"]')).not.toBeNull();
    expect(document.querySelector('[data-widget-preview-error]')).toBeNull();
  });

  
  it('captures an unexpected renderer exception without crashing the editor', async () => {
    const Bomb = () => { throw new Error('Deliberate preview renderer failure'); };
    const failed = vi.fn();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    try {
      await act(async () => root?.render(createElement(WidgetPreviewBoundary, { onFailure: failed },
        createElement(Bomb))));
      expect(host.querySelector('[data-widget-preview-error]')).not.toBeNull();
      expect(host.textContent).toContain('configuration was not applied');
      expect(failed).toHaveBeenCalledOnce();
    } finally { consoleSpy.mockRestore(); }
  });
});

