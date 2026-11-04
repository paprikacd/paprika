import { issueText } from './input-issues.helper';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CLINICAL_VISITS, completenessConfig, followupConfig, followupDistribution, followupFromRecords, forestConfig, hazardEstimates, kaplanMeier,
  responseConfig, responseObservations, survivalAt, survivalConfig, survivalObservations,
  swimmerObservations, visitParticipants, type SurvivalObservation,
} from '../src/charts/clinical/model';
import { buildTrialEvidence, clinicalFrame, clinicalParticipants, CLINICAL_POPULATIONS, inClinicalPopulation } from '../src/lenses/clinical/fixtures';
import { clinicalChartCatalog, makeClinicalCatalogFixture } from '../src/charts/clinical/catalog';
import { registerClinicalCharts } from '../src/charts/clinical/register';
import { getWidgetDefinition } from '@insights/widget-registry';
import { widgetSchema } from '@insights/schema';
import { parseRecordFrame } from '@insights/record-data';

const hand: SurvivalObservation[] = [
  { id: 'event-1', arm: 'A', duration: 1, event: true },
  { id: 'censor-1', arm: 'A', duration: 1, event: false },
  { id: 'event-2', arm: 'A', duration: 2, event: true },
  { id: 'censor-3', arm: 'A', duration: 3, event: false },
];
describe('clinical right-censored survival mathematics', () => {
  it('uses the pre-censor risk set for tied event/censor observations', () => {
    const curve = kaplanMeier(hand)[0];
    expect(curve.steps[1]).toMatchObject({ time: 1, risk: 4, events: 1, censored: 1, remaining: 2, survival: .75 });
    expect(curve.steps[2]).toMatchObject({ time: 2, risk: 2, events: 1, censored: 0, remaining: 1, survival: .375 });
    expect(curve.steps[3].survival).toBe(.375);
    expect(curve.median).toBe(2);
    expect(kaplanMeier([...hand].reverse())).toEqual([curve]);
  });
  it('calculates Greenwood log-log limits, retaining ordered probability bounds', () => {
    const first = kaplanMeier(hand)[0].steps[1];
    expect(first.greenwood).toBeCloseTo(1 / 12, 12);
    expect(first.lower).toBeCloseTo(.12794691759514576, 12);
    expect(first.upper).toBeCloseTo(.9605486422850784, 12);
    for (const curve of kaplanMeier(survivalObservations(buildTrialEvidence().survival.result.records!))) {
      curve.steps.forEach((step, index) => {
        expect(step.lower).toBeGreaterThanOrEqual(0); expect(step.upper).toBeLessThanOrEqual(1);
        expect(step.lower).toBeLessThanOrEqual(step.survival); expect(step.upper).toBeGreaterThanOrEqual(step.survival);
        if (index) expect(step.survival).toBeLessThanOrEqual(curve.steps[index - 1].survival);
      });
    }
  });
  it('aligns risk counts immediately before endpoint times and refuses tail extrapolation', () => {
    const curve = kaplanMeier(hand)[0];
    expect(survivalAt(curve, 1).risk).toBe(4); expect(survivalAt(curve, 1.25).risk).toBe(2);
    expect(survivalAt(curve, 2).risk).toBe(2); expect(survivalAt(curve, 2.25).risk).toBe(1);
    expect(survivalAt(curve, 3).available).toBe(true); expect(survivalAt(curve, 3.25).available).toBe(false);
    expect(survivalAt(curve, 3.25).risk).toBe(0);
    expect(() => survivalAt(curve, NaN)).toThrow();
  });
  it('handles no events, terminal failure and events at time zero without NaN', () => {
    const censored = kaplanMeier(hand.map(row => ({ ...row, event: false })))[0];
    expect(censored.median).toBeNull(); expect(censored.steps.every(row => row.survival === 1)).toBe(true);
    const terminal = kaplanMeier([{ id: 'x', arm: 'A', duration: 0, event: true }])[0];
    expect(survivalAt(terminal, 0)).toMatchObject({ survival: 0, lower: 0, upper: 0, risk: 1 });
    expect(terminal.steps.every(row => Object.values(row).every(Number.isFinite))).toBe(true);
  });
  it('keeps each arm denominator independent', () => {
    const curves = kaplanMeier([...hand, { id: 'other', arm: 'B', duration: 2, event: false }]);
    expect(curves.map(curve => curve.size)).toEqual([4, 1]);
    expect(curves[1].steps.at(-1)?.survival).toBe(1);
  });
  it('rejects duplicate identities, ambiguous flags and incompatible units', () => {
    expect(() => kaplanMeier([...hand, hand[0]])).toThrow(/unique/);
    const frame = buildTrialEvidence().survival.result.records!;
    frame.rows[0][3] = 1;
    expect(() => survivalObservations(frame)).toThrow();
    const seconds = buildTrialEvidence().survival.result.records!;
    seconds.columns.find(column => column.key === 'duration')!.unit = 'seconds';
    expect(() => survivalObservations(seconds)).toThrow(/Convert the source/);
  });
});

