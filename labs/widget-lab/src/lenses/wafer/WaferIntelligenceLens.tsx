import { useId, useMemo, useState } from 'react';
import type { DrilldownContext } from '@insights/drilldown';
import type { EditLensWidget } from '../LensStudio';
import { DomainChartPanel, DomainHeader, MetricStrip } from '../../components/lab/DomainPrimitives';
import { registerLabCharts } from '../../charts/register-lab-charts';
import { registerWaferCharts } from '../../charts/wafer/register';
import { summarizeWafer, type WaferDie } from '../../charts/wafer/model';
import { WAFER_COLORS, waferNumber } from '../../charts/wafer/WaferMap';
import { waferFixtures, WAFER_IDS, type WaferId } from './fixtures';
import './wafer-lens.css';

registerLabCharts();
registerWaferCharts();

function WaferThumbnail({ id, dies, selected, onSelect }: { id: string; dies: WaferDie[]; selected: boolean; onSelect: () => void }) {
  const clip = `wafer-thumb-${useId().replaceAll(':', '')}`, summary = summarizeWafer(dies);
  return <button className="wafer-thumbnail" aria-label={`Select wafer ${id}, yield ${waferNumber(summary.yield, 2)} percent`} aria-pressed={selected} onClick={onSelect}>
    <span>{id}</span><svg viewBox="-154 -154 308 308" role="img" aria-label={`${id} final-test bin overview`}>
      <defs><clipPath id={clip}><circle r="150"/></clipPath></defs><circle r="150" fill="var(--gamma-bg)" stroke="var(--gamma-muted)" strokeWidth="2"/>
      <g clipPath={`url(#${clip})`}>{dies.map(d => <rect key={d.id} x={d.xMm - 4} y={-d.yMm - 4} width="8" height="8" fill={WAFER_COLORS[d.bin]} opacity={d.bin === 'excluded' ? .5 : 1}/>)}</g>
      <path d="M-7 151Q0 133 7 151" fill="var(--gamma-bg)" stroke="var(--gamma-muted)" strokeWidth="2"/>
    </svg><small>{waferNumber(summary.yield, 1)}%</small>
  </button>;
}

export function WaferIntelligenceLens({ onEdit }: { onEdit?: EditLensWidget }) {
  const [wafer, setWafer] = useState<WaferId>('W-17'), [preset, setPreset] = useState<'ready' | 'gaps'>('ready');
  const data = useMemo(() => waferFixtures(wafer, preset), [wafer, preset]);
  const [selectedDie, setSelectedDie] = useState(data.initialDie);
  const summary = summarizeWafer(data.active.dies), die = data.active.dies.find(d => d.id === selectedDie), chamber = data.active.dies[0]?.chamber ?? '';
  const chooseWafer = (id: WaferId) => { setWafer(id); setSelectedDie(''); };
  const selectDie = (context: DrilldownContext) => { if (context.labels?.dieId !== undefined) setSelectedDie(context.labels.dieId); };
  const selectChamber = (context: DrilldownContext) => {
    const next = data.lot.find(w => w.dies[0]?.chamber === context.labels?.chamber);
    if (next && next.id !== wafer && context.labels?.chamber !== chamber) chooseWafer(next.id);
  };
  return <main className="domain-lens wafer-lens" data-domain-lens="wafer-intelligence">
    <DomainHeader title="Wafer Intelligence"><span>Fab F-03 · Lot L26-1048</span>
      <label>Wafer <select aria-label="Active wafer" value={wafer} onChange={event => chooseWafer(event.target.value as WaferId)}>{WAFER_IDS.map(id => <option key={id} value={id}>{id}</option>)}</select></label>
      <label>Data <select aria-label="Wafer acquisition scenario" value={preset} onChange={event => { setPreset(event.target.value as 'ready' | 'gaps'); setSelectedDie(''); }}><option value="ready">Final electrical</option><option value="gaps">Missing tests</option></select></label>
      <span>300 mm wafer · {chamber}</span>
    </DomainHeader>
    <MetricStrip items={[
      { label: 'Tested dies', value: summary.tested.toLocaleString(), detail: `${summary.eligible} eligible positions` },
      { label: 'Passing', value: summary.passing.toLocaleString(), tone: 'green' },
      { label: 'Yield', value: summary.yield === null ? 'Unknown' : `${waferNumber(summary.yield, 2)}%`, detail: 'Passing / tested' },
      { label: 'Failed', value: summary.failed, tone: 'red', detail: 'Exclusive final bins' },
      { label: 'Untested', value: summary.untested, tone: 'amber', detail: `${summary.excluded} edge exclusions separate` },
    ]}/>
    <div className="wafer-lens-grid"><div className="wafer-lens-primary">
      <DomainChartPanel panel={data.map} onEdit={onEdit} selection={{ selectedDieId: selectedDie }} onContextChange={selectDie}/>
      <section className="wafer-lot-overview" aria-label="Compare wafers in lot"><header><h2>Lot wafers</h2><span>Same physical scale · final test bins</span></header><div className="wafer-thumbnails">{data.lot.map(w => <WaferThumbnail key={w.id} id={w.id} dies={w.dies} selected={w.id === wafer} onSelect={() => chooseWafer(w.id)}/>)}</div></section>
      <DomainChartPanel panel={data.transect} onEdit={onEdit} selection={{ selectedDieId: selectedDie }} onContextChange={selectDie}/>
    </div><div className="wafer-lens-secondary">
      <DomainChartPanel panel={data.signature} onEdit={onEdit}/>
      <DomainChartPanel panel={data.yield} onEdit={onEdit}/>
      <DomainChartPanel panel={data.chambers} onEdit={onEdit} selection={{ selectedChamber: chamber }} onContextChange={selectChamber}/>
    </div></div>
    <DomainChartPanel panel={data.lineage} onEdit={onEdit} selection={{ selectedDieId: selectedDie }} onContextChange={selectDie} className="wafer-process-panel"/>
    <footer className="wafer-lens-footer"><span>Seven synthetic wafers · final electrical snapshot · 27–29 Oct 2026 UTC</span><span>{die ? `Linked die ${die.id} · chamber ${die.chamber}` : 'Select a die to link its process evidence'}</span></footer>
  </main>;
}
