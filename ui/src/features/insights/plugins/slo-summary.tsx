"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ChevronsDown, Gauge } from "lucide-react";
import { DEFAULT_MAX_ROWS, evaluateSlo, evaluationTimestamp, validateSloConfig, type SloBurn, type SloConfig, type SloGroup, type SloOverallState, type SloReason } from "../slo";
import { formatBounds, formatReading } from "../units";
import { StatusChip } from "../status-chip";
import { getWidgetDefinition, registerWidgetPlugin, type WidgetRendererProps } from "../widget-registry";
import { ObservationDetails } from "../observation-tooltip";
import { TooltipDetail, TooltipFact } from "../tooltip-content";
import styles from "./slo-summary.module.css";

/** The authored default: a 30 day availability objective on the conventional request counter. It validates as saved. */
export const SLO_DEFAULT_CONFIG: SloConfig = {
  objective: 99.9,
  period: "30d",
  total: "http_requests_total",
  bad: 'http_requests_total{code=~"5.."}',
  burnAlerts: "multiwindow",
};

const EXACT = new Intl.NumberFormat("en", { maximumFractionDigits: 4 });

/** A single objective needs about 360px at phone width: its chip, budget, burn windows and denominator inside the card. */
const SINGLE_MIN_HEIGHT = 360;
/** The services chrome around the rows: the header, the truncation note, the column header and the footer, with their gaps. */
const SERVICES_CHROME_HEIGHT = 130;
/** One listed group at phone width, measured: the name and status on one line, the readings wrapped onto a second. */
const SERVICES_ROW_HEIGHT = 64;
/** A result whose newest sample is older than this is an earlier range, so its card names the range end. Point timestamps are milliseconds. */
const RANGE_END_TOLERANCE_MS = 300_000;
/** How often a card re-reads the clock. It is far below the tolerance, so a live card never names a range end. */
const CLOCK_TICK_MS = 30_000;
/** Sub-pixel slack when comparing measured row heights with the space a region has. */
const FIT_TOLERANCE_PX = 0.5;

/** The current time in Unix milliseconds, kept fresh on a slow tick so a card that stays open keeps judging its range. */
function useNowMs(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * How many leading rows fit in the space given, in order. Rows are measured in their rendered order, worst first, so a row
 * is kept only when it fits completely: a half-cut row is never shown.
 */
export function rowsThatFit(rowHeights: readonly number[], available: number): number {
  let used = 0;
  let count = 0;
  for (const height of rowHeights) {
    if (used + height > available + FIT_TOLERANCE_PX) break;
    used += height;
    count += 1;
  }
  return count;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A short local range end, such as "19 Nov 03:10": the day, the month and the time, with no year, so it fits a small card. */
export function shortRangeEnd(ms: number): string {
  const at = new Date(ms);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `${at.getDate()} ${MONTHS[at.getMonth()]} ${hh}:${mm}`;
}

/**
 * The services rows that fit the card's region. The region's height comes from the grid, not from its rows, so the rows are
 * measured after layout: every row is laid out, the leading rows that fit completely are kept, and the rest are hidden with
 * the hidden attribute, so each group is in the DOM once. React never renders that attribute, so it never resets it. A
 * region with no height (a card that is not laid out, as in a DOM without layout) shows every listed row. The fit is
 * re-measured after each render and on every resize of the region or of a row.
 */
function useFittingRows(): { regionRef: RefObject<HTMLDivElement | null>; tableRef: RefObject<HTMLTableElement | null>; fit: number | null } {
  const regionRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [fit, setFit] = useState<number | null>(null);
  const measure = useCallback(() => {
    const region = regionRef.current;
    const table = tableRef.current;
    if (!region || !table) return;
    const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr"));
    // Lay every row out before measuring, so a row hidden by an earlier, smaller fit is measured too.
    for (const row of rows) row.hidden = false;
    const available = region.clientHeight;
    if (available <= 0) {
      setFit(null);
      return;
    }
    const headRow = table.querySelector("thead tr");
    const header = headRow ? headRow.getBoundingClientRect().height : 0;
    const count = rowsThatFit(rows.map(row => row.getBoundingClientRect().height), available - header);
    rows.forEach((row, index) => { row.hidden = index >= count; });
    setFit(count);
  }, []);
  // Measured after every render, so new rows or new data are placed before the browser paints.
  useLayoutEffect(() => measure());
  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(region);
    // A row that grows on its own (a late font swap) changes the fit without resizing the region.
    if (tableRef.current) observer.observe(tableRef.current);
    return () => observer.disconnect();
  }, [measure]);
  return { regionRef, tableRef, fit };
}

/**
 * The minimum card height for a config. A services card lists up to maxRows groups. The group count is known only once the
 * query has run, so the row cap stands in for it. The minimum is approximate (row heights vary with the readings); the card
 * never half-cuts a row either way, because rows that do not fit are hidden and counted in its footer. A single objective
 * keeps its fixed minimum.
 */