describe('observed follow-up distribution accounting', () => {
  it('places zero, tied boundaries and the final endpoint into exactly one interval', () => {
    const observations: SurvivalObservation[] = [
      { id: 'first', arm: 'Control', duration: 0, event: true },
      { id: 'below', arm: 'Study', duration: 3 - 1e-12, event: false },
      { id: 'boundary', arm: 'Study', duration: 3, event: true },
      { id: 'last', arm: 'Control', duration: 6, event: false },
    ];
    const result = followupDistribution(observations, 3);
    expect(result.bins.map(bin => [bin.start, bin.end, bin.upperInclusive, bin.events, bin.censored, bin.count])).toEqual([[0, 3, false, 1, 1, 2], [3, 6, true, 1, 1, 2]]);
    expect(result.bins[0].participants).toEqual(['below', 'first']);
    expect(result.bins[1].participants).toEqual(['boundary', 'last']);
    expect(followupDistribution([...observations].reverse(), 3)).toEqual(result);
  });
  it('conserves endpoint totals and every arm under bin-width changes', () => {
    const observations = survivalObservations(buildTrialEvidence().survival.result.records!);
    for (const width of [.5, 1.5, 3, 5, 24]) {
      const distribution = followupDistribution(observations, width);
      expect(distribution.population).toBe(480);
      expect(distribution.bins.reduce((total, bin) => total + bin.count, 0)).toBe(480);
      expect(distribution.bins.reduce((total, bin) => total + bin.events, 0)).toBe(distribution.events);
      expect(distribution.bins.reduce((total, bin) => total + bin.censored, 0)).toBe(distribution.censored);
      expect(distribution.events + distribution.censored).toBe(480);
      for (const bin of distribution.bins) {
        expect(bin.arms.reduce((total, arm) => total + arm.count, 0)).toBe(bin.count);
        expect(bin.events + bin.censored).toBe(bin.count);
        bin.arms.forEach(arm => expect(arm.events + arm.censored).toBe(arm.count));
      }
    }
  });
  it('retains empty bins as measured zero and does not treat censors as future events', () => {
    const observations: SurvivalObservation[] = [{ id: 'short', arm: 'A', duration: 0, event: false }, { id: 'long', arm: 'A', duration: 6.25, event: false }];
    const distribution = followupDistribution(observations, 2);
    expect(distribution.bins.map(bin => bin.count)).toEqual([1, 0, 0, 1]);
    expect(distribution.events).toBe(0); expect(distribution.censored).toBe(2);
    expect(distribution.bins.flatMap(bin => bin.participants)).toEqual(['short', 'long']);
    expect(followupDistribution([], 2)).toMatchObject({ bins: [], population: 0, events: 0, censored: 0 });
  });
  it('derives the exact subgroup denominator from the same endpoint records as survival', () => {
    for (const population of CLINICAL_POPULATIONS) {
      const trial = buildTrialEvidence(population.id), distribution = followupFromRecords(trial.followup.result.records!);
      expect(distribution.population).toBe(trial.summary.size);
      expect(distribution.events).toBe(trial.summary.events);
      expect(distribution.censored).toBe(trial.summary.censored);
      expect(distribution.bins.reduce((sum, bin) => sum + bin.count / distribution.population, 0)).toBeCloseTo(1, 12);
    }
  });
  it('supports independent renamed fields and explicitly declared month units', () => {
    const frame = {
      columns: [{ key: 'subject', type: 'string' as const }, { key: 'stratum', type: 'string' as const }, { key: 'observed', type: 'number' as const, unit: 'month' }, { key: 'endpoint', type: 'boolean' as const }],
      rows: [['S-b', 'B', 3.5, false], ['S-a', 'A', .25, true]],
    };
    const config = followupConfig.parse({ id: 'subject', arm: 'stratum', duration: 'observed', event: 'endpoint', binWidthMonths: 1 });
    expect(followupFromRecords(frame, config)).toMatchObject({ population: 2, events: 1, censored: 1, maxDuration: 3.5 });
    expect(followupFromRecords(frame, config).bins.at(-1)?.arms).toEqual([{ arm: 'A', events: 0, censored: 0, count: 0 }, { arm: 'B', events: 0, censored: 1, count: 1 }]);
    expect(() => followupFromRecords(frame, followupConfig.parse({ ...config, duration: 'unknown' }))).toThrow(/Missing clinical field: unknown/);
    frame.columns[2].unit = 'days';
    expect(() => followupFromRecords(frame, config)).toThrow(/Convert the source/);
  });
  it('rejects duplicate subjects, negative durations, ambiguous flags and excessive bin counts', () => {
    expect(() => followupDistribution([...hand, hand[0]])).toThrow(/unique/);
    expect(() => followupDistribution([{ ...hand[0], duration: -1 }])).toThrow(/0–120/);
    expect(() => followupDistribution([{ ...hand[0], event: 1 as unknown as boolean }])).toThrow(/event\/censor/);
    expect(() => followupDistribution([{ ...hand[0], duration: 120 }], .25)).toThrow(/at most 64 bins/);
    expect(() => followupDistribution(hand, 0)).toThrow(/0.25–24/);
    expect(() => followupConfig.parse({ arrangement: 'density' })).toThrow();
  });
});

