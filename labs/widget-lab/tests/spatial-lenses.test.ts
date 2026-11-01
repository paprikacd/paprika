import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { widgetSchema } from '../src/renderer-extensions/schema';
import { parseRecordFrame } from '@insights/record-data';
import { bandBounds, buoyRows, curtainConfig, dwellRows, fieldAxes, fieldCells, fieldDensityLevel, fitEquirectangular, intervalConfig, iqConfig, iqRows, mapConfig, nearestValue, polarPoint, rmsEvm, roseConfig, roseRows, roseSector, shipments, spectrumConfig } from '../src/charts/spatial/model';
import { coastalFixtures, logisticsFixtures, recordResult, spectrumFixtures } from '../src/lenses/spatial/fixtures';
import { isSpatialCatalogId, makeSpatialCatalogFixture, spatialChartCatalog } from '../src/catalog/spatial-fixtures';
import { registerSpatialCharts } from '../src/charts/spatial/register';
import { getWidgetDefinition } from '../src/renderer-extensions/widget-registry';
import { vectorBearing } from '../src/charts/spatial/model';

describe('logistics population and arrival interval contracts',()=>{
  it('keeps filtered shipment identity and quantitative evidence stable',()=>{
    const all=shipments(logisticsFixtures().map.result.records), risk=shipments(logisticsFixtures('risk').map.result.records);
    expect(all).toHaveLength(10);expect(risk).toHaveLength(5);
    for(const shipment of risk)expect(shipment).toEqual(all.find(p=>p.id===shipment.id));
    for(const p of all){expect(p.low).toBeLessThanOrEqual(p.median);expect(p.high).toBeGreaterThanOrEqual(p.median);expect(p.risk).toBeGreaterThanOrEqual(0);expect(p.risk).toBeLessThanOrEqual(100);}
    expect(shipments(logisticsFixtures().eta.result.records)).toEqual(all);
  });
  it('rejects inverted ETA bounds, duplicate identities and partial waypoints',()=>{
    const frame=structuredClone(logisticsFixtures().map.result.records!);
    frame.rows[0][9]=Number(frame.rows[0][11])+1;
    expect(()=>shipments(frame)).toThrow(/bounds/);
    const duplicate=structuredClone(logisticsFixtures().map.result.records!);duplicate.rows.push([...duplicate.rows[0]]);
    expect(()=>shipments(duplicate)).toThrow(/Duplicate/);
    const waypoint=structuredClone(logisticsFixtures().map.result.records!);waypoint.rows[0][7]=103;
    expect(()=>shipments(waypoint)).toThrow(/together/);
  });
  it('retains quartiles, sample population and outliers separately',()=>{
    const frame=logisticsFixtures().dwell.result.records!, data=dwellRows(frame);
    expect(data.reduce((sum,p)=>sum+p.samples,0)).toBe(915);
    for(const p of data){expect([p.min,p.q1,p.median,p.q3,p.max]).toEqual([p.min,p.q1,p.median,p.q3,p.max].sort((a,b)=>a-b));expect(p.outliers.every(v=>v>p.max)).toBe(true);}
    const bad=structuredClone(frame);bad.rows[0][3]=100;
    expect(()=>dwellRows(bad)).toThrow(/ordered/);
  });
});

