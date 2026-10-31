import { useEffect, useMemo, useRef, useState } from 'react';
import type { WidgetRendererProps } from '../../vendor/paprika/ui/src/features/insights/widget-registry';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { differentialProfile, differentialProfileConfig, type Build, type DifferentialFrame } from './model';
import { performanceNumber as fmt } from './PerformanceDensity';
import './performance.css';

export function PerformanceDifferentialFlamegraph({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const config = differentialProfileConfig.parse(widget.config ?? {}), data = useMemo(() => result.records ? differentialProfile(result.records) : null, [result.records]);
  const host = useRef<HTMLDivElement>(null), width = usePlotWidth(host, 830), enabled = !embedded && widget.options?.showTooltip !== false;
  const frames = data?.frames ?? [], lookup = new Map(frames.map(frame => [frame.id, frame]));
  const [focusId, setFocusId] = useState<string | null>(null), [search, setSearch] = useState(''), [widthBy, setWidthBy] = useState<Build>(config.widthBy);
  useEffect(() => { setFocusId(null); setSearch(''); }, [result]);
  useEffect(() => setWidthBy(config.widthBy), [config.widthBy]);
  const inspection = useInspection(frames, result, enabled, config.selectedId), selected = inspection.item ?? lookup.get(config.selectedId);
  const root = frames.find(frame => frame.parentId === null), focus = focusId ? lookup.get(focusId) ?? root : root;
  const ancestors = (frame: DifferentialFrame | undefined) => { const chain: DifferentialFrame[] = []; let current = frame; while (current) { chain.unshift(current); current = current.parentId ? lookup.get(current.parentId) : undefined; } return chain; };
  const chain = ancestors(focus), visible = focus ? frames.filter(frame => ancestors(frame).some(parent => parent.id === focus.id) && frame[widthBy].total > 0) : [];
  const focusWidth = focus?.[widthBy].total ?? 0, focusStart = focus?.[widthBy].start ?? 0;
  const x = (cost: number) => focusWidth > 0 ? (cost - focusStart) / focusWidth * width : 0;
  const levels = visible.length ? Math.max(...visible.map(frame => frame.depth)) - (focus?.depth ?? 0) + 1 : 0;
  const color = (frame: DifferentialFrame) => frame.deltaShare === null ? 'var(--gamma-surface-2)' : `color-mix(in srgb, ${frame.deltaShare >= 0 ? C.orange : C.blue} ${14 + Math.min(1, Math.abs(frame.deltaShare) / 18) * 65}%, var(--gamma-surface-2))`;
  const shareText = (value: number | null) => value === null ? 'Unknown · zero profile total' : `${value >= 0 ? '+' : ''}${fmt(value)} pp`;
  const pick = (frame: DifferentialFrame, target: SVGElement | HTMLElement) => { if (!enabled) return; inspection.select(frame.id, target); onContextChange?.({ series: frame.label, value: frame.after.total / frame.afterRequests, labels: { action: 'function', functionId: frame.id, functionName: frame.label } }); };
  const focusOn = (frame: DifferentialFrame) => { if (frame[widthBy].total > 0) { setFocusId(frame.id); inspection.dismiss(); } };
  return <div ref={host} className="performance-chart performance-profile" onKeyDown={inspection.onKeyDown}>
    {!frames.length ? <div className="domain-empty">No paired CPU profile costs.</div> : <>
      <div className="performance-toolbar">
        {!embedded && <><label>Width<select aria-label="Profile width build" value={widthBy} onChange={event => setWidthBy(event.target.value as Build)}><option value="after">Candidate CPU</option><option value="before">Baseline CPU</option></select></label><label className="performance-symbol-search">Symbol<input aria-label="Search profile functions" placeholder="Search function…" value={search} onChange={event => setSearch(event.target.value)}/></label></>}
        <span className="performance-profile-scope">Aggregate CPU · {data?.beforeRequests}/{data?.afterRequests} requests</span>
      </div>
      <div className="performance-chart-key"><div className="domain-legend">{frames.some(frame => frame.deltaShare === null) ? <span><i style={{ background: C.muted }}/>CPU share unknown · zero profile total</span> : <><span><i style={{ background: C.blue }}/>Lower CPU share</span><span><i style={{ background: C.orange }}/>Higher CPU share</span></>}</div><span>Color: candidate − baseline, percentage points</span></div>
      {!embedded && <nav className="performance-profile-breadcrumbs" aria-label="Profile ancestry">{chain.map((frame, index) => <button key={frame.id} onClick={() => { setFocusId(frame.parentId === null ? null : frame.id); inspection.dismiss(); }}>{index ? '› ' : ''}{frame.label === 'total' ? 'All stacks' : frame.label}</button>)}</nav>}
      {focusWidth <= 0 ? <div className="domain-empty">No {widthBy === 'after' ? 'candidate' : 'baseline'} CPU cost in this stack. Choose the other width population.</div> : <svg viewBox={`0 0 ${width} ${levels * config.rowHeight + 2}`} role="group" aria-label="Differential aggregate flamegraph. Width is selected build CPU cost, not chronology. Color is share change.">
        {visible.map(frame => {
          const value = frame[widthBy], boxWidth = x(value.start + value.total) - x(value.start), top = (frame.depth - (focus?.depth ?? 0)) * config.rowHeight, active = selected?.id === frame.id, match = !search || frame.label.toLowerCase().includes(search.toLowerCase());
          return <g key={frame.id} role="button" tabIndex={enabled ? 0 : undefined} aria-label={`${frame.label}, baseline ${fmt(frame.before.total / frame.beforeRequests)} milliseconds per request, candidate ${fmt(frame.after.total / frame.afterRequests)}, CPU share change ${shareText(frame.deltaShare)}`} onPointerEnter={() => inspection.setHover(frame.id)} onPointerLeave={() => inspection.setHover(null)} onFocus={() => inspection.setHover(frame.id)} onBlur={() => inspection.setHover(null)} onClick={event => pick(frame, event.currentTarget)} onDoubleClick={() => { if (!embedded) focusOn(frame); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick(frame, event.currentTarget); } }}>
            <rect x={x(value.start)} y={top + 1} width={Math.max(.2, boxWidth - .6)} height={config.rowHeight - 1.5} rx="1" fill={color(frame)} opacity={match ? 1 : .27} stroke={active ? C.cyan : 'var(--gamma-border)'} strokeWidth={active ? 2.5 : .5}/>
            {config.showLabels && boxWidth > 48 && <text x={x(value.start) + 5} y={top + config.rowHeight * .67} fill="var(--gamma-ink)" opacity={match ? 1 : .45} pointerEvents="none">{frame.label.length * 6.2 > boxWidth - 10 ? `${frame.label.slice(0, Math.max(1, Math.floor((boxWidth - 22) / 6.2)))}…` : frame.label}</text>}
          </g>;
        })}
      </svg>}
      {!embedded && <div className="performance-toolbar"><button disabled={!selected || selected[widthBy].total <= 0} onClick={() => { if (selected) focusOn(selected); }}>Focus selected stack</button><button disabled={!focusId} onClick={() => { setFocusId(null); inspection.dismiss(); }}>Reset profile</button>{search && <span>{frames.filter(frame => frame.label.toLowerCase().includes(search.toLowerCase())).length} matching frames · all costs retained</span>}</div>}
      {selected && <div className="performance-selected-function"><div><small>Selected function</small><strong>{selected.label}</strong></div><div><small>Baseline CPU / request</small><strong>{fmt(selected.before.total / selected.beforeRequests)} ms</strong></div><div><small>Candidate CPU / request</small><strong>{fmt(selected.after.total / selected.afterRequests)} ms</strong></div><div><small>CPU share change</small><strong style={{ color: selected.deltaShare === null ? C.muted : selected.deltaShare >= 0 ? C.orange : C.blue }}>{shareText(selected.deltaShare)}</strong></div></div>}
      {inspection.item && <DomainInspector title={inspection.item.label} pinned={!!inspection.pinned} onClose={inspection.dismiss}><DetailValues items={[["Candidate inclusive CPU", `${fmt(inspection.item.after.total)} ms`], ['Candidate self CPU', `${fmt(inspection.item.after.self)} ms`], ['Baseline inclusive CPU', `${fmt(inspection.item.before.total)} ms`], ['Per-request CPU change', `${inspection.item.deltaPerRequest >= 0 ? '+' : ''}${fmt(inspection.item.deltaPerRequest)} ms`], ['CPU share change', shareText(inspection.item.deltaShare)], ['Original denominators', `${inspection.item.beforeRequests} baseline / ${inspection.item.afterRequests} candidate requests`], ['Ancestry', ancestors(inspection.item).map(frame => frame.label).join(' → ')]]}/></DomainInspector>}
      <p className="domain-note">Matched synthetic aggregate CPU costs, with canonical Pyroscope profile accounting. Width is cost, not elapsed time. Share color can decrease while absolute CPU increases; exact values retain both measures.</p>
    </>}
  </div>;
}
