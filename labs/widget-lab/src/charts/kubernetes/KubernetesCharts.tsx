import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { scaleLinear } from 'd3-scale';
import { area, line } from 'd3-shape';
import type { WidgetRendererProps } from '../../renderer-extensions/widget-registry';
import { TimeWindowControls, useChartTimeWindow, useTimeWindowBrush } from '../../renderer-extensions/time-window-controls';
import { CHART_COLORS as C, DetailValues, DomainInspector, useInspection, usePlotWidth } from '../../components/lab/DomainPrimitives';
import { fleetRows, resourceBarsConfig, resourceSummary, resourceTimepoints, resourceTrendConfig, throttleConfig, throttleRows, type FleetTimepoint } from './model';
import { fleetNumber, fleetTime } from './PlacementChart';
import './kubernetes.css';
import { PlotHatchDefs, plotHatchFill } from '@insights/plot-hatch';
import { useChartEntrance } from '@insights/chart-entrance';
import chartEntrance from '@insights/chart-entrance.module.css';

export function KubernetesResourceBars({ widget, result, embedded }: WidgetRendererProps) {
  const cfg = resourceBarsConfig.parse(widget.config ?? {}), entities = useMemo(() => fleetRows(result.records), [result]), summary = resourceSummary(entities, cfg.selectedId);
  const rows = [{ id: 'cpu', label: 'CPU', unit: 'cores', color: C.cyan, ...summary.cpuUsed, requested: summary.cpuRequested, limit: summary.cpuLimit, allocatable: summary.cpuAllocatable },
    { id: 'memory', label: 'Memory', unit: 'GiB', color: C.violet, ...summary.memoryUsed, requested: summary.memoryRequested, limit: summary.memoryLimit, allocatable: summary.memoryAllocatable }];
  const host = useRef<HTMLDivElement>(null), width = usePlotWidth(host, 470), enabled = !embedded && widget.options?.showTooltip !== false, inspect = useInspection(rows, result, enabled, cfg.selectedId), uid = `kube-bars-${useId().replaceAll(':', '')}`;
  const entering = useChartEntrance({ anchor: host });
  if (!entities.length) return <div className="domain-empty">No Kubernetes resource observations</div>;
  return <div ref={host} className="kube-chart" data-chart-entering={entering || undefined} onKeyDown={inspect.onKeyDown}><svg width={width} height="222" role="group" aria-label={`${widget.title} · ${summary.label}`}>
    <defs><PlotHatchDefs id={uid}/></defs>
    {rows.map((row, i) => {
      const top = i * 106, max = Math.max(1, row.value ?? 0, row.requested, row.allocatable ?? 0, cfg.showLimits ? row.limit : 0), x = scaleLinear().domain([0, max]).nice(3).range([8, width - 12]);
      return <g key={row.id} className="kube-resource-row" data-active={inspect.item?.id === row.id} role={enabled ? 'button' : undefined} tabIndex={enabled ? 0 : undefined} aria-label={`${row.label}, observed ${fleetNumber(row.value)}, request ${fleetNumber(row.requested)}, limit ${fleetNumber(row.limit)} ${row.unit}`} aria-pressed={enabled ? inspect.pinned === row.id : undefined}
        onPointerEnter={() => { if (!inspect.pinned) inspect.setHover(row.id); }} onPointerLeave={() => { if (!inspect.pinned) inspect.setHover(null); }} onFocus={() => inspect.setHover(row.id)} onBlur={() => inspect.setHover(null)}
        onClick={event => enabled && inspect.select(row.id, event.currentTarget)} onKeyDown={event => { if (enabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); inspect.select(row.id, event.currentTarget); } }}>
        <rect className="kube-resource-hit" x="1" y={top + 1} width={width - 2} height="100" rx="3" fill="transparent"/><text x="7" y={top + 16} className="kube-emphasis">{row.label} · {row.unit}</text>
        {cfg.showValues && <text x={width - 12} y={top + 16} textAnchor="end">{fleetNumber(row.value)} observed</text>}
        <rect x={x(0)} y={top + 29} width={x(max) - x(0)} height="16" rx="3" fill={row.value === null ? plotHatchFill(uid) : 'var(--gamma-surface)'}/>
        {row.value !== null && <rect x={x(0)} y={top + 29} width={Math.max(0, x(row.value) - x(0))} height="16" rx="3" fill={row.color}/>}
        <rect x={x(0)} y={top + 48} width={x(row.requested) - x(0)} height="4" fill={C.blue}/>
        {row.allocatable !== null && <line x1={x(row.allocatable)} x2={x(row.allocatable)} y1={top + 23} y2={top + 56} stroke="var(--gamma-ink)" strokeWidth="1.5"/>}
        {cfg.showLimits && <line x1={x(row.limit)} x2={x(row.limit)} y1={top + 23} y2={top + 56} stroke={C.violet} strokeWidth="1.5" strokeDasharray="3 2"/>}
        {x.ticks(width < 360 ? 3 : 5).map(t => <text x={x(t)} y={top + 70} key={t} textAnchor="middle">{fleetNumber(t, 1)}</text>)}
        {cfg.showValues && <text x="8" y={top + 91}>Requested {fleetNumber(row.requested)} · {row.allocatable !== null ? `Allocatable ${fleetNumber(row.allocatable)}` : `Limit ${fleetNumber(row.limit)}`}</text>}
      </g>;
    })}
  </svg>{widget.options?.showLegend !== false && <div className="domain-legend"><span><i style={{ background: C.cyan }}/>Observed workload usage</span><span><i style={{ background: C.blue }}/>Request</span><span>Solid marker: allocatable</span>{cfg.showLimits && <span>Dashed marker: sum of limits</span>}<span>CPU {summary.cpuUsed.count}/{summary.expected} · memory {summary.memoryUsed.count}/{summary.expected} containers observed</span></div>}
    {inspect.item && <DomainInspector title={`${summary.label} · ${inspect.item.label}`} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[
      ['Observed workload usage', `${fleetNumber(inspect.item.value, 5)} ${inspect.item.unit}`], ['Request', `${fleetNumber(inspect.item.requested, 5)} ${inspect.item.unit}`], ['Limit sum', `${fleetNumber(inspect.item.limit, 5)} ${inspect.item.unit}`],
      ['Node allocatable', inspect.item.allocatable === null ? 'Belongs to parent node' : `${fleetNumber(inspect.item.allocatable)} ${inspect.item.unit}`], ['Coverage', `${inspect.item.count} / ${summary.expected} containers`], ['Scope', 'Container workloads; operating-system overhead excluded'],
    ]}/></DomainInspector>}
  </div>;
}

