import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { criticalPath, dailyResourceLoad, feasibleCandidates, materialCandidates, materialConfig, neighbourhood, paretoFrontier, proposeSchedule, relationConfig, relationMatrix, scheduleConfig, scheduleIssues, scheduleTasks, ternaryPoint, ternaryRectangle, threatEvents, topologicalTasks, type MaterialCandidate, type ScheduleTask } from '../src/charts/exploration/model';
import { registerExplorationCharts } from '../src/charts/exploration/register';
import { MATERIAL_CANDIDATES, materialFrame, SCHEDULE_TASKS, scheduleFrame, THREAT_EVENTS, THREAT_GAP, threatFrame } from '../src/lenses/exploration/data';
import { explorationChartCatalog, makeExplorationCatalogFixture } from '../src/catalog/exploration-fixtures';
import { getWidgetDefinition } from '../src/renderer-extensions/widget-registry';
import { widgetSchema } from '../src/renderer-extensions/schema';
import { ThreatHuntLens } from '../src/lenses/exploration/ThreatHuntLens';

const task=(id:string,start:number,end:number,predecessors:string[]=[],resource=id):ScheduleTask=>({id,label:id,group:'Test',resource,start,end,baselineStart:start,baselineEnd:end,predecessors,progress:0});
const material=(id:string,density:number|null,strength:number|null,extra:Partial<MaterialCandidate>={}):MaterialCandidate=>({id,density,strength,matrix:40,fibre:40,filler:20,cost:20,recycled:25,replicates:10,...extra});

describe('Threat Hunt evidence contracts',()=>{
 it('keeps investigation evidence in the dashboard layout without an implicit popup',()=>{
  const html=renderToStaticMarkup(createElement(ThreatHuntLens));
  const sidebar=html.match(/<aside class="xp-inspector" aria-label="Investigation evidence">[\s\S]*?<\/aside>/)?.[0];
  expect(sidebar).toBeDefined();
  expect(sidebar).toContain('svc-ci → api-02');
  expect(sidebar).toContain('Observed events');
  expect(sidebar).toContain('Event counts · five-minute bins');
  expect(sidebar).toContain('Clear investigation selection');
  expect(html).not.toContain('data-observation-tooltip');
 });
 it('reconciles each directed matrix count with the same captured event IDs',()=>{
  const events=threatEvents(threatFrame()),matrix=relationMatrix(events);
  expect(matrix.entities).toHaveLength(18);expect(matrix.relations).toHaveLength(21);
  expect(matrix.count).toBe(events.reduce((sum,event)=>sum+event.count,0));
  expect(matrix.relations.reduce((sum,edge)=>sum+edge.count,0)).toBe(matrix.count);
  expect(new Set(matrix.relations.flatMap(edge=>edge.events.map(event=>event.id))).size).toBe(events.length);
  for(const relation of matrix.relations){expect(relation.events.every(event=>event.source===relation.source&&event.target===relation.target)).toBe(true);expect(relation.first).toBe(Math.min(...relation.events.map(event=>event.timestamp)));expect(relation.last).toBe(Math.max(...relation.events.map(event=>event.timestamp)));}
 });
 it('keeps direction and bounded neighbours without inventing links',()=>{
  const model=relationMatrix(THREAT_EVENTS),graph=neighbourhood(model.relations,'api-02',4),ids=new Set(graph.ids);
  expect(graph.ids).toHaveLength(4);expect(graph.omitted).toBeGreaterThan(0);
  for(const edge of graph.edges){expect(ids.has(edge.source)&&ids.has(edge.target)).toBe(true);expect(model.relations).toContain(edge);}
  const a={...THREAT_EVENTS[0],id:'one',source:'X',target:'Y',sourceType:'Host',targetType:'Host',count:5},b={...a,id:'two',source:'Y',target:'X',count:2};
  expect(relationMatrix([a,b]).relations.map(edge=>edge.count)).toEqual([5,2]);
 });
 it('records explicit ingestion coverage and preserves it independently of events',()=>{
  expect(THREAT_EVENTS.some(event=>event.timestamp>=THREAT_GAP.start&&event.timestamp<THREAT_GAP.end)).toBe(false);
  const fixture=makeExplorationCatalogFixture('event-swimlanes');
  expect(relationConfig.parse(fixture.widget.config).coverageGaps).toEqual([THREAT_GAP]);
  expect(()=>relationConfig.parse({coverageGaps:[{start:20,end:10}]})).toThrow();
 });
 it('rejects duplicate evidence, missing counts and inconsistent entity identities',()=>{
  const frame=threatFrame();frame.rows.push(frame.rows[0]);expect(()=>threatEvents(frame)).toThrow(/unique/);
  const missing=threatFrame();missing.rows[0][7]=null;expect(()=>threatEvents(missing)).toThrow(/finite number count/);
  const source={...THREAT_EVENTS[0]},changed={...source,id:'changed',sourceType:'Different'};expect(()=>relationMatrix([source,changed])).toThrow(/Conflicting entity/);
 });
});

