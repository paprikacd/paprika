import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GeoMap } from '../src/charts/geo/GeoMap';
import type { GeoGeometry, GeoLocation } from '../src/charts/geo/geo-data';
import { geoScreenUnits } from '../src/charts/geo/geo-viewport';
import { EdgeSupporting } from '../src/reference/EdgeSupporting';
import { outcomeBarX, outcomeLayout } from '../src/reference/edge-supporting-layout';

describe('responsive outcome geometry', () => {
  it('retains literal comparison geometry independently of its surrounding width', () => {
    for (const availableWidth of [280, 446, 768, 1200]) {
      const layout = outcomeLayout(availableWidth, 28, 1, false);
      expect(layout).toMatchObject({ width: 446, height: 155, plot: { x: 37, y: 8, w: 400, h: 111 }, barWidth: 9 });
      expect(outcomeBarX(layout, 0, 632, 1)).toBe(39.5);
      expect(outcomeBarX(layout, 27, 1016, 1)).toBe(423.5);
    }
  });

  it.each([280, 390, 768, 1200])('uses a %ipx panel without moving or clipping authored observations', width => {
    const layout = outcomeLayout(width, 28, 1, true);
    expect(layout.width).toBe(width);
    expect(layout.height).toBeGreaterThanOrEqual(190);
    expect(layout.height).toBeLessThanOrEqual(260);
    for (const [index, referenceX] of [[0, 632], [14, 824], [27, 1016]]) {
      const x = outcomeBarX(layout, index, referenceX, 1);
      expect(x).toBeGreaterThanOrEqual(layout.plot.x);
      expect(x + layout.barWidth).toBeLessThanOrEqual(layout.plot.x + layout.plot.w);
      // Resizing changes pixels, not the authored relative spacing.
      const fraction = (x + layout.barWidth / 2 - layout.plot.x) / layout.plot.w;
      const literal = outcomeLayout(446, 28, 1, false);
      const literalFraction = (outcomeBarX(literal, index, referenceX, 1) + literal.barWidth / 2 - literal.plot.x) / literal.plot.w;
      expect(fraction).toBeCloseTo(literalFraction, 10);
    }
  });

  it('keeps every grouped bucket visible and separate at narrow and wide widths', () => {
    for (const width of [280, 390, 768, 1200]) for (const group of [2, 3]) {
      const count = Math.ceil(28 / group), layout = outcomeLayout(width, count, group, true);
      const xs = Array.from({ length: count }, (_, index) => outcomeBarX(layout, index, 632, group));
      expect(xs[0]).toBeGreaterThanOrEqual(layout.plot.x);
      expect(xs.at(-1)! + layout.barWidth).toBeLessThanOrEqual(layout.plot.x + layout.plot.w);
      expect(xs.slice(1).every((x, index) => x > xs[index] + layout.barWidth)).toBe(true);
    }
  });

  it('retains every supplied count, classification and flag in adaptive presentation', () => {
    const literal = renderToStaticMarkup(createElement(EdgeSupporting));
    const adaptive = renderToStaticMarkup(createElement(EdgeSupporting, { adaptive: true }));
    const observations = (html: string) => [...html.matchAll(/aria-label="(Concept bucket [^"]+)"/g)].map(match => match[1]);
    expect(observations(adaptive)).toEqual(observations(literal));
    expect(observations(adaptive)).toHaveLength(28);
    const risks = (html: string) => [...html.matchAll(/aria-label="(\d of 6 risk units)"/g)].map(match => match[1]);
    expect(risks(adaptive)).toEqual(risks(literal));
    expect(risks(adaptive)).toHaveLength(5);
    const flags = (html: string) => [...html.matchAll(/viewBox="0 0 22 14" role="img" aria-label="([^"]+)"/g)].map(match => match[1]);
    expect(flags(adaptive)).toEqual(['United States', 'China', 'Russia', 'Germany', 'India']);
    expect(flags(adaptive)).toEqual(flags(literal));
    expect(adaptive).toContain('aria-label="Inspect request outcome bucket"');
    const marks = [...adaptive.matchAll(/tabindex="([^"]+)" class="edge-outcome-bucket"/g)].map(match => match[1]);
    expect(marks.filter(value => value === '0')).toHaveLength(1);
    expect(marks).toHaveLength(28);
  });
});

describe('screen-sized geographic marks', () => {
  it('retains visible mark sizes and a 28px hit diameter through container scaling', () => {
    for (const cssScale of [.3, .55, 1, 1.6, 2.5]) {
      for (const radius of [1.9, 4.2, 7, 14]) expect(geoScreenUnits(radius, cssScale) * cssScale).toBeCloseTo(radius, 10);
      expect(geoScreenUnits(14, cssScale) * 2 * cssScale).toBeCloseTo(28, 10);
    }
    expect(geoScreenUnits(3, 0)).toBe(3);
    expect(geoScreenUnits(3, NaN)).toBe(3);
    expect(geoScreenUnits(-3, 1)).toBe(0);
    expect(geoScreenUnits(NaN, 1)).toBe(0);
  });

  it('opts in without changing projection, observed zero, selection or touch navigation', () => {
    const geometry: GeoGeometry = { width: 446, height: 174, description: 'Test projection', countries: [], project: () => [200, 80] };
    const location: GeoLocation = { id: 'zero', label: 'Observed zero', longitude: 0, latitude: 0, value: 0, severity: 'low' };
    const props = { label: 'Responsive geography', geometry, locations: [location], selectedLocationId: 'zero' };
    const literal = renderToStaticMarkup(createElement(GeoMap, props));
    const responsive = renderToStaticMarkup(createElement(GeoMap, { ...props, responsive: true }));
    expect(literal).not.toContain('data-geo-responsive');
    expect(responsive).toContain('data-geo-responsive="true"');
    for (const html of [literal, responsive]) {
      expect(html).toContain('viewBox="0 0 446 174"');
      expect(html).toContain('data-geo-zoom="1.000"');
      expect(html).toContain('data-geo-touch-navigation="off"');
      expect(html).toContain('Location details for Observed zero');
      expect(html).toContain('<b>0</b>');
      expect(html).toContain('class="paprika-geo-mark" r="3"');
      expect(html).toContain('class="paprika-geo-hit" r="14"');
    }
  });
});
