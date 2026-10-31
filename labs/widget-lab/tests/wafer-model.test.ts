import { describe, expect, it } from 'vitest';
import { parseRecordFrame } from '../src/vendor/paprika/ui/src/features/insights/record-data';
import { chamberBoxes, chamberRows, dieAngle, filterDies, processSteps, quantile, summarizeWafer, waferChamberConfig, waferLineageConfig, waferLosses, waferMapConfig, waferRows, waferSignature, waferSignatureConfig, waferYieldConfig } from '../src/charts/wafer/model';
import { chamberResult, waferFixtures, waferLot, waferResult } from '../src/lenses/wafer/fixtures';

describe('wafer physical source and canonical transport', () => {
  it('represents one full wafer within canonical limits and keeps excluded/untested separate', () => {
    for (const wafer of waferLot()) {
      expect(parseRecordFrame(wafer.result.records)).toEqual(wafer.result.records);
      expect(wafer.dies).toHaveLength(709);
      const s = summarizeWafer(wafer.dies);
      expect(s.excluded).toBe(80);
      expect(s.eligible).toBe(629);
      expect(s.tested + s.untested + s.excluded).toBe(s.positions);
      expect(s.passing + s.failed).toBe(s.tested);
      expect(s.yield).toBeCloseTo(100 * s.passing / s.tested, 10);
      expect(new Set(wafer.dies.map(d => d.chamber)).size).toBe(1);
      for (const die of wafer.dies) {
        expect(die.xMm).toBe(die.column * die.pitchMm);
        expect(die.yMm).toBe(die.row * die.pitchMm);
        expect(Math.hypot(die.xMm, die.yMm)).toBeLessThanOrEqual(150);
        if (die.bin === 'untested' || die.bin === 'excluded') { expect(die.leakageNA).toBeNull(); expect(die.probeAt).toBeNull(); }
      }
    }
  });
  it('does not turn acquisition gaps into failed or measured-zero dies', () => {
    const ready = waferRows(waferResult().records), gap = waferRows(waferResult('W-17', 'gaps').records);
    expect(gap).toHaveLength(ready.length);
    expect(summarizeWafer(gap).untested).toBeGreaterThan(summarizeWafer(ready).untested);
    expect(summarizeWafer(gap).excluded).toBe(summarizeWafer(ready).excluded);
    for (const die of gap.filter(d => d.bin !== 'untested')) expect(die).toEqual(ready.find(d => d.id === die.id));
  });
  it('rejects absent columns, duplicate positions, wrong units and mismatched coordinates', () => {
    const source = waferResult().records!;
    const missing = structuredClone(source); missing.columns[5].key = 'renamed_x';
    expect(() => waferRows(missing)).toThrow(/Missing chart column/);
    const duplicate = structuredClone(source); duplicate.rows.push([...duplicate.rows[0]]);
    expect(() => waferRows(duplicate)).toThrow(/Duplicate/);
    const bad = structuredClone(source); bad.rows[0][5] = 1;
    expect(() => waferRows(bad)).toThrow(/disagree/);
    const unit = structuredClone(source); unit.columns[5].unit = 'm';
    expect(() => waferRows(unit)).toThrow(/millimetres/);
  });
  it('rejects fake test observations and temporally inverted process history', () => {
    const bad = structuredClone(waferResult().records!); bad.rows[0][11] = 0;
    expect(() => waferRows(bad)).toThrow(/Untested and excluded/);
    const times = structuredClone(waferResult().records!); times.rows[0][15] = Number(times.rows[0][16]) + 1;
    expect(() => waferRows(times)).toThrow(/sequence/);
  });
});

