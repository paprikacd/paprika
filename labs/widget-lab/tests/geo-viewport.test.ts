import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { dismissGeoSelection, GeoMap, reconcileGeoSelection, type GeoSelectionState } from '../src/charts/geo/GeoMap';
import { normalizeGeoLocations } from '../src/charts/geo/geo-data';
import type { GeoGeometry, GeoLocation } from '../src/charts/geo/geo-data';
import { constrainGeoView, geoToScreen, geoWheelView, INITIAL_GEO_VIEW, panGeoBy, pinchGeo, revealGeoPoint, zoomGeoAt } from '../src/charts/geo/geo-viewport';

// SSR exposes only the choice of the shared popup; the map's selection/content remain real.
vi.mock('../src/components/lab/ChartTooltip', async () => {
  const { createElement } = await import('react');
  return { ChartTooltip: ({ pinned, children }: { pinned: boolean; children: ReactNode }) => createElement('div', { 'data-test-map-tooltip': pinned ? 'pinned' : 'transient' }, children) };
});

const extent = { width: 446, height: 174 };
const point: GeoLocation = { id: 'melbourne', label: 'Melbourne', longitude: 144.9631, latitude: -37.8136, value: 0, severity: 'low' };
const geometry: GeoGeometry = { ...extent, description: 'Test equirectangular projection', countries: [], project: (lon, lat) => [(lon + 180) / 360 * extent.width, (90 - lat) / 180 * extent.height] };