export function sloMinHeight(config: unknown): number {
  const parsed = sloConfigOf(config);
  if (!parsed?.groupBy) return SINGLE_MIN_HEIGHT;
  return SERVICES_CHROME_HEIGHT + (parsed.maxRows ?? DEFAULT_MAX_ROWS) * SERVICES_ROW_HEIGHT;
}

/**
 * Chip status and words per objective state. "No data" covers no traffic, no data and an incomplete result. "Partial" is the
 * overall state when no evaluated group is worse than meeting but some group is unknown or a truncated result may hide groups.
 * It is never "Meeting".
 */
const STATE_CHIP: Record<SloOverallState, { status: "ok" | "warning" | "critical" | "unknown"; label: string }> = {
  meeting: { status: "ok", label: "Meeting" },
  at_risk: { status: "warning", label: "At risk" },
  breaching: { status: "critical", label: "Breaching" },
  unknown: { status: "unknown", label: "No data" },
  partial: { status: "unknown", label: "Partial" },
};

const COUNT = new Intl.NumberFormat("en", { maximumFractionDigits: 0 });

/**
 * A value at the widget's decimals. Bounds (the objective) keep their own value, so 99.9 never reads as 100. The ratio
 * arithmetic leaves float residue (-100.00000000002), so the value is first rounded to six decimals, far below any display.
 */
function reading(value: number, unit: string, decimals: number | undefined, keepSides: number[] = []): string {
  const shown = formatReading(Math.round(value * 1e6) / 1e6, unit, { decimals, keepSides });
  return `${shown.value}${shown.unit}`;
}

/**
 * A percentage at the widget's decimals. Fixed decimals can round a value under 100 up to 100 (99.96 at one place), so that
 * case falls back to Auto, which never prints a float residue. Auto (decimals undefined) already has this guard.
 */
function percentText(value: number, decimals: number | undefined, keepSides: number[] = []): string {
  const shown = reading(value, "%", decimals, keepSides);
  if (value < 100 && Number.parseFloat(shown) >= 100) return reading(value, "%", undefined, keepSides);
  // A negative value keeps its sign at any decimals: an overspend of 0.04% must not read as 0%.
  if (value < 0 && Number.parseFloat(shown) >= 0) return reading(value, "%", undefined, [...keepSides, 0]);
  return shown;
}

/**
 * A burn rate or factor at the widget's decimals, with one unit spacing everywhere. Each value is rounded on its own, so a
 * rate near its factor never prints extra digits to tell them apart, and a rate of 0.3 at zero decimals reads "0 ×".
 */
function multipleText(value: number, decimals: number | undefined): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  if (decimals === undefined) return formatBounds([rounded], "×")[0];
  const shown = formatReading(rounded, "×", { decimals });
  return `${shown.value} ${shown.unit}`;
}

/**
 * A burn factor is an authored bound, so it follows the widget's decimals but keeps its own value: 14.4 reads "14.4 ×" at zero
 * decimals and "14.40 ×" at two, never "14 ×". formatReading's keepSides only guards against a collision, so bounds are used here.
 */
function factorText(value: number, decimals: number | undefined): string {
  const rounded = Math.round(value * 1e6) / 1e6;
  return formatBounds([rounded], "×", decimals)[0];
}

/** The chip for a group or the whole objective. A group with no requests is "No traffic", not a failed or unknown reading. */
function chipFor(state: SloOverallState, reasons: readonly SloReason[]): { status: "ok" | "warning" | "critical" | "unknown"; label: string } {
  if (state === "unknown" && reasons.includes("no_traffic")) return { status: "unknown", label: "No traffic" };
  return STATE_CHIP[state];
}

function sloConfigOf(config: unknown): SloConfig | undefined {
  return validateSloConfig(config) === undefined ? (config as SloConfig) : undefined;
}

/**
 * The words for a group with no availability reading. The reason decides the copy: a truncated result, no traffic in the
 * period, a missing total series, or a missing error series. Only no traffic reads as "no requests".
 */
function unknownText(group: SloGroup, period: string): string {
  if (group.reasons.includes("incomplete")) return "Result truncated; objective not proven";
  if (group.reasons.includes("no_traffic")) return `No requests in ${period}`;
  if (group.total === null) return "No data";
  return "Error series missing";
}

function groupName(group: SloGroup, config: SloConfig): string {
  if (!config.groupBy) return "All requests";
  // A series without the grouping label is not one of the named groups, so it says what is missing rather than reading as all requests.
  if (group.labels[config.groupBy] === undefined) return `(no ${config.groupBy})`;
  return Object.values(group.labels).join(", ");
}

