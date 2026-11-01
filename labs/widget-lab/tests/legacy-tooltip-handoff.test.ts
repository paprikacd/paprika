import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTooltipDismissController } from '../src/components/lab/useTooltipDismiss';
import { createTooltipInteractionStore } from '../src/renderer-extensions/tooltip-interaction';
import { RouteMap, CoastalVectorMap } from '../src/charts/spatial/Maps';
import { ETAWindows, DirectionalRose } from '../src/charts/spatial/DistributionCharts';
import { RackMatrix } from '../src/charts/inference/InferenceCharts';
import { coastalFixtures, logisticsFixtures } from '../src/lenses/spatial/fixtures';
import { buildInferenceFleet } from '../src/lenses/inference-fleet-data';
import { buoyRows, shipments } from '../src/charts/spatial/model';

// Keep actual family selection/rendering, while exposing its popup decision to SSR.
vi.mock('../src/components/lab/ChartTooltip', async () => {
  const { createElement } = await import('react');
  return { ChartTooltip: ({ pinned, children }: { pinned: boolean; children: ReactNode }) => createElement('section', { 'data-test-tooltip': pinned ? 'pinned' : 'transient' }, children) };
});

afterEach(() => vi.useRealTimers());

describe('legacy chart tooltip handoff contracts', () => {
  it('keeps popup focus alive after pointer departure and dismisses only after both leave', () => {
    vi.useFakeTimers();
    const store = createTooltipInteractionStore(), dismiss = vi.fn();
    const owner = Symbol('panel'); store.claimPanel(owner, false, () => {});
    const controller = createTooltipDismissController(() => ({ pinned: false, enabled: true, engaged: store.isPanelEngaged() }), dismiss);
    const unsubscribe = store.subscribe(controller.engagementChanged);
    controller.schedule();
    vi.advanceTimersByTime(90);
    store.setPanelHovered(owner, true);
    store.setPanelFocused(owner, true);
    store.setPanelHovered(owner, false);
    // Pointer movement notifications must not erase keyboard engagement.
    store.pointer(40, 50, null);
    vi.advanceTimersByTime(500);
    expect(dismiss).not.toHaveBeenCalled();
    store.setPanelFocused(owner, false);
    vi.advanceTimersByTime(179);
    expect(dismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
    unsubscribe(); controller.dispose();
  });

  it('preserves controlled route and arrival highlights without opening or pinning a popup', () => {
    const fixtures = logisticsFixtures(), id = shipments(fixtures.map.result.records)[0].id;
    const snapshot = JSON.stringify(fixtures);
    for (const [Component, panel] of [[RouteMap, fixtures.map], [ETAWindows, fixtures.eta]] as const) {
      const markup = renderToStaticMarkup(createElement(Component, { ...panel, widget: { ...panel.widget, config: { ...panel.widget.config, selectedId: id } } }));
      expect(markup).toContain(id);
      expect(markup).toContain('stroke="var(--gamma-accent)"');
      expect(markup).not.toContain('aria-pressed="true"');
      expect(markup).not.toContain('data-test-tooltip');
    }
    expect(JSON.stringify(fixtures)).toBe(snapshot);
  });

  it('keeps a controlled coastal highlight passive and exposes keyboard inspection for rose sectors', () => {
    const fixtures = coastalFixtures(), id = buoyRows(fixtures.map.result.records).find(row => row.kind === 'buoy')!.id;
    const map = renderToStaticMarkup(createElement(CoastalVectorMap, { ...fixtures.map, widget: { ...fixtures.map.widget, config: { ...fixtures.map.widget.config, selectedId: id } } }));
    expect(map).toContain(`data-spatial-id="${id}"`);
    expect(map).toContain('stroke="var(--gamma-accent)"');
    expect(map).not.toContain('data-test-tooltip');
    const rose = renderToStaticMarkup(createElement(DirectionalRose, fixtures.rose));
    expect(rose.match(/aria-pressed="false"/g)).toHaveLength(64);
    expect(rose).not.toContain('data-test-tooltip');
    const embedded = renderToStaticMarkup(createElement(DirectionalRose, { ...fixtures.rose, embedded: true }));
    expect(embedded).not.toContain('role="button"');
    expect(embedded).not.toContain('data-test-tooltip');
  });

  it('never turns a configured rack observation into an implicit pin or disabled popup', () => {
    const panel = buildInferenceFleet().rack;
    const markup = renderToStaticMarkup(createElement(RackMatrix, panel));
    expect(markup.match(/data-selected="true"/g)).toHaveLength(1);
    expect(markup).toContain('aria-label="gpu-073,');
    expect(markup).not.toContain('data-test-tooltip');
    const disabled = renderToStaticMarkup(createElement(RackMatrix, { ...panel, widget: { ...panel.widget, options: { ...panel.widget.options, showTooltip: false } } }));
    expect(disabled).not.toContain('data-test-tooltip');
    const embedded = renderToStaticMarkup(createElement(RackMatrix, { ...panel, embedded: true }));
    expect(embedded).not.toContain('data-test-tooltip');
  });
});
