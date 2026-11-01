import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { scaleLinear, scaleLog } from 'd3-scale';
import { line } from 'd3-shape';
import type { WidgetRendererProps } from '../../renderer-extensions/widget-registry';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { BIN_LABEL, chamberRows, processSteps, summarizeWafer, waferChamberConfig, waferLineageConfig, waferLosses, waferRows, waferSignature, waferSignatureConfig, waferYieldConfig } from './model';
import { dieLabel, signed, waferNumber, WAFER_COLORS } from './WaferMap';
import './wafer.css';

function polar(angle: number, radius: number) { const a = (angle - 90) * Math.PI / 180; return { x: Math.cos(a) * radius, y: Math.sin(a) * radius }; }
function wedge(lower: number, upper: number, radius: number) {
  if (radius <= 0) return '';
  const a = polar(lower + 1, radius), b = polar(upper - 1, radius);
  return `M0 0L${a.x} ${a.y}A${radius} ${radius} 0 0 1 ${b.x} ${b.y}Z`;
}
function evidence<T extends { id: string }>(inspect: ReturnType<typeof useInspection<T>>, item: T, label: string, enabled: boolean, choose?: () => void) {
  return {
    role: enabled ? 'button' as const : undefined, tabIndex: enabled ? 0 : undefined, 'aria-label': label, 'aria-pressed': enabled ? inspect.pinned === item.id : undefined,
    onPointerEnter: () => { if (!inspect.pinned) inspect.setHover(item.id); }, onPointerLeave: () => { if (!inspect.pinned) inspect.setHover(null); },
    onFocus: () => { if (!inspect.pinned) inspect.setHover(item.id); }, onBlur: () => { if (!inspect.pinned) inspect.setHover(null); },
    onClick: (event: React.MouseEvent<SVGElement>) => { if (!enabled) return; inspect.select(item.id, event.currentTarget); choose?.(); },
    onKeyDown: (event: React.KeyboardEvent<SVGElement>) => { if (enabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); inspect.select(item.id, event.currentTarget); choose?.(); } },
  };
}

