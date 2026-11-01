import { useId, useMemo, type ReactNode } from 'react';
import { Clock3, Pin, X } from 'lucide-react';
import { line, area } from 'd3-shape';
import { GammaButton } from '@insights/gamma/button';
import { exactMetric, formatMetricDetails, type Point, type Series } from '@insights/chart-data';
import { inspectPreparedObservation, prepareObservationInspector, type InspectionWindow, type InspectorSeries } from './observation-inspector-data';
import styles from './chart-styles.module.css';

const utcDate = new Intl.DateTimeFormat('en', { year: 'numeric', month: 'short', day: '2-digit', timeZone: 'UTC' });
const utcTime = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23', timeZone: 'UTC' });
const utcBound = (timestamp: number) => `${utcDate.format(timestamp)} ${utcTime.format(timestamp)}`;

function exactLabel(row: InspectorSeries, unit: string, decimals?: number) {
  return row.exact.kind === 'observed' ? formatMetricDetails(row.exact.value, unit, decimals)
    : row.exact.kind === 'absent' ? 'No sample at this time'
    : row.exact.kind === 'ambiguous' ? 'Multiple observations'
    : 'Missing observation';
}

function InspectorHistory({ row, start, end, timestamp, color }: { row: InspectorSeries; start: number; end: number; timestamp: number; color: string }) {
  const uid = useId();
  // Every history has the same elapsed-time axis. Area extends to actual zero.
  const min = Math.min(0, row.min ?? 0), max = Math.max(0, row.max ?? 0);
  const magnitude = Math.max(1, Math.abs(min), Math.abs(max));
  const low = min / magnitude, high = max / magnitude, span = high - low || 1;
  const zero = high === low ? 1 : high / span;
  const stops = zero === 1 ? [[0, .24], [1, .025]] : zero === 0 ? [[0, .025], [1, .24]] : [[0, .24], [zero, .025], [1, .24]];
  const x = (time: number) => start === end ? 140 : 2 + (time - start) / (end - start) * 276;
  const y = (value: number) => 35 - (value / magnitude - low) / span * 30;
  const path = line<Point>().defined(point => point.value !== null).x(point => x(point.timestamp)).y(point => y(point.value!))(row.points);
  const fill = area<Point>().defined(point => point.value !== null).x(point => x(point.timestamp)).y0(y(0)).y1(point => y(point.value!))(row.points);
  const selected = row.exact.kind === 'observed' ? row.exact.value : null;
  const isolated = row.points.filter((point, index, points) => point.value !== null && (!index || points[index - 1].value === null) && (index === points.length - 1 || points[index + 1].value === null));
  return <svg viewBox="0 0 280 40" preserveAspectRatio="none" className={styles.richInspectorHistory} aria-hidden="true" style={{ color }}>
    <defs><linearGradient id={uid} x1="0" x2="0" y1="0" y2="1">{stops.map(([offset, opacity]) => <stop key={offset} offset={offset} stopColor="currentColor" stopOpacity={opacity}/>)}</linearGradient></defs>
    <path d={fill ?? undefined} fill={`url(#${uid})`}/>
    <line x1="2" x2="278" y1={y(0)} y2={y(0)} stroke="currentColor" strokeOpacity=".12"/>
    <path d={path ?? undefined} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke"/>
    {isolated.map((point, index) => <path key={`${point.timestamp}:${index}`} d={`M${x(point.timestamp)},${y(point.value!)}h0`} stroke="currentColor" strokeWidth="3" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>)}
    {timestamp >= start && timestamp <= end && <line x1={x(timestamp)} x2={x(timestamp)} y1="2" y2="38" stroke="var(--gamma-muted)" strokeDasharray="2 3" strokeOpacity=".65"/>}
    {selected !== null && timestamp >= start && timestamp <= end && <path d={`M${x(timestamp)},${y(selected)}h0`} stroke="currentColor" strokeWidth="4.5" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>}
  </svg>;
}

