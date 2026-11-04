import { z } from 'zod';
import type { RecordFrame } from '@insights/schema';
import { parseRecordFrame } from '@insights/record-data';

const field = z.string().min(1).max(80);
const identityFields = { id: field.default('id'), arm: field.default('arm') };
const selection = { selectedId: z.string().max(100).default('') };
export const survivalConfig = z.strictObject({
  ...identityFields, duration: field.default('duration'), event: field.default('event'),
  showConfidence: z.boolean().default(true), showCensors: z.boolean().default(true),
  showRiskTable: z.boolean().default(true), showControls: z.boolean().default(true),
  selectedMonth: z.number().finite().min(0).max(120).default(12),
});
export const forestConfig = z.strictObject({
  id: field.default('id'), label: field.default('label'), estimate: field.default('estimate'),
  lower: field.default('lower'), upper: field.default('upper'), samples: field.default('samples'),
  showValues: z.boolean().default(true), showSampleCounts: z.boolean().default(true), ...selection,
});
export const responseConfig = z.strictObject({
  ...identityFields, value: field.default('response'), month: field.default('responseMonth'),
  threshold: z.number().finite().min(-100).max(1000).default(-30),
  showThreshold: z.boolean().default(true), sort: z.enum(['response', 'identity']).default('response'), ...selection,
});
export const completenessConfig = z.strictObject({
  ...identityFields, visitPrefix: field.default('visit'),
  pageSize: z.number().int().min(4).max(24).default(12), showControls: z.boolean().default(true), ...selection,
});
export const swimmerConfig = z.strictObject({
  ...identityFields, duration: field.default('duration'), event: field.default('event'),
  treatmentEnd: field.default('treatmentEnd'), visitPrefix: field.default('visit'),
  maxRows: z.number().int().min(1).max(16).default(8), showVisits: z.boolean().default(true),
  showValues: z.boolean().default(true), ...selection,
});
export const followupConfig = z.strictObject({
  ...identityFields, duration: field.default('duration'), event: field.default('event'),
  binWidthMonths: z.number().finite().min(.25).max(24).default(3),
  arrangement: z.enum(['stacked', 'grouped']).default('stacked'),
  measure: z.enum(['count', 'percent']).default('count'),
  showValues: z.boolean().default(true), showControls: z.boolean().default(true),
  ...selection,
});