export function WaferSignature(props: WidgetRendererProps) {
  const cfg = useMemo(() => waferSignatureConfig.parse(props.widget.config ?? {}), [props.widget.config]);
  const dies = useMemo(() => waferRows(props.result.records), [props.result]);
  const data = useMemo(() => waferSignature(dies, cfg.angularBins, cfg.defect), [dies, cfg.angularBins, cfg.defect]);
  const items = [...data.angular.map(b => ({ ...b, kind: 'angle' })), ...data.radial.map(b => ({ ...b, kind: 'radius' }))];
  const enabled = !props.embedded && props.widget.options?.showTooltip !== false, inspect = useInspection(items, props.result, enabled, `${cfg.metric}:${cfg.angularBins}:${cfg.defect}`);
  const host = useRef<HTMLDivElement>(null), width = usePlotWidth(host, 620), stack = width < 540, pw = stack ? width : width * .44, rx0 = stack ? 0 : pw, ry0 = stack ? 244 : 0;
  const rw = stack ? width : width - pw, height = stack ? 480 : 250, cx = pw / 2, cy = 128, radius = Math.min(78, pw * .32);
  const value = (b: typeof items[number]) => cfg.metric === 'rate' ? b.rate : b.failures;
  const maximum = Math.max(1, ...items.map(b => value(b) ?? 0)), ceiling = cfg.metric === 'rate' ? Math.max(10, Math.ceil(maximum / 10) * 10) : Math.max(5, Math.ceil(maximum / 5) * 5);
  const x = scaleLinear().domain([0, data.radius]).range([rx0 + 43, rx0 + rw - 14]);
  const y = scaleLinear().domain([0, ceiling]).range([ry0 + 202, ry0 + 38]);
  const color = cfg.defect === 'all' ? C.red : WAFER_COLORS[cfg.defect];
  if (!dies.length) return <div className="domain-empty">No wafer spatial observations</div>;
  return <div ref={host} className="wafer-chart" onKeyDown={inspect.onKeyDown}>
    <svg width={width} height={height} role="group" aria-label={props.widget.title}>
      <text x="5" y="15" className="wafer-chart-label">Angular {cfg.metric === 'rate' ? 'failure rate' : 'defect count'}</text>
      <g transform={`translate(${cx} ${cy})`}>
        {[.25, .5, .75, 1].map(f => <g key={f}><circle r={radius * Math.sqrt(f)} className="wafer-grid" fill="none"/>{cfg.showValues && <text x={3} y={-radius * Math.sqrt(f) - 2} className="wafer-muted">{waferNumber(ceiling * f, 1)}{cfg.metric === 'rate' ? '%' : ''}</text>}</g>)}
        {[0, 90, 180, 270].map(a => { const p = polar(a, radius); return <line key={a} x1="0" y1="0" x2={p.x} y2={p.y} className="wafer-grid"/>; })}
        {data.angular.map(bin => { const item = items.find(b => b.id === bin.id)!, v = value(item); return <g key={bin.id} {...evidence(inspect, item, `${bin.lower} to ${bin.upper} degrees: ${bin.failures} failed of ${bin.tested} tested`, enabled)}>
          <path d={wedge(bin.lower, bin.upper, radius)} fill="transparent"/>{v !== null && v > 0 && <path d={wedge(bin.lower, bin.upper, radius * Math.sqrt(v / ceiling))} fill={color} fillOpacity={inspect.item?.id === bin.id ? 1 : .78} stroke={inspect.item?.id === bin.id ? C.orange : 'none'} strokeWidth="2"/>}
        </g>; })}
        <text x="0" y={-radius - 16} textAnchor="middle">N · 0°</text><text x={radius + 10} y="4">E</text><text x="0" y={radius + 20} textAnchor="middle">S · 180°</text><text x={-radius - 10} y="4" textAnchor="end">W</text>
      </g>
      <text x={rx0 + 4} y={ry0 + 15} className="wafer-chart-label">Radial {cfg.metric === 'rate' ? 'failure rate' : 'defect count'}</text>
      {y.ticks(4).map(t => <g key={t}><line x1={x(0)} x2={x(data.radius)} y1={y(t)} y2={y(t)} className="wafer-grid"/><text x={x(0) - 7} y={y(t) + 4} textAnchor="end">{t}{cfg.metric === 'rate' ? '%' : ''}</text></g>)}
      {[0, 50, 100, 150].filter(t => t <= data.radius).map(t => <g key={t}><line x1={x(t)} x2={x(t)} y1={ry0 + 38} y2={ry0 + 202} className="wafer-grid"/><text x={x(t)} y={ry0 + 220} textAnchor="middle">{t}</text></g>)}
      <path d={line<typeof data.radial[number]>().defined(b => cfg.metric === 'count' || b.rate !== null).x(b => x((b.lower + b.upper) / 2)).y(b => y(cfg.metric === 'rate' ? b.rate! : b.failures))(data.radial) ?? ''} fill="none" stroke={color} strokeWidth="2"/>
      {data.radial.map(bin => { const item = items.find(b => b.id === bin.id)!, v = value(item), xx = x((bin.lower + bin.upper) / 2); return <g key={bin.id} {...evidence(inspect, item, `${bin.lower} to ${bin.upper} millimetres: ${bin.failures} failed of ${bin.tested} tested`, enabled)}>
        <rect x={x(bin.lower)} y={ry0 + 30} width={x(bin.upper) - x(bin.lower)} height="173" fill="transparent"/>{v !== null && <circle cx={xx} cy={y(v)} r={inspect.item?.id === bin.id ? 5 : 3} fill={color} stroke={inspect.item?.id === bin.id ? C.orange : 'none'} strokeWidth="2"/>}
      </g>; })}
      <text x={rx0 + rw / 2} y={ry0 + 240} textAnchor="middle">Distance from centre (mm)</text>
    </svg>
    {props.widget.options?.showLegend !== false && <div className="domain-legend"><span><i style={{ background: color }}/>{cfg.defect === 'all' ? 'All final failure bins' : BIN_LABEL[cfg.defect]}</span><span>{cfg.metric === 'rate' ? 'Failed / tested within each bin · sector area = rate' : 'Sector area = failed die count'}</span></div>}
    {inspect.item && <DomainInspector title={`${inspect.item.kind === 'angle' ? 'Azimuth' : 'Radius'} ${inspect.item.lower}–${inspect.item.upper}${inspect.item.kind === 'angle' ? '°' : ' mm'}`} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[
      ['Failed / tested', `${inspect.item.failures} / ${inspect.item.tested}`], ['Failure rate', inspect.item.rate === null ? 'No tested dies' : `${waferNumber(inspect.item.rate, 3)}%`], ['Untested', inspect.item.untested], ['Population', 'Selected wafer · edge exclusions omitted'],
    ]}/></DomainInspector>}
  </div>;
}

