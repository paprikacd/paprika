import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { widgetKind, widgetOptionsSchema, type Widget, type WidgetOptions } from '@insights/schema';
import { makeCatalogFixture } from '../src/catalog/chart-fixtures';
import { registerLabCharts } from '../src/charts/register-lab-charts';
import { registerConceptCharts } from '../src/charts/register-concept-charts';
import { validateEditorWidget, editorStyleControls, updateWidgetOption } from '../src/editor/editor-model';
import {
  AdvancedAxisSettings, AppearanceSettings, LabelSettings, PresentationPresets,
  SeriesColourSettings, StatSettings, ThresholdSettings, TooltipContentControls,
  presentationPreset, changeTooltipMiniType,
} from '../src/editor/RichWidgetOptions';
import { widgetPanelMenu } from '../src/components/lab/DashboardWorkbench';

registerLabCharts();
registerConceptCharts();
const noop = () => undefined;

describe('rich widget configuration and tooltip authoring', () => {
  it('preserves the original data/query/security identity with every presentation preset', () => {
    for (const family of ['timeseries', 'stat', 'record-table', 'kubernetes-placement'] as const) {
      const { widget, result } = makeCatalogFixture(family);
      const source = structuredClone(widget);
      for (const id of ['focus', 'investigate', 'briefing'] as const) {
        const preset = presentationPreset(widget, id);
        expect(preset.id).toBe(widget.id);
        expect(preset.providerId).toBe(widget.providerId);
        expect(preset.query).toBe(widget.query);
        expect(preset.queryRef).toEqual(widget.queryRef);
        expect(preset.layout).toEqual(widget.layout);
        expect(preset.config).toEqual(widget.config);
        expect(validateEditorWidget(preset, widgetKind(widget), result).errors, family + ':' + id).toEqual([]);
        if (!editorStyleControls(widget).includes('legend')) expect(preset.options?.showLegend).toBe(widget.options?.showLegend);
      }
      expect(widget).toEqual(source);
    }
  });

  it('uses real metric tooltip fields and supports bounded series-backed mini visualizations', () => {
    const { widget, result } = makeCatalogFixture('timeseries');
    const revised = {
      ...widget,
      options: { ...widget.options, tooltipTitle: 'Runbook signal', tooltipValueLabel: 'P95 observed',
        tooltipDecimals: 3, tooltipShowUnit: false,
        tooltipView: { type: 'timeseries' as const, height: 160 as const, source: { type: 'series' as const },
          title: 'Recent response', showGrid: true, showAxis: true, showLegend: false },
      },
    };
    expect(validateEditorWidget(revised, widgetKind(widget), result).errors).toEqual([]);
    const html = renderToStaticMarkup(createElement(TooltipContentControls, { widget: revised, result, onOption: noop }));
    for (const text of ['Runbook signal', 'P95 observed', 'Mini history', 'Embedded mini-chart', '160px', 'Content sample', 'Loaded fixture', 'Source details'])
      expect(html, text).toContain(text);
    expect(html).toContain('aria-label="Tooltip heading"');
    expect(html).toContain('aria-label="Tooltip mini-chart type"');
    expect(html).toContain('aria-label="Tooltip mini-chart height"');
    expect(html).not.toContain('Invalid input');
    expect(JSON.stringify(result)).toBe(JSON.stringify(makeCatalogFixture('timeseries').result));
  });

  it('renders data-backed record tooltip preview without promising a query backend', () => {
    const { widget, result } = makeCatalogFixture('record-table');
    const html = renderToStaticMarkup(createElement(TooltipContentControls, { widget, result, onOption: noop }));
    expect(html).toContain('Loaded fixture');
    expect(html).toContain('Content sample');
    expect(html).not.toContain('Tooltip mini-chart type');
    expect(html).not.toContain('500 randomly generated');
  });

  it('can configure reference lines, exact-label colours, stat thresholds and formatting within the real schema', () => {
    const metric = makeCatalogFixture('timeseries');
    const annotations: WidgetOptions = {
      timeAxis: 'calendar', axisUnit: 'caption', plotInsetLeft: 64, plotInsetRight: 24,
      referenceLines: [{value: 0, label:'Neutral'}, {value: 10, color:'#428ff5',label:'SLO'}],
      seriesColors: [{ label:'service', value:'checkout', color:'#428ff5' }],
    };
    expect(widgetOptionsSchema.safeParse(annotations).success).toBe(true);
    const next = { ...metric.widget, options: { ...metric.widget.options, ...annotations } };
    expect(validateEditorWidget(next, widgetKind(next), metric.result).errors).toEqual([]);
    const series = renderToStaticMarkup(createElement(SeriesColourSettings, { widget: next, result: metric.result, onOption: noop }));
    expect(series).toContain('Source label');
    expect(series).toContain('Exact value');
    expect(series).toContain('Add series colour');
    const axis = renderToStaticMarkup(createElement(AdvancedAxisSettings, { widget: next, onOption: noop }));
    expect(axis).toContain('Time scale');
    expect(axis).toContain('Reference lines');
    expect(axis).toContain('Reference line 2');
    const stat = makeCatalogFixture('stat');
    const statConfig = { ...stat.widget, options:{ ...stat.widget.options, min:0, max:100, showStatBar:true,
      thresholds:[{value:30,color:'#428ff5'}, {value:80,color:'#d69c54'}] } };
    expect(validateEditorWidget(statConfig, widgetKind(statConfig), stat.result).errors).toEqual([]);
    const markup = renderToStaticMarkup(createElement(StatSettings, { widget:statConfig, onOption:noop }));
    expect(markup).toContain('Value progress bar');
    expect(markup).toContain('Stale after');
    expect(renderToStaticMarkup(createElement(ThresholdSettings, { widget:statConfig, onOption:noop }))).toContain('Threshold 2');
  });

  it('makes preset, appearance and family-specific controls discoverable', () => {
    const metric = makeCatalogFixture('timeseries').widget;
    const stat = makeCatalogFixture('stat').widget;
    const heatmap = { ...makeCatalogFixture('timeseries').widget, type: 'bar' as const };
    const presets = renderToStaticMarkup(createElement(PresentationPresets, {widget:metric,onApply:noop}));
    for (const phrase of ['Focus', 'Investigate', 'Briefing', 'Apply Focus presentation preset']) expect(presets).toContain(phrase);
    const appearance = renderToStaticMarkup(createElement(AppearanceSettings, {widget:metric,onOption:noop}));
    expect(appearance).toContain('Panel background');
    expect(appearance).toContain('Panel text');
    expect(renderToStaticMarkup(createElement(LabelSettings, {widget:heatmap,onOption:noop}))).toContain('Show category labels');
    expect(renderToStaticMarkup(createElement(LabelSettings, {widget:stat,onOption:noop}))).not.toContain('category labels');
  });

  it('rejects invalid rich settings without affecting the last valid preview', () => {
    const {widget,result}=makeCatalogFixture('timeseries');
    const correct = updateWidgetOption(widget, 'tooltipDecimals', 4);
    expect(validateEditorWidget(correct, widgetKind(correct), result).errors).toEqual([]);
    expect(validateEditorWidget({ ...correct, options:{...correct.options,tooltipDecimals:12}},widgetKind(correct),result).widget).toBeNull();
    expect(validateEditorWidget({ ...correct, options:{...correct.options,referenceLines:[{value:0,label:''}]}},widgetKind(correct),result).widget).toBeNull();
    expect(widget.options?.tooltipDecimals).toBeUndefined();
  });
  it('keeps advanced tooltip source queries through visualization changes without inventing an endpoint', () => {
    const source = { type:'query' as const, providerId:'fixture-provider', query:'synthetic_history{service="api"}' };
    const existing = { type:'timeseries' as const, source, height:160 as const, showGrid:true };
    const changed = changeTooltipMiniType(existing, 'bar');
    expect(changed).toMatchObject({ type:'bar', source, height:160, showGrid:true });
    expect(changed?.source).toBe(source);
    expect(changeTooltipMiniType(existing, 'none')).toBeUndefined();
    expect(changeTooltipMiniType(undefined, 'timeseries')).toEqual({ type:'timeseries', source:{type:'series'}, height:120 });
    expect(widgetOptionsSchema.safeParse({tooltipView:changed}).success).toBe(true);
  });

  it('offers direct panel-menu shortcuts without offering unsupported tooltip controls', () => {
    const selected: string[] = [];
    const open = (value: string) => selected.push(value);
    const withTooltip = widgetPanelMenu(open, () => undefined, false, true);
    withTooltip.find(item => item.id === 'appearance')?.onSelect();
    withTooltip.find(item => item.id === 'tooltip')?.onSelect();
    expect(selected).toEqual(['appearance','tooltip']);
    const unsupported = widgetPanelMenu(open, () => undefined, false, false);
    expect(unsupported.find(item => item.id === 'tooltip')).toBeUndefined();
    expect(unsupported.find(item => item.id === 'appearance')).toBeDefined();
  });

  it('does not advertise generic metric-content controls for renderer-owned record tooltip bodies', () => {
    const { widget, result } = makeCatalogFixture('record-table');
    const html = renderToStaticMarkup(createElement(TooltipContentControls,{widget,result,onOption:noop}));
    expect(html).toContain('renderer owns its observation content');
    expect(html).not.toContain('aria-label="Tooltip heading"');
    expect(html).not.toContain('Tooltip mini-chart type');
  });

});

