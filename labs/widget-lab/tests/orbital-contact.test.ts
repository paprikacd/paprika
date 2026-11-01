import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseRecordFrame } from '../src/vendor/paprika/ui/src/features/insights/record-data';
import { widgetSchema } from '../src/vendor/paprika/ui/src/features/insights/schema';
import { getWidgetDefinition } from '../src/vendor/paprika/ui/src/features/insights/widget-registry';
import { budgetSteps, budgetTerms, budgetTotal, contactTimelineConfig, groundPoints, groundTrackConfig, groupByPass, isObstructed, linkBudgetConfig, nearestAt, skyPoints, skyPosition, skyplotConfig, splitDateline, summarizePasses, wrapLongitude, type SkyPoint } from '../src/charts/orbital/model';
import { isOrbitalCatalogId, makeOrbitalCatalogFixture, orbitalChartCatalog } from '../src/charts/orbital/catalog';
import { registerOrbitalCharts } from '../src/charts/orbital/register';
import { orbitalFixtures, ORBITAL_START, ORBITAL_END } from '../src/lenses/orbital/fixtures';

describe('orbital geographic and polar geometry', () => {
  it('splits crossings into boundary intersections without a map-wide chord', () => {
    const east = splitDateline([{ longitude: 175, latitude: 10 }, { longitude: -175, latitude: 30 }]);
    expect(east).toEqual([[{longitude:175,latitude:10},{longitude:180,latitude:20}],[{longitude:-180,latitude:20},{longitude:-175,latitude:30}]]);
    const west = splitDateline([{ longitude: -175, latitude: 10 }, { longitude: 175, latitude: 30 }]);
    expect(west).toEqual([[{longitude:-175,latitude:10},{longitude:-180,latitude:20}],[{longitude:180,latitude:20},{longitude:175,latitude:30}]]);
    expect(splitDateline([])).toEqual([]);
    expect(splitDateline([{longitude:0,latitude:0},{longitude:60,latitude:20}])).toHaveLength(1);
    for (const group of groupByPass(groundPoints(orbitalFixtures().map.result.records))) {
      for (const segment of splitDateline(group.points)) for (let i = 1; i < segment.length; i++) expect(Math.abs(segment[i].longitude - segment[i-1].longitude)).toBeLessThanOrEqual(180);
    }
  });
  it('wraps coordinates deterministically and keeps polar elevation inverted', () => {
    expect(wrapLongitude(181)).toBe(-179); expect(wrapLongitude(-181)).toBe(179); expect(wrapLongitude(0)).toBe(0);
    const north=skyPosition(0,0,100),east=skyPosition(90,0,100),south=skyPosition(180,0,100),west=skyPosition(270,0,100);
    expect(north.y).toBe(-100);expect(east.x).toBeCloseTo(100);expect(south.y).toBeCloseTo(100);expect(west.x).toBeCloseTo(-100);
    expect(Math.hypot(...Object.values(skyPosition(218,90,100)))).toBe(0);
    expect(Math.hypot(...Object.values(skyPosition(218,30,100)))).toBeCloseTo(100*2/3);
    expect(()=>skyPosition(30,-1,100)).toThrow();expect(()=>skyPosition(30,91,100)).toThrow();expect(()=>skyPosition(NaN,30,100)).toThrow();
    expect(isObstructed(145,10)).toBe(true);expect(isObstructed(145,20)).toBe(false);expect(isObstructed(210,10)).toBe(false);
  });
  it('preserves a shared coordinate/identity record while sorting track timestamps', () => {
    const frame=structuredClone(orbitalFixtures().map.result.records!);frame.rows.reverse();
    const groups=groupByPass(groundPoints(frame));expect(groups).toHaveLength(8);
    for(const group of groups){expect(group.points).toHaveLength(61);expect(group.points[0].timestamp).toBeLessThan(group.points.at(-1)!.timestamp);}
    const selected=groups.find(p=>p.id==='pass-01')!,middle=nearestAt(selected.points,(selected.points[0].acquisition+selected.points[0].loss)/2)!;
    expect(middle.longitude).toBeCloseTo(middle.stationLon,4);expect(middle.latitude).toBeCloseTo(middle.stationLat,4);
  });
  it('rejects invalid geographic positions, duplicate timestamps and contradictory pass metadata', () => {
    const base=orbitalFixtures().map.result.records!;
    const bad=structuredClone(base);bad.rows[0][5]=181;expect(()=>groundPoints(bad)).toThrow(/Longitude/);
    const duplicate=structuredClone(base);duplicate.rows[1][4]=duplicate.rows[0][4];expect(()=>groundPoints(duplicate)).toThrow(/duplicate track timestamps/);
    const identity=structuredClone(base);identity.rows[0][2]='Another satellite';expect(()=>groundPoints(identity)).toThrow(/agree/);
    const missing=structuredClone(base);missing.columns[5].key='renamed-longitude';expect(()=>groundPoints(missing)).toThrow(/Missing orbital field/);
  });
});

