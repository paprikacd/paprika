import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TooltipSettings } from '../src/editor/WidgetEditor';
import { createEditorDraft, editorStyleControls, revalidateEditorDraft, reviseEditorDraft, travelEditorDraft, updateWidgetOption, validateEditorWidget, visualizationCandidate } from '../src/editor/editor-model';
import { makeCatalogFixture, type CatalogId } from '../src/catalog/chart-fixtures';
import { registerConceptCharts } from '../src/charts/register-concept-charts';
import { getWidgetDefinition } from '../src/vendor/paprika/ui/src/features/insights/widget-registry';
import { widgetKind, widgetOptionsSchema, type WidgetOptions } from '../src/vendor/paprika/ui/src/features/insights/schema';

registerConceptCharts();

describe('shared tooltip configuration', () => {
  it('accepts only implemented placement and bounded pixel dimensions', () => {
    for (const tooltipPlacement of ['auto', 'top', 'right', 'bottom', 'left']) {
      expect(widgetOptionsSchema.safeParse({ tooltipPlacement, tooltipOffset: 0, tooltipMaxWidth: 220, tooltipMaxHeight: 160 }).success).toBe(true);
      expect(widgetOptionsSchema.safeParse({ tooltipPlacement, tooltipOffset: 40, tooltipMaxWidth: 640, tooltipMaxHeight: 800 }).success).toBe(true);
    }
    const invalid = [
      { tooltipPlacement: 'fixed-card' }, { tooltipPosition: 'anchor' },
      { tooltipOffset: -1 }, { tooltipOffset: 41 }, { tooltipOffset: .5 },
      { tooltipMaxWidth: 219 }, { tooltipMaxWidth: 641 }, { tooltipMaxWidth: Number.POSITIVE_INFINITY },
      { tooltipMaxHeight: 159 }, { tooltipMaxHeight: 801 }, { tooltipMaxHeight: Number.NaN },
    ];
    for (const options of invalid) expect(widgetOptionsSchema.safeParse(options).success).toBe(false);
  });

  it('preserves invalid tooltip input and the last valid preview through correction and history', () => {
    const { widget, result } = makeCatalogFixture('kubernetes-placement');
    const source = JSON.stringify({ widget, result });
    const original = createEditorDraft(widget, result);
    const changed = reviseEditorDraft(original, updateWidgetOption(original.draft, 'tooltipPlacement', 'left'), 'records', result);
    const invalid = reviseEditorDraft(changed, updateWidgetOption(changed.draft, 'tooltipMaxWidth', 100), 'records', result);
    expect(invalid.draft.options?.tooltipMaxWidth).toBe(100);
    expect(invalid.errors.some(error => error.startsWith('options.tooltipMaxWidth:'))).toBe(true);
    expect(invalid.preview).toBe(changed.preview);
    expect(validateEditorWidget(invalid.draft, 'records', result).widget).toBeNull();

    const corrected = reviseEditorDraft(invalid, updateWidgetOption(invalid.draft, 'tooltipMaxWidth', 420), 'records', result);
    expect(corrected.errors).toEqual([]);
    expect(corrected.preview.options).toMatchObject({ tooltipPlacement: 'left', tooltipMaxWidth: 420 });
    const undone = travelEditorDraft(corrected, 'undo', 'records', result);
    expect(undone.draft.options?.tooltipMaxWidth).toBe(100);
    expect(undone.preview).toBe(corrected.preview);
    expect(undone.errors.length).toBeGreaterThan(0);
    const redone = travelEditorDraft(undone, 'redo', 'records', result);
    expect(redone.errors).toEqual([]);
    expect(redone.preview.options?.tooltipMaxWidth).toBe(420);
    expect(JSON.stringify({ widget, result })).toBe(source);
  });

  it('restores runtime defaults by removing cleared options while preserving zero and disabled inspection', () => {
    const { widget } = makeCatalogFixture('timeseries');
    let draft = updateWidgetOption(widget, 'tooltipOffset', 0);
    draft = updateWidgetOption(draft, 'tooltipMaxWidth', 390);
    draft = updateWidgetOption(draft, 'showTooltip', false);
    expect(draft.options).toMatchObject({ tooltipOffset: 0, tooltipMaxWidth: 390, showTooltip: false });
    const reset = updateWidgetOption(draft, 'tooltipMaxWidth', undefined);
    expect(Object.hasOwn(reset.options!, 'tooltipMaxWidth')).toBe(false);
    expect(reset.options).toMatchObject({ tooltipOffset: 0, showTooltip: false });
    expect(draft.options?.tooltipMaxWidth).toBe(390);
    expect(widget.options?.tooltipOffset).toBeUndefined();
  });

  it('revalidates refreshed source data without losing tooltip edits or adding history entries', () => {
    const { widget, result } = makeCatalogFixture('kubernetes-placement');
    const initial = createEditorDraft(widget, result);
    const edited = reviseEditorDraft(initial, updateWidgetOption(initial.draft, 'tooltipOffset', 22), 'records', result);
    const changedSource = { ...result, records: { ...result.records!, columns: result.records!.columns.slice(1), rows: result.records!.rows.map(row => row.slice(1)) } };
    const snapshot = JSON.stringify(changedSource);
    const refreshed = revalidateEditorDraft(edited, 'records', changedSource);
    expect(refreshed.errors.length).toBeGreaterThan(0);
    expect(refreshed.draft).toBe(edited.draft);
    expect(refreshed.preview).toBe(edited.preview);
    expect(refreshed.draft.options?.tooltipOffset).toBe(22);
    expect(refreshed.past).toBe(edited.past);
    expect(refreshed.future).toBe(edited.future);
    expect(validateEditorWidget(refreshed.draft, 'records', changedSource).widget).toBeNull();
    const recovered = revalidateEditorDraft(refreshed, 'records', result);
    expect(recovered.errors).toEqual([]);
    expect(recovered.preview.options?.tooltipOffset).toBe(22);
    expect(recovered.past).toBe(edited.past);
    expect(JSON.stringify(changedSource)).toBe(snapshot);
    expect(travelEditorDraft(recovered, 'undo', 'records', result).draft.options?.tooltipOffset).toBe(widget.options?.tooltipOffset);
  });

  it('preserves common tooltip settings across compatible renderers and restores remembered renderer drafts', () => {
    const { widget, result } = makeCatalogFixture('timeseries');
    const options: WidgetOptions = { ...widget.options, showTooltip: false, inspectorDensity: 'compact', tooltipPlacement: 'top', tooltipOffset: 0, tooltipMaxWidth: 410, tooltipMaxHeight: 350 };
    const source = { ...widget, options };
    const bar = visualizationCandidate(source, getWidgetDefinition('bar')!);
    expect(bar.options).toMatchObject({ showTooltip: false, inspectorDensity: 'compact', tooltipPlacement: 'top', tooltipOffset: 0, tooltipMaxWidth: 410, tooltipMaxHeight: 350 });
    expect(bar.providerId).toBe(source.providerId);
    expect(bar.query).toBe(source.query);
    expect(validateEditorWidget(bar, 'metrics', result).errors).toEqual([]);
    const editedBar = updateWidgetOption(bar, 'tooltipMaxWidth', 500);
    const restored = visualizationCandidate(editedBar, getWidgetDefinition('timeseries')!, source);
    expect(restored.options).toEqual(source.options);
  });

  it('uses common tooltip options for the main metric and SRE chart families with their loaded results', () => {
    const ids: CatalogId[] = ['stat', 'timeseries', 'kubernetes-placement', 'kubernetes-resource-trend', 'performance-latency-density', 'performance-trace-waterfall', 'distributed-peer-latency', 'distributed-replication-tracks'];
    for (const id of ids) {
      const { widget, result } = makeCatalogFixture(id);
      const snapshot = JSON.stringify(result);
      expect(editorStyleControls(widget), id).toContain('tooltips');
      const next = { ...widget, options: { ...widget.options, inspectorDensity: 'compact' as const, tooltipPlacement: 'right' as const, tooltipOffset: 18, tooltipMaxWidth: 380, tooltipMaxHeight: 480 } };
      expect(validateEditorWidget(next, widgetKind(widget), result).errors, id).toEqual([]);
      expect(JSON.stringify(result), id).toBe(snapshot);
    }
    expect(editorStyleControls(makeCatalogFixture('record-table').widget)).not.toContain('tooltips');
  });

  it('renders labelled tooltip controls, retains disabled values, and exposes no competing fixed-position mode', () => {
    const markup = renderToStaticMarkup(createElement(TooltipSettings, { options: { showTooltip: false, inspectorDensity: 'compact', tooltipMaxWidth: 440, tooltipOffset: 0 }, onChange: () => undefined }));
    expect(markup).toContain('Show tooltips');
    expect(markup).toMatch(/<fieldset[^>]*disabled=""[^>]*aria-label="Tooltip appearance and placement"/);
    expect(markup).toContain('aria-label="Tooltip density"');
    expect(markup).toContain('aria-label="Tooltip placement"');
    expect(markup).toContain('aria-label="Tooltip maximum width"');
    expect(markup).toContain('value="440"');
    expect(markup).toContain('value="0"');
    expect(markup).toContain('292 × 560 px');
    expect(markup).not.toContain('Show legend');
    expect(markup).not.toContain('Fixed card');
  });
});