describe('clinical participant and uncertainty contracts', () => {
  it('conserves endpoint accounting and actually filters subgroup records', () => {
    const full = buildTrialEvidence();
    expect(full.summary.size).toBe(480); expect(full.summary.events + full.summary.censored).toBe(480);
    for (const group of CLINICAL_POPULATIONS) {
      const filtered = buildTrialEvidence(group.id);
      expect(filtered.summary.size).toBe(full.allParticipants.filter(patient => inClinicalPopulation(patient, group.id)).length);
      expect(filtered.curves.reduce((total, curve) => total + curve.size, 0)).toBe(filtered.summary.size);
      expect(hazardEstimates(full.forest.result.records!).find(row => row.id === group.id)?.samples).toBe(filtered.summary.size);
    }
  });
  it('retains zero responses and requires paired assessment times', () => {
    const frame = buildTrialEvidence().response.result.records!;
    frame.rows[0][5] = 0; frame.rows[0][6] = 6;
    expect(responseObservations(frame).find(row => row.id === frame.rows[0][0])?.value).toBe(0);
    frame.rows[0][6] = null;
    expect(() => responseObservations(frame)).toThrow(/paired/);
  });
  it('response ordering changes neither values, identities nor assessed population', () => {
    const frame = buildTrialEvidence().response.result.records!;
    const responseOrder = responseObservations(frame), identityOrder = responseObservations(frame, responseConfig.parse({ sort: 'identity' }));
    expect(responseOrder.map(row => row.id).sort()).toEqual(identityOrder.map(row => row.id).sort());
    for (const row of responseOrder) expect(identityOrder.find(other => other.id === row.id)).toEqual(row);
    expect(responseOrder.filter(row => row.value !== null).length).toBe(buildTrialEvidence().summary.responses);
  });
  it('forest intervals require positive ordered ratios and explicit population counts', () => {
    const fixture = buildTrialEvidence().forest.result.records!;
    expect(hazardEstimates(fixture).some(row => row.lower < 1 && row.upper > 1)).toBe(true);
    fixture.rows[0][3] = 0; expect(() => hazardEstimates(fixture)).toThrow(/positive/);
    const reversed = buildTrialEvidence().forest.result.records!; reversed.rows[0][4] = .1;
    expect(() => hazardEstimates(reversed)).toThrow(/ordered/);
  });
  it('distinguishes missed visits from post-event and after-censor periods', () => {
    const fixture = buildTrialEvidence('all', true), rows = visitParticipants(fixture.completeness.result.records!);
    const states = new Set(rows.flatMap(row => row.visits));
    expect(states).toEqual(new Set(['observed', 'missing', 'post-event', 'after-censor']));
    for (const patient of fixture.participants) {
      if (patient.response !== null) expect(patient.visits[3]).toBe('observed');
      patient.visits.forEach((state, index) => { if (CLINICAL_VISITS[index] > patient.duration) expect(state).toBe(patient.event ? 'post-event' : 'after-censor'); });
    }
  });
  it('coverage scenarios change missing visits without changing endpoint records', () => {
    const complete = buildTrialEvidence('all', false), gaps = buildTrialEvidence('all', true);
    expect(complete.summary.missingVisits).toBe(0); expect(gaps.summary.missingVisits).toBeGreaterThan(0);
    expect(survivalObservations(complete.survival.result.records!)).toEqual(survivalObservations(gaps.survival.result.records!));
  });
  it('keeps treatment and observed visits inside each participant follow-up', () => {
    const frame = clinicalFrame(clinicalParticipants(true));
    expect(swimmerObservations(frame)).toHaveLength(480);
    frame.rows[0][4] = Number(frame.rows[0][2]) + 1;
    expect(() => swimmerObservations(frame)).toThrow(/within observed follow-up/);
  });
});