describe('Production Planner DAG and proposal contracts',()=>{
 it('has a valid baseline and a longest duration chain, not a sum of all parallel work',()=>{
  const tasks=scheduleTasks(scheduleFrame()),critical=criticalPath(tasks),byId=new Map(tasks.map(t=>[t.id,t]));
  expect(tasks).toHaveLength(12);expect(scheduleIssues(tasks)).toEqual([]);
  expect(critical.duration).toBe(236);expect(critical.ids).toEqual(['WO-101','WO-102','WO-208','WO-209','WO-401','WO-501','WO-601','WO-602']);
  expect(critical.ids.reduce((sum,id)=>sum+byId.get(id)!.end-byId.get(id)!.start,0)).toBe(critical.duration);
  expect(critical.duration).toBeLessThan(tasks.reduce((sum,t)=>sum+t.end-t.start,0));
 });
 it('does not add parallel predecessor durations or resource gaps into critical work',()=>{
  const tasks=[task('a',0,10),task('b',0,8),task('c',30,34,['a','b'])];
  expect(criticalPath(tasks)).toEqual({ids:['a','c'],duration:14});
  expect(topologicalTasks([...tasks].reverse()).map(t=>t.id).indexOf('c')).toBe(2);
 });
 it('rejects cycles, nonexistent predecessors, duplicate identities and invalid intervals',()=>{
  expect(()=>topologicalTasks([task('a',0,1,['b']),task('b',1,2,['a'])])).toThrow(/acyclic/);
  expect(()=>topologicalTasks([task('a',0,1,['absent'])])).toThrow(/Unknown predecessor/);
  const duplicate=scheduleFrame([SCHEDULE_TASKS[0],SCHEDULE_TASKS[0]]);expect(()=>scheduleTasks(duplicate)).toThrow(/unique/);
  const reversed=scheduleFrame([{...SCHEDULE_TASKS[0],end:0}]);expect(()=>scheduleTasks(reversed)).toThrow(/intervals/);
 });
 it('preserves duration, resource and original baseline while proposing downstream shifts immutably',()=>{
  const before=JSON.stringify(SCHEDULE_TASKS),proposal=proposeSchedule(SCHEDULE_TASKS,'WO-208',88,true);
  expect(proposal.issues).toEqual([]);expect(proposal.tasks.find(t=>t.id==='WO-208')!.start).toBe(88);
  expect(proposal.tasks.find(t=>t.id==='WO-209')!.start).toBe(136);expect(proposal.tasks.find(t=>t.id==='WO-401')!.start).toBe(168);
  expect(proposal.tasks.find(t=>t.id==='WO-103')!.start).toBe(8);
  for(const changed of proposal.tasks){const original=SCHEDULE_TASKS.find(t=>t.id===changed.id)!;expect(changed.end-changed.start).toBe(original.end-original.start);expect(changed.resource).toBe(original.resource);expect(changed.baselineStart).toBe(original.baselineStart);expect(changed.baselineEnd).toBe(original.baselineEnd);}
  expect(JSON.stringify(SCHEDULE_TASKS)).toBe(before);
 });
 it('surfaces precedence, resource collisions and horizon breaches without silently repairing them',()=>{
  expect(proposeSchedule(SCHEDULE_TASKS,'WO-208',88,false).issues.some(issue=>issue.includes('WO-209'))).toBe(true);
  expect(scheduleIssues([task('a',0,10,[],'same'),task('b',9,12,[],'same')])).toContain('a and b: same is double-booked.');
  expect(scheduleIssues([task('a',0,10,[],'same'),task('b',10,12,[],'same')])).toEqual([]);
  expect(proposeSchedule(SCHEDULE_TASKS,'WO-602',510,true).issues.some(issue=>issue.includes('horizon'))).toBe(true);
  expect(proposeSchedule(SCHEDULE_TASKS,'WO-208',40,true).issues.some(issue=>issue.includes('starts before'))).toBe(true);
 });
 it('sums exact resource-hour overlaps across days, including partial days',()=>{
  const load=dailyResourceLoad([task('a',20,28),task('b',0,12)],2);
  expect(load).toEqual([{day:0,hours:16,capacity:48},{day:1,hours:4,capacity:48}]);
  expect(dailyResourceLoad(SCHEDULE_TASKS).reduce((sum,day)=>sum+day.hours,0)).toBe(SCHEDULE_TASKS.reduce((sum,t)=>sum+t.end-t.start,0));
 });
});

