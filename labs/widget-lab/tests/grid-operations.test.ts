import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ForecastBands } from '../src/charts/grid/ForecastBands';
import { BATTERY_CAPACITY_MWH, GRID_AS_OF, GRID_DAY_START, GRID_LOCATIONS, GRID_STEP, buildGridOperations, gridDay, gridForecast, gridNetwork } from '../src/lenses/grid-operations-data';
import { forecastBandConfig, forecastRecords, gridFlowColor, gridNetworkConfig, networkRecords } from '../src/charts/grid/grid-model';
import type { RecordFrame } from '../src/vendor/paprika/ui/src/features/insights/schema';

describe('Grid Operations source accounting',()=>{
  it.each(['peak','balanced'] as const)('reconciles every %s power observation and exclusive generation source',scenario=>{
    const points=gridDay(scenario);
    expect(points).toHaveLength(193);expect(points[0].timestamp).toBe(GRID_DAY_START);expect(points.at(-1)!.timestamp).toBe(GRID_AS_OF);
    for(const p of points){expect(p.solar+p.wind+p.hydro+p.dispatchable).toBeCloseTo(p.generation,8);expect(p.generation+p.battery).toBeCloseTo(p.demand+p.exportMW,8);expect(p.demand).toBeGreaterThan(0);}
  });
  it('integrates signed MW into MWh at the declared five-minute cadence',()=>{
    const points=gridDay();expect(points[0].energy).toBe(440);
    for(let i=1;i<points.length;i++){expect(points[i].timestamp-points[i-1].timestamp).toBe(GRID_STEP);expect(points[i].energy).toBeCloseTo(points[i-1].energy-points[i].battery*5/60,5);expect(points[i].energy).toBeGreaterThanOrEqual(0);expect(points[i].energy).toBeLessThanOrEqual(BATTERY_CAPACITY_MWH);}
    expect(points.some(p=>p.battery<0)).toBe(true);expect(points.some(p=>p.battery>0)).toBe(true);
  });
  it('filters the loaded history without mutating the current snapshot or SOC',()=>{
    const full=buildGridOperations('peak','day'),recent=buildGridOperations('peak','recent');
    expect(recent.day).toHaveLength(73);expect(recent.latest).toEqual(full.latest);expect(recent.day).toEqual(full.day.slice(-73));expect(recent.panels.map.result).toEqual(full.panels.map.result);
    expect(recent.forecast.every(p=>p.timestamp>=GRID_AS_OF-6*3600000)).toBe(true);
  });
  it('preserves missing observations and distinguishes forecasts from observations',()=>{
    const points=gridForecast();expect(points.filter(p=>p.timestamp<GRID_AS_OF&&p.observed===null)).toHaveLength(5);
    expect(points.filter(p=>p.timestamp>GRID_AS_OF).every(p=>p.observed===null&&p.median!==null)).toBe(true);
    for(const p of points.filter(p=>p.median!==null)){expect(p.low95!).toBeLessThanOrEqual(p.low68!);expect(p.low68!).toBeLessThanOrEqual(p.median!);expect(p.median!).toBeLessThanOrEqual(p.high68!);expect(p.high68!).toBeLessThanOrEqual(p.high95!);}
  });
});

describe('Geographic network adapter',()=>{
  it('retains stable coordinates, missing values, bounded nodes and exact directed links',()=>{
    const frame=gridNetwork('peak').records!,network=networkRecords(frame);
    expect(network.nodes).toHaveLength(GRID_LOCATIONS.length);expect(network.nodes.find(n=>n.id==='eastern')?.value).toBe(184);expect(network.nodes.find(n=>n.id==='latrobe')?.value).toBeNull();expect(network.omitted).toBe(0);
    expect(network.links.find(l=>l.id==='eastern-morwell')).toMatchObject({source:'eastern',target:'morwell',value:918,capacity:900});
    expect(network.nodes.every(n=>n.history.length===49)).toBe(true);
    expect(network.nodes.every(n=>n.history.at(-1)?.timestamp===GRID_AS_OF&&n.history.at(-1)?.value===n.value)).toBe(true);
    const reversed=networkRecords({...frame,rows:[...frame.rows].reverse()});expect(reversed.nodes.find(n=>n.id==='eastern')).toEqual(network.nodes.find(n=>n.id==='eastern'));
    expect(networkRecords(frame,3).nodes).toHaveLength(3);
  });
  it('rejects duplicate IDs, skips invalid coordinates and uses capacity thresholds',()=>{
    const frame=gridNetwork('peak').records!;expect(()=>networkRecords({...frame,rows:[...frame.rows,frame.rows[0]]})).toThrow(/unique/);
    const invalid=frame.rows[0].slice();invalid[3]=200;const parsed=networkRecords({...frame,rows:[invalid,...frame.rows.slice(1)]});expect(parsed.omitted).toBeGreaterThan(0);expect(parsed.nodes.some(n=>n.id===invalid[1])).toBe(false);
    expect(gridFlowColor(79,100)).toBe('#21d1e7');expect(gridFlowColor(80,100)).toBe('#ffc35a');expect(gridFlowColor(100,100)).toBe('#ff665c');
  });
});