describe('geographic projection and directional semantics',()=>{
  it('projects Natural Earth path coordinates and markers through the same affine transform',()=>{
    const p=fitEquirectangular({west:92,east:180,south:-47,north:43},720,410);
    const affine=[...p.landTransform.matchAll(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/g)].map(m=>Number(m[0]));
    const [tx,ty,sx,sy]=affine,lon=144.96,lat=-37.81,point=p.project(lon,lat);
    expect(tx+(lon+180)*2*sx).toBeCloseTo(point.x,8);
    expect(ty+(90-lat)*2*sy).toBeCloseTo(point.y,8);
    expect(p.project(136,-2)).toEqual({x:360,y:205});
  });
  it('uses one map scale and rejects invalid geographic extents',()=>{
    const p=fitEquirectangular({west:144.6,east:145.1,south:-38.35,north:-37.9},500,410);
    const a=p.project(144.8,-38.1),east=p.project(144.9,-38.1),north=p.project(144.8,-38);
    expect((east.x-a.x)/(a.y-north.y)).toBeCloseTo(Math.cos(-38.125*Math.PI/180),8);
    expect(()=>fitEquirectangular({west:0,east:180,south:-91,north:45},500,410)).toThrow();
    expect(()=>fitEquirectangular({west:0,east:180,south:-90,north:90},NaN,410)).toThrow();
  });
  it('interprets current vectors as flow toward, clockwise from north',()=>{
    expect(vectorBearing(0,1)).toBe(0);expect(vectorBearing(1,0)).toBe(90);
    expect(vectorBearing(0,-1)).toBe(180);expect(vectorBearing(-1,0)).toBe(270);
    expect(polarPoint(0,10).y).toBeCloseTo(-10);expect(polarPoint(90,10).x).toBeCloseTo(10);
  });
  it('does not substitute a zero current for missing components',()=>{
    const frame=structuredClone(coastalFixtures().map.result.records!),data=buoyRows(frame);
    expect(data.filter(p=>p.kind==='buoy')).toHaveLength(12);
    expect(data.find(p=>p.id==='B11')?.u).toBeNull();expect(data.find(p=>p.id==='B11')?.v).toBeNull();
    frame.rows[0][5]=0;frame.rows[0][6]=0;expect(buoyRows(frame)[0].u).toBe(0);
    frame.rows[0][6]=null;expect(()=>buoyRows(frame)).toThrow(/Both/);
  });
});

describe('frequency domain and raster missingness',()=>{
  it('orders, clamps and minimum-bounds brush selections without changing source data',()=>{
    expect(bandBounds(2.46,2.43,2.4,2.48)).toEqual([2.43,2.46]);
    expect(bandBounds(1,3,2.4,2.48)).toEqual([2.4,2.48]);
    const edge=bandBounds(3,4,2.4,2.48);expect(edge[1]).toBe(2.48);expect(edge[1]-edge[0]).toBeCloseTo(.001);
    expect(bandBounds(0,0,0,.0001,.001)).toEqual([0,.0001]);
    expect(()=>bandBounds(NaN,2,1,3)).toThrow();
    expect(nearestValue([2.4,2.4005,2.401],2.4006)).toBe(2.4005);
  });
  it('retains every source bin and distinguishes absent acquisitions from numeric zero',()=>{
    const frame=spectrumFixtures().analyzer.result.records!,cells=fieldCells(frame,'frequency','timestamp','power'),axes=fieldAxes(cells);
    expect(axes.x).toHaveLength(161);expect(axes.y).toHaveLength(61);expect(cells).toHaveLength(9821);
    expect(cells.filter(p=>p.value===null)).toHaveLength(3*161);
    expect(axes.x[1]-axes.x[0]).toBeCloseTo(.0005,10);expect(axes.y[1]-axes.y[0]).toBe(10000);
    const fixture=recordResult([['x','number'],['y','number'],['value','number']],[[0,0,0],[1,0,null]]);
    expect(fieldCells(fixture.records,'x','y','value').map(p=>p.value)).toEqual([0,null]);
    expect(fieldDensityLevel(-110,-110,-30)).toBe(0);expect(fieldDensityLevel(0,-110,-30)).toBe(23);expect(fieldDensityLevel(null,-110,-30)).toBeNull();
    fixture.records!.rows.push([0,0,2]);expect(()=>fieldCells(fixture.records,'x','y','value')).toThrow(/Duplicate/);
  });
  it('retains depth/time dimensions and makes profile changes follow selected buoy identity',()=>{
    const a=coastalFixtures('B01'),b=coastalFixtures('B07'),cells=fieldCells(a.curtain.result.records,'timestamp','depth','temperature'),axes=fieldAxes(cells);
    expect(axes.x).toHaveLength(49);expect(axes.y).toHaveLength(25);expect(axes.y[0]).toBe(0);expect(axes.y.at(-1)).toBe(60);
    expect(cells.filter(p=>p.value===null)).toHaveLength(4*25);
    expect(a.map.result).toEqual(b.map.result);expect(a.curtain.result).not.toEqual(b.curtain.result);
  });
});

