import { z } from 'zod';
import type { RecordFrame } from '../../renderer-extensions/schema';

const identity = z.string().min(1).max(160);
export const relationConfig = z.strictObject({ selectedSource: identity.optional(), selectedTarget: identity.optional(), showDetails: z.boolean().default(true), showValues: z.boolean().default(false), showLabels: z.boolean().default(true), maxNodes: z.number().int().min(4).max(18).default(10), coverageGaps:z.array(z.strictObject({start:z.number().finite(),end:z.number().finite()}).refine(value=>value.end>value.start,'Coverage intervals must increase.')).max(40).default([]) });
export const scheduleConfig = z.strictObject({ selectedId: identity.optional(), showDetails: z.boolean().default(true), showDependencies: z.boolean().default(true), showProgress: z.boolean().default(true), rowHeight: z.number().int().min(28).max(48).default(35), editable: z.boolean().default(false) });
export const materialConfig = z.strictObject({ selectedId: identity.optional(), activeIds: z.array(identity).max(500).optional(), showLabels: z.boolean().default(true), showDetails: z.boolean().default(true), showFrontier: z.boolean().default(true), minStrength: z.number().min(0).max(1000).default(250), maxDensity: z.number().positive().max(10).default(1.6), maxCost: z.number().positive().max(1000).default(30) });