describe('Materials Lab geometry and population contracts',()=>{
 it('validates the composition simplex and retains pending properties as null',()=>{
  const candidates=materialCandidates(materialFrame());expect(candidates).toHaveLength(186);expect(candidates.filter(c=>c.strength===null)).toHaveLength(14);
  for(const candidate of candidates)expect(candidate.matrix+candidate.fibre+candidate.filler).toBe(100);
  const invalid=materialFrame();invalid.rows[0][1]=101;expect(()=>materialCandidates(invalid)).toThrow(/sum to 100/);
  const missing=materialFrame();missing.rows[0][1]=null;expect(()=>materialCandidates(missing)).toThrow(/finite number matrix/);
 });
 it('maps the three pure components and centroid to correct barycentric positions',()=>{
  expect(ternaryPoint({matrix:100,fibre:0,filler:0})).toEqual({x:.5,y:0});
  expect(ternaryPoint({matrix:0,fibre:100,filler:0})).toEqual({x:0,y:Math.sqrt(3)/2});
  expect(ternaryPoint({matrix:0,fibre:0,filler:100})).toEqual({x:1,y:Math.sqrt(3)/2});
  const centre=ternaryPoint({matrix:100/3,fibre:100/3,filler:100/3});expect(centre.x).toBeCloseTo(.5,12);expect(centre.y).toBeCloseTo(Math.sqrt(3)/3,12);
  const actual=ternaryPoint(MATERIAL_CANDIDATES[41],500),normal=ternaryPoint(MATERIAL_CANDIDATES[41]);expect(actual.x).toBeCloseTo(normal.x*500);expect(actual.y).toBeCloseTo(normal.y*500);
  expect(()=>ternaryPoint({matrix:40,fibre:40,filler:21})).toThrow(/sum to 100/);
 });
 it('computes nondomination with two objectives, ties and missing observations',()=>{
  const candidates=[material('a',1,100),material('b',1.2,150),material('c',1.3,120),material('d',.9,80),material('e',1.2,150),material('missing',null,500)];
  expect(paretoFrontier(candidates).map(c=>c.id)).toEqual(['d','a','b','e']);
  expect(paretoFrontier([material('missing',null,500)])).toEqual([]);
  const actual=paretoFrontier(MATERIAL_CANDIDATES);for(const candidate of actual)expect(MATERIAL_CANDIDATES.some(other=>other.density!==null&&other.strength!==null&&other.density<=candidate.density&&other.strength>=candidate.strength&&(other.density<candidate.density||other.strength>candidate.strength))).toBe(false);
 });
 it('intersects exact candidate IDs with property bounds and excludes pending measurements',()=>{
  const limits={minStrength:250,maxDensity:1.6,maxCost:30},all=feasibleCandidates(MATERIAL_CANDIDATES,limits);
  expect(all.some(c=>c.id==='CMP-042')).toBe(true);expect(all.every(c=>c.density!==null&&c.strength!==null)).toBe(true);
  expect(feasibleCandidates(MATERIAL_CANDIDATES,limits,[])).toEqual([]);
  expect(feasibleCandidates(MATERIAL_CANDIDATES,limits,['CMP-042','CMP-185']).map(c=>c.id)).toEqual(['CMP-042']);
  const brush=ternaryRectangle(MATERIAL_CANDIDATES,{x1:.3,x2:.6,y1:.25,y2:.6});
  expect(brush.length).toBeGreaterThan(0);expect(brush.length).toBeLessThan(MATERIAL_CANDIDATES.length);
  expect(ternaryRectangle(MATERIAL_CANDIDATES,{x1:.6,x2:.3,y1:.6,y2:.25})).toEqual(brush);
  const chosen=feasibleCandidates(MATERIAL_CANDIDATES,limits,brush);expect(chosen.map(c=>c.id)).toEqual(all.filter(c=>brush.includes(c.id)).map(c=>c.id));
 });
});