describe('polar populations and complex sample error',()=>{
  it('requires a complete equally spaced polar partition without zero-filling missing bins',()=>{
    const frame=coastalFixtures().rose.result.records!,cells=roseRows(frame);
    expect(cells).toHaveLength(64);expect(new Set(cells.map(p=>p.direction)).size).toBe(16);
    expect(cells.reduce((s,p)=>s+p.count,0)).toBe(frame.rows.reduce((s,p)=>s+Number(p[2]),0));
    expect(roseSector(90,20,40)).not.toMatch(/NaN|Infinity/);
    expect(roseSector(0,0,40)).toContain('A40,40');
    const missing=structuredClone(frame);missing.rows.pop();expect(()=>roseRows(missing)).toThrow(/Every rose/);
    const bad=structuredClone(frame);bad.rows[0][2]=-1;expect(()=>roseRows(bad)).toThrow(/nonnegative/);
  });
  it('calculates RMS EVM from exact squared error and ideal symbol energy',()=>{
    const sample={id:'known',i:3,q:4,idealI:3,idealQ:4};expect(rmsEvm([sample])).toBe(0);
    expect(rmsEvm([{...sample,i:3.3,q:4.4}])).toBeCloseTo(10,10);
    expect(rmsEvm([{...sample,i:0,q:0,idealI:0,idealQ:0}])).toBeNull();
    const data=iqRows(spectrumFixtures().iq.result.records);expect(data).toHaveLength(960);expect(rmsEvm(data)).toBeGreaterThan(0);expect(rmsEvm(data)).toBeLessThan(10);
  });
});

describe('registered spatial charts and catalogue states',()=>{
  it('registers each family once with strict, executable editor configuration',()=>{
    registerSpatialCharts();registerSpatialCharts();
    for(const entry of spatialChartCatalog){expect(isSpatialCatalogId(entry.id)).toBe(true);const source=makeSpatialCatalogFixture(entry.id),definition=getWidgetDefinition('plugin',source.widget.pluginId);expect(definition).toBeTruthy();expect(definition?.dataKind).toBe('records');expect(()=>definition?.parseConfig?.(source.widget.config)).not.toThrow();expect(definition?.configFields?.length).toBeGreaterThan(0);expect(makeSpatialCatalogFixture(entry.id,'empty').result.records?.rows).toEqual([]);}
  });
  it('rejects unsupported flags and preserves explicit all-missing source cells',()=>{
    for(const config of [mapConfig,intervalConfig,spectrumConfig,iqConfig,roseConfig,curtainConfig])expect(()=>config.parse({unimplementedOption:true})).toThrow();
    const spectral=makeSpatialCatalogFixture('spectrum-analyzer','gaps');expect(fieldCells(spectral.result.records,'frequency','timestamp','power').some(p=>p.value===null)).toBe(true);
    const coastal=makeSpatialCatalogFixture('coastal-vector-map','gaps');expect(()=>buoyRows(coastal.result.records)).not.toThrow();
    expect(()=>makeSpatialCatalogFixture('eta-windows','gaps')).toThrow(/Unsupported/);
  });
  it('passes every advertised preset through canonical widget/record contracts and embedded registered renderers',()=>{
    registerSpatialCharts();
    for(const feature of spatialChartCatalog)for(const preset of feature.presets){
      const source=makeSpatialCatalogFixture(feature.id,preset),widget=widgetSchema.parse(source.widget);
      expect(parseRecordFrame(source.result.records!)).toEqual(source.result.records);
      const definition=getWidgetDefinition('plugin',widget.pluginId)!;
      const config=definition.parseConfig?.(widget.config)??widget.config;
      const html=renderToStaticMarkup(createElement(definition.render,{widget:{...widget,config},result:source.result,embedded:true}));
      expect(html,`${feature.id}/${preset}`).not.toMatch(/NaN|Infinity|undefined|role="button"|<button|<input|<select/);
      expect(html.length).toBeGreaterThan(20);
      if(preset==='empty')expect(html).toContain('No ');
    }
  });
  it('renders each geographic port label once while distinguishing shared-destination shipments',()=>{
    registerSpatialCharts();
    const source=makeSpatialCatalogFixture('route-map'),definition=getWidgetDefinition('plugin','route-map')!;
    const html=renderToStaticMarkup(createElement(definition.render,source));
    for(const port of ['Shanghai','Singapore','Melbourne','Sydney','Busan','Jakarta','Auckland','Manila','Bangkok']){
      expect(html.match(new RegExp(`<text[^>]*>${port}</text>`,'g'))).toHaveLength(1);
    }
    expect(html).toContain('aria-label="Inspect PK-2881 · Bangkok"');
    expect(html).toContain('aria-label="Inspect PK-3012 · Bangkok"');
  });
});