function budgetWidth(budget: number | null): number {
  if (budget === null || !Number.isFinite(budget)) return 0;
  return Math.min(100, Math.max(0, budget));
}

/** The burn pair whose long rate is furthest over its factor, for the services table. */
function worstBurn(group: SloGroup): SloBurn | undefined {
  let worst: SloBurn | undefined;
  let worstRatio = Number.NEGATIVE_INFINITY;
  for (const entry of group.burn) {
    if (entry.longBurn === null) continue;
    const ratio = entry.longBurn / entry.factor;
    if (ratio > worstRatio) {
      worst = entry;
      worstRatio = ratio;
    }
  }
  return worst;
}

/** The exact values behind one burn pair, for its tooltip. Rates keep four decimals; a missing rate reads as no traffic. */
function BurnDetail({ entry }: { entry: SloBurn }) {
  // The same unit spacing as the chip: "14.4 ×", never "14.4×".
  const exact = (value: number | null) => (value === null ? "no traffic in this window" : `${EXACT.format(value)} ×`);
  return (
    <TooltipDetail title={`${entry.long} over ${entry.short}`}>
      <TooltipFact label="Long rate">{exact(entry.longBurn)}</TooltipFact>
      <TooltipFact label="Short rate">{exact(entry.shortBurn)}</TooltipFact>
      <TooltipFact label="Factor">{exact(entry.factor)}</TooltipFact>
      <TooltipFact label="Pair">{entry.firing ? `Fires as ${entry.severity}` : "Does not fire"}</TooltipFact>
    </TooltipDetail>
  );
}

/** Burn windows of the group: the long and short rate of each pair against its factor. */
function BurnChips({ group, decimals }: { group: SloGroup; decimals: number | undefined }) {
  if (group.burn.length === 0) return null;
  return (
    <ul className={styles.burn} aria-label="Burn windows">
      {group.burn.map(entry => {
        const long = entry.longBurn === null ? "no traffic" : multipleText(entry.longBurn, decimals);
        const short = entry.shortBurn === null ? "no traffic" : multipleText(entry.shortBurn, decimals);
        const factor = factorText(entry.factor, decimals);
        const pair = `${entry.long}·${entry.short}`;
        return (
          <li key={pair} className={styles.burnChip} data-slo-severity={entry.severity} data-slo-firing={entry.firing || undefined}>
            <ObservationDetails
              label={`Burn windows ${entry.long} and ${entry.short}`}
              observationKey={pair}
              className={styles.burnTrigger}
              details={<BurnDetail entry={entry} />}
            >
              <span className={styles.burnWindow}>{pair}</span>
              <span>{long} / {short} of {factor}</span>
            </ObservationDetails>
          </li>
        );
      })}
    </ul>
  );
}

/** The error budget as a bounded track. An overspent budget shows an empty track, an overflow cue and the signed value. */
function BudgetBar({ group, decimals }: { group: SloGroup; decimals: number | undefined }) {
  const budget = group.budgetRemaining;
  if (budget === null) return <span className={styles.muted}>—</span>;
  const overspent = budget < 0;
  const text = percentText(budget, decimals, [0]);
  return (
    <span className={styles.budget} data-slo-overspent={overspent || undefined}>
      <span className={styles.track} role="img" aria-label={`Error budget remaining ${text}`}>
        <span className={styles.fill} style={{ width: `${budgetWidth(budget)}%` } as CSSProperties} />
      </span>
      {overspent && <ChevronsDown aria-hidden="true" size={13} className={styles.overflow} />}
      <span className={overspent ? styles.overspent : undefined} data-slo-budget-value>{text}</span>
    </span>
  );
}

function Denominator({ group, period }: { group: SloGroup; period: string }) {
  if (group.total === null || group.bad === null || group.allowed === null) return null;
  return (
    <p className={styles.denominator}>
      {COUNT.format(group.bad)} of {COUNT.format(group.total)} requests failed in {period}; {COUNT.format(group.allowed)} allowed
    </p>
  );
}

