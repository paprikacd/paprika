import type { WidgetConfigField } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { getWidgetDefinition, registerWidgetPlugin } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { HazardForest, ParticipantSwimmer, ResponseWaterfall, SurvivalKM, VisitCompleteness } from './ClinicalCharts';
import { FollowupDistribution } from './FollowupDistribution';
import { completenessConfig, followupConfig, followupFromRecords, forestConfig, hazardEstimates, responseConfig, responseObservations, survivalConfig, survivalObservations, swimmerConfig, swimmerObservations, visitParticipants } from './model';
const identityFields: WidgetConfigField[] = [
  { key: 'id', label: 'Participant identity field', kind: 'text', binding: { types: ['string'], role: 'Unique, stable participant identity' } },
  { key: 'arm', label: 'Study arm field', kind: 'text', binding: { types: ['string'], role: 'Study arm or survival stratum' } },
];
const endpointFields: WidgetConfigField[] = [
  { key: 'duration', label: 'Follow-up duration field', kind: 'text', binding: { types: ['number'], unit: 'months', acceptedUnits: ['months', 'month'], role: 'Elapsed months to the observed endpoint or last contact' } },
  { key: 'event', label: 'Observed event field', kind: 'text', binding: { types: ['boolean'], role: 'True means an observed endpoint; false means right-censored' } },
];
export function registerClinicalCharts() {
  if (!getWidgetDefinition('plugin', 'survival-km')) registerWidgetPlugin({
    id: 'survival-km', label: 'Kaplan–Meier survival', description: 'Right-censored endpoint records produce step estimates, censor marks, 95% Greenwood log–log intervals and aligned risk counts.', dataKind: 'records', render: SurvivalKM,
    layout: { mode: 'intrinsic', minWidth: 280, minHeight: 340 },
    defaultConfig: survivalConfig.parse({}), parseConfig: config => survivalConfig.parse(config ?? {}),
    validateInput: (result, config) => { if (!result.records) throw new Error('Survival requires endpoint records.'); survivalObservations(result.records, survivalConfig.parse(config ?? {})); },
    styleControls: ['grid', 'legend', 'tooltips'], configFields: [...identityFields, ...endpointFields, { key: 'showConfidence', label: 'Show 95% confidence bands', kind: 'boolean' }, { key: 'showCensors', label: 'Show censor marks', kind: 'boolean' }, { key: 'showRiskTable', label: 'Show aligned at-risk table', kind: 'boolean' }, { key: 'showControls', label: 'Show exact month controls', kind: 'boolean' }],
  });
  if (!getWidgetDefinition('plugin', 'hazard-forest')) registerWidgetPlugin({
    id: 'hazard-forest', label: 'Hazard-ratio forest plot', description: 'Supplied positive estimates and ordered intervals share a logarithmic ratio axis and a reference at one.', dataKind: 'records', render: HazardForest,
    layout: { mode: 'intrinsic', minWidth: 280, minHeight: 300 }, defaultConfig: forestConfig.parse({}), parseConfig: config => forestConfig.parse(config ?? {}),
    validateInput: (result, config) => { if (!result.records) throw new Error('Forest plots require estimate records.'); hazardEstimates(result.records, forestConfig.parse(config ?? {})); },
    styleControls: ['tooltips'], configFields: [
      { key: 'id', label: 'Subgroup identity field', kind: 'text', binding: { types: ['string'], role: 'Unique, stable subgroup identity' } },
      { key: 'label', label: 'Subgroup label field', kind: 'text', binding: { types: ['string'], role: 'Readable subgroup name' } },
      { key: 'estimate', label: 'Hazard ratio field', kind: 'text', binding: { types: ['number'], unit: 'ratio', acceptedUnits: ['ratio', '1'], role: 'Positive supplied hazard-ratio estimate' } },
      { key: 'lower', label: 'Lower interval field', kind: 'text', binding: { types: ['number'], unit: 'ratio', acceptedUnits: ['ratio', '1'], role: 'Positive lower 95% interval bound' } },
      { key: 'upper', label: 'Upper interval field', kind: 'text', binding: { types: ['number'], unit: 'ratio', acceptedUnits: ['ratio', '1'], role: 'Positive upper 95% interval bound' } },
      { key: 'samples', label: 'Participant count field', kind: 'text', binding: { types: ['number'], role: 'Positive integer subgroup sample population' } },
      { key: 'showValues', label: 'Show exact ratio and interval column', kind: 'boolean' }, { key: 'showSampleCounts', label: 'Show subgroup sample counts', kind: 'boolean' },
    ],
  });
  if (!getWidgetDefinition('plugin', 'response-waterfall')) registerWidgetPlugin({
    id: 'response-waterfall', label: 'Participant response waterfall', description: 'Baseline-relative observed changes remain distinct from missing assessments, with exact participant identity and assessment month.', dataKind: 'records', render: ResponseWaterfall,
    layout: { mode: 'intrinsic', minWidth: 280, minHeight: 220 }, defaultConfig: responseConfig.parse({}), parseConfig: config => responseConfig.parse(config ?? {}),
    validateInput: (result, config) => { if (!result.records) throw new Error('Response plots require participant records.'); responseObservations(result.records, responseConfig.parse(config ?? {})); },
    styleControls: ['grid', 'legend', 'tooltips'], configFields: [...identityFields, { key: 'value', label: 'Response change field', kind: 'text', binding: { types: ['number'], unit: '%', acceptedUnits: ['%', 'percent'], role: 'Baseline-relative change; null means unassessed' } }, { key: 'month', label: 'Assessment month field', kind: 'text', binding: { types: ['number'], unit: 'months', acceptedUnits: ['months', 'month'], role: 'Elapsed assessment time, paired with the response value' } }, { key: 'showThreshold', label: 'Show protocol threshold', kind: 'boolean' }, { key: 'threshold', label: 'Protocol threshold (%)', kind: 'number', min: -100, max: 1000, step: 1 }, { key: 'sort', label: 'Participant ordering', kind: 'select', options: [{ value: 'response', label: 'Observed response' }, { value: 'identity', label: 'Participant identity' }] }],
  });
  if (!getWidgetDefinition('plugin', 'visit-completeness')) registerWidgetPlugin({
    id: 'visit-completeness', label: 'Follow-up completeness', description: 'Scheduled visits distinguish observed, missing, post-event and after-censor states without inventing outcomes.', dataKind: 'records', render: VisitCompleteness,
    layout: { mode: 'intrinsic', minWidth: 280, minHeight: 220 }, defaultConfig: completenessConfig.parse({}), parseConfig: config => completenessConfig.parse(config ?? {}),
    validateInput: (result, config) => { if (!result.records) throw new Error('Completeness matrices require visit records.'); visitParticipants(result.records, completenessConfig.parse(config ?? {})); },
    styleControls: ['legend', 'tooltips'], configFields: [...identityFields, { key: 'visitPrefix', label: 'Visit column prefix (0–6)', kind: 'text' }, { key: 'pageSize', label: 'Visible participants per page', kind: 'number', min: 4, max: 24, step: 1 }, { key: 'showControls', label: 'Show page controls', kind: 'boolean' }],
  });
  if (!getWidgetDefinition('plugin', 'participant-swimmer')) registerWidgetPlugin({
    id: 'participant-swimmer', label: 'Participant follow-up timeline', description: 'Observed treatment duration, scheduled visits and event or censor endpoints share one elapsed-month axis.', dataKind: 'records', render: ParticipantSwimmer,
    layout: { mode: 'intrinsic', minWidth: 280, minHeight: 220 }, defaultConfig: swimmerConfig.parse({}), parseConfig: config => swimmerConfig.parse(config ?? {}),
    validateInput: (result, config) => { if (!result.records) throw new Error('Follow-up timelines require participant records.'); swimmerObservations(result.records, swimmerConfig.parse(config ?? {})); },
    styleControls: ['legend', 'tooltips'], configFields: [...identityFields, ...endpointFields, { key: 'treatmentEnd', label: 'Treatment end field', kind: 'text', binding: { types: ['number'], unit: 'months', acceptedUnits: ['months', 'month'], role: 'Elapsed treatment end, within observed follow-up' } }, { key: 'visitPrefix', label: 'Visit column prefix (0–6)', kind: 'text' }, { key: 'maxRows', label: 'Maximum visible histories', kind: 'number', min: 1, max: 16, step: 1 }, { key: 'showVisits', label: 'Show observed and missed visit marks', kind: 'boolean' }, { key: 'showValues', label: 'Show exact follow-up durations', kind: 'boolean' }],
  });
  if (!getWidgetDefinition('plugin', 'followup-distribution')) registerWidgetPlugin({
    id: 'followup-distribution', label: 'Follow-up endpoint distribution', description: 'Observed event and censor times form disjoint duration bins, with exact cohort denominators and per-arm counts.', dataKind: 'records', render: FollowupDistribution,
    layout: { mode: 'intrinsic', minWidth: 280, minHeight: 330 }, defaultConfig: followupConfig.parse({}), parseConfig: config => followupConfig.parse(config ?? {}),
    validateInput: (result, config) => { if (!result.records) throw new Error('Follow-up distributions require endpoint records.'); followupFromRecords(result.records, followupConfig.parse(config ?? {})); },
    styleControls: ['grid', 'legend', 'tooltips'], configFields: [...identityFields, ...endpointFields,
      { key: 'binWidthMonths', label: 'Interval width (months)', kind: 'number', min: .25, max: 24, step: .25, help: 'Equal-width duration intervals; at most 64 bins. The final bin includes its right boundary.' },
      { key: 'arrangement', label: 'Endpoint arrangement', kind: 'select', options: [{ value: 'stacked', label: 'Stacked counts' }, { value: 'grouped', label: 'Side-by-side counts' }] },
      { key: 'measure', label: 'Vertical measure', kind: 'select', options: [{ value: 'count', label: 'Participant count' }, { value: 'percent', label: 'Percent of entire selected cohort' }] },
      { key: 'showValues', label: 'Show values above bins', kind: 'boolean' }, { key: 'showControls', label: 'Show interval inspection control', kind: 'boolean' },
    ],
  });
}