describe('wafer accounting and spatial statistics', () => {
  const dies = waferRows(waferResult().records);
  it('reconciles waterfall offsets exactly to passing count', () => {
    const s = summarizeWafer(dies), bars = waferLosses(dies);
    expect(bars[0].end).toBe(s.tested);
    expect(bars.slice(1, 4).reduce((n, b) => n + b.value, s.tested)).toBe(s.passing);
    for (let i = 1; i < 4; i++) expect(bars[i].start).toBe(bars[i - 1].end);
    expect(bars[3].end).toBe(bars[4].end);
    expect(bars[4].start).toBe(0);
    expect(summarizeWafer([]).yield).toBeNull();
  });
  it('retains identities and original totals during presentation filtering', () => {
    const failed = filterDies(dies, 'failed');
    expect(failed.length).toBe(summarizeWafer(dies).failed);
    for (const die of failed) expect(dies.find(d => d.id === die.id)).toBe(die);
    expect(filterDies(dies, 'untested')).toHaveLength(summarizeWafer(dies).untested);
    expect(filterDies(dies, 'all')).toHaveLength(dies.length);
  });
  it('counts every eligible die once per spatial partition and uses tested denominators', () => {
    const summary = summarizeWafer(dies);
    for (const n of [8, 12, 16, 20, 24]) {
      const signature = waferSignature(dies, n);
      for (const bins of [signature.angular, signature.radial]) {
        expect(bins.reduce((a, b) => a + b.tested, 0)).toBe(summary.tested);
        expect(bins.reduce((a, b) => a + b.failures, 0)).toBe(summary.failed);
        expect(bins.reduce((a, b) => a + b.untested, 0)).toBe(summary.untested);
        for (const bin of bins) expect(bin.rate).toBe(bin.tested ? bin.failures / bin.tested * 100 : null);
      }
    }
    expect(waferSignature(dies, 12, 'leakage').angular.reduce((n, b) => n + b.failures, 0)).toBe(summary.bins.leakage);
    expect(() => waferSignature(dies, 13)).toThrow(/angular bins/);
    expect(waferSignature([], 12).angular.every(b => b.rate === null)).toBe(true);
  });
  it('uses clockwise azimuth from physical positive Y', () => {
    expect(dieAngle({ xMm: 0, yMm: 1 })).toBe(0);
    expect(dieAngle({ xMm: 1, yMm: 0 })).toBe(90);
    expect(dieAngle({ xMm: 0, yMm: -1 })).toBe(180);
    expect(dieAngle({ xMm: -1, yMm: 0 })).toBe(270);
  });
});

describe('lot chamber distributions and lineage', () => {
  it('derives chamber statistics from the same lot and advertises bounded outlier marks', () => {
    const dies = waferLot().flatMap(w => w.dies), boxes = chamberBoxes(dies), result = chamberResult(dies);
    expect(boxes).toHaveLength(5);
    expect(parseRecordFrame(result.records)).toEqual(result.records);
    expect(chamberRows(result.records)).toEqual(boxes);
    expect(boxes.reduce((n, b) => n + b.count + b.missing, 0)).toBe(dies.filter(d => d.bin !== 'excluded').length);
    for (const box of boxes) {
      expect(box.outliers.length).toBeLessThanOrEqual(20);
      expect(box.outliers.length).toBeLessThanOrEqual(box.outlierCount);
      const exact = dies.filter(d => d.chamber === box.id && d.leakageNA !== null).map(d => d.leakageNA!);
      expect(box.median).toBe(quantile(exact, .5));
      expect(box.count).toBe(exact.length);
    }
  });
  it('validates summary ordering and distinguishes a real zero from an absent observation', () => {
    const result = structuredClone(waferFixtures().chambers.result.records!);
    result.rows[0][4] = 10000;
    expect(() => chamberRows(result)).toThrow(/ordered/);
    const zero = structuredClone(waferFixtures().chambers.result.records!);
    zero.rows[0][3] = 0; zero.rows[0][8] = 0;
    expect(() => chamberRows(zero, 'log')).toThrow(/positive/);
    expect(() => chamberRows(zero, 'linear')).not.toThrow();
    expect(quantile([0, 10, 20, 30], .25)).toBe(7.5);
  });
  it('uses supplied stage timestamps and keeps measurement units separate', () => {
    const die = waferRows(waferResult().records).find(d => d.bin === 'leakage')!;
    const steps = processSteps(die);
    expect(steps.map(s => s.time)).toEqual([die.processStart, die.lithographyAt, die.etchAt, die.cleanAt, die.probeAt]);
    expect(steps.map(s => s.unit)).toEqual(['nm', 'mJ/cm²', 's', 'ppm', 'nA']);
    const untested = waferRows(waferResult().records).find(d => d.bin === 'untested')!;
    expect(processSteps(untested).at(-1)?.time).toBeNull();
    expect(processSteps(untested).at(-1)?.value).toBeNull();
  });
  it('exposes only implemented strict configurations', () => {
    for (const schema of [waferMapConfig, waferSignatureConfig, waferYieldConfig, waferChamberConfig, waferLineageConfig]) expect(() => schema.parse({ inventedOption: true })).toThrow();
    expect(() => waferMapConfig.parse({ cellGap: .8 })).toThrow();
    expect(() => waferChamberConfig.parse({ specification: 0 })).toThrow();
    expect(() => waferSignatureConfig.parse({ angularBins: 13 })).toThrow();
  });
});
