import { useId, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Clock3, MoreVertical, Search, TriangleAlert, X } from 'lucide-react';
import { useDemoReplay, useLabMotion } from '../components/lab/motion';
import { Dot, Info, RefPanel, RefSelect } from './ReferenceShared';
import { ReferenceTimeseries } from './ReferenceCharts';
import { achievedAvailabilityProfile, targetAvailabilityProfile } from './reference-reliability-profiles';
import './ReferenceReliability.css';
import {referenceTimelineStates} from './reference-timeline-profile';

const GREEN = '#23eeb4';
const AMBER = '#f8bf47';
const RED = '#f84846';

type Service = { name: string; availability: number; delta: number; budget: number; amount: string; status: string; tone: 'red' | 'amber' | 'green'; bar?: number };
const SERVICES: Service[] = [
  { name: 'payment-api', availability: 99.72, delta: -.18, budget: 14, amount: '8.64m / 10.00m', status: 'At risk', tone: 'red', bar: 83 },
  { name: 'auth-api', availability: 99.88, delta: -.06, budget: 72, amount: '12.10m / 43.20m', status: 'At risk', tone: 'amber', bar: 30 },
  { name: 'catalog-api', availability: 99.97, delta: .01, budget: 88, amount: '38.16m / 43.20m', status: 'Healthy', tone: 'green', bar: 88 },
  { name: 'uptime-api', availability: 99.96, delta: .01, budget: 60, amount: '25.92m / 43.20m', status: 'Healthy', tone: 'green', bar: 60 },
  { name: 'search-api', availability: 99.95, delta: -.02, budget: 70, amount: '30.24m / 43.20m', status: 'Healthy', tone: 'green', bar: 70 },
  { name: 'worker-api', availability: 99.93, delta: -.04, budget: 44, amount: '19.00m / 43.20m', status: 'Monitoring', tone: 'amber', bar: 41 },
];
const TIMELINE_SERVICES = ['uptime-api', 'payment-api', 'auth-api', 'catalog-api', 'search-api', 'worker-api'];
const TIMELINE_CELLS = 85;
const TIMELINE_START = Date.UTC(2024, 4, 1);
const TIMELINE_STEP = 30 * 24 * 60 * 60 * 1000 / TIMELINE_CELLS;
function timelineBoundary(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getUTCMonth() === 4 ? 'May' : 'Jun'} ${String(date.getUTCDate()).padStart(2,'0')} ${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')}`;
}
export function referenceTimelineInterval(cell: number) {
  return `${timelineBoundary(TIMELINE_START + cell * TIMELINE_STEP)} to ${timelineBoundary(TIMELINE_START + (cell + 1) * TIMELINE_STEP)} UTC`;
}
export function referenceTimeBudget(availability: number) {
  const allowedMinutes = 43.2;
  const consumedMinutes = (100 - availability) / 100 * 30 * 24 * 60;
  const remainingMinutes = allowedMinutes - consumedMinutes;
  return { allowedMinutes, consumedMinutes, remainingMinutes, remainingPercent: remainingMinutes / allowedMinutes * 100 };
}
const INCIDENTS = [
  { day: 16, date: 'May 16, 2024', time: '10:21', service: 'payment-api', duration: '58m', cause: 'Increased latency from third-party dependency (payments-gateway)', impact: 'Elevated error rate (5xx) and timeouts', tone: 'red' },
  { day: 10, date: 'May 10, 2024', time: '03:14', service: 'auth-api', duration: '22m', cause: 'Elevated error rate (5xx) after deployment v1.3.2', impact: 'Authentication failures for some users', tone: 'red' },
  { day: 5, date: 'May 05, 2024', time: '18:37', service: 'catalog-api', duration: '1h 12m', cause: 'Database connection pool exhaustion', impact: 'Increased latency and 5xx errors', tone: 'amber' },
  { day: 1, date: 'May 01, 2024', time: '09:03', service: 'worker-api', duration: '36m', cause: 'Message queue backlog (kafka)', impact: 'Delayed job processing, increased queue depth', tone: 'red' },
];

