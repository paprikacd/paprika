import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { scaleLinear, scaleLog } from 'd3-scale';
import { line } from 'd3-shape';
import type { WidgetRendererProps } from '../../renderer-extensions/widget-registry';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { BIN_LABEL, waferFocusId, waferTransect, waferTransectConfig, waferTransectRows, waferTransectSegments, type WaferDie } from './model';
import { dieLabel, signed, WAFER_COLORS } from './WaferMap';
import './wafer.css';
import { useChartEntrance } from '@insights/chart-entrance';
import chartEntrance from '@insights/chart-entrance.module.css';

const exact = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString('en-US', { maximumSignificantDigits: 7, notation: value !== 0 && (Math.abs(value) < .0001 || Math.abs(value) >= 1e8) ? 'scientific' : 'standard' });

/** Physical row/column sampling: missing values and unsupplied slots break the connecting trace. */
export function WaferTransect(props: WidgetRendererProps) {
  const cfg = useMemo(() => waferTransectConfig.parse(props.widget.config ?? {}), [props.widget.config]);
  const dies = useMemo(() => waferTransectRows(props.result.records, cfg), [props.result, cfg.xField, cfg.yField, cfg.valueField]);
  const [selectedId, setSelectedId] = useState<string | null>(cfg.selectedDieId || null), [focusId, setFocusId] = useState<string | null>(null), [tablePage, setTablePage] = useState(0);
  useEffect(() => { setSelectedId(cfg.selectedDieId || null); setFocusId(null); }, [props.result, cfg.selectedDieId]);
  const section = useMemo(() => waferTransect(dies, { ...cfg, selectedDieId: selectedId ?? '' }), [dies, cfg, selectedId]);
  const segments = useMemo(() => waferTransectSegments(section.points, cfg.axis), [section.points, cfg.axis]);
  const revision = useMemo(() => ({ result: props.result, axis: cfg.axis, index: section.index }), [props.result, cfg.axis, section.index]);
  useEffect(() => setTablePage(0), [revision]);
  const enabled = !props.embedded && props.widget.options?.showTooltip !== false;
  const inspect = useInspection(section.points, revision, enabled, cfg.selectedDieId);
  const host = useRef<HTMLDivElement>(null), width = usePlotWidth(host, 620), marks = useRef(new Map<string, SVGGElement>());
  const entering = useChartEntrance({ anchor: host });
  const clip = `wafer-section-${useId().replaceAll(':', '')}`, left = 52, right = width - 14, top = 30, bottom = 216, emptyLane = 244, height = 294;
  const x = scaleLinear().domain([-section.radiusMm, section.radiusMm]).range([left, right]);
  const values = section.points.flatMap(die => die.leakageNA === null ? [] : [die.leakageNA]);
  const bounds = [...values, ...(cfg.showReference ? [cfg.referenceValue] : [])];
  const low = bounds.length ? Math.min(...bounds) : .1, high = bounds.length ? Math.max(...bounds) : 10;
  const roundedLow = 10 ** Math.floor(Math.log10(Math.max(Number.MIN_VALUE, low))), roundedHigh = 10 ** Math.ceil(Math.log10(Math.max(high, low)));
  let logLow = roundedLow > 0 ? roundedLow : Math.max(Number.MIN_VALUE, low), logHigh = Number.isFinite(roundedHigh) ? roundedHigh : high;
  if (logHigh <= logLow) { if (logLow / 10 > 0) logLow /= 10; else logHigh = logLow * 10; }
  const y = cfg.scale === 'log' ? scaleLog().domain([logLow, logHigh]).range([bottom, top]) : scaleLinear().domain([0, Math.max(1, Math.min(Number.MAX_VALUE, high * 1.12))]).range([bottom, top]);
  const yTicks = cfg.scale === 'log' ? y.ticks(4).filter(tick => Math.abs(Math.log10(tick) - Math.round(Math.log10(tick))) < 1e-7) : y.ticks(4);
  const coordinate = (die: WaferDie) => cfg.axis === 'row' ? die.xMm : die.yMm;
  const selected = section.points.find(die => die.id === selectedId), rovingId = waferFocusId(section.points, focusId, selectedId);
  const page = Math.min(tablePage, Math.max(0, Math.ceil(section.points.length / 12) - 1)), exactRows = section.points.slice(page * 12, (page + 1) * 12);
  const fieldAxis = cfg.axis === 'row' ? 'X' : 'Y', fixedAxis = cfg.axis === 'row' ? 'Y' : 'X';
  const choose = (die: WaferDie, trigger?: HTMLElement | SVGElement) => {
    if (!enabled) return;
    setSelectedId(die.id); setFocusId(die.id); inspect.select(die.id, trigger);
    props.onContextChange?.({ series: die.id, value: die.leakageNA, labels: { dieId: die.id, wafer: die.wafer, chamber: die.chamber, bin: die.bin } });
  };
  const step = (die: WaferDie, key: string) => {
    const i = section.points.findIndex(point => point.id === die.id);
    const index = key === 'Home' ? 0 : key === 'End' ? section.points.length - 1 : key === 'ArrowRight' || key === 'ArrowUp' ? i + 1 : key === 'ArrowLeft' || key === 'ArrowDown' ? i - 1 : -1;
    const next = section.points[index];
    if (next) { setFocusId(next.id); marks.current.get(next.id)?.focus({ preventScroll: true }); }
  };

  if (!dies.length) return <div className="domain-empty">No wafer measurements. Choose a wafer result with physical die positions.</div>;
  return <div ref={host} className="wafer-chart wafer-transect" data-chart-entering={entering || undefined} onKeyDown={inspect.onKeyDown}>
    <div className="wafer-transect-context"><strong>{cfg.axis === 'row' ? 'Row' : 'Column'} {signed(section.index)}<span>{fixedAxis} = {exact(section.fixedMm)} mm</span></strong><span>{cfg.followSelection && selected ? 'Follows selected die' : 'Configured section'} · {section.observed}/{section.eligible} eligible measurements</span></div>
    <svg width={width} height={height} role="group" aria-label={`${props.widget.title}. ${cfg.axis} ${section.index}; leakage in nanoamps along physical ${fieldAxis} coordinates. Arrow keys explore dies; Enter pins evidence.`}>
      <defs><clipPath id={clip}><rect x={left - 5} y={top - 6} width={right - left + 10} height={bottom - top + 12}/></clipPath></defs>
      <text x={left} y="16" className="wafer-chart-label">Leakage · nA <tspan className="wafer-muted">({cfg.scale})</tspan></text>
      {yTicks.map(tick => <g key={tick}>{cfg.showGrid && <line x1={left} x2={right} y1={y(tick)} y2={y(tick)} className="wafer-grid"/>}<text x={left - 8} y={y(tick) + 4} textAnchor="end">{tick !== 0 && (Math.abs(tick) < .001 || Math.abs(tick) >= 1e6) ? tick.toExponential(0) : tick.toLocaleString('en-US', { maximumSignificantDigits: 3 })}</text></g>)}
      {x.ticks(width < 420 ? 3 : 6).map(tick => <g key={tick}>{cfg.showGrid && <line x1={x(tick)} x2={x(tick)} y1={top} y2={bottom} className="wafer-grid"/>}<text x={x(tick)} y="272" textAnchor="middle">{tick}</text></g>)}
      {cfg.showReference && <g><line x1={left} x2={right} y1={y(cfg.referenceValue)} y2={y(cfg.referenceValue)} stroke={C.amber} strokeWidth="1.2" strokeDasharray="5 4"/><text x={right - 3} y={Math.max(top + 12, y(cfg.referenceValue) - 6)} textAnchor="end" className="wafer-transect-reference">Ref {exact(cfg.referenceValue)} nA</text></g>}
      <line x1={left} x2={right} y1={231} y2={231} className="wafer-grid"/>
      <text x={left - 8} y={emptyLane - 3} textAnchor="end" className="wafer-muted">No</text><text x={left - 8} y={emptyLane + 10} textAnchor="end" className="wafer-muted">value</text>
      {cfg.showConnections && <g clipPath={`url(#${clip})`}>{segments.filter(segment => segment.length > 1).map(segment => <path key={segment[0].id} d={line<WaferDie>().x(die => x(coordinate(die))).y(die => y(die.leakageNA!))(segment) ?? ''} fill="none" stroke={C.blue} strokeOpacity=".65" strokeWidth="1.4"/>)}</g>}
      {section.points.map(die => {
        const xx = x(coordinate(die)), yy = die.leakageNA === null ? emptyLane : y(die.leakageNA), active = inspect.item?.id === die.id || selectedId === die.id;
        return <g key={die.id} ref={node => { if (node) marks.current.set(die.id, node); else marks.current.delete(die.id); }} data-transect-die={die.id}
          role={enabled ? 'button' : undefined} tabIndex={enabled ? rovingId === die.id ? 0 : -1 : undefined} aria-pressed={enabled ? selectedId === die.id : undefined}
          aria-label={`${dieLabel(die)}, ${fieldAxis} ${exact(coordinate(die))} millimetres, leakage ${die.leakageNA === null ? 'unavailable' : `${exact(die.leakageNA)} nanoamps`}`}
          onPointerEnter={() => { if (!inspect.pinned) inspect.setHover(die.id); }} onPointerLeave={() => { if (!inspect.pinned) inspect.setHover(null); }}
          onFocus={() => { if (!inspect.pinned) inspect.setHover(die.id); }} onBlur={() => { if (!inspect.pinned) inspect.setHover(null); }}
          onClick={event => choose(die, event.currentTarget)} onKeyDown={event => {
            if (!enabled) return;
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { event.preventDefault(); step(die, event.key); }
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(die, event.currentTarget); }
          }}>
          <circle cx={xx} cy={yy} r="12" fill="transparent"/>
          {die.leakageNA !== null ? <g className={chartEntrance.revealMarks}><circle cx={xx} cy={yy} r={active ? 5 : 3.6} fill={WAFER_COLORS[die.bin]} stroke={active ? C.orange : 'var(--gamma-bg)'} strokeWidth={active ? 2 : 1}/></g>
            : <><g className={chartEntrance.revealMarks}><rect x={xx - 4} y={yy - 4} width="8" height="8" fill="var(--gamma-bg)" stroke={active ? C.orange : die.bin === 'excluded' ? C.muted : WAFER_COLORS[die.bin]} strokeWidth={active ? 2 : 1}/></g>{die.bin !== 'excluded' && <path d={`M${xx - 3} ${yy + 3}L${xx + 3} ${yy - 3}`} stroke={active ? C.orange : WAFER_COLORS[die.bin]} strokeWidth="1.2"/>}</>}
        </g>;
      })}
      {!section.observed && <text x={(left + right) / 2} y={(top + bottom) / 2} textAnchor="middle" className="wafer-chart-label">No measured leakage in this section</text>}
      <text x={(left + right) / 2} y="291" textAnchor="middle">Physical {fieldAxis} coordinate (mm)</text>
    </svg>
    {props.widget.options?.showLegend !== false && <div className="domain-legend wafer-transect-legend"><span><i style={{ background: C.cyan }}/>Measured dies · final test-bin colour</span><span><i className="wafer-transect-unmeasured"/>Unmeasured positions in separate lane</span>{cfg.showConnections && <span>Adjacent measured positions only</span>}</div>}
    <div className="wafer-transect-summary"><span>Median <strong>{exact(section.median)}{section.median === null ? '' : ' nA'}</strong></span><span>{section.untested} untested · {section.unavailable} tested without leakage · {section.excluded} edge excluded</span></div>
    {!props.embedded && <details className="wafer-exact"><summary>Exact section values · {section.points.length} supplied positions</summary>
      {enabled && <div className="wafer-controls"><label>Inspect die <select className="domain-control" aria-label="Inspect wafer transect die" value={selected?.id ?? ''} onChange={event => { const die = section.points.find(point => point.id === event.target.value); if (die) choose(die, event.currentTarget); }}><option value="">Choose a die</option>{section.points.map(die => <option key={die.id} value={die.id}>{dieLabel(die)}</option>)}</select></label></div>}
      <div className="domain-table-scroll wafer-transect-values"><table className="domain-table"><thead><tr><th>Die</th><th>{fieldAxis} · mm</th><th>Leakage · nA</th><th>Final bin</th></tr></thead><tbody>{exactRows.map(die => <tr key={die.id} data-selected={die.id === selectedId}><td>{enabled ? <button className="wafer-text-button" onClick={event => choose(die, event.currentTarget)}>C{signed(die.column)} / R{signed(die.row)}</button> : `C${signed(die.column)} / R${signed(die.row)}`}</td><td className="is-number">{exact(coordinate(die))}</td><td className="is-number">{exact(die.leakageNA)}</td><td>{BIN_LABEL[die.bin]}</td></tr>)}</tbody></table></div>
      <div className="wafer-controls"><span>{page * 12 + 1}–{Math.min((page + 1) * 12, section.points.length)} of {section.points.length} positions</span><button className="domain-control" aria-label="Previous section values" disabled={page === 0} onClick={() => setTablePage(page - 1)}>Previous</button><button className="domain-control" aria-label="Next section values" disabled={(page + 1) * 12 >= section.points.length} onClick={() => setTablePage(page + 1)}>Next</button></div>
    </details>}
    {inspect.item && <DomainInspector title={`${inspect.item.wafer} · C${signed(inspect.item.column)} / R${signed(inspect.item.row)}`} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[
      ['Leakage', inspect.item.leakageNA === null ? 'Not measured' : `${exact(inspect.item.leakageNA)} nA`], ['Final test bin', BIN_LABEL[inspect.item.bin]],
      ['Physical X / Y', `${exact(inspect.item.xMm)} / ${exact(inspect.item.yMm)} mm`], ['Wafer / chamber', `${inspect.item.wafer} / ${inspect.item.chamber}`],
      ['Reference', cfg.showReference ? `${exact(cfg.referenceValue)} nA · display only` : 'Hidden'], ['Source field', cfg.valueField],
    ]}/></DomainInspector>}
  </div>;
}
