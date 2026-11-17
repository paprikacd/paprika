import { useEffect, useMemo, useState } from 'react';
import { DomainChartPanel, DomainHeader, MetricStrip } from '../../components/lab/DomainPrimitives';
import { registerClinicalCharts } from '../../charts/clinical/register';
import type { DrilldownContext } from '@insights/drilldown';
import type { EditLensWidget } from '../LensStudio';
import { buildTrialEvidence, CLINICAL_POPULATIONS, type ClinicalPopulation } from './fixtures';
import './clinical-lens.css';

registerClinicalCharts();
export function TrialEvidenceLens({ onEdit }: { onEdit?: EditLensWidget }) {
  const [population, setPopulation] = useState<ClinicalPopulation>('all'), [gaps, setGaps] = useState(true);
  const [participant, setParticipant] = useState('P-017'), [month, setMonth] = useState(12);
  const data = useMemo(() => buildTrialEvidence(population, gaps), [population, gaps]);
  useEffect(() => { if (!data.participants.some(row => row.id === participant)) setParticipant(data.participants[0]?.id ?? ''); }, [data.participants, participant]);
  const chosen = data.participants.find(row => row.id === participant) ?? data.participants[0];
  const selectParticipant = (context: DrilldownContext) => { const id = context.labels?.participant; if (id && data.participants.some(row => row.id === id)) setParticipant(id); };
  const selectPopulation = (context: DrilldownContext) => { const id = context.labels?.population; if (CLINICAL_POPULATIONS.some(row => row.id === id)) setPopulation(id as ClinicalPopulation); };
  return <div className="domain-lens clinical-lens">
    <DomainHeader title="Trial Evidence" eyebrow="PAPRIKA / RESEARCH">
      <span>Protocol <b>P-204</b></span>
      <label>Population <select aria-label="Trial population" value={population} onChange={event => setPopulation(event.target.value as ClinicalPopulation)}>{CLINICAL_POPULATIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
      <label>Participant <select aria-label="Trial participant" value={chosen?.id ?? ''} onChange={event => setParticipant(event.target.value)}>{data.participants.map(row => <option key={row.id} value={row.id}>{row.id} · {row.arm}</option>)}</select></label>
      <label>Coverage <select aria-label="Trial visit coverage" value={gaps ? 'gaps' : 'complete'} onChange={event => setGaps(event.target.value === 'gaps')}><option value="gaps">Missed visits</option><option value="complete">Complete visits</option></select></label>
      <label>Inspect month <input aria-label="Trial inspection month" type="number" min={0} max={18} step={.25} value={month} onChange={event => { const value = Number(event.target.value); if (Number.isFinite(value)) setMonth(Math.min(18, Math.max(0, value))); }}/></label>
      <button onClick={() => { setPopulation('all'); setParticipant('P-017'); setMonth(12); }}>Reset selection</button>
    </DomainHeader>
    <MetricStrip items={[
      { label: 'Participants', value: data.summary.size, detail: `${data.curves.map(curve => `${curve.arm}: ${curve.size}`).join(' · ')}` },
      { label: 'Observed endpoints', value: data.summary.events, detail: 'Events within recorded follow-up', tone: 'violet' },
      { label: 'Right-censored', value: data.summary.censored, detail: 'Event-free through last observation' },
      { label: 'Response assessments', value: data.summary.responses, detail: 'Month 6 · synthetic assessment subset' },
    ]}/>
    <div className="clinical-lens-grid">
      <DomainChartPanel panel={data.survival} className="clinical-lens-survival" onEdit={onEdit} selection={{ selectedMonth: month }} onContextChange={context => { const value = Number(context.labels?.month); if (Number.isFinite(value)) setMonth(value); }}/>
      <DomainChartPanel panel={data.forest} className="clinical-lens-forest" onEdit={onEdit} selection={{ selectedId: population }} onContextChange={selectPopulation}/>
      <DomainChartPanel panel={data.response} className="clinical-lens-response" onEdit={onEdit} selection={{ selectedId: chosen?.id ?? '' }} onContextChange={selectParticipant}/>
      <DomainChartPanel panel={data.followup} className="clinical-lens-followup" onEdit={onEdit} selection={{ selectedId: chosen?.id ?? '' }}/>
      <DomainChartPanel panel={data.completeness} className="clinical-lens-completeness" onEdit={onEdit} selection={{ selectedId: chosen?.id ?? '' }} onContextChange={selectParticipant}/>
      <DomainChartPanel panel={data.swimmer} className="clinical-lens-participant" onEdit={onEdit} selection={{ selectedId: chosen?.id ?? '' }} onContextChange={selectParticipant}/>
    </div>
    {chosen && <div className="clinical-selection-footer"><span><i/>Selected <strong>{chosen.id} · {chosen.arm}</strong></span><span>Observed change <b>{chosen.response === null ? 'Not assessed' : `${chosen.response > 0 ? '+' : ''}${chosen.response}% at month ${chosen.responseMonth}`}</b></span><span>Age {chosen.age} · marker {chosen.marker.toLowerCase()}</span><span>Follow-up {chosen.duration} months · {chosen.event ? 'observed endpoint' : 'right-censored'}</span></div>}
    <footer className="clinical-lens-footer">Synthetic research cohort · right-censored endpoints · elapsed months · population selection changes the underlying cohort and all its risk counts.</footer>
  </div>;
}
