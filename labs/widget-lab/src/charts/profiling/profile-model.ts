import { z } from 'zod';
import type { RecordFrame } from '@insights/schema';

export type ProfileUnit = 'samples' | 'bytes' | 'objects' | 'nanoseconds' | 'milliseconds';
export interface ProfileFrame { id: string; parentId: string | null; label: string; depth: number; start: number; total: number; self: number }
export interface Profile { name: string; source: string; unit: ProfileUnit; sampleRate: number; total: number; frames: ProfileFrame[] }
export interface WeightedStack { stack: string[]; value: number }
export interface StackSample { id: string; start: number; end: number; stack: string[]; thread: string }
export interface FlamechartSpan { id: string; parentId: string | null; label: string; depth: number; start: number; end: number; thread: string }

export const flamegraphConfig = z.strictObject({ orientation: z.enum(['icicle', 'flame']).default('icicle'), rowHeight: z.number().int().min(18).max(40).default(25), showValues: z.boolean().default(true), colorBy: z.enum(['package', 'cost']).default('package') });
export const flamechartConfig = z.strictObject({ rowHeight: z.number().int().min(18).max(36).default(24), showLabels: z.boolean().default(true) });
export const queryPlanConfig = z.strictObject({ showEstimates: z.boolean().default(true) });

