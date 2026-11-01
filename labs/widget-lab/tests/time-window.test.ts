import { describe, expect, it } from 'vitest';
import { minimumTimeWindow, nearestTimeIndex, normalizeTimeWindow, observationsInWindow, sameTimeWindow, timeWindowExtent, timeWindowFromPixels } from '../src/renderer-extensions/time-window';
import { makeReferenceResult } from '../src/reference/ReferenceCharts';
import { calendarTick } from '../src/renderer-extensions/chart-presentation';

describe('chart time window contract', () => {
  it('uses finite timestamps across series, including legitimate zero and null observations', () => {
    expect(timeWindowExtent([{points:[{timestamp:NaN,value:4},{timestamp:120,value:null},{timestamp:0,value:0}]},{points:[{timestamp:240,value:8}]}])).toEqual({start:0,end:240});
    expect(timeWindowExtent([{points:[{timestamp:10,value:3}]}])).toBeNull();
    expect(timeWindowExtent([])).toBeNull();
  });

  it('normalizes reverse drags and constrains both ends to the available observations', () => {
    expect(normalizeTimeWindow({start:800,end:200},{start:0,end:1000},20)).toEqual({start:200,end:800});
    expect(normalizeTimeWindow({start:-100,end:1200},{start:0,end:1000},20)).toEqual({start:0,end:1000});
  });

  it('rejects clicks, undersized selections and non-finite input', () => {
    for (const range of [{start:100,end:100},{start:100,end:110},{start:NaN,end:900},{start:200,end:Infinity}]) {
      expect(normalizeTimeWindow(range,{start:0,end:1000},20)).toBeNull();
    }
    expect(normalizeTimeWindow({start:0,end:1000},{start:1000,end:0},20)).toBeNull();
  });

  it('converts plot pixels to actual timestamps independently of sample array length', () => {
    expect(timeWindowFromPixels(140,380,20,480,{start:1000,end:9000},1)).toEqual({start:3000,end:7000});
    expect(timeWindowFromPixels(380,140,20,480,{start:1000,end:9000},1)).toEqual({start:3000,end:7000});
    expect(timeWindowFromPixels(-20,900,20,480,{start:1000,end:9000},1)).toEqual({start:1000,end:9000});
    expect(timeWindowFromPixels(10,20,0,0,{start:0,end:100},1)).toBeNull();
  });

  it('constrains nested zoom to the current domain', () => {
    const first=timeWindowFromPixels(100,300,0,400,{start:0,end:1000},10)!;
    const second=timeWindowFromPixels(100,300,0,400,first,10)!;
    expect(first).toEqual({start:250,end:750});
    expect(second).toEqual({start:375,end:625});
    expect(sameTimeWindow(second,first)).toBe(false);
  });

  it('sets a meaningful two-interval minimum without assuming regular samples', () => {
    const points=[0,10,50,80].map(timestamp=>({timestamp,value:1}));
    expect(minimumTimeWindow([{points}],{start:0,end:80})).toBe(20);
    expect(minimumTimeWindow([{points:[{timestamp:0,value:null},{timestamp:10,value:2}]}],{start:0,end:10})).toBe(10);
  });

  it('keeps raw values, null gaps, zeros, order and source objects intact when selecting a window', () => {
    const points=[{timestamp:30,value:3},{timestamp:0,value:0},{timestamp:10,value:null},{timestamp:20,value:200}];
    const original=structuredClone(points);
    const selected=observationsInWindow(points,{start:5,end:25});
    expect(selected).toEqual([{timestamp:10,value:null},{timestamp:20,value:200}]);
    expect(selected[0]).toBe(points[2]);
    expect(points).toEqual(original);
  });

  it('retains only immediate outside observations when clipping painted boundaries', () => {
    const points=[0,10,20,30,40,50].map(timestamp=>({timestamp,value:timestamp===30?null:timestamp}));
    expect(observationsInWindow(points,{start:15,end:35},true).map(point=>point.timestamp)).toEqual([10,20,30,40]);
    expect(observationsInWindow(points,{start:21,end:29},true).map(point=>point.timestamp)).toEqual([20,30]);
    expect(observationsInWindow(points,{start:21,end:29})).toEqual([]);
  });

  it('finds exact nearest source observations and never inspects an off-window point', () => {
    const points=[{timestamp:0,value:10},{timestamp:9,value:null},{timestamp:1000,value:90}];
    expect(nearestTimeIndex(points,8)).toBe(1);
    expect(nearestTimeIndex(points,900,{start:0,end:10})).toBe(1);
    expect(nearestTimeIndex(points,500,{start:100,end:800})).toBeNull();
  });

  it('distinguishes UTC sub-day calendar ticks after zoom while keeping full-month labels concise', () => {
    const midnight=Date.UTC(2026,9,13), noon=midnight+12*3600000;
    expect(calendarTick(midnight,3*86400000)).toBe('Oct 13 00:00');
    expect(calendarTick(noon,3*86400000)).toBe('Oct 13 12:00');
    expect(calendarTick(midnight,30*86400000)).toBe('Oct 13');
    expect(calendarTick(noon,3600000)).toBe('12:00');
  });

  for (const kind of ['edge','reliability'] as const) {
    it(`${kind} reference window preserves authored exact values and gap observations`, () => {
      const result=makeReferenceResult(kind), series=result.series!;
      const before=structuredClone(series), extent=timeWindowExtent(series)!;
      const from=series[0].points[150].timestamp,to=series[0].points[330].timestamp;
      const window=normalizeTimeWindow({start:from,end:to},extent,minimumTimeWindow(series,extent))!;
      expect(window.end-window.start).toBeLessThan(extent.end-extent.start);
      for (const entry of series) {
        const selected=observationsInWindow(entry.points,window);
        expect(selected[0].timestamp).toBe(from);
        expect(selected.at(-1)!.timestamp).toBe(to);
        if(kind==='reliability')expect(selected.some(point=>point.value===null)).toBe(true);
      }
      expect(series).toEqual(before);
    });
  }
});