function AuthoredAvailabilityProfile({ target = false, availability = 99.96 }: { target?: boolean; availability?: number }) {
  const id = useId().replace(/:/g,'');
  const profile = target ? targetAvailabilityProfile : achievedAvailabilityProfile;
  const width = profile.length - 1, height = target ? 40 : 52;
  const shift = target ? 0 : (99.96 - availability) / .2 * height;
  const path = profile.map((value,index) => `${index ? 'L' : 'M'}${index},${(value + shift).toFixed(2)}`).join(' ');
  return <svg className="ref-rel-authored-profile" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id={`availability-${id}`} gradientUnits="userSpaceOnUse" x1="0" x2="0" y1="0" y2={height}><stop offset="0" stopColor="#00d7bf" stopOpacity=".30"/><stop offset="1" stopColor="#00c7b3" stopOpacity="0"/></linearGradient></defs>
    <path d={`${path} L${width},${height} L0,${height} Z`} fill={`url(#availability-${id})`}/>
    {target && <><line x1="0" x2={width} y1="8" y2="8" stroke="#f4c242" strokeWidth="1.4" strokeDasharray="6 4"/><line x1="0" x2={width} y1="20" y2="20" stroke="#e3bf36" strokeOpacity=".65" strokeWidth="1" strokeDasharray="7 3"/></>}
    <path d={path} fill="none" stroke={target ? '#1cd4b2' : '#0ae8cd'} strokeWidth="1.1" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
  </svg>;
}

function AvailabilityShield() {
  return <svg viewBox="0 0 36 36" aria-hidden="true" fill="none"><path d="m18 3 12 5v10c0 8-12 14-12 14S6 26 6 18V8Z" stroke="currentColor" strokeWidth="2.8" strokeLinejoin="round"/></svg>;
}

function SloTarget() {
  return <svg viewBox="0 0 36 36" aria-hidden="true" fill="none"><circle cx="16" cy="20" r="12" stroke="currentColor" strokeWidth="2.6"/><circle cx="16" cy="20" r="6" stroke="currentColor" strokeWidth="2.4"/><path d="m16 20 14-14M23 6h7v7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/></svg>;
}

function BudgetPie() {
  return <svg viewBox="0 0 36 36" aria-hidden="true"><path d="M16 3a15 15 0 1 0 17 17H16Z" fill="currentColor"/><path d="M20 2v14h14A14 14 0 0 0 20 2Z" fill="currentColor"/></svg>;
}

function AvailabilityMetric({ service }: { service: Service }) {
  return <section className="ref-rel-metric ref-rel-achieved" aria-label="Achieved availability">
    <div className="ref-rel-metric-icon ref-rel-green"><AvailabilityShield/></div>
    <div className="ref-rel-metric-name">Achieved availability <Info text="Synthetic reference snapshot. The headline is a time-based percentage over 30 days. The sparkline is an authored SVG silhouette measured from the concept image, not sampled provider telemetry."/></div>
    <div className="ref-rel-metric-value">{service.availability.toFixed(2)} <span>%</span></div>
    <div className={`ref-rel-metric-delta ${service.delta >= 0 ? 'ref-rel-green' : 'ref-rel-red'}`}>{service.delta >= 0 ? <ArrowUp/> : <ArrowDown/>}{Math.abs(service.delta).toFixed(2)}%</div>
    <div className="ref-rel-previous">vs. previous 30d</div>
    <div className="ref-rel-mini-axis"><span>100.00%</span><span>99.90%</span><span>99.80%</span></div>
    <div className="ref-rel-availability-trace"><div className="ref-rel-mini-target"/><AuthoredAvailabilityProfile availability={service.availability}/></div>
  </section>;
}

function TargetMetric() {
  return <section className="ref-rel-metric ref-rel-target" aria-label="Target SLO">
    <div className="ref-rel-metric-icon ref-rel-blue"><SloTarget/></div>
    <div className="ref-rel-metric-name">Target (SLO) <Info text="99.90% availability allows 43.20 minutes of unavailability in an exact 30-day window. The miniature SVG reproduces the concept’s authored profile and dashed rules; their visual positions are not a calibrated telemetry scale."/></div>
    <div className="ref-rel-metric-value">99.90 <span>%</span></div>
    <div className="ref-rel-error-budget-caption">Error budget: 43.20m / 30 days</div>
    <div className="ref-rel-mini-axis"><span>100.00%</span><span>99.90%</span><span>99.80%</span></div>
    <div className="ref-rel-target-trace"><AuthoredAvailabilityProfile target/></div>
    <div className="ref-rel-target-key"><span><Dot color={GREEN}/>Achieved</span><span><i className="ref-rel-target-dash"/>Target (99.90%)</span></div>
  </section>;
}

