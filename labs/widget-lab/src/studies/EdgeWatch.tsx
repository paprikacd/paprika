import { useMemo, useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, Clock3, Network, RefreshCw, ShieldBan, Table2, MousePointer2, Pin, Info } from 'lucide-react';
import { MetricCard, Panel, Sparkline, StatusBadge } from '../components/lab/StudyPrimitives';
import { useDemoReplay } from '../components/lab/motion';
import { GammaButton } from '../vendor/paprika/ui/src/features/insights/gamma/button';
import { GammaSelect } from '../vendor/paprika/ui/src/features/insights/gamma/select';
import { ChartCursorProvider, useChartCursor, useChartCursorPublisher } from '../vendor/paprika/ui/src/features/insights/chart-cursor';
import { WidgetVisualization } from '../vendor/paprika/ui/src/features/insights/charts';
import type { Widget } from '../vendor/paprika/ui/src/features/insights/schema';
import { buildEdgeTelemetry, makeEdgeChartResult, type EdgeDataset, type EdgeGateway, type EdgeMinutes, type EdgeResolution, type EdgeTrafficPoint, type EdgeRule, type EdgeScenario } from '../data/edge-telemetry';
import styles from './EdgeWatch.module.css';

const number = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const clock = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const preciseClock = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const date = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const format = (value: number | null, digits = false) => value === null ? '—' : (digits ? decimal : number).format(value);
const percent = (ratio: number | null) => ratio === null ? '—' : `${decimal.format(ratio * 100)}%`;
const change = (ratio: number | null, complete: boolean, minutes: number) => complete && ratio !== null ? `${ratio >= 0 ? '+' : ''}${(ratio * 100).toFixed(1)}% · later vs earlier ${Math.floor(minutes / 2)}m` : 'Observed interval mean · partial coverage';
const SCENARIOS = [{ value: 'incident', label: 'Traffic surge' }, { value: 'steady', label: 'Steady traffic' }, { value: 'gaps', label: 'Missing samples' }];
const GATEWAYS = [{ value: 'all', label: 'All gateways' }, { value: 'edge-01', label: 'edge-01 · Sydney' }, { value: 'edge-02', label: 'edge-02 · Singapore' }];
const RULES = [{ value: 'all', label: 'All rules' }, { value: 'rate-limit', label: 'Rate limit' }, { value: 'request-signature', label: 'Request signature' }, { value: 'connection-limit', label: 'Connection limit' }];

function EdgeObservation({ data, resolution }: { data: EdgeDataset; resolution: EdgeResolution }) {
  const cursor = useChartCursor();
  const publisher = useChartCursorPublisher();
  const outcomesSource = cursor?.source === 'edge-outcomes';
  const samples = outcomesSource || resolution === '1m' ? data.points : data.samples10s;
  const point = cursor ? samples.find(item => item.timestampMs === cursor.timestamp) : undefined;
  if (!point) return <div className={styles.observation}><MousePointer2 size={13} /><span>{resolution} fixture samples · egress mirrored</span><span className={styles.observationHint}>Hover · arrows · Enter to pin</span></div>;
  const interval = outcomesSource ? '1m outcomes' : `${resolution} traffic`;
  return <div className={styles.observation} data-edge-observation=""><span className={styles.observationTitle}>{cursor?.pinned ? <Pin size={13} /> : <MousePointer2 size={13} />}{!outcomesSource && resolution === '10s' ? preciseClock.format(point.timestampMs) : clock.format(point.timestampMs)}<span className={styles.observationCadence}>{interval}</span></span>{point.requests === null ? <span>Missing observation</span> : <><span><i className={styles.cyanDot} />Ingress <strong>{format(point.ingressMbps, true)}</strong></span><span><i className={styles.violetDot} />Egress <strong>{format(point.egressMbps, true)}</strong></span><span>Blocked <strong>{format(point.blocked)}</strong></span></>}{cursor?.pinned && outcomesSource && <GammaButton size="sm" variant="ghost" onClick={() => publisher.clear('edge-outcomes')}>Clear pin</GammaButton>}</div>;
}

