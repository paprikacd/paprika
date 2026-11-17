import type { AggregatePoint } from '../data/telemetry';
import { clockTime, latency, integer, percentage, TIMEZONE } from '../format';

export function ExactData({ timeline }: { timeline: readonly AggregatePoint[] }) {
  return <div className="data-scroll" tabIndex={0} aria-label="Exact interval data, scrollable table">
    <table>
      <caption>Observed values per 60-second interval · {TIMEZONE}. Percentiles are histogram estimates. Missing values are shown as unavailable.</caption>
      <thead><tr><th scope="col">Interval end</th><th scope="col">Requests</th><th scope="col">Failed</th><th scope="col">Error rate</th><th scope="col">p50 (ms)</th><th scope="col">p95 (ms)</th><th scope="col">Coverage</th></tr></thead>
      <tbody>{timeline.map(point => <tr key={point.timestampMs}>
        <th scope="row"><time dateTime={new Date(point.timestampMs).toISOString()}>{clockTime(point.timestampMs)}</time></th>
        <td>{integer(point.requests)}</td><td>{integer(point.errors)}</td><td>{percentage(point.errorRatio)}</td><td>{latency(point.p50Ms)}</td><td>{latency(point.p95Ms)}</td>
        <td>{point.observedRegions}/{point.expectedRegions} regions{!point.complete && ' · missing'}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}