function BudgetMetric({ service }: { service: Service }) {
  const { consumedMinutes: consumed, remainingMinutes: remaining, remainingPercent: percent } = referenceTimeBudget(service.availability);
  const isDefault = service.name === 'uptime-api';
  return <section className="ref-rel-metric ref-rel-budget" aria-label="Budget remaining">
    <div className="ref-rel-metric-icon ref-rel-green"><BudgetPie/></div>
    <div className="ref-rel-metric-name">Budget remaining <Info text="Time-based synthetic SLO: 43.20 minutes allowed, minus 17.28 minutes consumed, leaves 25.92 minutes (60%). The reproduced source artwork uses an illustrative bar length; the exact values are shown alongside it. Service-table values are authored concept examples rather than a single reconciled measurement set."/></div>
    <div className={`ref-rel-metric-value ${percent < 0 ? 'ref-rel-red' : ''}`}>{percent.toFixed(2)} <span>%</span></div>
    <div className="ref-rel-budget-consumed">{consumed.toFixed(2)}m consumed / 43.20m allowed</div>
    <div className="ref-rel-budget-track"><span style={{ width: `${isDefault ? 44.4 : Math.max(0, Math.min(100, consumed / 43.2 * 100))}%`, background: percent < 0 ? RED : undefined }}/></div>
    <div className="ref-rel-budget-scale"><span>{consumed.toFixed(2)}m</span><span>{remaining.toFixed(2)}m remaining</span><span>43.20m</span></div>
  </section>;
}

function ServicesTable({ onSelect }: { onSelect: (service: string) => void }) {
  const [filter, setFilter] = useState('All services');
  const visible = SERVICES.filter(service => filter === 'All services' || service.tone !== 'green');
  return <RefPanel title="Services needing attention" className="ref-rel-services" scrollLabel="Service reliability records" info="These are the illustrative service rows from the supplied design reference. Their independently authored budget amounts and percentages are reproduced for visual comparison, not treated as reconciled production accounting." action={<RefSelect value={filter} options={['All services', 'Needs attention']} onChange={setFilter} label="Service table filter"/>}>
    <table className="ref-rel-service-table"><colgroup><col/><col/><col/><col/></colgroup><thead><tr><th>Service</th><th>Availability (30d)</th><th>Error budget</th><th>Status</th></tr></thead><tbody>{visible.map(service => <tr key={service.name}>
      <td><button className="ref-rel-service-link" onClick={() => onSelect(service.name)}>{service.name}</button></td>
      <td><div className="ref-rel-availability-cell"><span>{service.availability.toFixed(2)} %</span><span className={service.delta >= 0 ? 'ref-rel-green' : 'ref-rel-red'}>{service.delta >= 0 ? <ArrowUp/> : <ArrowDown/>}{Math.abs(service.delta).toFixed(2)}%</span></div></td>
      <td><div className={`ref-rel-row-budget ref-rel-${service.tone}`}><span className="ref-rel-row-track"><i style={{ width: `${service.bar ?? service.budget}%` }}/></span><span>{service.budget}%</span></div><div className="ref-rel-budget-amount">{service.amount}</div></td>
      <td><span className={`ref-rel-status ref-rel-${service.tone}`}><i/>{service.status}</span></td>
    </tr>)}</tbody></table>
  </RefPanel>;
}

type TimelineState = 'healthy' | 'risk' | 'breach' | 'unknown';