export function WaferYieldWaterfall(props: WidgetRendererProps) {
  const cfg = waferYieldConfig.parse(props.widget.config ?? {}), dies = useMemo(() => waferRows(props.result.records), [props.result]);
  const summary = summarizeWafer(dies), bars = waferLosses(dies), host = useRef<HTMLDivElement>(null), width = usePlotWidth(host, 620), height = 225;
  const enabled = !props.embedded && props.widget.options?.showTooltip !== false, inspect = useInspection(bars, props.result, enabled);
  const y = scaleLinear().domain([0, Math.max(1, summary.tested)]).nice(4).range([height - 39, 25]), left = 46, slot = (width - left - 12) / bars.length, barWidth = slot * .65;
  if (!dies.length) return <div className="domain-empty">No wafer yield observations</div>;
  return <div className="wafer-chart" ref={host} onKeyDown={inspect.onKeyDown}><svg width={width} height={height} role="group" aria-label={props.widget.title}>
    {y.ticks(4).map(t => <g key={t}><line x1={left} x2={width - 8} y1={y(t)} y2={y(t)} className="wafer-grid"/><text x={left - 7} y={y(t) + 4} textAnchor="end">{t}</text></g>)}
    <text x={left} y="14" className="wafer-muted">Die count</text>
    {bars.map((bar, i) => { const cx = left + (i + .5) * slot, high = Math.max(bar.start, bar.end), low = Math.min(bar.start, bar.end), color = bar.id === 'passing' ? C.cyan : bar.total ? C.muted : WAFER_COLORS[bar.id as 'leakage' | 'timing' | 'open'];
      return <g key={bar.id} {...evidence(inspect, bar, `${bar.label}: ${Math.abs(bar.value)} dies`, enabled)}>
        <rect x={cx - slot / 2} y="20" width={slot} height={height - 48} fill="transparent"/>
        <rect x={cx - barWidth / 2} y={y(high)} width={barWidth} height={Math.max(0, y(low) - y(high))} fill={color} fillOpacity={bar.total ? .9 : .8} stroke={inspect.item?.id === bar.id ? C.orange : 'none'} strokeWidth="2"/>
        {i < bars.length - 1 && <line x1={cx + barWidth / 2} x2={cx + slot - barWidth / 2} y1={y(bar.end)} y2={y(bar.end)} stroke={C.muted} strokeDasharray="3 3"/>}
        {cfg.showValues && <text x={cx} y={y(high) - 6} textAnchor="middle" className="wafer-emphasis">{bar.value.toLocaleString()}</text>}
        <text x={cx} y={height - 18} textAnchor="middle">{bar.label}</text>
      </g>;
    })}
  </svg><div className="wafer-yield-summary"><span>Yield <strong>{summary.yield === null ? 'Unavailable' : `${waferNumber(summary.yield, 2)}%`}</strong></span><span>{summary.passing} passing / {summary.tested} tested</span><span>{summary.untested} untested · {summary.excluded} excluded</span></div>
    {inspect.item && <DomainInspector title={inspect.item.label} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[
      ['Die count', Math.abs(inspect.item.value)], ['Accounting level', `${inspect.item.start} → ${inspect.item.end}`], ['Tested population', summary.tested], ['Meaning', inspect.item.total ? 'Total from zero' : 'Exclusive final failure bin'],
    ]}/></DomainInspector>}
  </div>;
}

