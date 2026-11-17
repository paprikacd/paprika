import { useMemo, useState } from 'react';
import { Clock3, Satellite } from 'lucide-react';
import { DomainChartPanel, DomainHeader, MetricStrip } from '../../components/lab/DomainPrimitives';
import { Panel } from '../../components/lab/StudyPrimitives';
import type { DrilldownContext } from '@insights/drilldown';
import type { EditLensWidget } from '../LensStudio';
import { registerOrbitalCharts } from '../../charts/orbital/register';
import { orbitalDuration, orbitalUtc } from '../../charts/orbital/model';
import { orbitalFixtures } from './fixtures';
import './orbital-lens.css';

registerOrbitalCharts();

export function OrbitalContactLens({ onEdit }: { onEdit?: EditLensWidget }) {
  const [gaps, setGaps] = useState(false), [selectedPass, setSelectedPass] = useState('pass-01'), [selectedTimestamp, setSelectedTimestamp] = useState<number | undefined>(undefined);
  const data = useMemo(() => {
    const fixtures = orbitalFixtures('pass-01', gaps);
    // Lens-level contact selection is shared; the editor may still enable a local picker.
    for (const panel of [fixtures.map, fixtures.skyplot, fixtures.timeline, fixtures.profile]) panel.widget.config = { ...panel.widget.config, showPassPicker: false };
    fixtures.timeline.widget.config = { ...fixtures.timeline.widget.config, showSignals: false };
    return fixtures;
  }, [gaps]), active = data.passes.find(p => p.id === selectedPass);
  const select = (id: string, time?: number) => { setSelectedPass(id); setSelectedTimestamp(time); };
  const context = (value: DrilldownContext) => { if (value.labels?.passId !== undefined) select(value.labels.passId, value.labels.timestamp ? Number(value.labels.timestamp) : undefined); };
  const selection = { selectedPass, ...(selectedTimestamp === undefined ? {} : { selectedTimestamp }) };
  const totalVolume = data.passes.every(p => p.volumeMB !== null) ? data.passes.reduce((sum, p) => sum + p.volumeMB!, 0) : null;
  return <main className="domain-lens orbital-lens" data-domain-lens="orbital-contact">
    <DomainHeader title="Orbital contact" eyebrow="PAPRIKA / MISSION CONTROL">
      <span><Satellite size={14}/>Aster-12</span>
      <label>Contact<select aria-label="Linked orbital contact" value={selectedPass} onChange={event => select(event.target.value)}><option value="">Choose a pass</option>{data.passes.map(p => <option key={p.id} value={p.id}>{p.satellite} / {p.station} · {orbitalUtc(p.start)}</option>)}</select></label>
      <label>Fixture<select aria-label="Orbital fixture state" value={gaps ? 'gaps' : 'ready'} onChange={event => { setGaps(event.target.value === 'gaps'); setSelectedTimestamp(undefined); }}><option value="ready">Complete predictions</option><option value="gaps">Signal coverage gap</option></select></label>
      <span><Clock3 size={14}/>31 Oct · 11:00–14:00 UTC</span>
      {selectedPass && <button onClick={() => select('')}>Clear selection</button>}
    </DomainHeader>
    <MetricStrip items={[
      { label: 'Upcoming passes', value: data.passes.length, detail: 'Synthetic predicted access intervals' },
      { label: 'Selected acquisition', value: active ? `${orbitalUtc(active.start)} UTC` : '—', detail: active ? `${active.satellite} / ${active.station}` : 'Choose a contact' },
      { label: 'Peak elevation', value: active ? `${active.peak.toFixed(0)}°` : '—', detail: 'Selected station-relative pass', tone: 'violet' },
      { label: 'Minimum link margin', value: active?.minMargin !== null && active?.minMargin !== undefined ? `${active.minMargin.toFixed(1)} dB` : '—', detail: active?.coverage === 1 ? 'Complete predicted contact' : active ? 'Known samples only · incomplete coverage' : 'No selected pass', tone: active?.minMargin !== null && active?.minMargin !== undefined && active.minMargin < 3 ? 'amber' : 'cyan' },
    ]}/>
    <div className="orbital-primary-grid"><DomainChartPanel panel={data.map} onEdit={onEdit} selection={selection} onContextChange={context}/><DomainChartPanel panel={data.skyplot} onEdit={onEdit} selection={selection} onContextChange={context}/></div>
    <div className="orbital-secondary-grid"><DomainChartPanel panel={data.profile} onEdit={onEdit} selection={selection} onContextChange={context}/><DomainChartPanel panel={data.budget} onEdit={onEdit} selection={{ selectedPass }}/></div>
    <div className="orbital-schedule-row"><DomainChartPanel panel={data.timeline} onEdit={onEdit} selection={selection} onContextChange={context}/></div>
    <Panel title="Pass queue" className="domain-panel" subtitle="Select one contact to link its ground track, station skyplot, time window and relative margin budget. Predicted volume integrates the supplied Mbps samples over real elapsed seconds.">
      <div className="domain-table-scroll"><table className="domain-table orbital-pass-table"><thead><tr><th>Satellite</th><th>Station</th><th>Acquisition · UTC</th><th>Duration</th><th>Peak elevation</th><th>Min margin</th><th>Predicted volume</th><th>Coverage</th><th>State</th></tr></thead><tbody>{data.passes.map(p => <tr key={p.id} data-selected={selectedPass === p.id}><td><button aria-pressed={selectedPass === p.id} onClick={() => select(p.id)}>{p.satellite}</button></td><td>{p.station}</td><td>{orbitalUtc(p.start, true)}</td><td>{orbitalDuration(p.end - p.start)}</td><td className="is-number">{p.peak.toFixed(0)}°</td><td className="is-number" data-risk={p.minMargin !== null && p.minMargin < 3}>{p.minMargin === null ? 'Unknown' : `${p.minMargin.toFixed(1)} dB`}</td><td className="is-number">{p.volumeMB === null ? 'Unknown' : `${(p.volumeMB / 1000).toFixed(2)} GB`}</td><td className="is-number">{(p.coverage * 100).toFixed(0)}%</td><td><span className="orbital-status" data-risk={p.minMargin !== null && p.minMargin < 3}>{p.minMargin === null ? 'Unknown' : p.minMargin < 0 ? 'Below margin' : p.minMargin < 3 ? 'Watch' : 'Nominal'}</span></td></tr>)}</tbody></table></div>
    </Panel>
    <footer className="orbital-lens-footer"><span>Authored synthetic trajectories · no ephemeris propagation or ground-station connection</span><span>{totalVolume === null ? 'Total volume unavailable · incomplete predicted signal coverage' : `${(totalVolume / 1000).toFixed(2)} GB predicted across all contacts`} · camera and chart zoom preserve this population</span></footer>
  </main>;
}

export default OrbitalContactLens;