describe('geographic selection ownership', () => {
  const initial: GeoSelectionState = { controlled:false,requestedId:null,id:null,snapshot:null,revision:'source-a',canInspect:true };
  const london: GeoLocation = { ...point,id:'london',label:'London',longitude:-.1,latitude:51.5,value:742,severity:'medium' };
  const input = { locations:[point,london],revision:'source-a',canInspect:true };

  it('switches controlled identities atomically without invalidating the previous snapshot against the new ID', () => {
    const first = reconcileGeoSelection(initial,{...input,selectedLocationId:'melbourne'});
    expect(first.state.id).toBe('melbourne');expect(first.revealId).toBe('melbourne');expect(first.notifyClear).toBe(false);
    const next = reconcileGeoSelection(first.state,{...input,selectedLocationId:'london'});
    expect(next.state.id).toBe('london');expect(next.notifyClear).toBe(false);expect(next.revealId).toBe('london');
    const settled = reconcileGeoSelection(next.state,{...input,selectedLocationId:'london'});
    expect(settled.state).toBe(next.state);expect(settled.revealId).toBeNull();expect(settled.notifyClear).toBe(false);
  });

  it('clears changed exact observations once, without resurrecting an unchanged controlled request', () => {
    const selected = reconcileGeoSelection(initial,{...input,selectedLocationId:'melbourne'}).state;
    const changed = {...input,locations:[{...point,value:12},london],selectedLocationId:'melbourne'};
    const invalid = reconcileGeoSelection(selected,changed);
    expect(invalid.state.id).toBeNull();expect(invalid.notifyClear).toBe(true);expect(invalid.revealId).toBeNull();
    const stillRequested = reconcileGeoSelection(invalid.state,changed);
    expect(stillRequested.state.id).toBeNull();expect(stillRequested.notifyClear).toBe(false);
    const acknowledged = reconcileGeoSelection(stillRequested.state,{...changed,selectedLocationId:null});
    const reselected = reconcileGeoSelection(acknowledged.state,changed);
    expect(reselected.state.id).toBe('melbourne');expect(reselected.notifyClear).toBe(false);
  });

  it('invalidates removed or filtered points, revisions and disabled inspection independently of camera geometry', () => {
    const selected = reconcileGeoSelection(initial,{...input,selectedLocationId:'london'}).state;
    for (const change of [{...input,locations:[point]},{...input,revision:'source-b'},{...input,canInspect:false}]) {
      const invalid = reconcileGeoSelection(selected,{...change,selectedLocationId:'london'});
      expect(invalid.state.id).toBeNull();expect(invalid.notifyClear).toBe(true);expect(invalid.revealId).toBeNull();
      expect(reconcileGeoSelection(invalid.state,{...change,selectedLocationId:'london'}).notifyClear).toBe(false);
    }
    const disabled = reconcileGeoSelection(selected,{...input,selectedLocationId:'london',canInspect:false}).state;
    expect(reconcileGeoSelection(disabled,{...input,selectedLocationId:'london'}).state.id).toBeNull();
  });

  it('keeps valid local selection when ownership returns to the map and invalidates stale local data', () => {
    const controlled = reconcileGeoSelection(initial,{...input,selectedLocationId:'london'}).state;
    const local = reconcileGeoSelection(controlled,input);
    expect(local.state.controlled).toBe(false);expect(local.state.id).toBe('london');expect(local.notifyClear).toBe(false);
    const changed = reconcileGeoSelection(local.state,{...input,locations:[point,{...london,severity:'high'}]});
    expect(changed.state.id).toBeNull();expect(changed.notifyClear).toBe(true);
  });

  it('acknowledges an unavailable external ID once and accepts a different explicit request on the new revision', () => {
    const absent = reconcileGeoSelection(initial,{...input,selectedLocationId:'missing'});
    expect(absent.state.id).toBeNull();expect(absent.notifyClear).toBe(true);
    expect(reconcileGeoSelection(absent.state,{...input,selectedLocationId:'missing'}).notifyClear).toBe(false);
    const current = reconcileGeoSelection(absent.state,{...input,revision:'source-b',selectedLocationId:'london'});
    expect(current.state.id).toBe('london');expect(current.notifyClear).toBe(false);
  });

  it('renders an initial controlled selection and preserves exact observed zero', () => {
    const html = renderToStaticMarkup(createElement(GeoMap,{label:'Linked map',geometry,locations:input.locations,selectedLocationId:'melbourne'}));
    expect(html).toContain('Location details for Melbourne');expect(html).toContain('<b>0</b>');
    expect(html).not.toContain('Location details for London');
    const disabled = renderToStaticMarkup(createElement(GeoMap,{label:'Read-only linked map',geometry,locations:input.locations,selectedLocationId:'melbourne',inspectable:false}));
    expect(disabled).not.toContain('Location details for');
  });

  it('uses the shared pinned popup only for the explicit widget presentation', () => {
    const props = { label: 'Selected map', geometry, locations: input.locations, selectedLocationId: 'melbourne' };
    const inline = renderToStaticMarkup(createElement(GeoMap, props));
    const popup = renderToStaticMarkup(createElement(GeoMap, { ...props, detailPresentation: 'tooltip' }));
    expect(inline).not.toContain('data-test-map-tooltip');
    expect(popup).toContain('data-test-map-tooltip="pinned"');
    for (const html of [inline, popup]) {
      expect(html).toContain('Location details for Melbourne');
      expect(html).toContain('<b>0</b>');
      expect(html).toContain('-37.8136');
      expect(html).toContain('144.9631');
      expect(html).toContain('aria-label="Zoom in map"');
      expect(html).toContain('data-geo-zoom="1.000"');
    }
    const disabled = renderToStaticMarkup(createElement(GeoMap, { ...props, detailPresentation: 'tooltip', inspectable: false }));
    expect(disabled).not.toContain('data-test-map-tooltip');
    expect(disabled).not.toContain('Location details for');
  });

  it('retires a superseded popup without clearing newer linked context or reopening a controlled request', () => {
    const selected = reconcileGeoSelection(initial, { ...input, selectedLocationId: 'melbourne' }).state;
    const superseded = dismissGeoSelection(selected, 'superseded');
    expect(superseded.notifyClear).toBe(false);
    expect(superseded.state.id).toBeNull();
    expect(superseded.state.requestedId).toBe('melbourne');
    const settled = reconcileGeoSelection(superseded.state, { ...input, selectedLocationId: 'melbourne' });
    expect(settled.state.id).toBeNull();
    expect(settled.notifyClear).toBe(false);
    const explicit = dismissGeoSelection(selected, 'close');
    expect(explicit.notifyClear).toBe(true);
    expect(explicit.state).toBe(selected);
    const local = dismissGeoSelection({ ...selected, controlled: false }, 'outside');
    expect(local.state.id).toBeNull();
    expect(local.notifyClear).toBe(true);
  });
});

