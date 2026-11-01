import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrbitalPassProfile } from '../src/charts/orbital/OrbitalPassProfile';
import { passProfileConfig, passProfilePoints, profilePasses, profileSignalPath, qualifyProfile, type PassProfilePoint } from '../src/charts/orbital/pass-profile-model';
import { orbitalFixtures } from '../src/lenses/orbital/fixtures';
import { getWidgetDefinition } from '../src/renderer-extensions/widget-registry';
import { registerOrbitalCharts } from '../src/charts/orbital/register';
import { validateEditorWidget } from '../src/editor/editor-model';

const sample = (id: string, seconds: number, elevation: number, margin: number | null = 10, throughput: number | null = 10): PassProfilePoint => ({ id, passId: 'independent', satellite: 'Dawn', station: 'Test site', timestamp: seconds * 1000, elevation, margin, throughput });
const profile = (points: PassProfilePoint[]) => profilePasses(points)[0];

describe('contact threshold intersection and accounting', () => {
  it('computes threshold crossings inside the interval rather than rounding to sample boundaries', () => {
    const result = qualifyProfile(profile([sample('a', 0, 0), sample('b', 60, 60)]));
    expect(result.windows).toEqual([{ start: 10000, end: 60000, volumeMB: 62.5 }]);
    expect(result.totalQualifiedMs).toBe(50000);
    expect(result.totalVolumeMB).toBe(62.5);
    expect(result.coverage).toBe(1);
  });

  it('intersects elevation and margin constraints and integrates rates at the clipped endpoints', () => {
    const pass = profile([sample('a', 0, 0, 10, 0), sample('b', 60, 20, 0, 16)]);
    const result = qualifyProfile(pass, { minimumElevation: 10, minimumMargin: 3 });
    expect(result.totalQualifiedMs).toBeCloseTo(12000);
    expect(result.windows[0].start).toBe(30000);
    expect(result.windows[0].end).toBe(42000);
    // Rates are 8 and 11.2 Mbps at 30s and 42s: average 9.6 * 12 / 8 = 14.4 MB.
    expect(result.totalVolumeMB).toBeCloseTo(14.4);
  });

  it('merges contiguous eligible intervals without changing their duration or integrated volume', () => {
    const result = qualifyProfile(profile([sample('c', 30, 30), sample('a', 0, 30), sample('b', 10, 30, 5, 20)]));
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].start).toBe(0);
    expect(result.windows[0].end).toBe(30000);
    expect(result.totalQualifiedMs).toBe(30000);
    expect(result.totalVolumeMB).toBe(56.25);
  });

  it('preserves measured zero capacity and zero-threshold equality', () => {
    const result = qualifyProfile(profile([sample('a', 0, 0, 0, 0), sample('b', 10, 0, 0, 0)]), { minimumElevation: 0, minimumMargin: 0 });
    expect(result.totalVolumeMB).toBe(0);
    expect(result.totalQualifiedMs).toBe(10000);
    expect(result.windows).toHaveLength(1);
    const excluded = qualifyProfile(profile([sample('a', 0, 4), sample('b', 10, 4)]));
    expect(excluded.totalVolumeMB).toBe(0);
    expect(excluded.totalQualifiedMs).toBe(0);
    expect(excluded.windows).toHaveLength(0);
  });

  it('does not bridge missing signals and reports known contributions separately from unknown totals', () => {
    const pass = profile([sample('a', 0, 30), sample('b', 10, 30), sample('c', 20, 30, null), sample('d', 30, 30), sample('e', 40, 30)]);
    const result = qualifyProfile(pass);
    expect(result.windows).toHaveLength(2);
    expect(result.qualifiedMs).toBe(20000);
    expect(result.knownVolumeMB).toBe(25);
    expect(result.unknownMs).toBe(20000);
    expect(result.coverage).toBe(.5);
    expect(result.totalQualifiedMs).toBeNull();
    expect(result.totalVolumeMB).toBeNull();
    expect(pass.samples[2].margin).toBeNull();
  });

  it('makes the acquisition-gap bound executable and never fills a long missing interval', () => {
    const pass = profile([sample('a', 0, 30), sample('b', 60, 30), sample('c', 121, 30)]);
    const bounded = qualifyProfile(pass, { maxGapSeconds: 60 });
    expect(bounded.coveredMs).toBe(60000);
    expect(bounded.knownVolumeMB).toBe(75);
    expect(bounded.unknownMs).toBe(61000);
    expect(bounded.totalVolumeMB).toBeNull();
    expect(qualifyProfile(pass, { maxGapSeconds: 61 }).totalVolumeMB).toBe(151.25);
  });

  it('retains known eligibility when only transfer rate is missing and resolves excluded intervals without inventing capacity', () => {
    const unknownRate = qualifyProfile(profile([sample('a', 0, 30, 10, null), sample('b', 10, 30)]));
    expect(unknownRate.totalQualifiedMs).toBe(10000);
    expect(unknownRate.totalVolumeMB).toBeNull();
    expect(unknownRate.knownVolumeMB).toBe(0);
    const excluded = qualifyProfile(profile([sample('a', 0, 0, null, null), sample('b', 10, 0, null, null)]));
    expect(excluded.totalQualifiedMs).toBe(0);
    expect(excluded.totalVolumeMB).toBe(0);
    expect(excluded.coverage).toBe(0);
  });

  it('preserves source samples and summaries when display-only options change', () => {
    const points = passProfilePoints(orbitalFixtures().profile.result.records), pass = profilePasses(points)[0], before = structuredClone(pass);
    expect(qualifyProfile(pass, { showThresholds: false, showSampleMarkers: true })).toEqual(qualifyProfile(pass));
    expect(pass).toEqual(before);
    const strict = qualifyProfile(pass, { minimumElevation: 50, minimumMargin: 8 });
    expect(strict.totalQualifiedMs).toBeLessThan(qualifyProfile(pass).totalQualifiedMs!);
    expect(strict.totalVolumeMB).toBeLessThan(qualifyProfile(pass).totalVolumeMB!);
  });
});

