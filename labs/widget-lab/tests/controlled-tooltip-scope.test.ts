import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OrbitalGroundTrack, OrbitalSkyplot, OrbitalContactTimeline } from '../src/charts/orbital/OrbitalCharts';
import { OrbitalPassProfile } from '../src/charts/orbital/OrbitalPassProfile';
import { KubernetesResourceTrend } from '../src/charts/kubernetes/KubernetesCharts';
import { WaferDieMap } from '../src/charts/wafer/WaferMap';
import { orbitalFixtures } from '../src/lenses/orbital/fixtures';
import { kubernetesFixtures } from '../src/lenses/kubernetes/fixtures';
import { waferFixtures } from '../src/lenses/wafer/fixtures';
import { resolveInspectionState } from '../src/charts/shared/inspection-state';

// Inspect the family's intent to open a popup: the actual portal returns no
// browser content during SSR, which would otherwise conceal this regression.
vi.mock('../src/components/lab/DomainInspector', () => ({
  DomainInspector: ({ title }: { title: string }) => createElement('div', { 'data-requested-tooltip': title }),
}));

describe('linked dashboard scope and local tooltip ownership', () => {
  const orbital = orbitalFixtures('pass-03');
  const timestamp = orbital.passes.find(pass => pass.id === 'pass-03')!.samples[4].timestamp;
  for (const [name, Component, panel] of [
    ['ground track', OrbitalGroundTrack, orbital.map],
    ['skyplot', OrbitalSkyplot, orbital.skyplot],
    ['contact timeline', OrbitalContactTimeline, orbital.timeline],
    ['qualification profile', OrbitalPassProfile, orbital.profile],
  ] as const) {
    it(`keeps the linked ${name} pass/time without opening a tooltip`, () => {
      const widget = { ...panel.widget, config: { ...panel.widget.config, selectedPass: 'pass-03', selectedTimestamp: timestamp } };
      const html = renderToStaticMarkup(createElement(Component, { ...panel, widget }));
      expect(html).not.toContain('data-requested-tooltip');
      expect(html).toContain('value="pass-03" selected=""');
      expect(html).not.toMatch(/NaN|Infinity/);
      if (name === 'ground track') expect(html).toContain('orbital-evidence-hint');
      if (name === 'qualification profile') expect(html).toContain('Qualifying duration');
    });
  }

  it('retains the linked Kubernetes timestamp marker without treating it as a local pin', () => {
    const panel = kubernetesFixtures().trend, records = panel.result.records!;
    const stamp = records.rows[10][records.columns.findIndex(column => column.key === 'timestamp')] as number;
    const widget = { ...panel.widget, config: { ...panel.widget.config, selectedAt: stamp } };
    const html = renderToStaticMarkup(createElement(KubernetesResourceTrend, { ...panel, widget }));
    expect(html).not.toContain('data-requested-tooltip');
    expect(html).toContain('kube-point-focus');
  });

  it('retains the controlled wafer highlight while tooltips wait for local interaction', () => {
    const data = waferFixtures();
    for (const showTooltip of [true, false]) {
      const widget = { ...data.map.widget, options: { ...data.map.widget.options, showTooltip }, config: { ...data.map.widget.config, selectedDieId: data.initialDie } };
      const html = renderToStaticMarkup(createElement(WaferDieMap, { ...data.map, widget }));
      expect(html).not.toContain('data-requested-tooltip');
      expect(html).toContain(`value="${data.initialDie}" selected=""`);
      expect(html).toContain('stroke="var(--gamma-chart-1)"');
    }
  });

  it('retains an explicit sample pin across its pass-selection echo, but clears it for another pass or result', () => {
    const result = {}, sample = { id: 'sample-4', passId: 'pass-03' };
    const state = { hover: null, pinned: sample.id }, previous = { revision: result, externalSelection: 'pass-01' };
    expect(resolveInspectionState(state, previous, { revision: result, externalSelection: sample.passId }, [sample], true, point => point.passId).pinned).toBe(sample.id);
    expect(resolveInspectionState(state, previous, { revision: result, externalSelection: 'pass-02' }, [sample], true, point => point.passId).pinned).toBeNull();
    expect(resolveInspectionState(state, previous, { revision: {}, externalSelection: sample.passId }, [sample], true, point => point.passId).pinned).toBeNull();
  });
});