export function recordObjects(frame: RecordFrame): Record<string, string | number | boolean | null>[] {
  if (new Set(frame.columns.map(c => c.key)).size !== frame.columns.length) throw new Error('Record column keys must be unique.');
  if (frame.rows.length > 5000) throw new Error('This chart accepts at most 5,000 source records.');
  return frame.rows.map(row => Object.fromEntries(frame.columns.map((c, i) => [c.key, row[i] ?? null])));
}
function required(row: Record<string, unknown>, key: string) { const value = row[key]; if (typeof value !== 'string' || !value) throw new Error(`Missing string field ${key}.`); return value; }
function numeric(row: Record<string, unknown>, key: string, nullable = false) { const value = row[key]; if (nullable && value === null) return null; if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid finite number ${key}.`); return value; }
function unique(items: { id: string }[]) { if (new Set(items.map(x => x.id)).size !== items.length) throw new Error('Record identities must be unique.'); }

export interface ThreatEvent { id: string; timestamp: number; source: string; target: string; action: string; sourceType: string; targetType: string; count: number; confidence: number; reviewed: boolean }
export function threatEvents(frame: RecordFrame): ThreatEvent[] {
  const items = recordObjects(frame).map(row => {
    const item = { id: required(row,'id'), timestamp: numeric(row,'timestamp')!, source: required(row,'source'), target: required(row,'target'), action: required(row,'action'), sourceType: required(row,'sourceType'), targetType: required(row,'targetType'), count: numeric(row,'count')!, confidence: numeric(row,'confidence')!, reviewed: row.reviewed === true };
    if (!Number.isInteger(item.count) || item.count < 1 || item.confidence < 0 || item.confidence > 100) throw new Error('Event counts must be positive integers and confidence must be 0–100%.');
    if (typeof row.reviewed !== 'boolean') throw new Error('Review state must be an explicit boolean; missing state is not unreviewed.');
    return item;
  });
  unique(items); return items.sort((a,b) => a.timestamp-b.timestamp || a.id.localeCompare(b.id));
}
export interface Relation { id: string; source: string; target: string; count: number; first: number; last: number; events: ThreatEvent[] }
export function relationMatrix(events: readonly ThreatEvent[]) {
  const types = new Map<string,string>();
  const relations = new Map<string,Relation>();
  events.forEach(event => {
    for (const [id,type] of [[event.source,event.sourceType],[event.target,event.targetType]] as const) {
      if (types.has(id) && types.get(id) !== type) throw new Error(`Conflicting entity type for ${id}.`);
      types.set(id,type);
    }
    const id = JSON.stringify([event.source,event.target]), previous = relations.get(id);
    if (previous) { previous.count += event.count; previous.first = Math.min(previous.first,event.timestamp); previous.last = Math.max(previous.last,event.timestamp); previous.events.push(event); }
    else relations.set(id,{ id,source:event.source,target:event.target,count:event.count,first:event.timestamp,last:event.timestamp,events:[event] });
  });
  const order = ['Host','Account','Process','Domain','Service'];
  const entities = [...types].map(([id,type])=>({id,type})).sort((a,b)=>order.indexOf(a.type)-order.indexOf(b.type)||a.id.localeCompare(b.id));
  if (entities.length > 32) throw new Error('Relationship matrices support at most 32 entities; filter the source first.');
  return { entities, relations:[...relations.values()], count:events.reduce((sum,e)=>sum+e.count,0) };
}
export function neighbourhood(relations: readonly Relation[], hub: string, maximum: number) {
  const counts = new Map<string,number>();
  relations.forEach(r=>{ if(r.source===hub)counts.set(r.target,(counts.get(r.target)??0)+r.count); if(r.target===hub)counts.set(r.source,(counts.get(r.source)??0)+r.count); });
  const neighbours = [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,maximum-1).map(([id])=>id);
  const ids = [hub,...neighbours], set = new Set(ids);
  return { ids, edges:relations.filter(r=>set.has(r.source)&&set.has(r.target)), omitted:Math.max(0,counts.size-neighbours.length) };
}

export const SCHEDULE_START = Date.UTC(2026,10,2);
export const HOUR = 3_600_000;
export interface ScheduleTask { id: string; label: string; group: string; resource: string; start: number; end: number; baselineStart: number; baselineEnd: number; progress: number; predecessors: string[] }
export function scheduleTasks(frame: RecordFrame): ScheduleTask[] {
  const tasks = recordObjects(frame).map(row => ({ id:required(row,'id'),label:required(row,'label'),group:required(row,'group'),resource:required(row,'resource'),start:numeric(row,'start')!,end:numeric(row,'end')!,baselineStart:numeric(row,'baselineStart')!,baselineEnd:numeric(row,'baselineEnd')!,progress:numeric(row,'progress')!,predecessors:required(row,'predecessors')==='—'?[]:required(row,'predecessors').split('|') }));
  unique(tasks);
  tasks.forEach(t=>{if(t.end<=t.start||t.baselineEnd<=t.baselineStart||t.progress<0||t.progress>100)throw new Error('Schedule intervals must increase and progress must be 0–100%.');});
  topologicalTasks(tasks); return tasks;
}
export function topologicalTasks(tasks: readonly ScheduleTask[]) {
  const byId = new Map(tasks.map(t=>[t.id,t])), visiting = new Set<string>(), done = new Set<string>(), ordered: ScheduleTask[] = [];
  function visit(id: string) { const task=byId.get(id); if(!task)throw new Error(`Unknown predecessor ${id}.`); if(visiting.has(id))throw new Error('Schedule dependencies must be acyclic.'); if(done.has(id))return; visiting.add(id); task.predecessors.forEach(visit); visiting.delete(id); done.add(id); ordered.push(task); }
  tasks.forEach(t=>visit(t.id)); return ordered;
}
export function scheduleIssues(tasks: readonly ScheduleTask[]) {
  const byId = new Map(tasks.map(t=>[t.id,t])), issues:string[]=[];
  topologicalTasks(tasks).forEach(task=>{
    if(task.start<0||task.end>24*21)issues.push(`${task.id}: outside the 21-day planning horizon.`);
    task.predecessors.forEach(id=>{if(byId.get(id)!.end>task.start+1e-8)issues.push(`${task.id}: starts before ${id} finishes.`);});
  });
  tasks.forEach((a,i)=>tasks.slice(i+1).forEach(b=>{if(a.resource===b.resource&&Math.max(a.start,b.start)<Math.min(a.end,b.end)-1e-8)issues.push(`${a.id} and ${b.id}: ${a.resource} is double-booked.`);}));
  return issues;
}
export function proposeSchedule(tasks: readonly ScheduleTask[], id: string, start: number, propagate: boolean) {
  if(!Number.isFinite(start))throw new Error('Enter a valid start time.');
  const changed=tasks.map(t=>({...t,predecessors:[...t.predecessors]})), selected=changed.find(t=>t.id===id);
  if(!selected)throw new Error('Select an existing task.');
  const duration=selected.end-selected.start; selected.start=start; selected.end=start+duration;
  if(propagate){const byId=new Map(changed.map(t=>[t.id,t])); for(const task of topologicalTasks(changed)){const earliest=Math.max(0,...task.predecessors.map(p=>byId.get(p)!.end)); if(task.id!==id&&task.start<earliest){const duration=task.end-task.start;task.start=earliest;task.end=earliest+duration;}}}
  return {tasks:changed,issues:scheduleIssues(changed)};
}
export function criticalPath(tasks: readonly ScheduleTask[]) {
  const totals = new Map<string,number>(), parents = new Map<string,string>();
  for(const task of topologicalTasks(tasks)){const previous=task.predecessors.map(id=>({id,total:totals.get(id)!})).sort((a,b)=>b.total-a.total)[0];totals.set(task.id,(previous?.total??0)+task.end-task.start);if(previous)parents.set(task.id,previous.id);}
  let end:string|undefined=[...totals].sort((a,b)=>b[1]-a[1])[0]?.[0];const ids:string[]=[];while(end){ids.unshift(end);end=parents.get(end);}
  return {ids,duration:Math.max(0,...totals.values())};
}
export function dailyResourceLoad(tasks: readonly ScheduleTask[], dayCount=14) {
  const resources = new Set(tasks.map(t=>t.resource));
  return Array.from({length:dayCount},(_,day)=>({day,hours:tasks.reduce((sum,t)=>sum+Math.max(0,Math.min((day+1)*24,t.end)-Math.max(day*24,t.start)),0),capacity:resources.size*24}));
}

export interface MaterialCandidate { id: string; matrix: number; fibre: number; filler: number; density: number | null; strength: number | null; cost: number; recycled: number; replicates: number }
export function materialCandidates(frame: RecordFrame): MaterialCandidate[] {
  const items=recordObjects(frame).map(row=>({id:required(row,'id'),matrix:numeric(row,'matrix')!,fibre:numeric(row,'fibre')!,filler:numeric(row,'filler')!,density:numeric(row,'density',true),strength:numeric(row,'strength',true),cost:numeric(row,'cost')!,recycled:numeric(row,'recycled')!,replicates:numeric(row,'replicates')!}));
  unique(items);if(items.length>500)throw new Error('Composition views support at most 500 candidates.');
  items.forEach(item=>{if([item.matrix,item.fibre,item.filler,item.recycled].some(v=>v<0||v>100)||Math.abs(item.matrix+item.fibre+item.filler-100)>1e-6)throw new Error('Composition percentages must be nonnegative and sum to 100%.');if(item.cost<=0||item.density!==null&&item.density<=0||item.strength!==null&&item.strength<0||!Number.isInteger(item.replicates)||item.replicates<0)throw new Error('Candidate measurements have invalid bounds.');});
  return items;
}
/** Matrix at the top, fibre at lower left, filler at lower right. */
export function ternaryPoint(candidate: Pick<MaterialCandidate,'matrix'|'fibre'|'filler'>, side=1) {
  if([candidate.matrix,candidate.fibre,candidate.filler].some(v=>!Number.isFinite(v)||v<0)||Math.abs(candidate.matrix+candidate.fibre+candidate.filler-100)>1e-6)throw new Error('Ternary components must sum to 100%.');
  return {x:side*(candidate.filler+candidate.matrix*.5)/100,y:side*Math.sqrt(3)/2*(1-candidate.matrix/100)};
}
export function paretoFrontier(candidates: readonly MaterialCandidate[]) {
  const observed=candidates.filter((c):c is MaterialCandidate&{density:number;strength:number}=>c.density!==null&&c.strength!==null);
  return observed.filter(a=>!observed.some(b=>b.id!==a.id&&b.density<=a.density&&b.strength>=a.strength&&(b.density<a.density||b.strength>a.strength))).sort((a,b)=>a.density-b.density||b.strength-a.strength);
}
export function feasibleCandidates(candidates: readonly MaterialCandidate[], limits:{minStrength:number;maxDensity:number;maxCost:number}, ids?: readonly string[]) {
  const chosen=ids?new Set(ids):null;
  return candidates.filter(c=>c.strength!==null&&c.density!==null&&c.strength>=limits.minStrength&&c.density<=limits.maxDensity&&c.cost<=limits.maxCost&&(!chosen||chosen.has(c.id)));
}
export function ternaryRectangle(candidates: readonly MaterialCandidate[], bounds:{x1:number;y1:number;x2:number;y2:number}) {
  return candidates.filter(c=>{const p=ternaryPoint(c);return p.x>=Math.min(bounds.x1,bounds.x2)&&p.x<=Math.max(bounds.x1,bounds.x2)&&p.y>=Math.min(bounds.y1,bounds.y2)&&p.y<=Math.max(bounds.y1,bounds.y2);}).map(c=>c.id);
}