function ServiceTimeline({ onSelect, adaptive }: { onSelect: (service: string) => void; adaptive: boolean }) {
  const [mode, setMode] = useState('6 services');
  const [selection, setSelection] = useState<{ service: string; cell: number; state: TimelineState } | null>(null);
  const gridId = useId();
  const shown = mode === '6 services' ? TIMELINE_SERVICES : TIMELINE_SERVICES.slice(0, 3);
  const inspectedService = selection?.service ?? shown[0];
  const inspectedCell = selection?.cell ?? 0;
  const selectInterval = (service: string, cell: number) => setSelection({ service, cell, state: referenceTimelineStates[TIMELINE_SERVICES.indexOf(service)][cell] });
  const setServiceCount = (value: string) => {
    setMode(value);
    if(value !== '6 services' && selection && !TIMELINE_SERVICES.slice(0,3).includes(selection.service)) setSelection(null);
  };
  const onKeys = (event: KeyboardEvent<HTMLButtonElement>, row: number, cell: number) => {
    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowUp' ? -TIMELINE_CELLS : event.key === 'ArrowDown' ? TIMELINE_CELLS : 0;
    if (!offset) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(shown.length * TIMELINE_CELLS - 1, row * TIMELINE_CELLS + cell + offset));
    document.getElementById(`${gridId}-${next}`)?.focus();
  };
  return <RefPanel title="Service SLO state timeline (30 days)" className="ref-rel-timeline" info="Authored reference states sampled from the concept artwork. Each row has 85 illustrative display bins mapped uniformly over 30 days; this does not establish the original measurement cadence. Unknown intervals are explicitly hatched. Select a cell for its UTC boundaries, or use arrow keys to move between cells." action={<RefSelect value={mode} options={['6 services', 'Top 3 services']} onChange={setServiceCount} label="Timeline service count"/>}>
    <div className="ref-rel-timeline-rows">{shown.map((name,row) => <div className="ref-rel-timeline-row" key={name}><button className="ref-rel-timeline-label" onClick={() => onSelect(name)}>{name}</button><div className="ref-rel-timeline-cells">{Array.from({ length: TIMELINE_CELLS }, (_, cell) => {
      const state = referenceTimelineStates[row][cell];
      const interval = referenceTimelineInterval(cell);
      return <button key={cell} id={`${gridId}-${row * TIMELINE_CELLS + cell}`} className={`ref-rel-state ref-rel-state-${state}`} style={state === 'healthy' ? { opacity: .82 + ((cell * 7 + row * 13) % 13) / 72 } : undefined} aria-label={`${name}, ${interval}, ${state}`} aria-pressed={selection?.service === name && selection.cell === cell} title={`${name} · ${interval} · ${state}`} tabIndex={cell === (selection?.service === name ? selection.cell : 0) ? 0 : -1} onKeyDown={event => onKeys(event,row,cell)} onClick={() => selectInterval(name,cell)}/>;
    })}</div></div>)}</div>
    <div className="ref-rel-timeline-ticks">{['May 01','May 04','May 07','May 10','May 13','May 16','May 19','May 22','May 25','May 28','May 31'].map(day => <span key={day}>{day}</span>)}</div>
    <div className="ref-rel-timeline-legend"><span><Dot color={GREEN}/>Healthy (within SLO)</span><span><Dot color={AMBER}/>At risk (elevated burn)</span><span><Dot color={RED}/>Breaching (burn &gt; 2x)</span><span><Dot color="#6b8da2"/>No data (unknown)</span></div>
    {adaptive && <div className="ref-rel-timeline-inspect" aria-label="Inspect timeline interval">
      <label htmlFor={`${gridId}-service`}>Inspect service<select id={`${gridId}-service`} value={inspectedService} onChange={event=>selectInterval(event.target.value,inspectedCell)}>{shown.map(name=><option key={name}>{name}</option>)}</select></label>
      <label htmlFor={`${gridId}-interval`}>Interval (UTC)<select id={`${gridId}-interval`} value={inspectedCell} onChange={event=>selectInterval(inspectedService,Number(event.target.value))}>{Array.from({length:TIMELINE_CELLS},(_,cell)=><option key={cell} value={cell}>{referenceTimelineInterval(cell)}</option>)}</select></label>
      <button onClick={()=>selectInterval(inspectedService,inspectedCell)}>Inspect interval</button>
    </div>}
    {selection && <div className="ref-rel-timeline-detail" role="status"><span>{selection.service} · {referenceTimelineInterval(selection.cell)} · {selection.state}</span><button onClick={() => setSelection(null)} aria-label="Close timeline detail"><X size={14}/></button></div>}
  </RefPanel>;
}