/** Dense, exact inspection content shared by the existing popup and plugin owners. */
export function RichObservationInspector({ title, series, selectedSeriesIndex, timestamp, unit, decimals, pinned, onPin, onClose, window, colors, note, children }: {
  title: string; series: Series[]; selectedSeriesIndex: number; timestamp: number; unit: string; decimals?: number;
  pinned: boolean; onPin: () => void; onClose: () => void; window?: InspectionWindow; colors: string[]; note?: string; children?: ReactNode;
}) {
  const prepared = useMemo(() => prepareObservationInspector(series, window, 12, 96, selectedSeriesIndex), [series, window?.start, window?.end, selectedSeriesIndex]);
  const model = useMemo(() => inspectPreparedObservation(prepared, timestamp), [prepared, timestamp]);
  const selected = model.rows.find(row => row.sourceIndex === selectedSeriesIndex) ?? model.rows[0];
  return <div className={styles.richInspector} data-rich-observation="" data-inspection-start={model.start ?? undefined} data-inspection-end={model.end ?? undefined}>
    <header className={styles.richInspectorHeader}><div><span>{pinned ? 'Pinned observation' : 'Observation'}</span><strong>{title}</strong></div><GammaButton variant="ghost" size="sm" iconOnly aria-label="Close observation" onClick={onClose}><X size={14}/></GammaButton></header>
    <div className={styles.richInspectorTime}><Clock3 size={13}/><time dateTime={new Date(timestamp).toISOString()}>{utcDate.format(timestamp)} <strong>{utcTime.format(timestamp)}</strong></time><span>UTC</span></div>
    {selected && <div className={styles.richInspectorTags}>{Object.entries(selected.labels).filter(([key]) => ['service', 'gateway', 'region', 'interval', 'slo', 'direction'].includes(key)).map(([key, value]) => <span key={key} title={`${key}: ${value}`}>{value}</span>)}</div>}
    <div className={styles.richInspectorRows}>{model.rows.map(row => {
      const color = colors[row.sourceIndex % colors.length] ?? 'var(--gamma-chart-1)';
      return <section key={row.key} className={styles.richInspectorRow} data-selected-series={row.sourceIndex === selectedSeriesIndex || undefined} data-observation-state={row.exact.kind}>
        <div className={styles.richInspectorValue}><span><i style={{ background: color }}/>{row.name}</span><strong title={row.exact.kind === 'observed' ? exactMetric(row.exact.value, unit) : undefined}>{exactLabel(row, unit, decimals)}</strong></div>
        {model.start !== null && model.end !== null && <InspectorHistory row={row} start={model.start} end={model.end} timestamp={timestamp} color={color}/>}
        <div className={styles.richInspectorStats}><span>Min <b>{row.min === null ? '—' : formatMetricDetails(row.min, unit, decimals)}</b></span><span>Max <b>{row.max === null ? '—' : formatMetricDetails(row.max, unit, decimals)}</b></span><span title="Finite samples / all returned samples in this history window">{row.finiteCount}/{row.sampleCount} observed</span></div>
        {row.missingCount > 0 && <span className={styles.richInspectorMissing}>{row.missingCount} missing sample{row.missingCount === 1 ? '' : 's'}</span>}
        {row.invalidTimestampCount > 0 && <span className={styles.richInspectorMissing}>{row.invalidTimestampCount} source sample{row.invalidTimestampCount === 1 ? '' : 's'} excluded: invalid timestamp</span>}
      </section>;
    })}</div>
    <p className={styles.richInspectorWindow}><span>{model.windowed ? 'Chart window history' : 'Source history'}</span>{model.start !== null && model.end !== null ? <>{utcBound(model.start)} – {utcBound(model.end)} UTC</> : 'No timestamped observations'}{model.rows.some(row => row.reduced) && <small>Histories visually reduced; statistics use all returned samples in this window.</small>}</p>
    {note && <p className={styles.richInspectorNote}>{note}</p>}
    {model.omittedSeries > 0 && <p className={styles.richInspectorNote}>{model.omittedSeries} additional series omitted from this inspector.</p>}
    {children}
    <details className={styles.richInspectorDetails}><summary>Exact observations &amp; labels</summary><p>{new Date(timestamp).toISOString()} · raw values before display rounding</p><table><caption>Exact observations at the selected timestamp</caption><thead><tr><th scope="col">Series</th><th scope="col">Value</th></tr></thead><tbody>{model.rows.map(row => <tr key={row.key}><th scope="row">{row.name}</th><td>{row.exact.kind === 'observed' ? exactMetric(row.exact.value, unit) : row.exact.kind === 'ambiguous' ? row.exactSamples.map(point => point.value === null ? 'Missing' : exactMetric(point.value, unit)).join('; ') : exactLabel(row, unit)}</td></tr>)}</tbody></table>{selected && <dl>{Object.entries(selected.labels).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}</details>
    <footer className={styles.richInspectorFooter}><GammaButton size="sm" variant="quiet" onClick={onPin} aria-pressed={pinned}><Pin size={13}/>{pinned ? 'Unpin observation' : 'Pin observation'}</GammaButton><span>Esc to close</span></footer>
  </div>;
}