function OutcomeBars({ data }: { data: EdgeDataset }) {
  const cursor = useChartCursor();
  const publisher = useChartCursorPublisher();
  const maximum = Math.max(1_000, Math.ceil(Math.max(0, ...data.points.map(point => point.requests ?? 0)) / 1_000) * 1_000);
  const ticks = [0, Math.floor(data.points.length / 2), data.points.length - 1];
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === 'Escape') { publisher.clear('edge-outcomes'); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const next = Math.min(data.points.length - 1, Math.max(0, index + (event.key === 'ArrowRight' ? 1 : -1)));
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
    }
  }
  return <div className={styles.outcomes}>
    <div className={styles.outcomeScale}><span>{number.format(Math.ceil(maximum / 1_000))}k</span><span>Requests / minute</span></div>
    <div className={styles.bars} role="group" aria-label="Request outcomes by minute. Use left and right arrow keys to inspect intervals.">
      {data.points.map((point, index) => <button key={point.timestampMs} className={`${styles.bar} ${point.requests === null ? styles.missingBar : ''} ${cursor?.timestamp === point.timestampMs ? styles.selectedBar : ''}`} type="button" aria-label={`${clock.format(point.timestampMs)}: ${point.requests === null ? 'missing observation' : `${number.format(point.allowed!)} allowed, ${number.format(point.challenged!)} challenged, ${number.format(point.blocked!)} blocked requests`}`} aria-pressed={cursor?.timestamp === point.timestampMs && cursor.pinned} title={`${clock.format(point.timestampMs)} · ${point.requests === null ? 'Missing' : `${number.format(point.requests)} requests`}`} tabIndex={cursor?.source === 'edge-outcomes' ? (cursor.timestamp === point.timestampMs ? 0 : -1) : (index === 0 ? 0 : -1)} onFocus={() => { if (!cursor?.pinned) publisher.publish('edge-outcomes', point.timestampMs); }} onBlur={() => { if (!(cursor?.source === 'edge-outcomes' && cursor.pinned)) publisher.clear('edge-outcomes'); }} onMouseEnter={() => { if (!cursor?.pinned) publisher.publish('edge-outcomes', point.timestampMs); }} onMouseLeave={() => { if (!(cursor?.source === 'edge-outcomes' && cursor.pinned)) publisher.clear('edge-outcomes'); }} onClick={() => cursor?.source === 'edge-outcomes' && cursor.timestamp === point.timestampMs && cursor.pinned ? publisher.clear('edge-outcomes') : publisher.publish('edge-outcomes', point.timestampMs, true)} onKeyDown={event => keyDown(event, index)}>
        {point.requests !== null && <span className={styles.stack} style={{ height: `${point.requests / maximum * 100}%` }}><span className={styles.blockedSegment} style={{ height: `${point.blocked! / point.requests * 100}%` }} /><span className={styles.challengedSegment} style={{ height: `${point.challenged! / point.requests * 100}%` }} /><span className={styles.allowedSegment} style={{ height: `${point.allowed! / point.requests * 100}%` }} /></span>}
      </button>)}
    </div>
    <div className={styles.barTicks}>{ticks.map(index => <span key={index}>{clock.format(data.points[index].timestampMs)}</span>)}</div>
    <div className={styles.outcomeLegend}><span><i className={styles.cyanDot} />Allowed <strong>{percent(data.summary.requests ? data.summary.allowed / data.summary.requests : null)}</strong></span><span><i className={styles.amberDot} />Challenged <strong>{percent(data.summary.requests ? data.summary.challenged / data.summary.requests : null)}</strong></span><span><i className={styles.redDot} />Blocked <strong>{percent(data.summary.blockedRatio)}</strong></span></div>
  </div>;
}

function ExactIntervals({ points, resolution }: { points: EdgeTrafficPoint[]; resolution: EdgeResolution }) {
  return <div className={styles.exactTable}><table><caption>Exact {resolution} synthetic intervals, labelled by interval end. Egress is a positive magnitude; only the plot mirrors its direction. {resolution === '10s' ? 'Every six intervals conserve their original minute totals.' : 'Minute totals are the source for summaries and request outcomes.'}</caption><thead><tr><th>Time</th><th>Ingress Mb/s</th><th>Egress Mb/s</th><th>Requests</th><th>Allowed</th><th>Challenged</th><th>Blocked</th></tr></thead><tbody>{points.map(point => <tr key={point.timestampMs}><td>{resolution === '10s' ? preciseClock.format(point.timestampMs) : clock.format(point.timestampMs)}</td><td>{format(point.ingressMbps, true)}</td><td>{format(point.egressMbps, true)}</td><td>{format(point.requests)}</td><td>{format(point.allowed)}</td><td>{format(point.challenged)}</td><td>{format(point.blocked)}</td></tr>)}</tbody></table></div>;
}

