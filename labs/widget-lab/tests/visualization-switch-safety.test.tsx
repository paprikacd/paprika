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
import { registerKubernetesCharts } from '../src/charts/kubernetes/register';
import { registerLabCharts } from '../src/charts/register-lab-charts';
import { makeCatalogFixture } from '../src/catalog/chart-fixtures';

vi.mock('@insights/charts', () => ({
  WidgetVisualization: ({ widget, naturalHeight }: { widget: Widget; naturalHeight?: boolean }) =>
    createElement('div', { 'data-rendered-family': widget.pluginId ?? widget.type, 'data-natural-height': String(naturalHeight) }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
registerLabCharts();
registerKubernetesCharts();

describe('fail-safe visualization switching', () => {
  let root: Root | undefined;
  let host: HTMLDivElement | undefined;
  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    host?.remove();
    root = undefined; host = undefined;
  });

  it('does not offer a giant table as a conversion from Kubernetes workload placement', () => {
    const { placement } = kubernetesFixtures();
    const { widget, result } = placement;
    const records = result.records!;
    expect(records.rows.length).toBeGreaterThan(MAX_CONVERTED_RECORD_ROWS);
    expect(records.columns.length).toBeGreaterThan(MAX_CONVERTED_RECORD_COLUMNS);
    const table = getWidgetDefinition('plugin', 'record-table')!;
    // Schema alone accepts the table: capability/geometry gating must go beyond schema validation.
    const candidate = visualizationCandidate(widget, table);
    expect(validateEditorWidget(candidate, widgetKind(widget), result).errors).toEqual([]);
    expect(isSafeVisualizationTransition(widget, result, table)).toBe(false);
    const choices = editorVisualizations(widget, result, [...widgetDefinitions, ...getWidgetPlugins()]);
    expect(choices.some(option => option.id === 'record-table')).toBe(false);
    expect(choices.some(option => option.id === 'kubernetes-placement')).toBe(true);
    expect(choices.every(option => !!validateEditorWidget(visualizationCandidate(widget, option), widgetKind(widget), result).widget)).toBe(true);
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
    // Existing records tables remain editable even when their source has many rows.
    const { placement } = kubernetesFixtures();
    const wideTable = visualizationCandidate(placement.widget, table);
    expect(isSafeVisualizationTransition(wideTable, placement.result, table)).toBe(true);
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

  it('confines a large existing records table to a finite chart preview instead of natural height', async () => {
    const { widget, result } = kubernetesFixtures().placement;
    const table = visualizationCandidate(widget, getWidgetDefinition('plugin', 'record-table')!);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(createElement(WidgetEditor, {
      widget: table, result, onApply: vi.fn(), onClose: vi.fn(),
    })));
    expect(document.querySelector('[data-rendered-family="record-table"]')).not.toBeNull();
    expect(document.querySelector('[data-natural-height="false"]')).not.toBeNull();
    expect(document.querySelector('.we-chart[data-editor-expanded="false"]')).not.toBeNull();
    const css = readFileSync('src/editor/WidgetEditor.css', 'utf8');
    expect(css).toMatch(/\.we-chart\s*\{[^}]*overflow:hidden/);
    expect(css).toMatch(/\.we-chart\[data-editor-expanded="false"\]\s*>\s*div\s*\{[^}]*max-height:100%/);
    expect(css).toMatch(/\.we-preview\s*\{[^}]*overflow:clip/);
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