describe('geographic viewport', () => {
  const wheel = { deltaY: -120, deltaMode: 0, ctrlKey: false, metaKey: false };

  it('zooms with ordinary wheel input and preserves the exact pointer anchor', () => {
    const anchor = { x: 123, y: 74 };
    const next = geoWheelView(INITIAL_GEO_VIEW, wheel, anchor, extent)!;
    expect(next.k).toBeGreaterThan(1);
    expect(geoToScreen(anchor, next).x).toBeCloseTo(anchor.x, 10);
    expect(geoToScreen(anchor, next).y).toBeCloseTo(anchor.y, 10);
    expect(geoWheelView(next, { ...wheel, deltaY: 120 }, anchor, extent)).toEqual(INITIAL_GEO_VIEW);
  });

  it('leaves browser zoom, outward boundary scroll and non-vertical input unconsumed', () => {
    const anchor = { x: 200, y: 80 };
    expect(geoWheelView(INITIAL_GEO_VIEW, { ...wheel, ctrlKey: true }, anchor, extent)).toBeNull();
    expect(geoWheelView(INITIAL_GEO_VIEW, { ...wheel, metaKey: true }, anchor, extent)).toBeNull();
    expect(geoWheelView(INITIAL_GEO_VIEW, { ...wheel, shiftKey: true }, anchor, extent)).toBeNull();
    expect(geoWheelView(INITIAL_GEO_VIEW, { ...wheel, deltaX: 160 }, anchor, extent)).toBeNull();
    expect(geoWheelView(INITIAL_GEO_VIEW, { ...wheel, deltaY: 120 }, anchor, extent)).toBeNull();
    expect(geoWheelView({ x: -600, y: -200, k: 8 }, wheel, anchor, extent)).toBeNull();
    expect(geoWheelView(INITIAL_GEO_VIEW, { ...wheel, deltaY: 0 }, anchor, extent)).toBeNull();
    expect(geoWheelView(INITIAL_GEO_VIEW, { ...wheel, deltaY: NaN }, anchor, extent)).toBeNull();
  });

  it('normalizes line/page wheel units and bounds large trackpad deltas', () => {
    const anchor = { x: 200, y: 80 };
    expect(geoWheelView(INITIAL_GEO_VIEW, { ...wheel, deltaY: -1, deltaMode: 1 }, anchor, extent)).toEqual(geoWheelView(INITIAL_GEO_VIEW, { ...wheel, deltaY: -16 }, anchor, extent));
    expect(geoWheelView(INITIAL_GEO_VIEW, { ...wheel, deltaY: -1, deltaMode: 2 }, anchor, extent)).toEqual(geoWheelView(INITIAL_GEO_VIEW, { ...wheel, deltaY: -174 }, anchor, extent));
    expect(geoWheelView({ x: -600, y: -200, k: 7.5 }, { ...wheel, deltaY: -10000 }, anchor, extent)?.k).toBe(8);
  });

  it('keeps the position under a zoom anchor stationary and reverses exactly', () => {
    const anchor = { x: 91, y: 63 };
    const zoomed = zoomGeoAt(INITIAL_GEO_VIEW, 3, anchor, extent);
    expect(geoToScreen(anchor, zoomed)).toEqual(anchor);
    expect(zoomGeoAt(zoomed, 1 / 3, anchor, extent)).toEqual(INITIAL_GEO_VIEW);
  });

  it('preserves an anchor when zooming an already panned viewport', () => {
    const view = { x: -132, y: -40, k: 2 };
    const anchor = { x: 240, y: 89 };
    const world = { x: (anchor.x - view.x) / view.k, y: (anchor.y - view.y) / view.k };
    const after = zoomGeoAt(view, 1.7, anchor, extent);
    expect(geoToScreen(world, after).x).toBeCloseTo(anchor.x, 10);
    expect(geoToScreen(world, after).y).toBeCloseTo(anchor.y, 10);
  });

  it('bounds zoom to 1–8 and prevents blank overscroll at every edge', () => {
    const maximum = zoomGeoAt(INITIAL_GEO_VIEW, 999, { x: 223, y: 87 }, extent);
    expect(maximum.k).toBe(8);
    expect(panGeoBy(maximum, { x: 1e6, y: 1e6 }, extent)).toEqual({ x: 0, y: 0, k: 8 });
    expect(panGeoBy(maximum, { x: -1e6, y: -1e6 }, extent)).toEqual({ x: -446 * 7, y: -174 * 7, k: 8 });
    expect(zoomGeoAt(maximum, .001, { x: 10, y: 10 }, extent)).toEqual(INITIAL_GEO_VIEW);
  });

  it('normalizes invalid transforms and ignores non-finite gesture deltas', () => {
    expect(constrainGeoView({ x: NaN, y: Infinity, k: -4 }, extent)).toEqual(INITIAL_GEO_VIEW);
    expect(zoomGeoAt(INITIAL_GEO_VIEW, NaN, { x: NaN, y: Infinity }, extent)).toEqual(INITIAL_GEO_VIEW);
    const view = { x: -20, y: -30, k: 2 };
    expect(panGeoBy(view, { x: Infinity, y: NaN }, extent)).toEqual(view);
  });

  it('moves a pinch midpoint while preserving its original world location', () => {
    const before = [{ x: 100, y: 60 }, { x: 200, y: 60 }] as const;
    const after = [{ x: 80, y: 70 }, { x: 280, y: 70 }] as const;
    const view = pinchGeo(INITIAL_GEO_VIEW, before, after, extent);
    expect(view.k).toBe(2);
    expect(geoToScreen({ x: 150, y: 60 }, view)).toEqual({ x: 180, y: 70 });
  });

  it('handles coincident pinch contacts without producing infinite transforms', () => {
    const result = pinchGeo({ x: -20, y: -30, k: 2 }, [{ x: 50, y: 50 }, { x: 50, y: 50 }], [{ x: 60, y: 60 }, { x: 70, y: 70 }], extent);
    expect(result).toEqual({ x: -5, y: -15, k: 2 });
  });

  it('reveals a keyboard-selected location without changing zoom', () => {
    const location = { x: 300, y: 110 };
    const result = revealGeoPoint({ x: 0, y: 0, k: 3 }, location, extent);
    const position = geoToScreen(location, result);
    expect(result.k).toBe(3);
    expect(position.x).toBeLessThanOrEqual(extent.width - 18);
    expect(position.y).toBeLessThanOrEqual(extent.height - 18);
    expect(revealGeoPoint(result, location, extent)).toEqual(result);
  });

  it('uses the supplied projection extent instead of fixed reference dimensions', () => {
    const wide = { width: 720, height: 360 };
    expect(zoomGeoAt(INITIAL_GEO_VIEW, 2, { x: 360, y: 180 }, wide)).toEqual({ x: -360, y: -180, k: 2 });
    expect(panGeoBy({ x: -360, y: -180, k: 2 }, { x: -1000, y: -1000 }, wide)).toEqual({ x: -720, y: -360, k: 2 });
  });
});