export function WaferChamberDistribution(props: WidgetRendererProps) {
  const cfg = useMemo(() => waferChamberConfig.parse(props.widget.config ?? {}), [props.widget.config]);
  const boxes = useMemo(() => chamberRows(props.result.records, cfg.scale), [props.result, cfg.scale]);
  const host = useRef<HTMLDivElement>(null), width = usePlotWidth(host, 620), height = 230, left = 51, right = 17, slot = (width - left - right) / Math.max(1, boxes.length);
  const populated = boxes.filter(b => b.count), low = Math.min(...populated.map(b => b.min!)), high = Math.max(cfg.specification * 1.3, ...populated.map(b => b.max!));
  const logLow = populated.length ? 10 ** Math.floor(Math.log10(Math.min(low, cfg.specification))) : .1, logHigh = populated.length ? 10 ** Math.ceil(Math.log10(high)) : 100;
  const y = cfg.scale === 'log' ? scaleLog().domain([logLow, Math.max(logLow * 10, logHigh)]).range([height - 44, 25]) : scaleLinear().domain([0, Math.max(1, high)]).nice(4).range([height - 44, 25]);
  const ticks = cfg.scale === 'log' ? Array.from({ length: Math.max(1, Math.round(Math.log10(logHigh / logLow)) + 1) }, (_, i) => logLow * 10 ** i) : y.ticks(4);
  const enabled = !props.embedded && props.widget.options?.showTooltip !== false, inspect = useInspection(boxes, props.result, enabled, cfg.selectedChamber);
  const shownOutliers = boxes.reduce((n, b) => n + b.outliers.length, 0), outlierCount = boxes.reduce((n, b) => n + b.outlierCount, 0);
  if (!populated.length) return <div className="domain-empty">No observed chamber leakage measurements</div>;
  return <div ref={host} className="wafer-chart" onKeyDown={inspect.onKeyDown}><svg width={width} height={height} role="group" aria-label={props.widget.title}>
    {ticks.map(t => <g key={t}><line x1={left} x2={width - right} y1={y(t)} y2={y(t)} className="wafer-grid"/><text x={left - 7} y={y(t) + 4} textAnchor="end">{waferNumber(t, 3)}</text></g>)}
    <text x={left} y="14" className="wafer-muted">Leakage · nA · {cfg.scale} scale</text>
    <line x1={left} x2={width - right} y1={y(cfg.specification)} y2={y(cfg.specification)} stroke={C.amber} strokeDasharray="5 4"/>
    {boxes.map((box, i) => { const x = left + (i + .5) * slot, selected = cfg.selectedChamber === box.id || inspect.item?.id === box.id, color = selected ? C.cyan : C.blue;
      return <g key={box.id} {...evidence(inspect, box, `${box.id}: median ${waferNumber(box.median, 3)} nanoamps, ${box.count} observed`, enabled, () => props.onContextChange?.({ series: box.id, value: box.median, labels: { chamber: box.id } }))}>
        <rect x={x - slot / 2 + 2} y="20" width={slot - 4} height={height - 21} fill={selected ? 'color-mix(in srgb,var(--gamma-chart-1) 7%,transparent)' : 'transparent'}/>
        {box.count ? <><line x1={x} x2={x} y1={y(box.lowWhisker!)} y2={y(box.highWhisker!)} stroke={color} strokeWidth="1.4"/>
          {[box.lowWhisker!, box.highWhisker!].map((v, j) => <line key={j} x1={x - slot * .16} x2={x + slot * .16} y1={y(v)} y2={y(v)} stroke={color} strokeWidth="1.4"/>)}
          <rect x={x - slot * .23} y={y(box.q3!)} width={slot * .46} height={Math.max(1, y(box.q1!) - y(box.q3!))} fill={color} fillOpacity=".22" stroke={color} strokeWidth="1.5"/>
          <line x1={x - slot * .23} x2={x + slot * .23} y1={y(box.median!)} y2={y(box.median!)} stroke={color} strokeWidth="2"/>
          {cfg.showOutliers && box.outliers.map((v, j) => <circle key={`${j}:${v}`} cx={x + ((j * 7) % 5 - 2) * 2} cy={y(v)} r="2" fill={C.red} pointerEvents="none"/>)}
        </> : <text x={x} y={height / 2} textAnchor="middle">Missing</text>}
        <text x={x} y={height - 24} textAnchor="middle" fill={color}>{box.id}</text><text x={x} y={height - 7} textAnchor="middle" className="wafer-muted">n={box.count}</text>
      </g>;
    })}
  </svg>{props.widget.options?.showLegend !== false && <div className="domain-legend"><span><i style={{ background: C.amber }}/>Specification {cfg.specification} nA</span><span>Boxes: Q1–Q3 · whiskers: 1.5×IQR</span>{cfg.showOutliers && <span>{shownOutliers} of {outlierCount} outliers shown · highest 20/chamber</span>}</div>}
    {inspect.item && <DomainInspector title={`Chamber ${inspect.item.id} · full lot`} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[
      ['Observed / unavailable', `${inspect.item.count} / ${inspect.item.missing}`], ['Median', `${waferNumber(inspect.item.median, 4)} nA`],
      ['Q1 – Q3', `${waferNumber(inspect.item.q1, 4)} – ${waferNumber(inspect.item.q3, 4)} nA`], ['Whiskers', `${waferNumber(inspect.item.lowWhisker, 4)} – ${waferNumber(inspect.item.highWhisker, 4)} nA`],
      ['Maximum / all outliers', `${waferNumber(inspect.item.max, 4)} nA / ${inspect.item.outlierCount}`], ['Shown outliers', inspect.item.outliers.map(v => waferNumber(v, 3)).join(', ') || 'None'],
    ]}/></DomainInspector>}
  </div>;
}