export function EdgeWatch({ theme, narrow }: { theme: 'dark' | 'light'; narrow: boolean }) {
  const [scenario, setScenario] = useState<EdgeScenario>('incident');
  const [gateway, setGateway] = useState<EdgeGateway>('all');
  const [minutes, setMinutes] = useState<EdgeMinutes>(30);
  const [resolution, setResolution] = useState<EdgeResolution>('10s');
  const [revision, setRevision] = useState(0);
  useDemoReplay(() => setRevision(value => value + 1));
  const [rule, setRule] = useState<EdgeRule | 'all'>('all');
  const [showExact, setShowExact] = useState(false);
  const [showAllEvents, setShowAllEvents] = useState(false);
  const data = useMemo(() => buildEdgeTelemetry({ scenario, gateway, minutes, revision }), [scenario, gateway, minutes, revision]);
  const trafficPoints = resolution === '10s' ? data.samples10s : data.points;
  const results = useMemo(() => makeEdgeChartResult(data, resolution), [data, resolution]);
  const widget: Widget = useMemo(() => {
    const maximum = Math.max(200, Math.ceil(Math.max(...trafficPoints.map(point => point.ingressMbps ?? 0), ...trafficPoints.map(point => point.egressMbps ?? 0)) / 200) * 200);
    return { id: 'edge-traffic', title: 'Gateway traffic', type: 'timeseries', providerId: 'synthetic-fixture', query: 'edge_traffic_fixture', unit: 'Mb/s', layout: { x: 0, y: 0, w: 8, h: 4 }, options: { display: 'area', curve: 'linear', showGrid: true, showLegend: true, showTooltip: true, decimals: 2, lineWidth: 1.6, fillOpacity: 0.28, fillStyle: 'gradient', gridX: true, timeAxis: 'calendar', axisUnit: 'caption', showZeroLine: true, inspectorDensity: 'compact', min: -maximum, max: maximum, tooltipView: { type: 'timeseries', source: { type: 'series' }, title: 'Selected series history', height: 80, showGrid: false, showAxis: false, showLegend: false, decimals: 2 } } };
  }, [trafficPoints]);
  const filteredEvents = data.events.filter(event => rule === 'all' || event.rule === rule);
  const events = showAllEvents ? filteredEvents : filteredEvents.slice(0, 4);
  const destinationMaximum = Math.max(1, ...data.destinations.map(destination => destination.meanMbps));
  const scopeKey = `${scenario}-${gateway}-${minutes}-${revision}-${resolution}`;
  const half = Math.floor(minutes / 2);
  return <section className={`${styles.study} ${narrow ? styles.narrow : ''}`} data-edge-theme={theme} aria-label="Edge Watch dashboard">
    <div className={`study-toolbar ${styles.toolbar}`}>
      <h1>Edge <span>/</span> Network activity</h1>
      <div className={styles.filter}><label id="edge-gateway-label">Gateway</label><GammaSelect aria-labelledby="edge-gateway-label" value={gateway} options={GATEWAYS} onValueChange={value => setGateway(value as EdgeGateway)} size="sm" /></div>
      <div className={styles.filter}><label id="edge-fixture-label">Fixture</label><GammaSelect aria-labelledby="edge-fixture-label" value={scenario} options={SCENARIOS} onValueChange={value => { setScenario(value as EdgeScenario); setRevision(0); }} size="sm" /></div>
      <div className={styles.toolbarEnd}><div role="group" aria-label="Edge time window" className={styles.timeButtons}>{([15, 30, 60] as const).map(value => <GammaButton key={value} size="sm" variant={minutes === value ? 'primary' : 'ghost'} aria-pressed={minutes === value} onClick={() => setMinutes(value)}>{value}m</GammaButton>)}</div><GammaButton variant="secondary" size="sm" onClick={() => setRevision(value => value + 1)}><RefreshCw size={13} />Next snapshot</GammaButton></div>
    </div>
    <div className={styles.scope}><span><Clock3 size={12} />{date.format(data.endMs)} · {clock.format(data.startMs)}–{clock.format(data.endMs)} · {timezone}</span><span>Synthetic fixture · snapshot {revision + 1} · 1m summaries</span></div>
    {data.coverage < 1 && <div className={styles.coverage} role="status"><Info size={14} /><span>{Math.round(data.coverage * 100)}% of intervals observed. Missing intervals remain gaps; summaries use observed intervals. Latest sample is {data.lastObservedMs === null ? 'unavailable' : `${(data.endMs - data.lastObservedMs) / 60_000}m before the window end`}.</span></div>}
    <div className={`kpi-grid ${styles.metrics}`} data-edge-summary="">
      <MetricCard label="Mean ingress" value={format(data.summary.ingressMbps, true)} unit="Mb/s" detail={change(data.summary.ingressChange, data.coverage === 1, minutes)} trend={data.points.map(point => point.ingressMbps)} tone="cyan" icon={<ArrowDown size={19} />} />
      <MetricCard label="Mean egress" value={format(data.summary.egressMbps, true)} unit="Mb/s" detail={change(data.summary.egressChange, data.coverage === 1, minutes)} trend={data.points.map(point => point.egressMbps)} tone="violet" icon={<ArrowUp size={19} />} />
      <MetricCard label="Blocked requests" value={percent(data.summary.blockedRatio)} detail={`${number.format(data.summary.blocked)} of ${number.format(data.summary.requests)} observed`} trend={data.points.map(point => point.requests ? point.blocked! / point.requests * 100 : null)} tone="red" icon={<ShieldBan size={19} />} />
      <MetricCard label="Active connections" value={format(data.summary.activeConnections)} detail={`Latest observed · ${data.lastObservedMs === null ? '—' : clock.format(data.lastObservedMs)}`} trend={data.points.map(point => point.activeConnections)} tone="amber" icon={<Network size={19} />} />
    </div>
    <ChartCursorProvider key={scopeKey}>
      <div className={styles.primaryGrid}>
        <Panel title="Traffic flow" subtitle={`${resolution} interval-ending synthetic observations. The 10s fixture partitions each minute into six integer-count buckets; it does not interpolate production telemetry. Egress is mirrored below zero. Window means use observed intervals; deltas compare equal ${half}m halves${minutes % 2 ? ', with the first minute excluded' : ''}.`} actions={<div className={styles.chartActions}><span className={styles.panelMeta}>Mb/s</span><div role="group" aria-label="Traffic fixture sampling" className={styles.samplingButtons}>{(['10s', '1m'] as const).map(value => <GammaButton key={value} size="sm" variant={resolution === value ? 'secondary' : 'ghost'} aria-pressed={resolution === value} onClick={() => setResolution(value)}>{value}</GammaButton>)}</div></div>} className={styles.flowPanel}>
          <div className={styles.trafficChart}><WidgetVisualization widget={widget} result={results} /></div>
          <EdgeObservation data={data} resolution={resolution} />
        </Panel>
        <Panel title="Top destinations" subtitle={`Selected gateway scope. Mean inbound traffic uses observed minute intervals. All traffic bars share a 0–${format(destinationMaximum, true)} Mb/s domain, ending at the highest destination mean in this scope. Share is a separate fraction of the same observed inbound byte total.`} actions={<span className={styles.panelMeta}>Inbound traffic</span>} className={styles.destinationsPanel}>
          <div className={styles.tableScroll}><table className={styles.destinations}><thead><tr><th>#</th><th>Destination</th><th>Mean Mb/s</th><th>Share</th></tr></thead><tbody>{data.destinations.map((destination, index) => <tr key={destination.address}><td className={styles.rank}>{index + 1}</td><td title={destination.name} aria-label={`${destination.address}, ${destination.name}`}><span className={styles.identifier}>{destination.address}</span></td><td className={styles.numeric}><div className={styles.trafficCell}><span>{format(destination.meanMbps, true)}</span><span className={styles.trafficTrack} aria-hidden="true"><i style={{ width: `${destination.meanMbps / destinationMaximum * 100}%` }} /></span></div></td><td className={styles.numeric}>{(destination.share * 100).toFixed(1)}%</td></tr>)}</tbody></table></div>
        </Panel>
      </div>
      <div className={styles.secondaryGrid}>
        <Panel title="Gateway contribution" subtitle="Selected population · mean inbound traffic" className={styles.gatewayPanel}>
          <div className={styles.gatewayRows}>{data.gateways.map(item => <div className={styles.gatewayRow} key={item.id}><div className={styles.gatewayHeading}><strong>{item.name}</strong><span className={styles.identifier}>{item.id}</span><strong className={styles.gatewayRate}>{format(item.meanMbps, true)} <small>Mb/s</small></strong></div><Sparkline values={item.trend} color="var(--gamma-chart-1)" height={24} label={`${item.name} inbound traffic trend`} /><div className={styles.gatewayDetail}><span>{item.region}</span><span>{percent(item.blockedRatio)} blocked</span>{item.coverage < 1 && <StatusBadge tone="amber">{Math.round(item.coverage * 100)}% observed</StatusBadge>}</div></div>)}</div>
        </Panel>
        <Panel title="Request outcomes" subtitle="One-minute buckets · exclusive outcomes" className={styles.outcomesPanel}><OutcomeBars data={data} /></Panel>
        <Panel title="Protocol distribution" subtitle="Share of observed requests" className={styles.protocolPanel}>
          <div className={styles.protocolRows}>{data.protocols.map((item, index) => <div className={styles.protocolRow} key={item.name}><div><span>{item.name}</span><small>{number.format(item.requests)} req</small><strong>{(item.share * 100).toFixed(1)}%</strong></div><div className={styles.protocolTrack}><i style={{ width: `${item.share * 100}%`, background: index % 2 ? 'var(--gamma-chart-2)' : 'var(--gamma-chart-1)' }} /></div></div>)}</div>
        </Panel>
      </div>
    </ChartCursorProvider>
    <Panel title="Recent blocked requests" subtitle="Synthetic policy batches with exact per-minute counts and documentation-range IP addresses. With All rules selected, the complete list sums to the selected scope's blocked count." actions={<GammaSelect aria-label="Blocked request rule" value={rule} options={RULES} onValueChange={value => { setRule(value as EdgeRule | 'all'); setShowAllEvents(false); }} size="sm" />} className={styles.eventsPanel}>
      <div id="edge-event-rows" className={`${styles.tableScroll} ${styles.eventTableScroll}`}><table className={styles.events}><thead><tr><th>Time</th><th>Gateway</th><th>Source</th><th>Destination</th><th>Rule</th><th>Count</th><th>Status</th></tr></thead><tbody>{events.map(event => <tr key={event.id}><td>{clock.format(event.timestampMs)}</td><td>{event.gateway}</td><td className={styles.identifier}>{event.source}</td><td className={styles.identifier}>{event.destination}</td><td>{event.rule}</td><td className={styles.numeric}>{number.format(event.count)}</td><td><StatusBadge tone="red">Blocked</StatusBadge></td></tr>)}</tbody></table></div>
      <div className={styles.eventFooter}><span>{events.length} of {filteredEvents.length} · 1m policy batches</span><div className={styles.eventActions}>{filteredEvents.length > 4 && <GammaButton variant="ghost" size="sm" onClick={() => setShowAllEvents(value => !value)} aria-expanded={showAllEvents} aria-controls="edge-event-rows">{showAllEvents ? 'Show recent' : `Show all ${filteredEvents.length}`}</GammaButton>}<GammaButton variant="ghost" size="sm" onClick={() => setShowExact(value => !value)} aria-expanded={showExact} aria-controls="edge-exact-data"><Table2 size={13} />{showExact ? 'Hide intervals' : 'Exact intervals'}</GammaButton></div></div>
    </Panel>
    {showExact && <div id="edge-exact-data"><Panel title="Exact network intervals" subtitle={`${trafficPoints.length} intervals · ${resolution} cadence · ${timezone}`}><ExactIntervals points={trafficPoints} resolution={resolution} /></Panel></div>}
  </section>;
}

export default EdgeWatch;