function IncidentCalendar({ selected, onSelect }: { selected: number | null; onSelect: (day: number | null) => void }) {
  const [month, setMonth] = useState(4);
  const [year, setYear] = useState(2024);
  const start = new Date(Date.UTC(year,month,1));
  const offset = (start.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year,month + 1,0)).getUTCDate();
  const rowCount = Math.ceil((offset + days) / 7);
  const label = new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(start);
  const cells = Array.from({length:rowCount * 7}, (_,i) => new Date(Date.UTC(year,month,1 + i - offset)));
  const move = (direction: number) => {const date = new Date(Date.UTC(year,month + direction,1));setMonth(date.getUTCMonth());setYear(date.getUTCFullYear());onSelect(null);};
  const actualMonth = year === 2024 && month === 4;
  return <RefPanel title="Incidents in this month" className="ref-rel-calendar" info="Authored May 2024 reference calendar. Colours reproduce the supplied concept's incident annotations. Select a date to filter the incident records; select it again to clear. These annotations are illustrative and do not imply a live incident service." action={<div className="ref-rel-month-controls"><button aria-label="Previous month" onClick={() => move(-1)}><ChevronLeft size={16}/></button><span>{label}</span><button aria-label="Next month" onClick={() => move(1)}><ChevronRight size={16}/></button></div>}>
    <div className="ref-rel-calendar-grid" style={{'--calendar-rows': rowCount} as CSSProperties} role="group" aria-label={`${label} incident dates`}>
      {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(day => <span className="ref-rel-weekday" key={day}>{day}</span>)}
      {cells.map((date, i) => {
        const day = date.getUTCDate(), outside = date.getUTCMonth() !== month;
        const state = actualMonth && !outside ? day === 7 ? 'major' : day === 10 ? 'minor' : day === 24 ? 'missing' : '' : '';
        const highlight = actualMonth && !outside && (selected ?? 16) === day;
        return <button key={date.toISOString()} className={`ref-rel-calendar-day ${outside ? 'is-outside' : ''} ${state ? `is-${state}` : ''} ${highlight ? 'is-selected' : ''}`} disabled={outside || !actualMonth} aria-pressed={selected === day && !outside} aria-label={`${label} ${day}${state ? `, ${state === 'missing' ? 'no data' : `${state} incident`}` : ''}${selected === day ? ', clear date filter' : ''}`} onClick={() => onSelect(selected === day ? null : day)} onKeyDown={event => {
          const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? 7 : event.key === 'ArrowUp' ? -7 : 0;
          if (!step) return;
          event.preventDefault();
          const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button');
          buttons?.[Math.max(0,Math.min(cells.length - 1,i + step))]?.focus();
        }}>{day}{actualMonth && !outside && day === 16 && <i/>}</button>;
      })}
    </div>
    <div className="ref-rel-calendar-legend"><span><Dot color={RED}/>Major incident</span><span><Dot color={AMBER}/>Minor incident</span><span><Dot color={AMBER}/>Degraded performance</span><span><i/>No data</span></div>
  </RefPanel>;
}

function RecentIncidents({ selectedDay, onClear }: { selectedDay: number | null; onClear: () => void }) {
  const [filter, setFilter] = useState('All incidents');
  const visible = INCIDENTS.filter(item => (selectedDay === null || item.day === selectedDay) && (filter === 'All incidents' || item.tone === 'red'));
  return <RefPanel title={selectedDay === null ? 'Recent incidents' : `Recent incidents · May ${selectedDay}`} className="ref-rel-incidents" scrollLabel="Incident records" info="Authored synthetic incident records from the reference. The selected calendar date filters this table only; the SLO budget retains its full 30-day window." action={<div className="ref-rel-incidents-actions">{selectedDay !== null && <button onClick={onClear}>Clear date</button>}<RefSelect value={filter} options={['All incidents', 'Major incidents']} onChange={setFilter} label="Incident table filter"/></div>}>
    <table className="ref-rel-incident-table"><colgroup><col/><col/><col/><col/><col/><col/><col/></colgroup><thead><tr><th aria-label="Severity"/><th>Time (UTC)</th><th>Service</th><th>Duration</th><th>Cause</th><th>Impact / Summary</th><th>Status</th></tr></thead><tbody>{visible.map(item => <tr key={`${item.day}-${item.service}`}><td><TriangleAlert className={`ref-rel-${item.tone}`} size={16} strokeWidth={2.4}/></td><td>{item.date}<span>{item.time}</span></td><td>{item.service}</td><td>{item.duration}</td><td>{item.cause}</td><td>{item.impact}</td><td><span className="ref-rel-resolved"><Dot color={GREEN}/>Resolved</span></td></tr>)}</tbody></table>
    {!visible.length && <div className="ref-rel-empty-incidents">No incident records on this date. <button onClick={onClear}>Show all incidents</button></div>}
  </RefPanel>;
}