type Cell = string | number | boolean | null;
function records(frame: RecordFrame, required: string[], types: Record<string, 'string' | 'number' | 'boolean'> = {}) {
  parseRecordFrame(frame);
  const keys = frame.columns.map(column => column.key);
  for (const key of required) {
    const column = frame.columns.find(value => value.key === key);
    if (!column) throw new Error(`Missing clinical field: ${key}`);
    if (types[key] && column.type !== types[key]) throw new Error(`Field ${key} must have type ${types[key]}.`);
  }
  return frame.rows.map(row => Object.fromEntries(keys.map((key, index) => [key, row[index]])) as Record<string, Cell>);
}
function text(value: Cell, name: string) { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} requires a nonempty identity.`); return value; }
function number(value: Cell, name: string) { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} requires a finite number.`); return value; }
function unique<T extends { id: string }>(rows: T[]) { if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Participant or estimate identities must be unique.'); return rows; }
function unit(frame: RecordFrame, key: string, accepted: string[]) { const declared = frame.columns.find(column => column.key === key)?.unit; if (declared && !accepted.includes(declared)) throw new Error(`Field ${key} has unit ${declared}; expected ${accepted.join(' or ')}. Convert the source explicitly.`); }

export interface SurvivalObservation { id: string; arm: string; duration: number; event: boolean }
export interface SurvivalStep { time: number; risk: number; events: number; censored: number; remaining: number; survival: number; lower: number; upper: number; greenwood: number }
export interface SurvivalCurve { arm: string; size: number; events: number; censored: number; steps: SurvivalStep[]; observations: SurvivalObservation[]; end: number; median: number | null }
export function survivalObservations(frame: RecordFrame, config = survivalConfig.parse({})): SurvivalObservation[] {
  unit(frame, config.duration, ['month', 'months']);
  const rows = unique(records(frame, [config.id, config.arm, config.duration, config.event], { [config.id]: 'string', [config.arm]: 'string', [config.duration]: 'number', [config.event]: 'boolean' }).map(row => {
    const duration = number(row[config.duration], 'Follow-up duration'), event = row[config.event];
    if (duration < 0 || duration > 120 || typeof event !== 'boolean') throw new Error('Survival observations require 0–120 months and an explicit event/censor flag.');
    return { id: text(row[config.id], 'Participant'), arm: text(row[config.arm], 'Arm'), duration, event };
  }));
  if (new Set(rows.map(row => row.arm)).size > 6) throw new Error('Compare at most six survival strata.');
  return rows;
}

/** Product-limit estimate for independent right-censored records. Tied events use the risk set before same-time censors.
 * Pointwise 95% Greenwood log-log intervals follow survival::survfit's usual transformed interval convention.
 * https://stat.ethz.ch/R-manual/R-devel/library/survival/html/survfit.formula.html
 * Left truncation, competing risks, weighting, and interval censoring are deliberately outside this adapter.
 */
export function kaplanMeier(observations: readonly SurvivalObservation[]): SurvivalCurve[] {
  unique([...observations]);
  if (observations.some(row => !Number.isFinite(row.duration) || row.duration < 0 || typeof row.event !== 'boolean' || !row.arm)) throw new Error('Invalid survival observation.');
  return [...new Set(observations.map(row => row.arm))].sort().map(arm => {
    const rows = observations.filter(row => row.arm === arm).sort((a, b) => a.duration - b.duration || a.id.localeCompare(b.id));
    const times = [...new Set(rows.map(row => row.duration))];
    let risk = rows.length, survival = 1, greenwood = 0;
    const steps: SurvivalStep[] = [{ time: 0, risk, events: 0, censored: 0, remaining: risk, survival: 1, lower: 1, upper: 1, greenwood: 0 }];
    for (const time of times) {
      const same = rows.filter(row => row.duration === time), events = same.filter(row => row.event).length, censored = same.length - events;
      survival *= 1 - events / risk;
      if (events && events < risk) greenwood += events / (risk * (risk - events));
      const error = survival > 0 && survival < 1 ? Math.sqrt(greenwood) / Math.abs(Math.log(survival)) : 0;
      const transformed = survival > 0 && survival < 1 ? Math.log(-Math.log(survival)) : 0;
      const lower = survival === 0 || survival === 1 ? survival : Math.exp(-Math.exp(transformed + 1.959963984540054 * error));
      const upper = survival === 0 || survival === 1 ? survival : Math.exp(-Math.exp(transformed - 1.959963984540054 * error));
      steps.push({ time, risk, events, censored, remaining: risk - events - censored, survival, lower, upper, greenwood });
      risk -= events + censored;
    }
    return { arm, size: rows.length, events: rows.filter(row => row.event).length, censored: rows.filter(row => !row.event).length, steps, observations: rows, end: rows.at(-1)?.duration ?? 0, median: steps.find(step => step.survival <= .5)?.time ?? null };
  });
}
/** Risk counts are immediately before events/censors at the requested instant. Beyond follow-up, the estimate is unavailable. */
export function survivalAt(curve: SurvivalCurve, time: number) {
  if (!Number.isFinite(time) || time < 0) throw new Error('Inspection month must be finite and nonnegative.');
  const step = [...curve.steps].reverse().find(value => value.time <= time) ?? curve.steps[0];
  return { ...step, time, risk: curve.observations.filter(row => row.duration >= time).length, available: time <= curve.end };
}

export interface FollowupBin {
  id: string; start: number; end: number; upperInclusive: boolean;
  events: number; censored: number; count: number; participants: string[];
  arms: { arm: string; events: number; censored: number; count: number }[];
}
export interface FollowupDistribution {
  bins: FollowupBin[]; population: number; events: number; censored: number;
  maxDuration: number; binWidthMonths: number;
}
/** One participant contributes once, at the end of observed follow-up.
 * Intervals are [start,end), except the last interval includes its right edge.
 * Censor counts are recorded observation endpoints, not imputed future events.
 */
export function followupDistribution(observations: readonly SurvivalObservation[], binWidthMonths = 3): FollowupDistribution {
  if (!Number.isFinite(binWidthMonths) || binWidthMonths < .25 || binWidthMonths > 24) throw new Error('Follow-up interval width must be 0.25–24 months.');
  unique([...observations]);
  if (observations.some(row => !row.id.trim() || !row.arm.trim() || !Number.isFinite(row.duration) || row.duration < 0 || row.duration > 120 || typeof row.event !== 'boolean')) throw new Error('Follow-up requires unique participants, explicit event/censor flags, and durations of 0–120 months.');
  const maxDuration = Math.max(0, ...observations.map(row => row.duration));
  const binCount = observations.length ? Math.max(1, Math.ceil(maxDuration / binWidthMonths)) : 0;
  if (binCount > 64) throw new Error(`Follow-up interval width creates ${binCount} bins. Increase binWidthMonths to at least ${Math.ceil(maxDuration / 64 * 1000) / 1000} months to keep at most 64 bins.`);
  const arms = [...new Set(observations.map(row => row.arm))].sort();
  const bins: FollowupBin[] = Array.from({ length: binCount }, (_, index) => {
    const start = index * binWidthMonths, end = (index + 1) * binWidthMonths;
    return { id: `followup:${start}:${end}`, start, end, upperInclusive: index === binCount - 1, events: 0, censored: 0, count: 0, participants: [], arms: arms.map(arm => ({ arm, events: 0, censored: 0, count: 0 })) };
  });
  for (const observation of observations) {
    const bin = bins.find(bin => observation.duration < bin.end || bin.upperInclusive)!, arm = bin.arms.find(row => row.arm === observation.arm)!;
    bin.count++; arm.count++; bin.participants.push(observation.id);
    if (observation.event) { bin.events++; arm.events++; } else { bin.censored++; arm.censored++; }
  }
  bins.forEach(bin => bin.participants.sort());
  const events = observations.filter(row => row.event).length;
  return { bins, population: observations.length, events, censored: observations.length - events, maxDuration, binWidthMonths };
}
export function followupFromRecords(frame: RecordFrame, config = followupConfig.parse({})): FollowupDistribution {
  const observations = survivalObservations(frame, survivalConfig.parse({ id: config.id, arm: config.arm, duration: config.duration, event: config.event }));
  return followupDistribution(observations, config.binWidthMonths);
}

export interface HazardEstimate { id: string; label: string; estimate: number; lower: number; upper: number; samples: number }
export function hazardEstimates(frame: RecordFrame, config = forestConfig.parse({})): HazardEstimate[] {
  for (const key of [config.estimate, config.lower, config.upper]) unit(frame, key, ['ratio', '1']);
  return unique(records(frame, [config.id, config.label, config.estimate, config.lower, config.upper, config.samples], { [config.id]: 'string', [config.label]: 'string', [config.estimate]: 'number', [config.lower]: 'number', [config.upper]: 'number', [config.samples]: 'number' }).map(row => {
    const estimate = number(row[config.estimate], 'Hazard ratio'), lower = number(row[config.lower], 'Lower interval'), upper = number(row[config.upper], 'Upper interval'), samples = number(row[config.samples], 'Sample count');
    if (lower <= 0 || lower > estimate || estimate > upper || !Number.isInteger(samples) || samples < 1) throw new Error('Hazard ratios require positive ordered bounds and a positive integer population.');
    return { id: text(row[config.id], 'Estimate'), label: text(row[config.label], 'Subgroup'), estimate, lower, upper, samples };
  }));
}

export interface ResponseObservation { id: string; arm: string; value: number | null; month: number | null }
export function responseObservations(frame: RecordFrame, config = responseConfig.parse({})): ResponseObservation[] {
  unit(frame, config.value, ['%', 'percent']); unit(frame, config.month, ['month', 'months']);
  const rows = unique(records(frame, [config.id, config.arm, config.value, config.month], { [config.id]: 'string', [config.arm]: 'string', [config.value]: 'number', [config.month]: 'number' }).map(row => {
    const value = row[config.value] === null ? null : number(row[config.value], 'Response'), month = row[config.month] === null ? null : number(row[config.month], 'Assessment month');
    if ((value === null) !== (month === null) || value !== null && value < -100 || month !== null && month < 0) throw new Error('Response observations require paired value/time, change ≥ −100%, or an explicit missing pair.');
    return { id: text(row[config.id], 'Participant'), arm: text(row[config.arm], 'Arm'), value, month };
  }));
  return rows.sort((a, b) => config.sort === 'identity' ? a.id.localeCompare(b.id) : (b.value ?? -Infinity) - (a.value ?? -Infinity) || a.id.localeCompare(b.id));
}

export const CLINICAL_VISITS = [0, 1.5, 3, 6, 9, 12, 18] as const;
export const VISIT_LABELS = ['Baseline', 'M1.5', 'M3', 'M6', 'M9', 'M12', 'M18'] as const;
export type VisitState = 'observed' | 'missing' | 'post-event' | 'after-censor';
export interface VisitParticipant { id: string; arm: string; visits: VisitState[] }
export function visitParticipants(frame: RecordFrame, config = completenessConfig.parse({})): VisitParticipant[] {
  const fields = CLINICAL_VISITS.map((_, index) => `${config.visitPrefix}${index}`);
  return unique(records(frame, [config.id, config.arm, ...fields], { [config.id]: 'string', [config.arm]: 'string', ...Object.fromEntries(fields.map(key => [key, 'string' as const])) }).map(row => {
    const visits = fields.map(field => { const state = row[field]; if (!['observed', 'missing', 'post-event', 'after-censor'].includes(String(state))) throw new Error('Visits require explicit observed, missing, post-event, or after-censor state.'); return state as VisitState; });
    return { id: text(row[config.id], 'Participant'), arm: text(row[config.arm], 'Arm'), visits };
  }));
}
export interface SwimmerObservation extends SurvivalObservation, VisitParticipant { treatmentEnd: number }
export function swimmerObservations(frame: RecordFrame, config = swimmerConfig.parse({})): SwimmerObservation[] {
  unit(frame, config.treatmentEnd, ['month', 'months']);
  const survival = survivalObservations(frame, survivalConfig.parse({ id: config.id, arm: config.arm, duration: config.duration, event: config.event }));
  const visits = visitParticipants(frame, completenessConfig.parse({ id: config.id, arm: config.arm, visitPrefix: config.visitPrefix }));
  const treatment = records(frame, [config.id, config.treatmentEnd], { [config.treatmentEnd]: 'number' });
  return survival.map((row, index) => {
    const treatmentEnd = number(treatment[index][config.treatmentEnd], 'Treatment end');
    if (treatmentEnd < 0 || treatmentEnd > row.duration) throw new Error('Treatment interval must stay within observed follow-up.');
    const visit = visits[index];
    if (visit.visits.some((state, index) => CLINICAL_VISITS[index] > row.duration && (state === 'observed' || state === 'missing'))) throw new Error('A visit after the event/censor endpoint cannot be reported as observed or missed follow-up.');
    return { ...row, ...visit, treatmentEnd };
  });
}