export function SloSummary({ widget, result }: WidgetRendererProps) {
  const now = useNowMs();
  const { regionRef, tableRef, fit } = useFittingRows();
  const config = sloConfigOf(widget.config);
  if (!config) {
    return <div className={styles.panel} role="alert"><p className={styles.muted}>The SLO configuration is invalid.</p></div>;
  }
  const decimals = widget.options?.decimals;
  const evaluation = evaluateSlo(config, result);
  const chip = chipFor(evaluation.state, evaluation.reasons);
  const target = percentText(config.objective, decimals, [config.objective]);
  // The range end is named only when it is not now, so a live card keeps its plain window wording.
  const end = evaluationTimestamp(result);
  const endedAt = end !== undefined && Math.abs(now - end) > RANGE_END_TOLERANCE_MS ? shortRangeEnd(end) : undefined;
  const header = (
    <header className={styles.header}>
      <StatusChip status={chip.status} label={chip.label} />
      <span className={styles.target}>Objective {target} over {endedAt ? `${config.period} ending ${endedAt}` : `${config.period} window`}</span>
    </header>
  );

  if (config.groupBy) {
    const listed = evaluation.groups.length;
    const total = listed + evaluation.groupsOmitted;
    const shown = fit === null ? listed : Math.min(fit, listed);
    const hidden = total - shown;
    const truncated = evaluation.reasons.includes("incomplete");
    // A truncated result cannot count the groups it cut, so its total is a lower bound, never an exact count.
    const footer = truncated && evaluation.groupsOmitted > 0
      ? `Showing ${shown} of at least ${total} groups; the result is truncated`
      : hidden > 0
        ? `Showing ${shown} of ${total} groups; ${hidden} more ${hidden === 1 ? "group" : "groups"} not shown${truncated ? "; the result is truncated" : ""}`
        : `${total} ${total === 1 ? "group" : "groups"}${truncated ? "; the result is truncated" : ""}`;
    const renderRow = (group: SloGroup) => {
      const groupChip = chipFor(group.state, group.reasons);
      const worst = worstBurn(group);
      return (
        <tr key={groupName(group, config)} data-slo-group={group.state}>
          <th scope="row">{groupName(group, config)}</th>
          <td data-label="Status"><StatusChip status={groupChip.status} label={groupChip.label} /></td>
          <td data-label="Availability">{group.availability === null ? unknownText(group, config.period) : percentText(group.availability, decimals, [config.objective])}</td>
          <td data-label="Budget"><BudgetBar group={group} decimals={decimals} /></td>
          <td data-label="Worst burn">{worst ? `${worst.long}·${worst.short} ${multipleText(worst.longBurn ?? 0, decimals)}` : "—"}</td>
        </tr>
      );
    };
    const columns = (
      <tr>
        <th scope="col">{config.groupBy}</th>
        <th scope="col">Status</th>
        <th scope="col">Availability</th>
        <th scope="col">Budget</th>
        <th scope="col">Worst burn</th>
      </tr>
    );
    return (
      <div className={styles.panel} data-slo-state={evaluation.state} data-slo-mode="services">
        {header}
        {truncated && (
          <p className={styles.muted}>Result truncated: some groups are not proven to meet the objective.</p>
        )}
        {/* Only the rows that fit completely are rendered, worst first. Rows hidden for space are counted in the footer. */}
        <div ref={regionRef} className={styles.scroll} role="region" aria-label={`${config.groupBy} groups`} data-slo-scroll>
          <table ref={tableRef} className={styles.table} data-slo-rows>
            <thead>{columns}</thead>
            <tbody>{evaluation.groups.map(renderRow)}</tbody>
          </table>
        </div>
        <p className={styles.footnote} data-slo-footer>{footer}</p>
      </div>
    );
  }

  const group = evaluation.groups[0];
  return (
    <div className={styles.panel} data-slo-state={evaluation.state} data-slo-mode="single">
      {header}
      {evaluation.reasons.includes("incomplete") && (
        <p className={styles.muted}>Result truncated: the series may be incomplete.</p>
      )}
      {!group || group.availability === null ? (
        <p className={styles.reading}>{group ? unknownText(group, config.period) : "No data"}</p>
      ) : (
        <>
          <p className={styles.reading}>
            <span data-slo-availability>{percentText(group.availability, decimals, [config.objective])}</span>
            <span className={styles.muted}> availability</span>
          </p>
          <BudgetBar group={group} decimals={decimals} />
          <BurnChips group={group} decimals={decimals} />
          <Denominator group={group} period={config.period} />
        </>
      )}
    </div>
  );
}

export function registerSloSummaryPlugin() {
  if (getWidgetDefinition("plugin", "slo-summary")) return;
  registerWidgetPlugin({
    id: "slo-summary",
    label: "SLO objective",
    description: "An author-declared objective: availability, error budget and burn windows over its period",
    dataKind: "metrics",
    render: SloSummary,
    listed: true,
    defaultConfig: SLO_DEFAULT_CONFIG,
    styleControls: ["decimals"],
    validateInput: (_result, config) => {
      const code = validateSloConfig(config);
      return code ? [{ message: `The SLO configuration is invalid: ${code}` }] : [];
    },
    // A single objective needs about 360px to keep its chip, budget, burn windows and denominator inside the card at a 390px
    // phone width. A services card grows with its row cap (sloMinHeight). The minimum grows the narrow projection's track
    // (responsive-layout.ts), so a short saved card is not clipped.
    sizing: { mode: "intrinsic", minHeight: SINGLE_MIN_HEIGHT, minHeightFor: sloMinHeight },
    icon: Gauge,
  });
}
