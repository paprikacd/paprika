import { useId, type CSSProperties } from "react";
import { GammaButton } from "@insights/gamma/button";
import styles from "./RegionalLatency.module.css";

export type RegionalLatencyItem = {
  id: string;
  name: string;
  code: string;
  requests: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  errorRatio: number | null;
  /** Observed region-minutes / expected region-minutes, in [0, 1]. */
  coverage: number;
};

export type RegionalLatencyProps = {
  items: readonly RegionalLatencyItem[];
  selectedRegion: string;
  onSelect: (region: string) => void;
};

const integer = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 1 });
const percent = new Intl.NumberFormat("en-AU", {
  style: "percent",
  maximumFractionDigits: 3,
});

const REGION_COLORS: Record<string, string> = {
  "ap-southeast-2": "var(--gamma-chart-1)",
  "us-west-2": "var(--gamma-chart-2)",
  "eu-west-1": "var(--gamma-chart-7)",
};

function validMagnitude(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0;
}

function intervalAvailable(item: RegionalLatencyItem) {
  return (
    item.requests !== 0 &&
    validMagnitude(item.p50Ms) &&
    validMagnitude(item.p95Ms) &&
    item.p95Ms >= item.p50Ms
  );
}

function domainMaximum(maximum: number) {
  // A common, zero-based domain makes intervals comparable across rows.
  // No geometry depends on the width of the component or the selected region.
  const required = maximum * 1.08;
  const candidates = [100, 200, 400, 600, 800, 1_000, 1_500, 2_000, 3_000, 5_000];
  return candidates.find((candidate) => candidate >= required)
    ?? Math.ceil(required / 1_000) * 1_000;
}

function latency(value: number | null) {
  return validMagnitude(value) ? `${decimal.format(value)} ms` : "Unavailable";
}

function errorRate(value: number | null) {
  if (value === null || !Number.isFinite(value) || value < 0 || value > 1) {
    return "Unavailable";
  }
  if (value > 0 && value < 0.00001) return "<0.001%";
  return percent.format(value);
}

/**
 * A bounded interval comparison: each range runs from p50 to p95, not zero to p95.
 * Callers supply percentiles computed from pooled compatible histogram buckets.
 */
export function RegionalLatency({
  items,
  selectedRegion,
  onSelect,
}: RegionalLatencyProps) {
  const hintId = useId();
  const usable = items.filter(intervalAvailable);
  const maximum = domainMaximum(Math.max(0, ...usable.map((item) => item.p95Ms!)));
  const ticks = Array.from({ length: 5 }, (_, index) => maximum * index / 4);

  if (!items.length) {
    return (
      <div className={styles.empty} role="status">
        No regional observations in this window.
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <svg width="14" height="12" aria-hidden="true">
            <circle cx="7" cy="6" r="3" fill="currentColor" />
          </svg>
          p50
        </span>
        <span className={styles.legendItem}>
          <svg width="14" height="12" aria-hidden="true">
            <path d="M7 1v10" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
          p95
        </span>
        <span className={styles.legendNote}>Same scale · milliseconds</span>
      </div>

      <div className={styles.rows}>
        {items.map((item) => {
          const selected = selectedRegion === item.id;
          const available = intervalAvailable(item);
          const start = available ? `${(item.p50Ms! / maximum) * 100}%` : "0%";
          const end = available ? `${(item.p95Ms! / maximum) * 100}%` : "0%";
          const coverageKnown = Number.isFinite(item.coverage)
            && item.coverage >= 0 && item.coverage <= 1;
          const partial = !coverageKnown || item.coverage < 1;
          const requests = validMagnitude(item.requests)
            ? integer.format(item.requests)
            : "Unavailable";
          const accessibleMetrics = available
            ? `Estimated p50 ${latency(item.p50Ms)}, p95 ${latency(item.p95Ms)}.`
            : "Latency interval unavailable.";
          const accessibleAction = selected
            ? `Show all regions; currently filtering to ${item.name}.`
            : `Filter dashboard to ${item.name}, ${item.code}.`;

          return (
            <GammaButton
              key={item.id}
              type="button"
              variant="quiet"
              className={styles.row}
              style={{
                "--region-color": REGION_COLORS[item.id] ?? "var(--gamma-chart-1)",
              } as CSSProperties}
              aria-pressed={selected}
              aria-describedby={hintId}
              aria-label={`${accessibleAction} ${accessibleMetrics} ${requests} requests. ${errorRate(item.errorRatio)} errors.${partial ? ` ${coverageKnown ? percent.format(item.coverage) : "Unknown"} interval coverage.` : ""}`}
              onClick={() => onSelect(selected ? "all" : item.id)}
            >
              <span className={styles.rowHeading}>
                <span className={styles.identity}>
                  <span className={styles.name}>{item.name}</span>
                  <span className={styles.code}>{item.code}</span>
                </span>
                <span className={styles.primaryValue}>
                  {available ? decimal.format(item.p95Ms!) : "—"}
                  <span className={styles.valueUnit}>{available ? "ms p95" : "no percentile"}</span>
                </span>
                <svg className={styles.filterIcon} width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  {selected
                    ? <path d="m3.5 8 3 3 6-6" />
                    : <path d="m6 4 4 4-4 4" />}
                </svg>
              </span>

              <span className={styles.plot}>
                <svg className={styles.range} width="100%" height="26" aria-hidden="true">
                  {ticks.map((tick, index) => (
                    <line
                      key={tick}
                      className={styles.guide}
                      x1={`${index * 25}%`}
                      x2={`${index * 25}%`}
                      y1="1"
                      y2="25"
                    />
                  ))}
                  {available && (
                    <>
                      <line className={styles.rangeWash} x1={start} x2={end} y1="13" y2="13" />
                      <line className={styles.rangeLine} x1={start} x2={end} y1="13" y2="13" />
                      <circle className={styles.median} cx={start} cy="13" r="3.5" />
                      <line className={styles.tail} x1={end} x2={end} y1="7" y2="19" />
                    </>
                  )}
                </svg>
                {!available && (
                  <span className={styles.noInterval}>
                    {item.requests === 0 ? "No requests · percentile undefined" : "Missing latency observations"}
                  </span>
                )}
              </span>

              <span className={styles.metrics}>
                <span className={styles.medianLabel}>p50 <strong>{available ? latency(item.p50Ms) : "—"}</strong></span>
                <span className={styles.context}>
                  <span>{requests} requests</span>
                  <span>{errorRate(item.errorRatio)} errors</span>
                </span>
              </span>
              {partial && (
                <span className={styles.coverage}>
                  {coverageKnown ? `${percent.format(item.coverage)} interval coverage` : "Interval coverage unavailable"}
                </span>
              )}
            </GammaButton>
          );
        })}
      </div>

      <div className={styles.axis} aria-hidden="true">
        {usable.length > 0 && ticks.map((tick, index) => (
          <span key={tick} style={{ left: `${index * 25}%` }}>{decimal.format(tick)}</span>
        ))}
      </div>
      <p id={hintId} className={styles.hint}>
        Select a region to filter. Percentiles are histogram estimates.
      </p>
    </div>
  );
}