describe('contact profile schema and independent input', () => {
  it('accepts renamed columns in a different order only through explicit field mappings', () => {
    const frame = structuredClone(orbitalFixtures().profile.result.records!);
    frame.rows = frame.rows.filter(row => row[1] === 'pass-03').reverse();
    frame.columns[4].key = 'sample_ms'; frame.columns[6].key = 'antenna_deg'; frame.columns[7].key = 'budget_db'; frame.columns[8].key = 'rate_mbps';
    const config = { timestampField: 'sample_ms', elevationField: 'antenna_deg', marginField: 'budget_db', throughputField: 'rate_mbps' };
    const points = passProfilePoints(frame, config), pass = profilePasses(points)[0];
    expect(pass.id).toBe('pass-03');
    expect(pass.samples).toHaveLength(31);
    expect(pass.samples[0].timestamp).toBeLessThan(pass.samples.at(-1)!.timestamp);
    expect(() => passProfilePoints(frame)).toThrow(/timestampField.*Missing orbital field/);
    const reversed = { columns: [...frame.columns].reverse(), rows: frame.rows.map(row => [...row].reverse()) };
    expect(passProfilePoints(reversed, config)).toEqual(points);
  });

  it('rejects incompatible units, primitive metadata and invalid physical values before rendering', () => {
    const base = orbitalFixtures().profile.result.records!;
    for (const [index, unit, field] of [[4, 's', 'timestampField'], [6, 'radians', 'elevationField'], [7, 'dBm', 'marginField'], [8, 'MB/s', 'throughputField']] as const) {
      const frame = structuredClone(base); frame.columns[index].unit = unit;
      expect(() => passProfilePoints(frame)).toThrow(new RegExp(field));
    }
    const typed = structuredClone(base); typed.columns[4].type = 'string'; expect(() => passProfilePoints(typed)).toThrow(/timestampField.*number/);
    const negative = structuredClone(base); negative.rows[0][8] = -1; expect(() => passProfilePoints(negative)).toThrow(/throughputField.*negative/);
    const elevation = structuredClone(base); elevation.rows[0][6] = 91; expect(() => passProfilePoints(elevation)).toThrow(/elevationField/);
    const invalidTime = structuredClone(base); invalidTime.rows[0][4] = 1e30; expect(() => passProfilePoints(invalidTime)).toThrow(/timestampField.*range/);
  });

  it('requires stable unique sample identities and unambiguous pass identities/timestamps', () => {
    const base = orbitalFixtures().profile.result.records!;
    const duplicateId = structuredClone(base); duplicateId.rows[1][0] = duplicateId.rows[0][0]; expect(() => passProfilePoints(duplicateId)).toThrow(/duplicate observation/);
    const duplicateTime = structuredClone(base); duplicateTime.rows[1][4] = duplicateTime.rows[0][4]; expect(() => profilePasses(passProfilePoints(duplicateTime))).toThrow(/duplicate timestamps/);
    const renamedStation = structuredClone(base); renamedStation.rows[1][3] = 'Unrelated'; expect(() => profilePasses(passProfilePoints(renamedStation))).toThrow(/inconsistent satellite or station/);
    expect(() => profilePasses([sample('only', 0, 30)])).toThrow(/at least two/);
  });

  it('validates planning bounds strictly without clamping or ignoring unknown options', () => {
    for (const config of [{ minimumElevation: 91 }, { minimumMargin: Infinity }, { maxGapSeconds: 0 }, { unknownOption: true }]) expect(() => passProfileConfig.parse(config)).toThrow();
  });

  it('rejects a broken mapping through the actual editor acceptance owner', () => {
    registerOrbitalCharts();
    const source = orbitalFixtures().profile, definition = getWidgetDefinition(source.widget)!;
    expect(definition.layout?.mode).toBe('intrinsic');
    expect(definition.configFields?.filter(field => field.binding)).toHaveLength(8);
    expect(() => definition.validateInput?.(source.result, source.widget.config)).not.toThrow();
    const bad = { ...source.widget, config: { ...source.widget.config, throughputField: 'does_not_exist' } };
    const validation = validateEditorWidget(bad, 'records', source.result);
    expect(validation.widget).toBeNull();
    expect(JSON.stringify(validation)).toMatch(/throughputField|does_not_exist/);
  });

  it('breaks plotted paths at missing values and the exact same long-gap policy used for accounting', () => {
    const points = [sample('a', 0, 30), sample('b', 10, 30), sample('c', 20, 30, null), sample('d', 30, 30), sample('e', 100, 30)];
    const path = profileSignalPath(points, 'margin', 60000, n => n / 1000, n => n);
    expect(path).toBe('M0,10 L10,10 M30,10 M100,10');
    expect(profileSignalPath(points, 'elevation', 60000, n => n / 1000, n => n)).toBe('M0,30 L10,30 L20,30 L30,30 M100,30');
  });

  it('renders independent pass data through a static embedded view without interactive controls', () => {
    const source = orbitalFixtures().profile;
    const records = structuredClone(source.result.records!); records.rows = records.rows.filter(row => row[1] === 'pass-03');
    const widget = { ...source.widget, config: { ...source.widget.config, selectedPass: 'pass-03', minimumElevation: 20 } };
    const html = renderToStaticMarkup(createElement(OrbitalPassProfile, { widget, result: { records }, embedded: true }));
    expect(html.replaceAll('<!-- -->', '')).toContain('AST-11 / Perth');
    expect(html).toContain('Qualifying transfer');
    expect(html).not.toMatch(/NaN|Infinity|undefined|<button|<select|<input/);
  });
});