export function ReferenceReliability({ adaptive = false }: { adaptive?: boolean }) {
  const motion = useLabMotion();
  const [phase,setPhase] = useState(0);
  useDemoReplay(() => setPhase(value => (value + 1) % 100000));
  const [serviceName,setServiceName] = useState('uptime-api');
  const [windowLabel,setWindowLabel] = useState('30 days');
  const [selectedDay,setSelectedDay] = useState<number | null>(null);
  const [searchOpen,setSearchOpen] = useState(false);
  const [search,setSearch] = useState('');
  const [menuOpen,setMenuOpen] = useState(false);
  const service = SERVICES.find(item => item.name === serviceName) ?? SERVICES[3];
  return <div className="ref-reliability">
    <div className="ref-rel-toolbar" aria-label="Reliability scope">
      <div className="ref-rel-toolbar-field"><label>Service</label><RefSelect label="Service" value={serviceName} options={['uptime-api','payment-api','auth-api','catalog-api','search-api','worker-api']} onChange={name => {setServiceName(name);setSelectedDay(null);}}/></div>
      <div className="ref-rel-toolbar-field ref-rel-slo-field"><label>SLO</label><RefSelect label="SLO" value="Availability" options={['Availability']}/></div>
      <div className="ref-rel-toolbar-field ref-rel-window-field"><label>Window</label><RefSelect label="Window" value={windowLabel} options={['30 days']} onChange={setWindowLabel}/></div>
      <div className="ref-rel-global-time"><Clock3 size={20}/><RefSelect value={`Last ${windowLabel}`} options={['Last 30 days']} onChange={value => setWindowLabel(value.replace('Last ',''))} label="Global time range"/></div>
      <button className="ref-live ref-rel-live" aria-label={motion.replaying ? 'Pause reference replay' : 'Play reference replay'} aria-pressed={motion.replaying} title={motion.replaying ? 'Pause the synthetic reference replay' : 'Play the authored reference fixture; one synthetic hour advances every 1.8 seconds'} onClick={motion.toggleReplay}><Dot color={GREEN}/>{motion.replaying ? 'Pause' : 'Live'}</button><span className="ref-rel-toolbar-divider"/>
      <button className="ref-rel-toolbar-icon" aria-label="Search services" aria-expanded={searchOpen} onClick={() => setSearchOpen(!searchOpen)}><Search size={22}/></button>
      <button className="ref-rel-toolbar-icon ref-rel-more" aria-label="Reliability view options" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><MoreVertical size={22}/></button>
    </div>
    {searchOpen && <div className="ref-rel-search-popover" onKeyDown={event => {if(event.key === 'Escape')setSearchOpen(false);}}><label htmlFor="reference-service-search">Find a service</label><input id="reference-service-search" autoFocus value={search} onChange={event => setSearch(event.target.value)} placeholder="Service name…"/>{SERVICES.filter(item => item.name.includes(search)).map(item => <button key={item.name} onClick={() => {setServiceName(item.name);setSearchOpen(false);}}>{item.name}<span>{item.availability.toFixed(2)}%</span></button>)}</div>}
    {menuOpen && <div className="ref-rel-menu-popover" onKeyDown={event => {if(event.key === 'Escape')setMenuOpen(false);}}><button onClick={() => {if(motion.replaying)motion.toggleReplay();setPhase(0);setServiceName('uptime-api');setWindowLabel('30 days');setSelectedDay(null);setMenuOpen(false);}}>Reset reference view</button><a href="#edge">Open Edge Watch</a><a href="#baseline">Open original widget lab</a></div>}
    <AvailabilityMetric service={service}/><TargetMetric/><BudgetMetric service={service}/>
    <RefPanel title="Availability burn rate (error budget)" className="ref-rel-burn" info="Illustrative one-hour and six-hour error-budget burn rates from the reference. The cyan and violet series share the displayed scale. The orange dashed rule is the 2x threshold; incident and unknown intervals are explicit. Live starts an authored fixture replay; it does not connect to a telemetry provider." action={<RefSelect value="All services" options={['All services']} label="Burn rate service scope"/>}><ReferenceTimeseries kind="reliability" service={serviceName} phase={phase}/></RefPanel>
    <ServicesTable onSelect={setServiceName}/><ServiceTimeline adaptive={adaptive} onSelect={setServiceName}/><IncidentCalendar selected={selectedDay} onSelect={setSelectedDay}/><RecentIncidents selectedDay={selectedDay} onClear={() => setSelectedDay(null)}/>
    {windowLabel !== '30 days' && <div className="ref-rel-window-note" role="status">Reference artwork uses a 30-day window. <button onClick={() => setWindowLabel('30 days')}>Restore reference window</button></div>}
  </div>;
}