describe('clinical authoring and canonical host preflight', () => {
  registerClinicalCharts();
  it('parses every fixture through the actual canonical record and widget contracts', () => {
    for (const feature of clinicalChartCatalog) for (const preset of feature.presets) {
      const fixture = makeClinicalCatalogFixture(feature.id, preset), definition = getWidgetDefinition('plugin', feature.id)!;
      expect(() => widgetSchema.parse(fixture.widget)).not.toThrow();
      expect(() => parseRecordFrame(fixture.result.records)).not.toThrow();
      expect(() => definition.parseConfig!(fixture.widget.config)).not.toThrow();
      expect(definition.validateInput!(fixture.result, fixture.widget.config)).toEqual([]);
      expect(definition.sizing?.mode).toBe('intrinsic');
      if (preset === 'empty') expect(fixture.result.records!.rows).toHaveLength(0);
    }
  });
  it('rejects schema-valid mappings to absent or wrongly typed fields', () => {
    const fixture = makeClinicalCatalogFixture('survival-km'), definition = getWidgetDefinition('plugin', 'survival-km')!;
    const config = survivalConfig.parse({ duration: 'missing_duration' });
    expect(() => definition.parseConfig!(config)).not.toThrow();
    expect(issueText(definition.validateInput!(fixture.result, config))).toMatch(/Missing clinical field/);
    fixture.result.records!.columns.find(column => column.key === 'duration')!.type = 'string';
    fixture.result.records!.rows.forEach(row => { row[2] = String(row[2]); });
    expect(issueText(definition.validateInput!(fixture.result, {}))).toMatch(/must have type number/);
  });
  it('rejects invented options and incompatible visit mappings', () => {
    expect(() => survivalConfig.parse({ intervalType: 'invented' })).toThrow();
    expect(() => forestConfig.parse({ showValues: 'yes' })).toThrow();
    expect(() => completenessConfig.parse({ pageSize: 0 })).toThrow();
    const fixture = makeClinicalCatalogFixture('visit-completeness');
    expect(() => visitParticipants(fixture.result.records!, completenessConfig.parse({ visitPrefix: 'unknown' }))).toThrow(/Missing/);
  });
  it('validates follow-up data before accepting renamed or over-dense configurations', () => {
    const fixture = makeClinicalCatalogFixture('followup-distribution'), definition = getWidgetDefinition('plugin', 'followup-distribution')!;
    expect(issueText(definition.validateInput!(fixture.result, { duration: 'missing' }))).toMatch(/Missing clinical field/);
    expect(issueText(definition.validateInput!(fixture.result, { binWidthMonths: .25 }))).toMatch(/at most 64 bins/);
    expect(definition.validateInput!(fixture.result, { binWidthMonths: .5 })).toEqual([]);
    expect(definition.configFields?.find(field => field.key === 'duration')?.binding).toMatchObject({ types: ['number'], unit: 'months', acceptedUnits: ['months', 'month'] });
  });
  it('renders follow-up variants without changing the source cohort or embedded interactivity', () => {
    const fixture = makeClinicalCatalogFixture('followup-distribution'), definition = getWidgetDefinition('plugin', 'followup-distribution')!;
    const records = JSON.stringify(fixture.result.records);
    for (const arrangement of ['stacked', 'grouped']) for (const measure of ['count', 'percent']) {
      const widget = { ...fixture.widget, config: { ...fixture.widget.config, arrangement, measure } };
      const markup = renderToStaticMarkup(createElement(definition.render, { ...fixture, widget, embedded: true }));
      expect(markup).not.toMatch(/NaN|Infinity/); expect(markup).toContain('480');
      expect(markup).not.toContain('role="button"'); expect(markup).not.toContain('<select');
      expect(JSON.stringify(fixture.result.records)).toBe(records);
    }
  });
  it('renders ready/gap/empty states through registered owners, with passive embedded content', () => {
    for (const feature of clinicalChartCatalog) for (const preset of feature.presets.filter(preset => preset !== 'error')) {
      const fixture = makeClinicalCatalogFixture(feature.id, preset), definition = getWidgetDefinition('plugin', feature.id)!;
      const output = renderToStaticMarkup(createElement(definition.render, { ...fixture, embedded: true }));
      expect(output).not.toMatch(/NaN|Infinity/);
      if (preset !== 'empty') expect(output).toContain('<svg');
      expect(output).not.toContain('role="button"'); expect(output).not.toContain('<button'); expect(output).not.toContain('<input');
    }
  });
});