describe('Exploration chart registry and generic fixtures',()=>{
 registerExplorationCharts();
 it('registers every documented chart with strict validated configs and record fixtures',()=>{
  expect(explorationChartCatalog).toHaveLength(9);
  for(const feature of explorationChartCatalog){for(const preset of feature.presets){const fixture=makeExplorationCatalogFixture(feature.id,preset),definition=getWidgetDefinition('plugin',feature.id)!;expect(definition).toBeDefined();expect(()=>widgetSchema.parse(fixture.widget)).not.toThrow();expect(()=>definition.parseConfig!(fixture.widget.config)).not.toThrow();if(preset==='empty')expect(fixture.result.records?.rows).toHaveLength(0);}}
  expect(()=>relationConfig.parse({invented:true})).toThrow();expect(()=>scheduleConfig.parse({rowHeight:10})).toThrow();expect(()=>materialConfig.parse({maxCost:0})).toThrow();
 });
 it('renders valid ready, missing and empty results without invalid geometry and with passive embeds',()=>{
  for(const feature of explorationChartCatalog){for(const preset of feature.presets.filter(p=>p!=='error')){const fixture=makeExplorationCatalogFixture(feature.id,preset),definition=getWidgetDefinition('plugin',feature.id)!;const html=renderToStaticMarkup(createElement(definition.render,{...fixture,embedded:true}));expect(html).not.toMatch(/NaN|Infinity|(?:width|height)="-\d/);expect(html).not.toContain('role="button"');expect(html).not.toContain('role="slider"');expect(html).not.toContain('<button');if(preset==='empty')expect(html).toContain('No observations');else expect(html).toContain('<svg');}}
 });
 it('keeps wholly pending material properties out of scatter and frontier geometry',()=>{
  const fixture=makeExplorationCatalogFixture('pareto-scatter'),frame=materialFrame(MATERIAL_CANDIDATES.map(c=>({...c,density:null,strength:null,replicates:0}))),definition=getWidgetDefinition('plugin','pareto-scatter')!;
  const html=renderToStaticMarkup(createElement(definition.render,{widget:fixture.widget,result:{records:frame},embedded:true}));expect(html).toContain('0 measured');expect(html).toContain('186 pending');expect(html).not.toMatch(/NaN|Infinity/);
 });
});