describe('geographic data contract', () => {
  it('preserves valid zeros and null values without changing supplied observations', () => {
    const source = [point, { ...point, id: 'origin', longitude: 0, latitude: 0, value: null }];
    const snapshot = structuredClone(source);
    expect(normalizeGeoLocations(source).locations).toEqual(source);
    expect(source).toEqual(snapshot);
    expect(normalizeGeoLocations(source).locations[0]).not.toBe(source[0]);
  });

  it('excludes invalid coordinates and non-finite values instead of coercing them to the origin', () => {
    const bad = [
      { ...point, latitude: 91 }, { ...point, latitude: -91 },
      { ...point, longitude: 181 }, { ...point, longitude: -181 },
      { ...point, longitude: NaN }, { ...point, value: Infinity },
      { ...point, id: '' }, { ...point, latitude: '0' }, { ...point, longitude: null },
    ] as unknown as GeoLocation[];
    expect(normalizeGeoLocations(bad)).toEqual({ locations: [], invalid: 9, duplicates: 0, omitted: 0 });
  });

  it('keeps stable identities after reorder, reports duplicates and never sums collocated observations', () => {
    const second = { ...point, id: 'other', value: 4 };
    expect(normalizeGeoLocations([second, point, { ...point, value: 99 }])).toEqual({ locations: [second, point], invalid: 0, duplicates: 1, omitted: 0 });
    expect(normalizeGeoLocations([point, second]).locations.map(item => item.id)).toEqual(['melbourne', 'other']);
  });

  it('reports capping separately from invalid and duplicate records', () => {
    const source = Array.from({ length: 503 }, (_, index) => ({ ...point, id: `point-${index}` }));
    const result = normalizeGeoLocations(source, Infinity);
    expect(result.locations).toHaveLength(500);
    expect(result.omitted).toBe(3);
    expect(result.invalid).toBe(0);
    expect(normalizeGeoLocations(source, 2.7).omitted).toBe(501);
  });

  it('preserves unknown severity instead of inventing a risk classification', () => {
    const result = normalizeGeoLocations([{ ...point, severity: 'unrecognized' } as unknown as GeoLocation]);
    expect(result.locations[0].severity).toBe('unknown');
  });

  it('provides a safe no-location state and discloses dropped observations', () => {
    const html = renderToStaticMarkup(createElement(GeoMap, { label: 'Invalid coordinates', geometry, locations: [{ ...point, latitude: NaN }] }));
    expect(html).toContain('No locations for this filter');
    expect(html).toContain('1 invalid or duplicate location excluded');
    expect(html).not.toContain('data-geo-location="melbourne"');
  });

  it('keeps embedded maps read-only without navigation controls or focus targets', () => {
    const html = renderToStaticMarkup(createElement(GeoMap, { label: 'Read-only geography', geometry, locations: [point], interactive: false }));
    expect(html).not.toContain('Map zoom controls');
    expect(html).not.toContain('Inspect a map location');
    expect(html).not.toContain('tabindex="0"');
    expect(html).not.toContain('Touch map navigation');
    expect(html).not.toContain('is-interactive');
    expect(html).not.toContain('is-inspectable');
    expect(html).not.toContain('Drag with a mouse');
    expect(html).toContain('Static location view');
    expect(html).toContain('Melbourne: 0 connections');
  });

  it('uses fixed presence geometry for generic locations regardless of values or severity', () => {
    const locations: GeoLocation[] = [point, { ...point, id: 'high', severity: 'high', value: 1_000_000 }, { ...point, id: 'medium', severity: 'medium', value: 1 }];
    const html = renderToStaticMarkup(createElement(GeoMap, { label: 'Presence map', geometry, locations }));
    expect([...html.matchAll(/class="paprika-geo-mark" r="([^"]+)"/g)].map(match => match[1])).toEqual(['3', '3', '3']);
    expect([...html.matchAll(/class="paprika-geo-halo" r="([^"]+)"/g)].map(match => match[1])).toEqual([]);
    const concept = renderToStaticMarkup(createElement(GeoMap, { label: 'Concept', geometry, locations, concept: true }));
    expect([...concept.matchAll(/class="paprika-geo-mark" r="([^"]+)"/g)].map(match => match[1])).toEqual(['2.4', '4.4', '3.4']);
  });

  it('starts touch navigation off and explains how to opt into map gestures', () => {
    const html = renderToStaticMarkup(createElement(GeoMap, { label: 'Touch-safe map', geometry, locations: [point] }));
    expect(html).toContain('data-geo-touch-navigation="off"');
    expect(html).toContain('aria-label="Touch map navigation" aria-pressed="false"');
    expect(html).not.toContain('is-touch-navigation');
    expect(html).toContain('page scrolling and browser pinch remain available');
    expect(html).toContain('Enable Touch navigation to drag or pinch the map');
  });

  it('can disable inspection while preserving viewport navigation', () => {
    const html = renderToStaticMarkup(createElement(GeoMap, { label: 'Navigation only', geometry, locations: [point], inspectable: false }));
    expect(html).toContain('Map zoom controls');
    expect(html).toContain('Touch map navigation');
    expect(html).not.toContain('Inspect a map location');
    expect(html).not.toContain('is-inspectable');
    expect(html).not.toContain('Location details for');
    expect(html).not.toContain('<title>');
    expect(html).toContain('Melbourne: 0 connections');
  });

  it('gives independent maps unique SVG resource identities', () => {
    const html = renderToStaticMarkup(createElement('div', null, createElement(GeoMap, { label: 'First', geometry, locations: [point] }), createElement(GeoMap, { label: 'Second', geometry, locations: [point] })));
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
