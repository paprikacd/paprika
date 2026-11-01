import { useDashboardPanels } from '../components/lab/DashboardWorkbench';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { Activity, ArrowUpRight, Check, ChevronLeft, ChevronRight, Clock3, Info, RefreshCw, ShieldCheck, Target, TriangleAlert, X } from 'lucide-react';
import { ChartCursorProvider, useChartCursor } from '@insights/chart-cursor';
import { WidgetVisualization } from '../renderer-extensions/charts';
import { GammaButton } from '@insights/gamma/button';
import { GammaSelect } from '@insights/gamma/select';
import type { QueryResult, Widget } from '../renderer-extensions/schema';
import { MetricCard, Panel, StatusBadge, EmptyNotice } from '../components/lab/StudyPrimitives';
import { useDemoReplay } from '../components/lab/motion';
import { HOUR_MS, RELIABILITY_SERVICES, buildReliability, incidentCalendar, reliabilityBurnSeries, reliabilityIncidents, reliabilityTimeline, summarizeReliability, type BurnPoint, type IncidentCalendarDay, type ReliabilityScenario, type ReliabilityScope, type ReliabilityServiceId, type ReliabilityWindow, type StateInterval } from '../data/reliability';
import styles from './ReliabilityRoom.module.css';

const int = new Intl.NumberFormat('en', { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat('en', { maximumFractionDigits: 1 });
const exactAllowance = new Intl.NumberFormat('en', { maximumFractionDigits: 3 });
const day = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
const dateTime = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const percent = (value: number | null, digits = 2) => value === null ? '—' : (value * 100).toFixed(digits);
const burnLabel = (value: number | null) => value === null ? '—' : `${value.toFixed(2)}×`;
const SERVICE_OPTIONS = [{ value: 'all', label: 'All services' }, ...RELIABILITY_SERVICES.map(service => ({ value: service.id, label: service.id }))];
const SCENARIO_OPTIONS = [{ value: 'incident', label: 'Incident replay' }, { value: 'steady', label: 'Steady service' }, { value: 'gaps', label: 'Missing samples' }];
const WINDOW_OPTIONS = [{ value: '30', label: 'Last 30 days' }, { value: '7', label: 'Last 7 days' }, { value: '1', label: 'Last 24 hours' }];

const BURN_WIDGET: Widget = {
  id: 'reliability-burn', title: 'Availability burn rate', type: 'timeseries', unit: '×',
  providerId: 'synthetic-fixture', query: 'request_based_availability_burn', layout: { x: 0, y: 0, w: 8, h: 4 },
  options: { display: 'area', curve: 'linear', min: 0, showGrid: true, gridX: true, showLegend: true, showTooltip: true, decimals: 2, lineWidth: 1.6,
    timeAxis: 'calendar', fillStyle: 'gradient', fillOpacity: 0.16, axisUnit: 'caption', inspectorDensity: 'compact',
    referenceLines: [{ value: 1, label: 'Budget pace 1×', style: 'dashed' }],
    tooltipView: { type: 'timeseries', source: { type: 'series' }, height: 80, showGrid: false, showAxis: false, showLegend: false, decimals: 2 } },
};

function BurnReadout({ points }: { points: BurnPoint[] }) {
  const cursor = useChartCursor();
  const point = cursor ? points.find(item => item.timestampMs === cursor.timestamp) : points.at(-1);
  return <div className={styles.readout} data-reliability-observation="">
    <span className={styles.readoutLabel}><span className={styles.cursorDot} />{cursor ? cursor.pinned ? 'Pinned observation' : 'Selected observation' : 'Latest interval'}<strong>{point ? dateTime.format(point.timestampMs) : 'No observation'}</strong></span>
    <span><i className={styles.swatch} />1h <strong>{burnLabel(point?.oneHour ?? null)}</strong></span>
    <span><i className={`${styles.swatch} ${styles.violet}`} />6h <strong>{burnLabel(point?.sixHour ?? null)}</strong></span>
    <span className={styles.readoutRequests}>{!point ? 'Reference boundary · no observation' : point.requests === null ? 'Incomplete interval' : `${int.format(point.requests)} requests · ${int.format(point.failures ?? 0)} failures`}</span>
  </div>;
}

export function ReliabilityRoom({ theme, narrow }: { theme: 'dark' | 'light'; narrow: boolean }) {
  const panels = useDashboardPanels(), burnWidget = panels.current(BURN_WIDGET);
  const [scope, setScope] = useState<ReliabilityScope>('all');
  const [days, setDays] = useState<ReliabilityWindow>(30);
  const [scenario, setScenario] = useState<ReliabilityScenario>('incident');
  const [revision, setRevision] = useState(0);
  const [selection, setSelection] = useState<{ service: ReliabilityServiceId; index: number } | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);
  const [accountingOpen, setAccountingOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState<string | null>(null);
  const [calendarDay, setCalendarDay] = useState<string | null>(null);
  const [calendarFocus, setCalendarFocus] = useState<string | null>(null);
  const dataset = useMemo(() => buildReliability(days, scenario, revision), [days, scenario, revision]);
  const summary = useMemo(() => summarizeReliability(dataset, scope), [dataset, scope]);
  const points = useMemo(() => reliabilityBurnSeries(dataset, scope), [dataset, scope]);
  const availabilityTrend = useMemo(() => points.map(point => point.oneHour === null ? null : 100 - point.oneHour * 0.1), [points]);
  const availabilityTrendLower = useMemo(() => {
    const observed = availabilityTrend.filter((value): value is number => value !== null);
    return Math.min(99.9, Math.floor((observed.length ? Math.min(...observed) : 99.9) * 10) / 10);
  }, [availabilityTrend]);
  const services = useMemo(() => RELIABILITY_SERVICES.map(service => ({ ...service, summary: summarizeReliability(dataset, service.id), burn: reliabilityBurnSeries(dataset, service.id).at(-1)!, intervals: reliabilityTimeline(dataset, service.id) })).sort((a, b) => (a.summary.budgetRemaining ?? -1) - (b.summary.budgetRemaining ?? -1)), [dataset]);
  const incidents = useMemo(() => reliabilityIncidents(dataset, scope), [dataset, scope]);
  const calendar = useMemo(() => incidentCalendar({ startMs: dataset.startMs, endMs: dataset.endMs, incidents, timeZone: timezone, month: calendarMonth }), [dataset, incidents, calendarMonth]);
  const selectedDay = calendar.days.find(item => item.key === calendarDay);
  const displayedIncidents = selectedDay ? incidents.filter(incident => selectedDay.episodeIds.includes(incident.id)) : incidents;
  const monthIndex = calendar.availableMonths.indexOf(calendar.month);
  const calendarTabKey = calendar.days.some(item => item.key === calendarFocus && item.inWindow) ? calendarFocus : calendar.days.find(item => item.inWindow && item.inMonth)?.key ?? calendar.days.find(item => item.inWindow)?.key;
  const result = useMemo<QueryResult>(() => ({ series: [
    { name: '1h burn rate', labels: { service: scope, slo: '99.90%', window: '1 hour', meaning: 'Observed error ratio divided by allowed error ratio' }, points: points.map(point => ({ timestamp: point.timestampMs, value: point.oneHour })) },
    { name: '6h burn rate', labels: { service: scope, slo: '99.90%', window: '6 hours', meaning: 'Observed error ratio divided by allowed error ratio' }, points: points.map(point => ({ timestamp: point.timestampMs, value: point.sixHour })) },
  ] }), [dataset, points, scope]);
  const activeService = selection ? services.find(service => service.id === selection.service) : undefined;
  const activeInterval = activeService && selection ? activeService.intervals[selection.index] : undefined;
  const remaining = summary.budgetRemaining;
  const remainingFailures = summary.allowedFailures - summary.failures;
  const budgetTone = remaining === null ? 'muted' : remaining < 0.25 ? 'red' : remaining < 0.5 ? 'amber' : 'green';
  const observed = summary.coverage < 1;
  const clearSelection = () => { setSelection(null); setFocusIndex(0); setCalendarDay(null); setCalendarFocus(null); setCalendarMonth(null); };
  useDemoReplay(() => { setRevision(value => value + 1); clearSelection(); });
  function selectService(value: string) { setScope(value as ReliabilityScope); clearSelection(); }
  function onTimelineKey(event: KeyboardEvent<HTMLButtonElement>, service: ReliabilityServiceId, index: number, length: number) {
    const next = event.key === 'ArrowRight' ? Math.min(index + 1, length - 1) : event.key === 'ArrowLeft' ? Math.max(index - 1, 0) : event.key === 'Home' ? 0 : event.key === 'End' ? length - 1 : null;
    if (next === null) return;
    event.preventDefault(); setFocusIndex(next); setSelection({ service, index: next });
    document.getElementById(`reliability-cell-${service}-${next}`)?.focus();
  }
  function describeInterval(service: string, interval: StateInterval) {
    return `${service}, ${dateTime.format(interval.startMs)} to ${dateTime.format(interval.endMs)}. ${interval.state}. Worst observed hourly burn ${burnLabel(interval.worstHourBurn)}. ${int.format(interval.requests)} observed requests, ${int.format(interval.failures)} failures. ${(interval.coverage * 100).toFixed(0)} percent coverage.`;
  }
  function describeDay(item: IncidentCalendarDay) {
    return `${item.label}, ${timezone}. ${!item.inWindow ? 'Outside the selected window.' : !item.episodeIds.length ? 'No recorded incident episodes in the selected window.' : `${item.episodeIds.length} episode${item.episodeIds.length === 1 ? '' : 's'}: ${item.activeCount} currently active, ${item.resolvedCount} resolved.`}${item.inWindow ? ' Select to filter the incident list only.' : ''}`;
  }
  function onCalendarKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const first = calendar.days.findIndex(item => item.inWindow);
    const last = calendar.days.findLastIndex(item => item.inWindow);
    const next = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'ArrowDown' ? index + 7 : event.key === 'ArrowUp' ? index - 7 : event.key === 'Home' ? first : event.key === 'End' ? last : null;
    if (next === null) return;
    event.preventDefault();
    const key = calendar.days[Math.max(first, Math.min(last, next))].key;
    setCalendarFocus(key);
    document.getElementById(`incident-day-${key}`)?.focus();
  }
  function moveCalendarMonth(direction: -1 | 1) {
    const next = calendar.availableMonths[monthIndex + direction];
    if (next) { setCalendarMonth(next); setCalendarDay(null); setCalendarFocus(null); }
  }
  function closeAccounting() {
    setAccountingOpen(false);
    document.getElementById('reliability-accounting-toggle')?.focus();
  }

  return <section className={`${styles.study} ${narrow ? styles.narrow : ''}`} data-study="reliability" data-theme={theme}>
    <div className="study-toolbar">
      <div className={styles.toolbarField}><label id="reliability-service-label">Service</label><GammaSelect aria-labelledby="reliability-service-label" value={scope} options={SERVICE_OPTIONS} onValueChange={selectService} size="sm" /></div>
      <div className={styles.toolbarField}><span>SLO</span><span className={styles.sloPill}><ShieldCheck size={13} />Availability</span></div>
      <div className={styles.toolbarField}><label id="reliability-fixture-label">Fixture</label><GammaSelect aria-labelledby="reliability-fixture-label" value={scenario} options={SCENARIO_OPTIONS} onValueChange={value => { setScenario(value as ReliabilityScenario); setRevision(0); clearSelection(); }} size="sm" /></div>
      <div className={styles.toolbarEnd}><Clock3 size={14} /><GammaSelect aria-label="Reliability window" value={String(days)} options={WINDOW_OPTIONS} onValueChange={value => { setDays(Number(value) as ReliabilityWindow); clearSelection(); }} size="sm" /><GammaButton variant="ghost" size="sm" aria-label="Advance reliability snapshot one hour" onClick={() => { setRevision(value => value + 1); clearSelection(); }}><RefreshCw size={14} />Next hour</GammaButton></div>
    </div>
    <div className={styles.scopeCaption}><span><span className={styles.scopeDot} />Synthetic availability · hourly request counts</span><span>{dateTime.format(dataset.startMs)}–{dateTime.format(dataset.endMs)} · {timezone} · Snapshot {revision + 1}</span></div>
    {observed && <div className={styles.coverage} role="status"><TriangleAlert size={15} /><span>{percent(summary.coverage, 1)}% coverage. Summaries use observed requests; incomplete rolling windows and timeline cells remain missing.</span></div>}

    <div className={styles.metrics}>
      <MetricCard label="Achieved availability" value={percent(summary.availability)} unit="%" detail={`Hourly trend ${availabilityTrendLower.toFixed(1)}–100%`} tone="green" icon={<ShieldCheck size={19} />} trend={availabilityTrend} trendDomain={[availabilityTrendLower, 100]} trendFill={false} trendLabel={`Hourly availability. Display range ${availabilityTrendLower.toFixed(1)} to 100 percent.`} />
      <MetricCard label="Target availability" value="99.90" unit="%" detail={`Request-based SLO · ${days}-day window`} tone="cyan" icon={<Target size={19} />} />
      <section className={styles.budgetCard} aria-label="Error budget remaining">
        <div className={styles.budgetHeadline}><span className={styles.budgetIcon}><Activity size={19} /></span><div><span className={styles.label}>Error budget remaining</span><div className={styles.budgetValue} data-testid="reliability-budget">{percent(remaining, 1)}<span>%</span></div></div><div className={styles.budgetActions}><StatusBadge tone={budgetTone}>{remaining !== null && remaining < 0 ? 'Exhausted' : observed ? 'Partial data' : 'Window budget'}</StatusBadge><GammaButton id="reliability-accounting-toggle" variant="ghost" size="sm" aria-label={accountingOpen ? 'Hide exact budget accounting' : 'Show exact budget accounting'} aria-expanded={accountingOpen} aria-controls="reliability-accounting" onClick={() => setAccountingOpen(value => !value)}><Info size={14} /></GammaButton></div></div>
        <div className={styles.budgetTrack} aria-label={`${percent(remaining, 1)} percent error budget remaining`}><span data-tone={budgetTone} style={{ width: `${Math.max(0, Math.min(100, (remaining ?? 0) * 100))}%` }} /></div>
        <div className={styles.budgetLegend}><span>{decimal.format(summary.failures)} consumed</span><span>{decimal.format(summary.allowedFailures)} allowed failures</span></div>
      </section>
    </div>
    {accountingOpen && <section id="reliability-accounting" className={styles.accountingDrawer} aria-labelledby="reliability-accounting-title" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); closeAccounting(); } }}>
      <div className={styles.accountingHeading}><strong id="reliability-accounting-title">Exact budget accounting</strong><span>{scope === 'all' ? 'All services' : scope} · full {days}-day window</span><GammaButton variant="ghost" size="sm" aria-label="Close exact budget accounting" onClick={closeAccounting}><X size={13} /></GammaButton></div>
      <dl className={styles.accounting}><div><dt>Requests observed</dt><dd data-testid="reliability-requests">{int.format(summary.requests)}</dd></div><div><dt>Failed requests</dt><dd>{int.format(summary.failures)}</dd></div><div><dt>Allowed failures <span>0.10% of requests</span></dt><dd>{exactAllowance.format(summary.allowedFailures)}</dd></div><div className={styles.remaining}><dt>Remaining allowance</dt><dd data-negative={remainingFailures < 0}>{exactAllowance.format(remainingFailures)}</dd></div></dl>
      <p className={styles.accountingNote}>{observed ? 'Partial coverage: all calculations use the observed request population.' : 'Availability and budget use the same request counts.'} Selecting a calendar date filters the incident list only.</p>
    </section>}

    <ChartCursorProvider key={`${scope}-${days}-${scenario}-${revision}`}>
      <div className={styles.mainGrid}>
        <Panel title={burnWidget.title} subtitle="Request-weighted 1-hour and 6-hour windows. 1× means the observed error ratio equals the 0.10% allowed error ratio." actions={<><span className={styles.subtle}>{days === 1 ? '24h' : `${days}d`} · 1× budget pace</span>{panels.actions({widget:BURN_WIDGET,result})}</>} className={styles.burnPanel}>
          <div className={styles.chart}><WidgetVisualization widget={burnWidget} result={result} /></div>
          <BurnReadout points={points} />
        </Panel>
        <Panel title="Services needing attention" subtitle={`All services · ${days}-day window · ranked by remaining budget`} actions={scope !== 'all' ? <GammaButton size="sm" variant="ghost" onClick={() => selectService('all')}>All services</GammaButton> : undefined}>
          <div className={styles.tableWrap}><table className={styles.serviceTable}><caption className={styles.visuallyHidden}>Service availability, remaining request-based error budget and latest observed burn</caption><thead><tr><th>Service</th><th>Availability</th><th>Budget left</th><th>Status</th></tr></thead><tbody>{services.map(service => {
            const oneHour = service.burn.oneHour;
            const tone = oneHour === null ? 'muted' : oneHour > 2 ? 'red' : oneHour > 1 ? 'amber' : 'green';
            const status = oneHour === null ? 'No data' : oneHour > 2 ? 'Burning' : oneHour > 1 ? 'Elevated' : 'Healthy';
            return <tr key={service.id} data-selected={scope === service.id}><td><GammaButton variant="ghost" size="sm" aria-pressed={scope === service.id} onClick={() => selectService(scope === service.id ? 'all' : service.id)}>{service.id}</GammaButton></td><td>{percent(service.summary.availability)}<span className={styles.unit}>%</span></td><td><div className={styles.inlineBudget}><div><span style={{ width: `${Math.max(0, Math.min(100, (service.summary.budgetRemaining ?? 0) * 100))}%` }} data-low={(service.summary.budgetRemaining ?? 0) < 0.25} /></div><span>{percent(service.summary.budgetRemaining, 0)}%</span></div></td><td><StatusBadge tone={tone}>{status}</StatusBadge></td></tr>;
          })}</tbody></table></div>
          <div className={styles.tableNote}><Info size={13} /><span>Latest 1h: healthy ≤1×, elevated ≤2×, burning &gt;2×.<br />Availability and budget: full {days}-day window.</span></div>
          <div className={styles.population}><span>Observed service hours · all services</span><strong>{int.format(services.reduce((total, service) => total + service.summary.observedIntervals, 0))} <span>/ {int.format(services.reduce((total, service) => total + service.summary.expectedIntervals, 0))}</span></strong></div>
        </Panel>
      </div>
    </ChartCursorProvider>

    <div className={styles.supportGrid}>
      <Panel title="Service reliability history" subtitle="Each cell reports the worst observed hourly burn in its interval; incomplete intervals are marked missing. Arrow keys inspect adjacent intervals. Exact counts and coverage appear below." actions={<span className={styles.subtle}>Worst 1h · {days === 30 ? '12h' : days === 7 ? '3h' : '1h'} cells</span>}>
        <div className={styles.timeline} aria-label="Service reliability history">{services.map(service => <div key={service.id} className={styles.timelineRow}><span>{service.id}</span><div className={styles.cells} role="group" aria-label={`${service.id} burn history`}>{service.intervals.map((interval, index) => <button key={interval.startMs} id={`reliability-cell-${service.id}-${index}`} type="button" className={styles.cell} data-state={interval.state} data-selected={selection?.service === service.id && selection.index === index} aria-label={describeInterval(service.id, interval)} aria-pressed={selection?.service === service.id && selection.index === index} tabIndex={index === Math.min(focusIndex, service.intervals.length - 1) ? 0 : -1} style={{ flexGrow: interval.endMs - interval.startMs }} onClick={() => { setSelection({ service: service.id, index }); setFocusIndex(index); }} onKeyDown={event => onTimelineKey(event, service.id, index, service.intervals.length)} />)}</div></div>)}</div>
        <div className={styles.timelineAxis}><span>{day.format(dataset.startMs)}</span><span>{day.format(dataset.startMs + (dataset.endMs - dataset.startMs) / 2)}</span><span>{day.format(dataset.endMs)}</span></div>
        <div className={styles.stateLegend}><span><i data-state="healthy" />≤1×</span><span><i data-state="elevated" />1–2×</span><span><i data-state="breaching" />&gt;2×</span><span><i data-state="missing" />Missing / partial</span><span className={styles.keyboardHint}>← → inspect</span></div>
        <div className={styles.timelineDetail} aria-live="polite">{activeInterval && activeService ? <><strong>{activeService.id}</strong><span>{dateTime.format(activeInterval.startMs)}–{dateTime.format(activeInterval.endMs)}</span><span>Worst 1h <b>{burnLabel(activeInterval.worstHourBurn)}</b></span><span><b>{int.format(activeInterval.requests)}</b> requests · <b>{int.format(activeInterval.failures)}</b> failures · {percent(activeInterval.coverage, 0)}% coverage</span></> : <><Info size={14} /><span>Select an interval to inspect its exact request counts and coverage.</span></>}</div>
      </Panel>
      <Panel title="Incident calendar" subtitle={`Episode presence for ${scope === 'all' ? 'all services' : scope}, in ${timezone}. Dates are clipped to the selected window. Active and resolved describe each episode's current state, not severity. Selecting a day filters only the incident list; availability and budget keep the full window.`} actions={<div className={styles.calendarNav}><GammaButton variant="ghost" size="sm" aria-label="Previous incident month" disabled={monthIndex === 0} onClick={() => moveCalendarMonth(-1)}><ChevronLeft size={13} /></GammaButton><span>{calendar.monthLabel}</span><GammaButton variant="ghost" size="sm" aria-label="Next incident month" disabled={monthIndex === calendar.availableMonths.length - 1} onClick={() => moveCalendarMonth(1)}><ChevronRight size={13} /></GammaButton></div>}>
        <p className={styles.visuallyHidden} id="incident-calendar-help">Arrow keys move by day or week. Home and End reach the first and last available dates. Enter or Space filters the incident list. Select the same day again to clear the filter. Counts show distinct episodes overlapping that local date within the selected window.</p>
        <table className={styles.calendar} aria-label={`Incident calendar, ${calendar.monthLabel}, ${timezone}`}><thead><tr>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(weekday => <th key={weekday} scope="col">{weekday}</th>)}</tr></thead><tbody>{Array.from({ length: calendar.days.length / 7 }, (_, week) => <tr key={week}>{calendar.days.slice(week * 7, week * 7 + 7).map((item, column) => <td key={item.key}><button id={`incident-day-${item.key}`} type="button" className={styles.calendarDay} data-state={item.state} data-current-month={item.inMonth} data-selected={calendarDay === item.key} disabled={!item.inWindow} tabIndex={item.key === calendarTabKey ? 0 : -1} aria-pressed={calendarDay === item.key} aria-label={describeDay(item)} aria-describedby="incident-calendar-help" title={describeDay(item)} onClick={() => { setCalendarDay(current => current === item.key ? null : item.key); setCalendarFocus(item.key); }} onKeyDown={event => onCalendarKey(event, week * 7 + column)}><span>{item.number}</span>{item.episodeIds.length > 0 && <b aria-hidden="true">{item.episodeIds.length}</b>}</button></td>)}</tr>)}</tbody></table>
        <div className={styles.calendarLegend}><span><i data-state="none" />0 episodes</span><span><i data-state="resolved" />Resolved</span><span><i data-state="active" />Active</span><span><i data-state="outside" />Outside window</span></div>
      </Panel>
    </div>

    <Panel title="Incident evidence" subtitle="Synthetic episodes overlapping the selected service and window. Start times and full observed episode durations are retained; an episode spanning midnight can appear on more than one calendar date." actions={<div className={styles.incidentActions}>{selectedDay && <GammaButton variant="ghost" size="sm" aria-label="Clear incident day filter" onClick={() => setCalendarDay(null)}>{selectedDay.key}<X size={12} /></GammaButton>}<span className={styles.subtle} aria-live="polite">{displayedIncidents.length} {displayedIncidents.length === 1 ? 'episode' : 'episodes'} · {selectedDay ? 'selected day only' : 'full window'}</span></div>}>
      {displayedIncidents.length ? <div className={styles.tableWrap}><table className={styles.incidentTable}><caption className={styles.visuallyHidden}>Fixture incident episodes{selectedDay ? ` overlapping ${selectedDay.label}, ${timezone}` : ' within the full selected window'}</caption><thead><tr><th>Started ({timezone})</th><th>Service</th><th>Duration</th><th>Observation</th><th>Status</th><th><span className={styles.visuallyHidden}>Inspect</span></th></tr></thead><tbody>{displayedIncidents.map(incident => <tr key={incident.id}><td><span className={styles.incidentTime}><TriangleAlert size={13} className={incident.status === 'Active' ? styles.criticalIcon : styles.mutedIcon} />{dateTime.format(incident.startMs)}</span></td><td className={styles.mono}>{incident.serviceId}</td><td>{(incident.endMs - incident.startMs) / HOUR_MS}h{incident.status === 'Active' ? ' observed' : ''}</td><td>{incident.title}</td><td><StatusBadge tone={incident.status === 'Active' ? 'red' : 'green'}>{incident.status === 'Active' ? <Activity size={11} /> : <Check size={11} />}{incident.status}</StatusBadge></td><td><GammaButton variant="ghost" size="sm" aria-label={`Inspect ${incident.title} for ${incident.serviceId}`} onClick={() => { setScope(incident.serviceId); const service = services.find(item => item.id === incident.serviceId)!; const index = service.intervals.findIndex(interval => incident.endMs > interval.startMs && incident.endMs <= interval.endMs); setSelection({ service: incident.serviceId, index: Math.max(0, index) }); }}><ArrowUpRight size={14} /></GammaButton></td></tr>)}</tbody></table></div> : <EmptyNotice>{selectedDay ? `No incident episodes overlap ${selectedDay.label} for ${scope === 'all' ? 'all services' : scope}.` : 'No incident episodes in this service and window.'}</EmptyNotice>}
    </Panel>
    <div className={styles.footer}><span>Request-based SLO · target 99.90% · time-bucket states are worst observed hourly burn</span><span>Deterministic fixture · no alert policy configured</span></div>
  </section>;
}
