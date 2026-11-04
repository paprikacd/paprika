import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe,it,expect } from 'vitest';
import { cohortCells, cohortConfig, controlConfig, controlSamples, countRows, density, distributionConfig, histogram, intervalRows, sampleGroups, stageFlow } from '../src/charts/analytics/data';
import { buildCohorts, buildExperiments, buildFactory, buildJourney } from '../src/lenses/analytics/analytics-data';
import { analyticsChartCatalog, makeAnalyticsCatalogFixture } from '../src/catalog/analytics-fixtures';
import { registerAnalyticsCharts } from '../src/charts/analytics/register';
import { getWidgetDefinition } from '@insights/widget-registry';
import { widgetSchema } from '@insights/schema';
import { parseRecordFrame } from '@insights/record-data';

describe('cohort population contracts',()=>{
 it('distinguishes future, missing and observed zero',()=>{const f=buildCohorts(true).records!,d=cohortCells(f);expect(d.cells.find(c=>c.cohort==='Oct 26'&&c.week===4)?.observed).toBe(false);expect(d.cells.find(c=>c.cohort==='Sep 14'&&c.week===3)?.percent).toBeNull();const copy=structuredClone(f);copy.rows[1][3]=0;expect(cohortCells(copy).cells[1].percent).toBe(0);});
 it('retains each cohort denominator across ages',()=>{const d=cohortCells(buildCohorts().records!);for(const cell of d.cells)if(cell.retained!==null)expect(cell.percent).toBeCloseTo(cell.retained/cell.size*100,10);const bad=structuredClone(buildCohorts().records!);bad.rows[2][2]=900;expect(()=>cohortCells(bad)).toThrow(/denominator/);});
 it('rejects duplicates and values in future cells',()=>{const f=buildCohorts().records!;const duplicate=structuredClone(f);duplicate.rows.push(duplicate.rows[0]);expect(()=>cohortCells(duplicate)).toThrow(/Duplicate/);const future=structuredClone(f);future.rows.at(-1)![3]=0;expect(()=>cohortCells(future)).toThrow(/future/);expect(()=>cohortConfig.parse({invented:true})).toThrow();});
 it('conserves path count at every stage and selected population',()=>{for(const name of ['Aug 10','Sep 14','Oct 26']){const j=buildJourney(name),flow=stageFlow(j.flow.result.records!),funnel=countRows(j.funnel.result.records!);expect(flow.total).toBe(j.summary.size);flow.columns.forEach(col=>expect(col.reduce((sum,r)=>sum+r.count,0)).toBe(flow.total));[0,1].forEach(stage=>expect(flow.links.filter(l=>l.stage===stage).reduce((sum,l)=>sum+l.count,0)).toBe(flow.total));expect(funnel.rows[0].count).toBe(j.summary.size);expect(flow.columns[2].find(r=>r.label==='Dashboard')?.count).toBe(funnel.rows[2].count);}});
 it('rejects increasing fixed-cohort funnels',()=>{const f=buildJourney().funnel.result.records!;f.rows[1][1]=9000;expect(()=>countRows(f)).toThrow(/grow/);});
});
describe('process and sample distribution contracts',()=>{
 it('keeps the full six-machine population inside the host record limit',()=>{const drift=buildFactory('drift'),stable=buildFactory('stable'),records=drift.histogram.result.records!;expect(records.rows).toHaveLength(960);expect(drift.summary.inspected).toBe(records.rows.length);expect(drift.groups).toHaveLength(6);drift.groups.forEach(g=>expect(g.values).toHaveLength(160));expect(drift.violin.result.records).toEqual(records);expect(parseRecordFrame(records)).toEqual(records);const values=drift.groups.flatMap(g=>g.values),outside=values.filter(v=>v<24.95||v>25.05).length;expect(drift.summary.outside).toBe(outside);expect(drift.summary.yield).toBeCloseTo((1-outside/values.length)*100,10);const shifted=drift.groups[3].values.filter((value,i)=>Math.abs(value-stable.groups[3].values[i])>1e-9);expect(shifted).toHaveLength(21);});
 it('identifies breached subgroup means while keeping gaps unknown',()=>{const f=buildFactory(),r=controlSamples(f.control.result.records!);expect(r.filter(r=>r.breach).length).toBe(f.summary.breaches);expect(f.summary.breaches).toBeGreaterThan(0);expect(controlSamples(buildFactory('gaps').control.result.records!).filter(r=>r.mean===null)).toHaveLength(5);expect(buildFactory('stable').summary.breaches).toBe(0);});
 it('control limits must bracket centre and duplicate samples fail',()=>{expect(()=>controlConfig.parse({lower:26})).toThrow();const f=buildFactory().control.result.records!;f.rows[1][0]=f.rows[0][0];expect(()=>controlSamples(f)).toThrow(/unique/);});
 it('bins preserve finite counts and include the final endpoint',()=>{const h=histogram([0,.1,.4,.5,.99,1,NaN,-1],0,1,4);expect(h.bins.reduce((n,b)=>n+b.count,0)).toBe(6);expect(h.bins.at(-1)?.count).toBe(2);expect(h.omitted).toBe(2);});
 it('keeps missing separate from samples and uses ordered exact quartiles',()=>{const f=buildFactory().histogram.result.records!;f.rows[0][1]=null;const groups=sampleGroups(f);expect(groups[0].missing).toBe(1);expect(groups[0].values).toHaveLength(159);for(const g of groups){expect(g.low!).toBeLessThanOrEqual(g.q1!);expect(g.q1!).toBeLessThanOrEqual(g.median!);expect(g.median!).toBeLessThanOrEqual(g.q3!);expect(g.q3!).toBeLessThanOrEqual(g.high!);expect(density(g,24.9,25.1).every(p=>Number.isFinite(p.density)&&p.density>=0)).toBe(true);}});
 it('Pareto cumulative share ends at 100 and the denominator is defects',()=>{const d=countRows(buildFactory().pareto.result.records!,undefined,'pareto');expect(d.total).toBe(431);expect(d.rows.at(-1)?.cumulative).toBe(100);expect(d.rows[0].label).toBe('Burr');});
 it('rejects reversed specifications',()=>expect(()=>distributionConfig.parse({lowerSpec:26,upperSpec:25})).toThrow());
});
describe('effect uncertainty and assignment accounting',()=>{
 it('central intervals are nested and derived from the same distributions',()=>{const e=buildExperiments(),rows=intervalRows(e.forest.result.records!);expect(rows).toHaveLength(9);for(const g of e.groups){const r=rows.find(r=>r.label===g.label+' · Overall')!;expect(r.estimate).toBeCloseTo(g.median!,8);expect(r.lower!).toBeLessThan(r.innerLower!);expect(r.innerUpper!).toBeLessThan(r.upper!);} });
 it('uses eligible population consistently and conserves coverage counts',()=>{for(const population of ['All workspaces','Pro workspaces'] as const){const e=buildExperiments(population);for(const row of e.coverage)expect(row.observed+row.pending+row.missing).toBe(row.assigned);if(population==='Pro workspaces')expect(intervalRows(e.forest.result.records!).some(r=>r.label.includes('Free'))).toBe(false);}});
 it('rejects partial unknown bounds and nonnested intervals',()=>{const f=buildExperiments().forest.result.records!,partial=structuredClone(f);partial.rows[0][3]=null;expect(()=>intervalRows(partial)).toThrow(/every bound/);const reversed=structuredClone(f);reversed.rows[0][5]=100;expect(()=>intervalRows(reversed)).toThrow(/nested/);});
});
describe('analytics catalog integration',()=>{
 registerAnalyticsCharts();
 it('every example is normalized, registered and config validated',()=>{for(const entry of analyticsChartCatalog){for(const preset of entry.presets){const f=makeAnalyticsCatalogFixture(entry.id,preset);expect(()=>widgetSchema.parse(f.widget)).not.toThrow();expect(()=>parseRecordFrame(f.result.records)).not.toThrow();const def=getWidgetDefinition('plugin',f.widget.pluginId!);expect(def).toBeDefined();expect(()=>def!.parseConfig!(f.widget.config)).not.toThrow();if(preset==='empty')expect(f.result.records?.rows).toHaveLength(0);}}});
});

