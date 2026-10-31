import { describe, expect, it } from 'vitest';
import { referenceBandLabel, referenceChartLayout, referenceTickAnchor } from '../src/reference/reference-chart-layout';

describe('reference chart responsive geometry', () => {
  it('preserves the authored source geometry only in explicit literal mode', () => {
    const edge = referenceChartLayout('edge', 320, false);
    expect(edge).toMatchObject({ width: 946, height: 253, plot: { left: 55, top: 17, width: 874, height: 200 } });
    const burn = referenceChartLayout('reliability', 1920, false);
    expect(burn).toMatchObject({ width: 933, height: 235, plot: { left: 52, top: 12, width: 859, height: 182 } });
    for (const y of [12, 41, 115, 194]) expect(burn.yFromSource(y)).toBe(y);
  });

  it.each(['edge', 'reliability'] as const)('fits the measured %s content width without a desktop minimum', kind => {
    for (const width of [180, 276.5, 320, 390, 768, 1280, 1920]) {
      const g = referenceChartLayout(kind, width, true);
      expect(g.width).toBe(width);
      expect(g.plot.left).toBeGreaterThan(0);
      expect(g.plot.width).toBeGreaterThan(0);
      expect(g.plot.left + g.plot.width).toBeLessThan(width);
      expect(g.height).toBeGreaterThan(g.plot.top + g.plot.height);
      expect(g.plot.height).toBeGreaterThanOrEqual(210);
      expect(g.plot.height).toBeLessThanOrEqual(360);
    }
  });

  it('reflows height while preserving the relative positions of data, zero and annotations', () => {
    const compact = referenceChartLayout('reliability', 320, true), wide = referenceChartLayout('reliability', 1440, true);
    expect(wide.height).toBeGreaterThan(compact.height);
    for (const g of [compact, wide]) {
      expect(g.yFromSource(12)).toBe(g.plot.top);
      expect(g.yFromSource(194)).toBe(g.plot.top + g.plot.height);
      expect((g.yFromSource(115) - g.plot.top) / g.plot.height).toBeCloseTo((115 - 12) / 182, 12);
      expect(g.yFromSource(194) - g.yFromSource(41)).toBeCloseTo(153 / 182 * g.plot.height, 10);
    }
  });

  it('places interval labels only where full-size text fits the visible interval', () => {
    expect(referenceBandLabel(100, 200, 40, 300, 50)).toBe(150);
    expect(referenceBandLabel(-40, 120, 40, 300, 50)).toBe(80);
    expect(referenceBandLabel(250, 420, 40, 300, 50)).toBeNull();
    expect(referenceBandLabel(120, 140, 40, 300, 50)).toBeNull();
    expect(referenceBandLabel(400, 500, 40, 300, 50)).toBeNull();
    expect(referenceBandLabel(NaN, 200, 40, 300, 50)).toBeNull();
  });

  it('keeps boundary tick labels within the measured SVG without changing timestamps', () => {
    expect(referenceTickAnchor(310, 35, 320)).toBe('end');
    expect(referenceTickAnchor(16, 70, 320)).toBe('start');
    expect(referenceTickAnchor(160, 70, 320)).toBe('middle');
  });
});