export function throttleColor(percent: number | null, ceiling: number) {
  if (percent === null) return C.muted;
  const p = Math.min(1, percent / ceiling);
  return p <= 0 ? 'var(--gamma-chart-empty)' : p >= .9 ? 'var(--gamma-danger)' : `var(--gamma-density-${Math.round(p * 23)})`;
}
export function KubernetesThrottleMatrix({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const cfg = throttleConfig.parse(widget.config ?? {}), data = useMemo(() => throttleRows(result.records), [result]), nodes = [...new Set(data.map(r => r.nodeId))];
  const [page, setPage] = useState(() => Math.max(0, Math.floor(nodes.indexOf(cfg.selectedNode) / cfg.rows)));
  useEffect(() => { const i = nodes.indexOf(cfg.selectedNode); if (i >= 0) setPage(Math.floor(i / cfg.rows)); else setPage(0); }, [result, cfg.selectedNode, cfg.rows]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(nodes.length / cfg.rows) - 1)), shown = nodes.slice(currentPage * cfg.rows, (currentPage + 1) * cfg.rows), visible = data.filter(d => shown.includes(d.nodeId));
  const host = useRef<HTMLDivElement>(null), width = usePlotWidth(host, 380), left = width < 340 ? 54 : 89, top = 49, rowHeight = 22, height = top + shown.length * rowHeight + 32;
  const entering = useChartEntrance({ anchor: host });
  const start = Math.min(...data.map(r => r.start)), end = Math.max(...data.map(r => r.end)), x = scaleLinear().domain([start, end]).range([left, width - 8]);
  const enabled = !embedded && widget.options?.showTooltip !== false, inspect = useInspection(visible, result, enabled, cfg.selectedNode, r => r.nodeId), uid = `kube-throttle-${useId().replaceAll(':', '')}`;
  const select = (id: string, target?: HTMLElement | SVGElement) => { const cell = visible.find(c => c.id === id); if (!enabled || !cell) return; inspect.select(id, target); onContextChange?.({ series: cell.nodeName, value: cell.percent, labels: { entityId: cell.nodeId, nodeId: cell.nodeId, timestamp: String(cell.end), bucketStart: String(cell.start), bucketEnd: String(cell.end) } }); };
  if (!data.length) return <div className="domain-empty">No CPU throttling observations</div>;
  return <div ref={host} className="kube-chart" data-chart-entering={entering || undefined} onKeyDown={inspect.onKeyDown}><svg width={width} height={height} role="group" aria-label={widget.title}>
    <defs><PlotHatchDefs id={uid}/><linearGradient id={`${uid}-scale`}>{Array.from({ length: 24 }, (_, i) => <stop key={i} offset={i / 23} stopColor={`var(--gamma-density-${i})`}/>)}</linearGradient></defs>
    <text x={left} y="13">% throttled periods</text><rect x={left} y="20" width={width - left - 8} height="7" fill={`url(#${uid}-scale)`}/>{[0, cfg.ceiling / 2, cfg.ceiling].map((v, i) => <text key={v} x={left + i / 2 * (width - left - 8)} y="41" textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}>{i === 2 ? '≥' : ''}{v}%</text>)}
    {shown.map((id, i) => <g key={id}><text x={left - 7} y={top + (i + .5) * rowHeight + 4} textAnchor="end" className={id === cfg.selectedNode ? 'kube-emphasis' : ''}>{width < 340 ? `N · ${id.slice(-2)}` : id}</text>{id === cfg.selectedNode && <rect x="0" y={top + i * rowHeight} width={width} height={rowHeight} fill="none" stroke={C.cyan}/>}</g>)}
    {visible.map(cell => { const y = top + shown.indexOf(cell.nodeId) * rowHeight, selected = inspect.item?.id === cell.id; return <g className={chartEntrance.revealMarks}><rect key={cell.id} className="kube-throttle-cell" data-active={selected} x={x(cell.start) + .5} y={y + .5} width={Math.max(0, x(cell.end) - x(cell.start) - 1)} height={rowHeight - 1} fill={cell.percent === null ? cell.expected ? plotHatchFill(uid) : 'var(--gamma-surface)' : throttleColor(cell.percent, cfg.ceiling)} stroke={selected ? C.orange : 'none'} strokeWidth="2"
      role={enabled ? 'button' : undefined} tabIndex={enabled ? 0 : undefined} aria-pressed={enabled ? inspect.pinned === cell.id : undefined} aria-label={`${cell.nodeName}, ${fleetTime(cell.start)} to ${fleetTime(cell.end)} UTC: ${cell.periods === 0 ? 'no observed CFS periods' : cell.percent === null ? cell.expected ? 'unavailable' : 'no matching containers' : `${fleetNumber(cell.percent)} percent throttled`}`}
      onPointerEnter={() => { if (!inspect.pinned) inspect.setHover(cell.id); }} onPointerLeave={() => { if (!inspect.pinned) inspect.setHover(null); }} onFocus={() => inspect.setHover(cell.id)} onBlur={() => inspect.setHover(null)} onClick={event => select(cell.id, event.currentTarget)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(cell.id, event.currentTarget); } }}/></g>; })}
    {inspect.item && <g className="kube-matrix-guides" pointerEvents="none" aria-hidden="true"><rect x={left} y={top + shown.indexOf(inspect.item.nodeId) * rowHeight} width={width - left - 8} height={rowHeight} fill="none" stroke="var(--gamma-ink)" strokeOpacity=".55"/><rect x={x(inspect.item.start)} y={top} width={x(inspect.item.end) - x(inspect.item.start)} height={shown.length * rowHeight} fill="none" stroke="var(--gamma-ink)" strokeOpacity=".35" strokeDasharray="3 3"/></g>}
    {x.ticks(width < 400 ? 3 : 5).map(t => <text key={t} x={x(t)} y={height - 8} textAnchor="middle">{fleetTime(t)}</text>)}
  </svg>{!embedded && <div className="kube-controls"><button className="domain-control" disabled={currentPage === 0} onClick={() => { inspect.dismiss(); setPage(p => p - 1); }}>Previous nodes</button><span>{currentPage * cfg.rows + 1}–{Math.min(nodes.length, (currentPage + 1) * cfg.rows)} / {nodes.length}</span><button className="domain-control" disabled={(currentPage + 1) * cfg.rows >= nodes.length} onClick={() => { inspect.dismiss(); setPage(p => p + 1); }}>Next nodes</button></div>}
    {inspect.item && <DomainInspector title={`${inspect.item.nodeName} · ${fleetTime(inspect.item.start)}–${fleetTime(inspect.item.end)} UTC`} pinned={!!inspect.pinned} onClose={inspect.dismiss}><DetailValues items={[
      ['Throttled / observed periods', `${fleetNumber(inspect.item.throttled, 0)} / ${fleetNumber(inspect.item.periods, 0)}`], ['Throttling rate', inspect.item.periods === 0 ? 'No observed CFS periods' : inspect.item.percent === null ? inspect.item.expected ? 'Unavailable' : 'No matching containers' : `${fleetNumber(inspect.item.percent, 4)}%`], ['Observed containers', `${inspect.item.observed} / ${inspect.item.expected}`], ['Interval start', new Date(inspect.item.start).toISOString()], ['Interval end', new Date(inspect.item.end).toISOString()], ['Window', `${fleetNumber((inspect.item.end - inspect.item.start) / 60000)} minutes · non-overlapping interval`],
    ]}/></DomainInspector>}
  </div>;
}

