import type { QueryResult, RecordFrame, Widget } from '../../renderer-extensions/schema';
import { CLINICAL_VISITS, kaplanMeier, survivalObservations, type VisitState } from '../../charts/clinical/model';

export type ClinicalPopulation = 'all' | 'younger' | 'older' | 'marker-high' | 'marker-low' | 'prior';
export const CLINICAL_POPULATIONS: { id: ClinicalPopulation; label: string }[] = [
  { id: 'all', label: 'All randomised participants' }, { id: 'younger', label: 'Age <65' },
  { id: 'older', label: 'Age ≥65' }, { id: 'marker-high', label: 'Marker high' },
  { id: 'marker-low', label: 'Marker low' }, { id: 'prior', label: 'Prior therapy' },
];
export type ClinicalPanel = { widget: Widget; result: QueryResult; caption: string };
export interface TrialParticipant {
  id: string; arm: string; duration: number; event: boolean; treatmentEnd: number;
  response: number | null; responseMonth: number | null; age: number; marker: string;
  prior: boolean; visits: VisitState[];
}
const random = (index: number, salt: number) => {
  let state = Math.imul(index + 31, 1664525) + Math.imul(salt + 17, 1013904223);
  state ^= state >>> 16; state = Math.imul(state, 0x45d9f3b); state ^= state >>> 16;
  return ((state >>> 0) + .5) / 4294967296;
};
export function clinicalParticipants(gaps = false): TrialParticipant[] {
  return Array.from({ length: 480 }, (_, index) => {
    const id = `P-${String(index + 1).padStart(3, '0')}`, arm = index % 2 === 0 ? 'Arm A' : 'Arm B';
    const admin = random(index, 2) < .67 ? 18 : Math.round((7 + 11 * random(index, 3)) * 4) / 4;
    const eventMonth = Math.max(.25, Math.round((-Math.log(1 - random(index, 5)) / (arm === 'Arm A' ? .020 : .034)) * 4) / 4);
    let duration = Math.min(admin, eventMonth), event = eventMonth <= admin;
    if (id === 'P-017') { duration = 17.5; event = false; }
    const assessed = index < 90 && duration >= 6 && !(gaps && index % 13 === 0);
    const response = id === 'P-017' ? -46 : assessed ? Number(Math.max(-93, 33 - 112 * random(index, 9) + (arm === 'Arm B' ? 9 : 0)).toFixed(1)) : null;
    const visits = CLINICAL_VISITS.map((month, visit): VisitState => month > duration ? event ? 'post-event' : 'after-censor' : gaps && visit > 0 && (index + visit * 3) % 11 === 0 ? 'missing' : 'observed');
    if (response !== null) visits[3] = 'observed';
    return { id, arm, duration, event, treatmentEnd: Math.min(duration, id === 'P-017' ? 8.5 : 6 + random(index, 6) * 3), response, responseMonth: response === null ? null : 6, age: index % 12 < 7 ? 38 + index % 27 : 65 + index % 20, marker: index % 24 < 11 ? 'High' : 'Low', prior: index % 4 === 0, visits };
  });
}
export function inClinicalPopulation(patient: TrialParticipant, population: ClinicalPopulation) {
  return population === 'all' || population === 'younger' && patient.age < 65 || population === 'older' && patient.age >= 65 || population === 'marker-high' && patient.marker === 'High' || population === 'marker-low' && patient.marker === 'Low' || population === 'prior' && patient.prior;
}
export function clinicalFrame(patients: readonly TrialParticipant[]): RecordFrame {
  return {
    columns: [
      { key: 'id', label: 'Participant', type: 'string' }, { key: 'arm', label: 'Study arm', type: 'string' },
      { key: 'duration', label: 'Observed follow-up', type: 'number', unit: 'months' }, { key: 'event', label: 'Endpoint observed', type: 'boolean' },
      { key: 'treatmentEnd', label: 'Treatment ended', type: 'number', unit: 'months' },
      { key: 'response', label: 'Change from baseline', type: 'number', unit: '%' }, { key: 'responseMonth', label: 'Response assessment', type: 'number', unit: 'months' },
      { key: 'age', type: 'number', unit: 'years' }, { key: 'marker', type: 'string' }, { key: 'prior', type: 'boolean' },
      ...CLINICAL_VISITS.map((month, index) => ({ key: `visit${index}`, label: `Visit month ${month}`, type: 'string' as const })),
    ],
    rows: patients.map(patient => [patient.id, patient.arm, patient.duration, patient.event, Number(patient.treatmentEnd.toFixed(2)), patient.response, patient.responseMonth, patient.age, patient.marker, patient.prior, ...patient.visits]),
  };
}
export function clinicalPanel(id: string, title: string, records: RecordFrame, config: Widget['config'] = {}, caption = ''): ClinicalPanel {
  return {
    widget: { id: `clinical-${id}`, title, type: 'plugin', pluginId: id, dataKind: 'records', providerId: 'synthetic-clinical', query: `fixture.${id}`, unit: '', layout: { x: 0, y: 0, w: 6, h: 6 }, options: { showTooltip: true, showLegend: true, showGrid: true, decimals: 2 }, config },
    result: { records }, caption,
  };
}
export function buildTrialEvidence(population: ClinicalPopulation = 'all', gaps = true) {
  const allParticipants = clinicalParticipants(gaps), participants = allParticipants.filter(patient => inClinicalPopulation(patient, population)), frame = clinicalFrame(participants);
  const ratios = [[.68, .52, .88], [.62, .43, .89], [.78, .51, 1.18], [.54, .36, .82], [.88, .61, 1.28], [1.12, .71, 1.78]];
  const hazardFrame: RecordFrame = {
    columns: [{ key: 'id', type: 'string' }, { key: 'label', type: 'string' }, { key: 'estimate', type: 'number', unit: 'ratio' }, { key: 'lower', type: 'number', unit: 'ratio' }, { key: 'upper', type: 'number', unit: 'ratio' }, { key: 'samples', type: 'number' }],
    rows: CLINICAL_POPULATIONS.map((group, index) => [group.id, index === 0 ? 'Overall' : group.label, ...ratios[index], allParticipants.filter(patient => inClinicalPopulation(patient, group.id)).length]),
  };
  const curves = kaplanMeier(survivalObservations(frame));
  return {
    participants, allParticipants, curves,
    summary: { size: participants.length, events: participants.filter(patient => patient.event).length, censored: participants.filter(patient => !patient.event).length, responses: participants.filter(patient => patient.response !== null).length, missingVisits: participants.reduce((total, patient) => total + patient.visits.filter(visit => visit === 'missing').length, 0) },
    survival: clinicalPanel('survival-km', 'Event-free survival', frame, { showControls: false, selectedMonth: 12 }, 'Right-censored participant records · Kaplan–Meier steps and pointwise 95% Greenwood log–log intervals. Risk counts are immediately before each labelled instant. No extrapolation beyond the observed follow-up.'),
    followup: clinicalPanel('followup-distribution', 'Observed follow-up distribution', frame, { binWidthMonths: 3, showControls: true, selectedId: 'P-017' }, 'Every participant appears once at their recorded event or censor month. Equal-width intervals use the full selected cohort as denominator; a right-censored endpoint marks the end of observation. The selected participant is located at their exact follow-up time.'),
    forest: clinicalPanel('hazard-forest', 'Subgroup effects · exploratory', hazardFrame, { selectedId: population }, 'Supplied synthetic model estimates, not calculated from the displayed endpoint fixture. Log hazard-ratio axis; intervals cross 1 where compatible with either direction. Select a subgroup to inspect its participant population.'),
    response: clinicalPanel('response-waterfall', 'Participant response · month 6', frame, {}, 'Available month-6 assessments in an explicitly selected synthetic assessment subset. Missing and unassessed participants are counted separately from measured zero. The −30% rule is a fixture protocol threshold, not a clinical recommendation.'),
    completeness: clinicalPanel('visit-completeness', 'Follow-up completeness', frame, { pageSize: 12 }, 'Observed, missed, post-event and after-censor visits remain distinct. Select a participant to link their response and observed history; use page controls to inspect the complete cohort.'),
    swimmer: clinicalPanel('participant-swimmer', 'Selected participant', frame, { maxRows: 1, selectedId: 'P-017' }, 'Participant-level observed treatment and visits. A terminal cross is censoring, a triangle is an observed endpoint. Population survival is never assigned to an individual.'),
  };
}