function object(v: unknown, name: string): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${name} must be an object.`); return v as Record<string, unknown>; }
function finite(v: unknown, name: string, nonnegative = true) { const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v; if (typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER || nonnegative && n < 0) throw new Error(`${name} must be a finite ${nonnegative ? 'nonnegative ' : ''}safe number.`); return n; }
function integer(v: unknown, name: string) { const n = finite(v, name); if (!Number.isInteger(n)) throw new Error(`${name} must be an integer.`); return n; }
function name(v: unknown): string { if (typeof v !== 'string' || !v.trim() || v.length > 2000) throw new Error('Frame names must contain 1–2,000 characters.'); return v; }
function array(v: unknown, title: string): unknown[] { if (!Array.isArray(v)) throw new Error(`${title} must be an array.`); return v; }
function unit(v: unknown): ProfileUnit { if (!['samples', 'bytes', 'objects', 'nanoseconds', 'milliseconds'].includes(String(v))) throw new Error('Supported profile units: samples, bytes, objects, nanoseconds, milliseconds.'); return v as ProfileUnit; }
const equal = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-7, Math.max(Math.abs(a), Math.abs(b)) * 1e-10);

/** Validate cost accounting independently from any layout or display reduction. */
export function validateProfile(profile: Profile): Profile {
  finite(profile.total, 'Profile total');
  unit(profile.unit); if (finite(profile.sampleRate, 'Sample rate') <= 0) throw new Error('Sample rate must be positive.');
  if (profile.frames.length > 20000) throw new Error('Profiles are limited to 20,000 frames.');
  if (!profile.frames.length) { if (profile.total !== 0) throw new Error('A nonzero profile needs a root frame.'); return profile; }
  const byId = new Map<string, ProfileFrame>();
  for (const frame of profile.frames) {
    if (byId.has(frame.id)) throw new Error('Frame IDs must be unique.');
    byId.set(frame.id, frame); name(frame.label);
    for (const [key, v] of Object.entries({ start: frame.start, total: frame.total, self: frame.self, depth: frame.depth })) finite(v, key);
    if (!Number.isInteger(frame.depth) || frame.depth > 128 || frame.self > frame.total) throw new Error('Invalid frame depth or self cost.');
  }
  const roots = profile.frames.filter(f => f.parentId === null);
  if (roots.length !== 1 || roots[0].depth !== 0 || roots[0].start !== 0 || !equal(roots[0].total, profile.total)) throw new Error('A profile needs one zero-offset root matching its total.');
  const children = new Map<string, ProfileFrame[]>();
  for (const frame of profile.frames) if (frame.parentId !== null) {
    const parent = byId.get(frame.parentId);
    if (!parent || frame.depth !== parent.depth + 1 || frame.start < parent.start || frame.start + frame.total > parent.start + parent.total + 1e-7) throw new Error('Frame is outside its immediate parent.');
    const list = children.get(parent.id) ?? []; list.push(frame); children.set(parent.id, list);
  }
  for (const frame of profile.frames) {
    const list = (children.get(frame.id) ?? []).sort((a, b) => a.start - b.start);
    if (!equal(frame.self + list.reduce((s, f) => s + f.total, 0), frame.total)) throw new Error(`Self + child costs do not reconcile for ${frame.label}.`);
    for (let i = 1; i < list.length; i++) if (list[i].start < list[i - 1].start + list[i - 1].total - 1e-7) throw new Error('Sibling frames overlap.');
  }
  return profile;
}

/** Pyroscope Flamebearer V1 single profiles and Querier FlameGraph JSON. */
export function decodePyroscope(input: unknown): Profile {
  const doc = object(input, 'Profile'), legacy = doc.flamebearer !== undefined;
  if (legacy && doc.version !== undefined && doc.version !== 1) throw new Error('Only Flamebearer version 1 is supported.');
  const meta = legacy ? object(doc.metadata, 'metadata') : object(doc.metadata ?? { units: 'nanoseconds', sampleRate: 1e9, name: 'Querier CPU profile' }, 'metadata');
  if (legacy && meta.format !== 'single') throw new Error('Only single Flamebearer profiles are supported; differential profiles require a separate adapter.');
  const body = object(legacy ? doc.flamebearer : doc.flamegraph ?? doc.flameGraph ?? doc, 'flamegraph');
  const names = array(body.names, 'names').map(name);
  if (names.length > 20000) throw new Error('At most 20,000 symbols are supported.');
  const levels = array(body.levels, 'levels');
  if (levels.length > 129) throw new Error('At most 128 stack levels are supported.');
  const total = integer(legacy ? body.numTicks : body.total, 'total');
  const frames: ProfileFrame[] = [], perDepth: ProfileFrame[][] = [];
  levels.forEach((raw, depth) => {
    const values = array(legacy ? raw : object(raw, 'level').values, 'level values');
    if (values.length % 4 !== 0) throw new Error('Single profile levels need four values per frame.');
    let previousEnd = 0;
    const row: ProfileFrame[] = [];
    for (let i = 0; i < values.length; i += 4) {
      const delta = integer(values[i], 'offset'), amount = integer(values[i + 1], 'total'), self = integer(values[i + 2], 'self'), index = integer(values[i + 3], 'symbol index');
      if (index >= names.length) throw new Error('Frame references an unknown symbol.');
      const start = previousEnd + delta; previousEnd = start + amount;
      const parent = depth ? perDepth[depth - 1].find(p => start >= p.start && start + amount <= p.start + p.total) : undefined;
      if (depth && !parent) throw new Error('Flamebearer frame has no containing parent.');
      const frame = { id: `frame-${depth}-${i / 4}`, parentId: parent?.id ?? null, label: names[index], depth, start, total: amount, self };
      row.push(frame); frames.push(frame);
    }
    perDepth.push(row);
  });
  const sampleRate = finite(meta.sampleRate ?? 100, 'sample rate');
  if (sampleRate <= 0) throw new Error('Sample rate must be positive.');
  if (total === 0 && frames.some(frame => frame.total !== 0 || frame.self !== 0)) throw new Error('An empty profile cannot contain nonzero frame costs.');
  return validateProfile({ name: typeof meta.name === 'string' ? meta.name : 'Imported profile', source: legacy ? 'Pyroscope Flamebearer v1' : 'Pyroscope Querier FlameGraph', unit: unit(meta.units ?? 'samples'), sampleRate, total, frames: total === 0 ? [] : frames });
}

export function profileFromStacks(stacks: readonly WeightedStack[], title = 'Synthetic profile', profileUnit: ProfileUnit = 'samples', sampleRate = 100): Profile {
  type Trie = { label: string; self: number; total: number; children: Map<string, Trie> };
  const root: Trie = { label: 'total', self: 0, total: 0, children: new Map() };
  if (stacks.length > 20000) throw new Error('At most 20,000 input stacks are supported.');
  for (const entry of stacks) {
    finite(entry.value, 'Stack value'); if (entry.stack.length > 128) throw new Error('Stack depth exceeds 128.');
    root.total += entry.value; let current = root;
    for (const label of entry.stack) { name(label); let next = current.children.get(label); if (!next) { next = { label, self: 0, total: 0, children: new Map() }; current.children.set(label, next); } next.total += entry.value; current = next; }
    current.self += entry.value;
  }
  const frames: ProfileFrame[] = [];
  function visit(node: Trie, parentId: string | null, depth: number, start: number) {
    const id = `stack-${frames.length}`;
    frames.push({ id, parentId, label: node.label, depth, start, total: node.total, self: node.self });
    let offset = start + node.self;
    for (const child of [...node.children.values()].sort((a, b) => a.label.localeCompare(b.label))) { visit(child, id, depth + 1, offset); offset += child.total; }
  }
  if (root.total > 0) visit(root, null, 0, 0);
  return validateProfile({ name: title, source: 'Collapsed stacks', unit: profileUnit, sampleRate, total: root.total, frames });
}

export function encodeFlamebearer(profile: Profile) {
  validateProfile(profile); const names: string[] = [], levels: number[][] = [];
  if (profile.frames.some(frame => !Number.isSafeInteger(frame.start) || !Number.isSafeInteger(frame.total) || !Number.isSafeInteger(frame.self))) throw new Error('Flamebearer export requires integer costs. Export the original sampled file to preserve fractional time weights.');
  for (const frame of [...profile.frames].sort((a, b) => a.depth - b.depth || a.start - b.start)) {
    let index = names.indexOf(frame.label); if (index < 0) { index = names.length; names.push(frame.label); }
    const row = levels[frame.depth] ?? []; row.push(frame.start, frame.total, frame.self, index); levels[frame.depth] = row;
  }
  for (const row of levels) { let end = 0; for (let i = 0; i < row.length; i += 4) { const x = row[i]; row[i] = x - end; end = x + row[i + 1]; } }
  if (!levels.length) { names.push('total'); levels.push([0, 0, 0, 0]); }
  return { version: 1, flamebearer: { names, levels, numTicks: profile.total, maxSelf: Math.max(0, ...profile.frames.map(f => f.self)) }, metadata: { format: 'single', name: profile.name, units: profile.unit, sampleRate: profile.sampleRate, spyName: 'paprika-synthetic-fixture' } };
}

export function decodeCollapsed(text: string): Profile {
  const stacks = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean).map((row, i) => { const match = /^(.*?)\s+(\d+(?:\.\d+)?)$/.exec(row); if (!match) throw new Error(`Invalid collapsed-stack line ${i + 1}.`); return { stack: match[1].split(';').map(name), value: Number(match[2]) }; });
  return profileFromStacks(stacks);
}

export function profileToRecords(profile: Profile): RecordFrame {
  return { columns: [ { key:'id',type:'string' },{ key:'parent',type:'string' },{ key:'label',type:'string' },{ key:'depth',type:'number' },{ key:'start',type:'number' },{ key:'total',type:'number' },{ key:'self',type:'number' },{ key:'unit',type:'string' },{ key:'sampleRate',type:'number' } ], rows: profile.frames.map(f => [f.id,f.parentId,f.label,f.depth,f.start,f.total,f.self,profile.unit,profile.sampleRate]) };
}
export function profileFromRecords(frame: RecordFrame): Profile {
  const col = (key: string) => { const i = frame.columns.findIndex(c => c.key === key); if (i < 0) throw new Error(`Missing profile column: ${key}.`); return i; };
  const keys = ['id','parent','label','depth','start','total','self','unit','sampleRate'].map(col);
  const frames = frame.rows.map(row => ({ id:name(row[keys[0]]),parentId:row[keys[1]] === null ? null : name(row[keys[1]]),label:name(row[keys[2]]),depth:integer(row[keys[3]],'depth'),start:finite(row[keys[4]],'start'),total:finite(row[keys[5]],'total'),self:finite(row[keys[6]],'self') }));
  const first = frame.rows[0];
  if (first && frame.rows.some(row => row[keys[7]] !== first[keys[7]] || row[keys[8]] !== first[keys[8]])) throw new Error('Profile units and sample rates must be consistent across rows.');
  return validateProfile({name:'Profile',source:'Normalized profile records',unit:first ? unit(first[keys[7]]) : 'samples',sampleRate:first ? finite(first[keys[8]],'sample rate') : 100,total:frames.find(f=>f.parentId===null)?.total??0,frames});
}

export function profileHotFunctions(profile: Profile) {
  const byLabel = new Map<string, { label: string; self: number; total: number; occurrences: number }>();
  const lookup = new Map(profile.frames.map(f=>[f.id,f]));
  for (const frame of profile.frames) {
    if (frame.parentId === null) continue;
    const item = byLabel.get(frame.label) ?? {label:frame.label,self:0,total:0,occurrences:0};
    item.self += frame.self; item.occurrences++;
    let parent = frame.parentId ? lookup.get(frame.parentId) : undefined, recursive = false;
    while (parent) { if (parent.label === frame.label) recursive = true; parent = parent.parentId ? lookup.get(parent.parentId) : undefined; }
    if (!recursive) item.total += frame.total;
    byLabel.set(frame.label,item);
  }
  return [...byLabel.values()].sort((a,b)=>b.self-a.self||b.total-a.total||a.label.localeCompare(b.label));
}

export function formatProfileValue(value: number, profile: Pick<Profile,'unit'|'sampleRate'>) {
  if (profile.unit === 'bytes') return value >= 1048576 ? `${(value/1048576).toFixed(2)} MiB` : `${(value/1024).toFixed(2)} KiB`;
  if (profile.unit === 'objects') return `${value.toLocaleString('en-US')} objects`;
  const ms = profile.unit === 'samples' ? value/profile.sampleRate*1000 : profile.unit === 'nanoseconds' ? value/1e6 : value;
  return ms >= 1000 ? `${(ms/1000).toFixed(3)} s` : `${ms.toFixed(2)} ms`;
}

export function decodeSpeedscope(input: unknown): StackSample[] {
  const doc = object(input,'Speedscope file'), shared = object(doc.shared,'shared'), frames = array(shared.frames,'frames').map(f=>name(object(f,'frame').name));
  const profiles = array(doc.profiles,'profiles'); if (profiles.length > 16) throw new Error('At most 16 sampled threads are supported.');
  const output: StackSample[] = [], usedThreads = new Set<string>();
  profiles.forEach((raw, pi) => {
    const p = object(raw,'sampled profile'); if(p.type!=='sampled') throw new Error('Only sampled Speedscope profiles are supported.');
    const factors: Record<string,number> = {seconds:1000,milliseconds:1,microseconds:.001,nanoseconds:.000001};
    const factor = factors[String(p.unit)]; if(!factor) throw new Error('A time flamechart requires a time unit. Bytes and unitless weights cannot establish chronology.');
    let start=finite(p.startValue,'start')*factor; const end=finite(p.endValue,'end')*factor, samples=array(p.samples,'samples'), weights=array(p.weights,'weights'), baseThread=name(p.name??`Thread ${pi+1}`);
    let thread=baseThread, suffix=2; while(usedThreads.has(thread))thread=`${baseThread} [${suffix++}]`;usedThreads.add(thread);
    if(samples.length!==weights.length||samples.length>10000) throw new Error('Sample/weight arrays must align and contain at most 10,000 entries per thread.');
    samples.forEach((s,i)=>{const weight=finite(weights[i],'weight')*factor, ids=array(s,'sample'); if(ids.length>128) throw new Error('Stack depth exceeds 128.'); const stack=ids.map(id=>{const index=integer(id,'frame index');if(index>=frames.length)throw new Error('Unknown Speedscope frame index.');return frames[index];});if(weight>0)output.push({id:`${pi}:${i}`,start,end:start+weight,stack,thread});start+=weight;});
    if(!equal(start,end))throw new Error('Sample weights must reconcile to the declared profile extent.');
  });
  flamechartSpans(output); return output;
}

/** Merge only contiguous identical ancestry; unlike an aggregate graph, x remains elapsed time. */
export function flamechartSpans(samples: readonly StackSample[]): FlamechartSpan[] {
  const output: FlamechartSpan[] = [], threads=[...new Set(samples.map(s=>s.thread))];
  if(samples.length>20000)throw new Error('At most 20,000 time samples are supported.');
  const seen=new Set<string>();for(const s of samples){if(seen.has(s.id))throw new Error('Sample IDs must be unique.');seen.add(s.id);finite(s.start,'start');finite(s.end,'end');if(s.end<=s.start||s.stack.length>128)throw new Error('Samples need a positive interval and at most 128 frames.');}
  for(const thread of threads){let active:FlamechartSpan[]=[];let previousEnd=-Infinity;
    for(const sample of samples.filter(s=>s.thread===thread).sort((a,b)=>a.start-b.start)){
      if(sample.start<previousEnd)throw new Error('Samples overlap within a thread.');
      let common=0; if(equal(sample.start,previousEnd))while(common<active.length&&common<sample.stack.length&&active[common].label===sample.stack[common])common++;
      active=active.slice(0,common); active.forEach(f=>{f.end=sample.end;});
      for(let depth=common;depth<sample.stack.length;depth++){const span={id:`span-${output.length}`,parentId:depth?active[depth-1].id:null,label:name(sample.stack[depth]),depth,start:sample.start,end:sample.end,thread};output.push(span);active.push(span);}
      previousEnd=sample.end;
    }
  }
  return output;
}

export function samplesToRecords(samples: readonly StackSample[]): RecordFrame { return {columns:[{key:'id',type:'string'},{key:'start',type:'number',unit:'ms'},{key:'end',type:'number',unit:'ms'},{key:'thread',type:'string'},{key:'stack',type:'string'}],rows:samples.map(s=>[s.id,s.start,s.end,s.thread,JSON.stringify(s.stack)])}; }
export function samplesFromRecords(frame: RecordFrame): StackSample[] { const keys=['id','start','end','thread','stack'].map(key=>{const i=frame.columns.findIndex(c=>c.key===key);if(i<0)throw new Error(`Missing sample column ${key}.`);return i;});return frame.rows.map(r=>({id:name(r[keys[0]]),start:finite(r[keys[1]],'start'),end:finite(r[keys[2]],'end'),thread:name(r[keys[3]]),stack:array(JSON.parse(String(r[keys[4]])),'stack').map(name)})); }

export function parseProfileText(text: string): {profile:Profile;samples:StackSample[]|null;format:string} {
  if(text.length>4_000_000)throw new Error('Profile imports are limited to 4 MB.');
  if(!text.trim())throw new Error('Paste a profile before importing.');
  if(!text.trimStart().startsWith('{'))return {profile:decodeCollapsed(text),samples:null,format:'Collapsed stacks'};
  const doc=JSON.parse(text) as Record<string,unknown>;
  if(doc.shared&&doc.profiles){const samples=decodeSpeedscope(doc);return {profile:profileFromStacks(samples.map(s=>({stack:s.stack,value:s.end-s.start})),String(doc.name??'Sampled profile'),'milliseconds',1000),samples,format:'Speedscope sampled'};}
  return {profile:decodePyroscope(doc),samples:null,format:'Pyroscope'};
}