export function KubernetesResourceTrend({ widget, result, embedded, onContextChange }: WidgetRendererProps) {
  const cfg = resourceTrendConfig.parse(widget.config ?? {}), data = useMemo(() => resourceTimepoints(result.records), [result]);
  const host = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null), width = usePlotWidth(host, 720), left = width < 400 ? 43 : 52, right = 12, strip = 97, count = cfg.showNetwork ? 3 : 2, height = strip * count + 22;
  const entering = useChartEntrance({ anchor: host });
  const extent = data.length ? { start: data[0].timestamp, end: data.at(-1)!.timestamp } : null, view = useChartTimeWindow(extent, result, 5 * 60000);
  const visible = data.filter(p => p.timestamp >= view.window.start && p.timestamp <= view.window.end), x = scaleLinear().domain([view.window.start, view.window.end]).range([left, width - right]);
  const enabled = !embedded && widget.options?.showTooltip !== false, inspect = useInspection(visible, result, enabled, cfg.selectedAt === null ? undefined : String(cfg.selectedAt), row => String(row.timestamp));
  const observation = inspect.item, active = observation ?? visible.find(row => row.timestamp === cfg.selectedAt), uid = `kube-trend-${useId().replaceAll(':', '')}`;
  const fields: { label: string; unit: string; key: 'cpuUsed' | 'memoryUsed' | 'networkRx'; other: 'cpuRequested' | 'memoryRequested' | 'networkTx'; color: string; otherColor: string }[] = [{ label: 'Workload CPU', unit: 'cores', key: 'cpuUsed', other: 'cpuRequested', color: C.cyan, otherColor: C.blue }, { label: 'Memory', unit: 'GiB', key: 'memoryUsed', other: 'memoryRequested', color: C.violet, otherColor: C.blue }, ...(cfg.showNetwork ? [{ label: 'Network', unit: 'Mb/s', key: 'networkRx' as const, other: 'networkTx' as const, color: C.cyan, otherColor: C.violet }] : [])];
  const position = (clientX: number, clientY: number) => {
    const node = svg.current; if (!node) return null;
    const matrix = node.getScreenCTM(), rect = node.getBoundingClientRect(), p = matrix ? new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse()) : { x: (clientX - rect.left) * width / rect.width, y: (clientY - rect.top) * height / rect.height };
    const xx = Math.max(left, Math.min(width - right, p.x)); return { x: xx, y: p.y, timestamp: x.invert(xx), inPlot: p.x >= left && p.x <= width - right && p.y >= 22 && p.y <= strip * count - 13 };
  };
  const clear = inspect.dismiss;
  const brush = useTimeWindowBrush({ enabled: !embedded && view.enabled, revision: result, window: view.window, point: position, commit: view.commit, onStart: clear });
  const at = (timestamp: number, pin: boolean, target?: SVGElement) => {
    if (!enabled || !visible.length) return;
    const nearest = visible.reduce((a, b) => Math.abs(a.timestamp - timestamp) < Math.abs(b.timestamp - timestamp) ? a : b);
    if (pin) { inspect.select(nearest.id, target); onContextChange?.({ series: nearest.scopeLabel, value: nearest.cpuUsed, labels: { scopeId: nearest.scopeId, timestamp: String(nearest.timestamp) } }); } else if (!inspect.pinned) inspect.setHover(nearest.id);
  };
  if (!data.length) return <div className="domain-empty">No Kubernetes resource time observations</div>;
  return <div ref={host} className="kube-chart" data-chart-entering={entering || undefined} onKeyDown={event => { if (event.key === 'Escape' && observation && !brush.active) { event.preventDefault(); event.stopPropagation(); clear(); } }}>
    <div className="kube-brush" {...brush.handlers}><svg ref={svg} width={width} height={height} role="group" aria-label={`${widget.title}. Drag to zoom, arrows inspect, Enter pins.`} tabIndex={enabled ? 0 : undefined}
      onPointerMove={event => { if (brush.active) return; const p = position(event.clientX, event.clientY); if (p?.inPlot) at(p.timestamp, false); else inspect.setHover(null); }} onPointerLeave={() => inspect.setHover(null)} onFocus={() => { const row = active ?? visible[0]; if (!inspect.item && row) inspect.setHover(row.id); }} onBlur={() => inspect.setHover(null)} onClick={event => { const p = position(event.clientX, event.clientY); if (p?.inPlot) at(p.timestamp, true, event.currentTarget); }}
      onKeyDown={event => { if (!enabled) return; if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); const index = visible.findIndex(p => p.id === active?.id), next = visible[Math.max(0, Math.min(visible.length - 1, (index < 0 ? 0 : index) + (event.key === 'ArrowRight' ? 1 : -1)))]; if (next) { if (inspect.pinned) inspect.dismiss(); inspect.setHover(next.id); } } else if (event.key === 'Enter' && active) { event.preventDefault(); at(active.timestamp, true, event.currentTarget); } }}>
      <defs>{fields.map(field => <linearGradient key={field.key} id={`${uid}-${field.key}`} x1="0" x2="0" y1="0" y2="1"><stop stopColor={field.color} stopOpacity=".35"/><stop offset="1" stopColor={field.color} stopOpacity=".02"/></linearGradient>)}</defs>
      {active && <line pointerEvents="none" x1={x(active.timestamp)} x2={x(active.timestamp)} y1="22" y2={strip * count - 13} stroke="var(--gamma-ink)" strokeDasharray="4 3" strokeOpacity=".65"/>}
      {fields.map((field, i) => {
        const top = strip * i + 22, bottom = strip * (i + 1) - 14, showOther = field.key === 'networkRx' || cfg.showRequested, max = Math.max(1, ...data.flatMap(p => [p[field.key] ?? 0, showOther ? p[field.other] ?? 0 : 0])), y = scaleLinear().domain([0, max * 1.12]).nice(3).range([bottom, top]);
        const primary = line<FleetTimepoint>().defined(p => p[field.key] !== null).x(p => x(p.timestamp)).y(p => y(p[field.key]!));
        return <g key={field.key}><text x="4" y={top - 8} className="kube-emphasis">{field.label} · {field.unit}</text>
          {y.ticks(2).map(t => <g key={t}><line x1={left} x2={width - right} y1={y(t)} y2={y(t)} className="kube-grid"/><text x={left - 6} y={y(t) + 4} textAnchor="end">{fleetNumber(t, 1)}</text></g>)}
          {x.ticks(width < 400 ? 4 : 8).map(t => <line key={t} x1={x(t)} x2={x(t)} y1={top} y2={bottom} className="kube-grid"/>)}
          {cfg.fill && <path d={area<FleetTimepoint>().defined(p => p[field.key] !== null).x(p => x(p.timestamp)).y0(bottom).y1(p => y(p[field.key]!))(visible) ?? ''} fill={`url(#${uid}-${field.key})`}/>}
          <path d={primary(visible) ?? ''} fill="none" stroke={field.color} strokeWidth="1.6"/>
          {visible.length === 1 && visible[0][field.key] !== null && <circle cx={x(visible[0].timestamp)} cy={y(visible[0][field.key]!)} r="3.2" fill={field.color}><title>{`${fleetTime(visible[0].timestamp)} UTC · ${field.label}: ${fleetNumber(visible[0][field.key], 4)} ${field.unit}`}</title></circle>}
          {showOther && <path d={line<FleetTimepoint>().defined(p => p[field.other] !== null).x(p => x(p.timestamp)).y(p => y(p[field.other]!))(visible) ?? ''} fill="none" stroke={field.otherColor} strokeWidth="1.3" strokeDasharray={field.key === 'networkRx' ? undefined : '5 3'}/>}
          {active && active[field.key] !== null && <g className="kube-point-focus" pointerEvents="none"><circle cx={x(active.timestamp)} cy={y(active[field.key]!)} r="6" fill="none" stroke={field.color} strokeOpacity=".6"/><circle cx={x(active.timestamp)} cy={y(active[field.key]!)} r="3.4" fill={field.color} stroke="var(--gamma-bg)" strokeWidth="1.5"/></g>}
          {active && showOther && active[field.other] !== null && <circle pointerEvents="none" cx={x(active.timestamp)} cy={y(active[field.other]!)} r="3" fill="var(--gamma-bg)" stroke={field.otherColor} strokeWidth="1.5"/>}
          {visible.every(p => p[field.key] === null) && <text x={(left + width - right) / 2} y={(top + bottom) / 2} textAnchor="middle">Observations unavailable</text>}
        </g>;
      })}
      {x.ticks(width < 400 ? 3 : 7).map(t => <text key={t} x={x(t)} y={height - 4} textAnchor="middle">{fleetTime(t)}</text>)}
      {brush.preview && <rect pointerEvents="none" x={Math.min(brush.preview.x1, brush.preview.x2)} y="22" width={Math.abs(brush.preview.x2 - brush.preview.x1)} height={strip * count - 35} fill={C.cyan} fillOpacity=".14" stroke={C.cyan}/>}
    </svg></div>
    {widget.options?.showLegend !== false && <div className="domain-legend"><span>Solid: observed usage{cfg.showNetwork ? ' / ingress' : ''}</span>{cfg.showRequested && <span>Dashed: request</span>}{cfg.showNetwork && <span>Violet network: egress</span>}<span>{data.at(-1)!.observed}/{data.at(-1)!.expected} containers observed</span></div>}
    {!embedded && view.enabled && <TimeWindowControls state={view} compact description="Zoom changes this chart window. Snapshot requests, placement and other panels retain their original scope."/>}
    {observation && <DomainInspector title={`${observation.scopeLabel} · ${fleetTime(observation.timestamp)} UTC`} pinned={!!inspect.pinned} onClose={clear}><DetailValues items={[
      ['Timestamp', new Date(observation.timestamp).toISOString()], ['CPU observed / requested', `${fleetNumber(observation.cpuUsed, 4)} / ${fleetNumber(observation.cpuRequested, 4)} cores`], ['Memory observed / requested', `${fleetNumber(observation.memoryUsed, 4)} / ${fleetNumber(observation.memoryRequested, 4)} GiB`], ['Network ingress / egress', `${fleetNumber(observation.networkRx, 4)} / ${fleetNumber(observation.networkTx, 4)} Mb/s`], ['Coverage', `${observation.observed} / ${observation.expected} containers · missing values excluded from observed sums`],
    ]}/></DomainInspector>}
  </div>;
}