describe('Forecast interval adapter',()=>{
  const frame=():RecordFrame=>({columns:[{key:'timestamp',type:'timestamp'},...['observed','median','low68','high68','low95','high95'].map(key=>({key,type:'number' as const}))],rows:[[1000,0,null,null,null,null,null],[2000,null,50,40,60,30,70],[3000,null,null,null,null,null,null]]});
  it('accepts an independent dataset with zero, unknown, sorted timestamps and nested intervals',()=>{
    const f=frame(),parsed=forecastRecords({...f,rows:[...f.rows].reverse()});expect(parsed.points.map(p=>p.timestamp)).toEqual([1000,2000,3000]);expect(parsed.points[0].observed).toBe(0);expect(parsed.points[2].median).toBeNull();expect(parsed.omitted).toBe(0);
  });
  it('rejects inverted or partial intervals and duplicate timestamp identity',()=>{
    const f=frame();f.rows[1][3]=55;expect(()=>forecastRecords(f)).toThrow(/nested/);
    const p=frame();p.rows[1][4]=null;expect(()=>forecastRecords(p)).toThrow(/all five/);
    const d=frame();d.rows.push(d.rows[0]);expect(()=>forecastRecords(d)).toThrow(/unique/);
  });
  it('validates strict configuration and registered fixture inputs',()=>{
    expect(()=>gridNetworkConfig.parse({unknown:true})).toThrow();expect(()=>forecastBandConfig.parse({show95:'yes'})).toThrow();
    const fixture=buildGridOperations().panels.prediction.result.records!;expect(forecastRecords(fixture).points).toHaveLength(289);
    expect(forecastRecords({...fixture,rows:[]}).points).toHaveLength(0);
  });
  it('renders absent or invalid forecast timestamps without fabricated plot chrome',()=>{
    const {widget,result}=buildGridOperations().panels.prediction;
    for(const records of [undefined,{...result.records!,rows:[]},{...result.records!,rows:[[null,null,null,null,null,null,null],[9e15,null,null,null,null,null,null]]}]){
      const markup=renderToStaticMarkup(createElement(ForecastBands,{widget,result:{records}}));
      expect(markup).toContain('No forecast observations');
      expect(markup).not.toContain('<svg');expect(markup).not.toContain('data-forecast-window-start');
      expect(markup).not.toContain('Chart time window');expect(markup).not.toContain('Forecast →');
      if(records?.rows.length)expect(markup).toContain('2 records with invalid time omitted.');
    }
  });
  it.each([1,3])('retains the real time domain for %i missing-only forecast rows',count=>{
    const {widget,result}=buildGridOperations().panels.prediction;
    const times=Array.from({length:count},(_,i)=>GRID_AS_OF+i*GRID_STEP);
    const records={...result.records!,rows:times.map(timestamp=>[timestamp,null,null,null,null,null,null])};
    const markup=renderToStaticMarkup(createElement(ForecastBands,{widget,result:{records}}));
    expect(markup).toContain('<svg');expect(markup).not.toContain('No forecast observations');
    expect(markup).toContain(`data-forecast-window-start="${times[0]}"`);expect(markup).toContain(`data-forecast-window-end="${times.at(-1)}"`);
    expect(markup).toContain('>16:00</text>');expect(markup).not.toContain('NaN');expect(markup).not.toContain('Forecast →');
    if(count===1)expect(markup).not.toContain('Chart time window');
  });
});