describe('predicted contact accounting and missingness', () => {
  const sample=(id:string,timestamp:number,throughput:number|null):SkyPoint=>({id,passId:'known',satellite:'AST',station:'Test',timestamp,azimuth:0,elevation:30,margin:5,throughput,uncertainty:1});
  it('integrates Mbps over true elapsed time and uses decimal MB/GB', () => {
    const pass=summarizePasses([sample('a',0,10),sample('b',10000,10)])[0];
    expect(pass.volumeMB).toBe(12.5);expect(pass.coverage).toBe(1);expect(pass.end-pass.start).toBe(10000);
    const zero=summarizePasses([sample('a',0,0),sample('b',10000,0)])[0];expect(zero.volumeMB).toBe(0);
  });
  it('does not bridge missing samples or represent partial volume as a complete total', () => {
    const pass=summarizePasses([sample('a',0,10),sample('b',10000,10),sample('c',20000,null),sample('d',30000,10)])[0];
    expect(pass.volumeMB).toBeNull();expect(pass.coverage).toBeCloseTo(1/3);
    const gap=orbitalFixtures('pass-01',true),normal=orbitalFixtures();
    const changed=gap.passes.find(p=>p.id==='pass-01')!;expect(changed.volumeMB).toBeNull();expect(changed.coverage).toBeLessThan(1);
    expect(gap.passes.find(p=>p.id==='pass-03')).toEqual(normal.passes.find(p=>p.id==='pass-03'));
  });
  it('derives exact intervals, peaks and minimum margin from the same observations', () => {
    const fixtures=orbitalFixtures(),observations=skyPoints(fixtures.skyplot.result.records);expect(observations).toHaveLength(248);expect(fixtures.passes).toHaveLength(8);
    for(const p of fixtures.passes){expect(p.start).toBeGreaterThanOrEqual(ORBITAL_START);expect(p.end).toBeLessThanOrEqual(ORBITAL_END);expect(p.peak).toBe(Math.max(...p.samples.map(s=>s.elevation)));expect(p.minMargin).toBe(Math.min(...p.samples.map(s=>s.margin!)));expect(p.volumeMB).toBeGreaterThan(0);}
    const selected=fixtures.passes.find(p=>p.id==='pass-01')!;expect(selected.end-selected.start).toBe(576000);expect(selected.peak).toBe(68);expect(selected.minMargin).toBe(3.8);
    const duplicate=structuredClone(fixtures.skyplot.result.records!);duplicate.rows.push([...duplicate.rows[0]]);expect(()=>skyPoints(duplicate)).toThrow(/Duplicate/);
    const bad=structuredClone(fixtures.skyplot.result.records!);bad.rows[0][6]=91;expect(()=>skyPoints(bad)).toThrow(/Elevation/);
  });
  it('reconciles every budget to the selected contact and retains signed contributions', () => {
    const fixtures=orbitalFixtures(),terms=budgetTerms(fixtures.budget.result.records);
    for(const pass of fixtures.passes){const selected=terms.filter(p=>p.passId===pass.id),steps=budgetSteps(selected);expect(steps).toHaveLength(5);expect(steps[0].start).toBe(0);expect(budgetTotal(selected)).toBeCloseTo(pass.minMargin!,10);expect(steps.at(-1)!.end).toBeCloseTo(pass.minMargin!,10);for(let i=1;i<steps.length;i++)expect(steps[i].start).toBe(steps[i-1].end);expect(selected.find(p=>p.label==='Weather')!.value).toBeLessThan(0);}
    const negative=budgetSteps([{id:'a',passId:'p',label:'Reference',order:0,value:2},{id:'b',passId:'p',label:'Loss',order:1,value:-4}]);expect(negative.at(-1)!.end).toBe(-2);
    const bad=structuredClone(fixtures.budget.result.records!);bad.rows[1][3]=bad.rows[0][3];expect(()=>budgetTerms(bad)).toThrow(/unique integers/);
  });
});

describe('orbital registration and canonical integration', () => {
  it('registers all strict, data-aware, intrinsic families exactly once', () => {
    registerOrbitalCharts();registerOrbitalCharts();
    for(const feature of orbitalChartCatalog){expect(isOrbitalCatalogId(feature.id)).toBe(true);const source=makeOrbitalCatalogFixture(feature.id),definition=getWidgetDefinition(source.widget)!;expect(definition).toBeTruthy();expect(definition.layout?.mode).toBe('intrinsic');expect(definition.configFields?.length).toBeGreaterThan(0);expect(()=>definition.validateInput?.(source.result,source.widget.config)).not.toThrow();const broken=structuredClone(source.result);broken.records!.columns[0].key='missing-id';expect(()=>definition.validateInput?.(broken,source.widget.config)).toThrow(/Missing orbital field/);}
    for(const config of [groundTrackConfig,skyplotConfig,contactTimelineConfig,linkBudgetConfig])expect(()=>config.parse({unsupported:true})).toThrow();
  });
  it('passes all fixture states through the canonical transport and static embedded renderer', () => {
    registerOrbitalCharts();
    for(const feature of orbitalChartCatalog)for(const preset of feature.presets){const source=makeOrbitalCatalogFixture(feature.id,preset),widget=widgetSchema.parse(source.widget),definition=getWidgetDefinition(widget)!;expect(parseRecordFrame(source.result.records!)).toEqual(source.result.records);expect(source.result.records!.rows.length).toBeLessThanOrEqual(1000);definition.validateInput?.(source.result,widget.config);const html=renderToStaticMarkup(createElement(definition.render,{widget,result:source.result,embedded:true}));expect(html,`${feature.id}/${preset}`).not.toMatch(/NaN|Infinity|undefined|role="button"|<button|<select|<input/);expect(html.length).toBeGreaterThan(20);if(preset==='empty')expect(html).toContain('No orbital observations');}
  });
  it('rejects unsupported missing-state presets and keeps family inputs independent', () => {
    expect(()=>makeOrbitalCatalogFixture('orbital-ground-track','gaps')).toThrow(/Unsupported/);
    expect(()=>makeOrbitalCatalogFixture('orbital-link-budget','gaps')).toThrow(/Unsupported/);
    const fixture=orbitalFixtures();expect(fixture.map.result.records?.rows).toHaveLength(488);expect(fixture.budget.result.records?.rows).toHaveLength(40);
  });
});