describe('analytics renderer boundaries',()=>{
 it('renders ready and missing data without invalid geometry, and keeps embedded charts passive',()=>{
  for(const entry of analyticsChartCatalog){
   for(const preset of entry.presets.filter(p=>p==='ready'||p==='gaps')){
    const fixture=makeAnalyticsCatalogFixture(entry.id,preset);const definition=getWidgetDefinition('plugin',fixture.widget.pluginId!)!;
    const markup=renderToStaticMarkup(createElement(definition.render,{...fixture,embedded:true}));
    expect(markup).toContain('<svg');expect(markup).not.toMatch(/NaN|Infinity/);expect(markup).not.toContain('role="button"');expect(markup).not.toContain('<button');
   }
  }
 });
 it('renders all-null sample populations as missing rather than fabricated density',()=>{const fixture=makeAnalyticsCatalogFixture('sample-ridgeline');fixture.result.records!.rows.forEach(row=>row[1]=null);const definition=getWidgetDefinition('plugin','sample-distribution')!;const markup=renderToStaticMarkup(createElement(definition.render,fixture));expect(markup).toContain('No finite distribution samples');expect(markup).not.toContain('<svg');});
 it('normalizes the contextual time-series widget through the existing schema',()=>expect(()=>widgetSchema.parse(buildExperiments().times.widget)).not.toThrow());
});
