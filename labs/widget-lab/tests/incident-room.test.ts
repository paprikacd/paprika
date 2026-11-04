import { describe,expect,it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { alignedTelemetryConfig, buildDependencyGraph, buildTraceSpans, dependencyConfig, telemetryAt, traceWaterfallConfig, visibleTraceSpans } from '../src/charts/incident/incident-model';
import { TraceWaterfall, ServiceDependency } from '../src/charts/incident/IncidentCharts';
import { registerIncidentCharts } from '../src/charts/incident/register';
import { getWidgetDefinition } from '@insights/widget-registry';
import { INCIDENT_END, INCIDENT_START, incidentDependencyPanel, incidentSamples, incidentTelemetryPanel, incidentTracePanel, summarizeIncident } from '../src/lenses/incident-room-data';
import { normalizeTimeWindow, observationsInWindow } from '@insights/time-window';

describe('Incident Room shared telemetry and trace semantics',()=>{
  it('pools errors from real request denominators and preserves missing tail buckets',()=>{
    const samples=incidentSamples('checkout-api'),summary=summarizeIncident(samples);
    expect(samples).toHaveLength(181);expect(summary.observed).toBe(156);expect(summary.missing).toBe(25);
    expect(samples.at(-1)?.requests).toBeNull();expect(samples.at(-1)?.p95).toBeNull();
    expect(summary.errorRatio).toBeCloseTo(summary.errors/summary.requests*100,10);
    for(const point of samples.filter(p=>p.requests!==null)){expect(point.errors).toBeLessThanOrEqual(point.requests!);expect(point.rate).toBe(point.requests!/10);}
    expect(summarizeIncident(samples,{start:INCIDENT_START+26*60_000,end:INCIDENT_END}).errorRatio).toBeNull();
  });
  it('gives all lanes identical UTC extents and exact non-indexed inspection',()=>{
    const panel=incidentTelemetryPanel('payment-svc');
    const timestamp=INCIDENT_START+12*60_000;
    expect(panel.result.series!.map(s=>[s.points[0].timestamp,s.points.at(-1)!.timestamp])).toEqual(Array(3).fill([INCIDENT_START,INCIDENT_END]));
    expect(telemetryAt([{name:'late',points:[{timestamp:30,value:0}]},{name:'early',points:[{timestamp:20,value:9},{timestamp:30,value:null}]}],30)).toEqual([{name:'late',value:0},{name:'early',value:null}]);
    expect(telemetryAt(panel.result.series!,timestamp).every(p=>p.value!==null)).toBe(true);
  });
  it('zooms all telemetry from a shared immutable source, including reverse intervals',()=>{
    const panel=incidentTelemetryPanel('checkout-api'),before=JSON.stringify(panel.result);
    const accepted=normalizeTimeWindow({start:INCIDENT_START+23*60_000,end:INCIDENT_START+11*60_000},{start:INCIDENT_START,end:INCIDENT_END},20_000)!;
    expect(accepted).toEqual({start:INCIDENT_START+11*60_000,end:INCIDENT_START+23*60_000});
    expect(panel.result.series!.map(s=>observationsInWindow(s.points,accepted).length)).toEqual([73,73,73]);
    expect(JSON.stringify(panel.result)).toBe(before);
  });
  it('keeps parallel span durations separate from 1,892ms elapsed time',()=>{
    const model=buildTraceSpans(incidentTracePanel().result.records!);
    expect(model.spans).toHaveLength(14);expect(model.duration).toBe(1892);
    const payment=model.byId.get('payment')!,auth=model.byId.get('authorize')!,fraud=model.byId.get('fraud')!,bank=model.byId.get('bank')!;
    expect(auth.duration).toBe(482);expect(fraud.start).toBeLessThan(auth.end);expect(bank.start).toBeLessThan(auth.end);
    expect(payment.duration).toBe(1203);expect(model.spans.reduce((sum,s)=>sum+s.duration,0)).toBeGreaterThan(model.duration);
    for(const span of model.spans)if(span.parentId){const p=model.byId.get(span.parentId)!;expect(span.start).toBeGreaterThanOrEqual(p.start);expect(span.end).toBeLessThanOrEqual(p.end);}
  });
  it('collapses by stable parent identity and searches inside hidden descendants',()=>{
    const model=buildTraceSpans(incidentTracePanel().result.records!);
    expect(visibleTraceSpans(model.spans,new Set(['payment'])).map(s=>s.id)).not.toContain('authorize');
    expect(visibleTraceSpans(model.spans,new Set(['payment']),'payments.authorize').map(s=>s.id)).toEqual(['authorize']);
    const frame=structuredClone(incidentTracePanel().result.records!);frame.rows.reverse();
    expect(buildTraceSpans(frame).spans.map(s=>s.id)).toEqual(model.spans.map(s=>s.id));
  });
  it('rejects false durations, unknown parents, duplicate IDs and incomplete containment',()=>{
    const invalid=structuredClone(incidentTracePanel().result.records!);invalid.rows[6][5]=2000;
    expect(()=>buildTraceSpans(invalid)).toThrow('outside');
    invalid.rows[6][5]=-1;expect(()=>buildTraceSpans(invalid)).toThrow('nonnegative');
    invalid.rows[6][5]=482;invalid.rows[6][1]='absent';expect(()=>buildTraceSpans(invalid)).toThrow('Missing parent');
    invalid.rows[6][1]='payment';invalid.rows[6][0]='root';expect(()=>buildTraceSpans(invalid)).toThrow('unique');
  });
  it('derives dependency error ratios from each observed call population',()=>{
    const graph=buildDependencyGraph(incidentDependencyPanel().result.records!);
    const node=graph.nodes.find(item=>item.name==='payment-svc')!;
    expect(node.requests).toBe(92000);expect(node.errors).toBe(12800);expect(node.errorRate).toBeCloseTo(12800/92000*100);
    expect(graph.nodes).toHaveLength(9);expect(graph.edges).toHaveLength(8);
    const invalid=structuredClone(incidentDependencyPanel().result.records!);invalid.rows[0][4]=999999;expect(()=>buildDependencyGraph(invalid)).toThrow('population');
  });
  it('keeps an unobserved dependency denominator unknown while preserving observed zero errors',()=>{
    const panel=incidentDependencyPanel(),frame=structuredClone(panel.result.records!);
    frame.rows=[['idle-producer','idle-consumer',null,0,0],['active-producer','active-consumer',20,50,0]];
    const graph=buildDependencyGraph(frame);
    expect(graph.edges[0].errorRate).toBeNull();expect(graph.nodes.find(node=>node.name==='idle-consumer')!.errorRate).toBeNull();
    expect(graph.edges[1].errorRate).toBe(0);expect(graph.nodes.find(node=>node.name==='active-consumer')!.errorRate).toBe(0);
    const html=renderToStaticMarkup(createElement(ServiceDependency,{widget:panel.widget,result:{records:frame}}));
    expect(html).toContain('error ratio unavailable; no observed calls');
    expect(html).toContain('active-consumer, 0.00 percent errors');
  });
  it('rejects reversed event intervals and ambiguous track or event identities',()=>{
    const tracks=[{name:'Requests',label:'Requests',unit:'req/s',color:'#11cde5'}];
    expect(alignedTelemetryConfig.safeParse({tracks:[...tracks,...tracks]}).success).toBe(false);
    expect(alignedTelemetryConfig.safeParse({tracks,events:[{id:'bad',label:'Backwards',start:20,end:10,kind:'incident'}]}).success).toBe(false);
    const event={id:'deploy',label:'Revision',start:10,kind:'deployment'};
    expect(alignedTelemetryConfig.safeParse({tracks,events:[event,event]}).success).toBe(false);
    expect(alignedTelemetryConfig.safeParse({tracks,events:[{...event,end:10}]}).success).toBe(true);
  });
  it('registers strict authorable plugins and keeps embedded rendering read-only',()=>{
    registerIncidentCharts();
    for(const id of ['aligned-telemetry','trace-waterfall','service-dependency'])expect(getWidgetDefinition('plugin',id)).toBeDefined();
    expect(traceWaterfallConfig.safeParse({rowHeight:10}).success).toBe(false);
    expect(dependencyConfig.safeParse({unexpected:true}).success).toBe(false);
    expect(alignedTelemetryConfig.safeParse({tracks:[]}).success).toBe(false);
    const trace=incidentTracePanel(),dependency=incidentDependencyPanel();
    const html=renderToStaticMarkup(createElement(TraceWaterfall,{...trace,embedded:true}));
    expect(html).toContain('payments.authorize');expect(html).not.toContain('role="button"');expect(html).not.toContain('Search trace spans');
    expect(renderToStaticMarkup(createElement(ServiceDependency,{...dependency,embedded:true}))).not.toContain('role="button"');
  });
  it('accepts a different trace population without relying on fixture span labels',()=>{
    const frame=structuredClone(incidentTracePanel().result.records!);frame.rows=[['x',null,'worker','ingest',0,50,'OK','other-trace'],['y','x','storage','write',8,31,'OK','other-trace']];
    const model=buildTraceSpans(frame);expect(model.duration).toBe(50);expect(model.spans[1].depth).toBe(1);expect(model.traceId).toBe('other-trace');
  });
  it('keeps deeply nested trace labels and hit regions inside their reserved column',()=>{
    const panel=incidentTracePanel(),frame=structuredClone(panel.result.records!);
    frame.rows=Array.from({length:25},(_,index)=>[`depth-${index}`,index?`depth-${index-1}`:null,'nested-worker',`long-operation-at-depth-${index}`,0,100,'OK','nested-trace']);
    expect(buildTraceSpans(frame).spans.at(-1)!.depth).toBe(24);
    const html=renderToStaticMarkup(createElement(TraceWaterfall,{widget:panel.widget,result:{records:frame},embedded:true}));
    expect(html).not.toMatch(/width="-\d/);expect(html).toContain('long-operation-at-depth-24');
    expect(html).toContain('clip-path=');
  });
  it('accepts zero-duration spans and rejects overflowing end geometry',()=>{
    const frame=structuredClone(incidentTracePanel().result.records!);
    frame.rows=[['instant',null,'worker','instant event',0,0,'UNKNOWN','instant-trace']];
    expect(buildTraceSpans(frame).duration).toBe(0);
    frame.rows[0][4]=1e308;frame.rows[0][5]=1e308;
    expect(()=>buildTraceSpans(frame)).toThrow('finite');
  });
});