export function WaferProcessLineage(props: WidgetRendererProps) {
  const cfg = waferLineageConfig.parse(props.widget.config ?? {}), dies = useMemo(() => waferRows(props.result.records), [props.result]);
  const [localId, setLocalId] = useState<string | null>(null);
  const selectedId = props.onContextChange ? cfg.selectedDieId : localId ?? cfg.selectedDieId;
  const selected = dies.find(d => d.id === selectedId);
  useEffect(() => setLocalId(null), [props.result, cfg.selectedDieId]);
  const steps = selected ? processSteps(selected) : [], enabled = !props.embedded && props.widget.options?.showTooltip !== false;
  const inspect = useInspection(steps, props.result, enabled, selected?.id);
  const time = (timestamp: number | null) => timestamp === null ? 'Not recorded' : new Date(timestamp).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  if (!dies.length) return <div className="domain-empty">No wafer process observations</div>;
  return <div className="wafer-chart" onKeyDown={inspect.onKeyDown}>
    {!props.embedded && !props.onContextChange && <div className="wafer-controls"><label>Die <select className="domain-control" aria-label="Process-history die" value={selected?.id ?? ''} onChange={event => setLocalId(event.target.value)}><option value="">Choose a die</option>{dies.map(d => <option key={d.id} value={d.id}>{dieLabel(d)}</option>)}</select></label></div>}
    {!selected ? <div className="domain-empty">Select a die on the wafer map to inspect its recorded process history.</div> : <>
      <div className="wafer-lineage-context"><strong>{selected.wafer} · C{signed(selected.column)} / R{signed(selected.row)}</strong><span>{BIN_LABEL[selected.bin]}</span><span>{selected.leakageNA === null ? 'No leakage observation' : `${waferNumber(selected.leakageNA, 3)} nA`}</span></div>
      <div className="wafer-lineage-grid">{steps.map((step, i) => {
        const content: ReactNode = <><span className="wafer-stage-symbol" data-stage={step.id}>{i + 1}</span><span><strong>{step.label}</strong><small>{step.tool}</small><time>{step.time === null ? 'Not tested' : new Date(step.time).toISOString().slice(11, 19) + ' UTC'}</time></span></>;
        return enabled ? <button className="wafer-stage" data-selected={inspect.item?.id === step.id} data-associated={step.id === 'etch'} key={step.id} onClick={event => inspect.select(step.id, event.currentTarget)} onFocus={() => inspect.setHover(step.id)} onBlur={() => inspect.setHover(null)} aria-pressed={inspect.pinned === step.id}>{content}</button> : <div className="wafer-stage" key={step.id}>{content}</div>;
      })}</div>
      {cfg.showMeasurements && <div className="domain-table-scroll"><table className="domain-table wafer-lineage-table"><thead><tr><th>Stage</th><th>Tool / chamber</th><th>Measurement</th><th>Unit</th><th>Recorded timestamp · UTC</th></tr></thead><tbody>{steps.map(step => <tr key={step.id} data-selected={inspect.item?.id === step.id}><td>{step.label}</td><td>{step.tool}</td><td className="is-number">{waferNumber(step.value, 3)}</td><td>{step.unit}</td><td>{time(step.time)}</td></tr>)}</tbody></table></div>}
      {inspect.item && <DomainInspector title={`${inspect.item.label} · ${selected.id}`} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[
        ['Tool', inspect.item.tool], ['Observed measurement', inspect.item.value === null ? 'Unavailable' : `${waferNumber(inspect.item.value, 4)} ${inspect.item.unit}`], ['Timestamp', time(inspect.item.time)],
      ]}/></DomainInspector>}
    </>}
  </div>;
}
