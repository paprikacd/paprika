import { PARTIAL_CHIP, staleChip, staleDetail } from "../benign-states";
import { useMemo, useRef } from "react";
import { useDashboardWindow } from "../dashboard-window";
import { StatDelta, useStatComparison, useStatDeltaFit } from "../stat-comparison";
import { useDashboardTimeZone } from "../dashboard-time-zone";
import { exactMetric, formatMetric, formatMetricDetails, latestPoint, seriesName } from "../chart-data";
import { formatReading, joinReading } from "../units";
import { StatSparkline, isSteadySeries } from "../stat-sparkline";
import { useAnnotationEvents } from "../annotation-events";
import sparklineStyles from "../stat-sparkline.module.css";
import { useEmbeddedWidget } from "../widget-presentation";
import styles from "../charts.module.css";
import type { DrilldownContext } from "../drilldown";
import { widgetTextColor } from "../appearance";
import { metricContext, validTimestamp } from "../widget-context";
import type { QueryResult, Widget } from "../schema";
import { PALETTE, type Point, type Series } from "../chart-renderer-shared";
import { widgetSeriesColors } from "../series-colors";
import { thresholdPaint } from "../status";
import { StatusChip } from "../status-chip";
import { widgetAttention, useWidgetAttentionContext } from "../widget-attention";
import { sourceNotice, truncationOf } from "../truncation";
import { EmptyState } from "./empty-state";

export function Stat({
  widget,
  series,
  result,
  onContextChange,
}: {
  widget: Widget;
  series: Series[];
  /** The whole result, so a truncated response is seen as well as the series. */
  result?: QueryResult;
  onContextChange?: (context: DrilldownContext) => void;
}) {
  const embedded = useEmbeddedWidget();
  const timeZone = useDashboardTimeZone();
  const sampleTime = useMemo(() => new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone, timeZoneName: "short" }), [timeZone]);
  // The earlier sample can be days away, so its title carries the date as well as the time.
  const earlierSampleTime = useMemo(() => new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, timeZone, timeZoneName: "short" }), [timeZone]);
  const { rangeEnd } = useDashboardWindow();
  // The change is the tile's, and an embedded stat (a tooltip's view) never shows one.
  const comparison = useStatComparison();
  const delta = embedded ? undefined : comparison;
  // Event ticks belong to the tile's own sparkline. A tooltip's or an embedded view's sparkline draws none.
  const annotationEvents = useAnnotationEvents();
  const statRef = useRef<HTMLDivElement>(null);
  // The tile evaluates its widget once and passes the verdict down. An embedded renderer shows another widget, so it evaluates its own.
  // Outside a tile, the renderer evaluates once itself; a tile's verdict is never recomputed here.
  const tileAttention = useWidgetAttentionContext();
  const attention = useMemo(
    () => !embedded && tileAttention ? tileAttention : widgetAttention(widget, { result: result ?? { series }, rangeEnd }),
    [embedded, tileAttention, widget, series, result, rangeEnd],
  );
  const entries = series
    .map((entry, index) => ({
      entry,
      index,
      name: seriesName(entry, index),
      point: latestPoint(entry),
    }))
    .filter((entry) => entry.point);
  const first = entries[0];
  useStatDeltaFit(statRef);
  if (!first?.point) return <EmptyState partial={attention.partial} />;
  // A Single value intentionally displays the last valid observation. A
  // newer missing observation must still be disclosed: otherwise an older
  // healthy value can be mistaken for a current reading. Match the dashboard
  // bundle's last-in-input rule for duplicate latest timestamps.
  let latestObservation: Point | undefined;
  for (const point of first.entry.points) {
    if (validTimestamp(point.timestamp) && (!latestObservation || point.timestamp >= latestObservation.timestamp)) latestObservation = point;
  }
  const latestMissing = latestObservation !== undefined && (typeof latestObservation.value !== "number" || !Number.isFinite(latestObservation.value));
  // Under the reading the card holds three lines: the extra rows and, when more than three series are left over, the note
  // that counts the rest. The latest-missing notice takes the caption's place rather than adding a line, so it needs no
  // room of its own. Measured at 74 px and 148 px (1, 3, 4, 5 and 120 series, shared and older captions, with and
  // without the missing line, at 390, 768 and 1512 px) every combination fits without scrolling.
  const extraSeries = entries.length - 1;
  const noteNeeded = extraSeries > 3;
  const extraRows = noteNeeded ? 2 : extraSeries;
  const shownSeries = extraRows + 1;
  const { ageSeconds, stale, band } = attention;
  const thresholds = widget.options?.thresholds;
  // Colour names the threshold's hue on the trend and the bar; the reading stays in ink (or an author's text colour).
  const textColor = widgetTextColor(widget.options);
  const color = textColor ?? thresholdPaint(band) ?? widget.color;
  const steady = !!widget.options?.showSparkline && isSteadySeries(first.entry);
  const minimum = widget.options?.min, maximum = widget.options?.max;
  const showBar = widget.options?.showStatBar === true && minimum !== undefined && maximum !== undefined && Number.isFinite(minimum) && Number.isFinite(maximum) && minimum < maximum;
  const boundedValue = showBar ? Math.max(minimum, Math.min(maximum, first.point.value)) : 0;
  const span = showBar ? maximum - minimum : 1;
  const magnitude = showBar ? Math.max(Math.abs(minimum), Math.abs(maximum), 1) : 1;
  const fraction = showBar ? Math.max(0, Math.min(1, Number.isFinite(span) ? (boundedValue - minimum) / span : (boundedValue / magnitude - minimum / magnitude) / (maximum / magnitude - minimum / magnitude))) : 0;
  // The reading may rescale its unit (ms to s, bytes to MiB), so the unit span shows the reading's unit, not the authored one.
  // Thresholds stay on their side of the rounded reading: 99.86 never reads 99.9 against a 99.9 threshold.
  const statReading = formatReading(first.point.value, widget.unit, { decimals: widget.options?.decimals, keepSides: (thresholds ?? []).map(threshold => threshold.value) });
  const barColor = thresholdPaint(band) ?? widget.color ?? "var(--gamma-chart-1)";
  // The status chip names a warning or critical band with its glyph and label. Every matched colour-only band gets a dot in
  // its hue, so the cue is never colour alone. Its text is its own label, or when unlabelled, its threshold value ("≥ 80%").
  // The first band has no value text ("≥ 0%" is noise): its dot alone, named "below" the next threshold.
  // A stale sample is a notice, not a breach: it takes the chip slot, so it never pushes the reading out of a one-row card.
  const sampleAge = ageSeconds === undefined ? "" : Math.floor(ageSeconds / 60) >= 1 ? `${Math.floor(ageSeconds / 60)} min` : `${Math.floor(ageSeconds)} sec`;
  const colourBand = band && band.status === undefined && band.color !== undefined ? band : undefined;
  const colourBandFirst = colourBand !== undefined && thresholds?.[0] !== undefined && colourBand.value <= thresholds[0].value;
  const colourBandOwnLabel = colourBand?.label?.trim() ?? "";
  const colourBandValue = colourBand ? formatMetric(colourBand.value, widget.unit, false, widget.options?.decimals) : "";
  const colourBandNext = colourBandFirst && thresholds?.[1] ? formatMetric(thresholds[1].value, widget.unit, false, widget.options?.decimals) : undefined;
  const colourBandText = colourBandOwnLabel || (colourBandFirst ? "" : `≥ ${colourBandValue}`);
  // A reading below a lone first band is named "below" it; a reading at or above it is "from" it, since "≥ 0%" is noise.
  const readingBelowBand = colourBand !== undefined && first.point.value < colourBand.value;
  const colourBandName = colourBandOwnLabel || (colourBandFirst && colourBandNext ? `below ${colourBandNext}`
    : colourBandFirst ? `${readingBelowBand ? "below" : "from"} ${colourBandValue}`
    : `≥ ${colourBandValue}`);
  // A row-capped result shows its first N by design, so it is not a partial reading.
  const statTruncation = truncationOf(result);
  const chip = <>
    {band?.status === "warning" || band?.status === "critical"
      ? <StatusChip status={band.status} color={band.color} label={band.label} className={styles.statChip} data-stat-chip={band.status} />
      : colourBand?.color
        ? <StatBandChip color={colourBand.color} text={colourBandText} name={colourBandName} />
        : null}
    {stale && <StatNoticeChip visible={staleChip(sampleAge)} full={staleDetail(sampleAge)} dataAttribute="data-stale-observation" />}
    {attention.partial && statTruncation !== "limit" && <StatNoticeChip visible={PARTIAL_CHIP} full={sourceNotice(statTruncation)} dataAttribute="data-partial-observation" />}
  </>;
  return (
    // The caption's time is in the missing notice when the latest observation is missing, so the caption is visually
    // hidden (kept for assistive technology) exactly as for a shared sample.
    <div ref={statRef} className={`${styles.stat} ${embedded ? styles.embeddedStat : ""}`} data-stat-sparkline-enabled={widget.options?.showSparkline || undefined} data-stat-bar-enabled={showBar || undefined} data-caption-merged={latestMissing || undefined}>
      {latestMissing && <div className={styles.missingObservation} role="status" data-latest-missing="" title="The latest returned observation is missing; the displayed value is the last valid sample.">Latest missing · last valid {sampleTime.format(new Date(first.point.timestamp))}</div>}
      <div
        className={`${sparklineStyles.summary} ${widget.options?.showSparkline ? sparklineStyles.withSparkline : ""}`}
        data-stat-summary=""
        data-sparkline-placement={widget.options?.sparklinePlacement ?? "background"}
      >
        {/* Anatomy, in order: reading and unit, status chip beside it, the latest valid sample's time, then the trend. */}
        <div className={sparklineStyles.value} data-stat-reading="">
          <div className={styles.statFigure} data-stat-figure="">
            {/* The reading and its status chips stay one group, so a change that wraps leaves them in place beside the reading. */}
            <span className={styles.statFigureReading}>
              {/* Plain text: the reading is never a trigger, highlight or details owner. The sparkline inspects recorded samples. */}
              <span
                className={styles.statValue}
                data-metric-value={String(first.point.value)}
                data-exact-title={`Exact value ${exactMetric(first.point.value, widget.unit)}`}
                title={`Exact value ${exactMetric(first.point.value, widget.unit)}`}
                style={{ color: textColor }}
              >
                {statReading.value}
                <span className={styles.statUnit}>{statReading.unit}</span>
              </span>
              {chip}
            </span>
            {delta && <StatDelta state={delta} formatTime={(timestamp) => earlierSampleTime.format(new Date(timestamp))} />}
          </div>
          <div className={styles.statMeta}>
            {entries.length > 1 ? `${first.name} · ` : ""}Latest valid sample ·{" "}
            <time dateTime={new Date(first.point.timestamp).toISOString()}>{sampleTime.format(new Date(first.point.timestamp))}</time>
          </div>
        </div>
        {widget.options?.showSparkline && (steady ? (
          <span className={sparklineStyles.steady} data-stat-steady="" title="Every valid sample in this range has the same value.">Steady</span>
        ) : (
          <StatSparkline widget={embedded ? undefined : widget}
            series={first.entry}
            events={embedded ? undefined : annotationEvents.events}
            name={first.name}
            unit={widget.unit}
            color={color ?? widgetSeriesColors(series, widget)[first.index]?.color ?? PALETTE[0]}
            onSelect={
              onContextChange
                ? () => onContextChange(metricContext(first.entry, first.index))
                : undefined
            }
          />
        ))}
      </div>
      {showBar && <div className={styles.statBar} role="meter" aria-label={`${widget.title} value on configured scale`}
        aria-valuemin={minimum} aria-valuemax={maximum} aria-valuenow={boundedValue}
        aria-valuetext={`${formatMetricDetails(first.point.value, widget.unit, widget.options?.decimals)}${first.point.value !== boundedValue ? " (outside configured scale)" : ""}`}
        data-stat-bar="" data-stat-bar-value={first.point.value} data-stat-bar-fraction={fraction}>
        <span className={styles.statBarFill} style={{ width: `${fraction * 100}%`, backgroundColor: barColor }} />
      </div>}
      {entries.length > 1 && (
        // With more than four series the reading and two rows fill the card, so the note takes the third row; the
        // rest are counted in the note. One section for the extra rows and their note, so the card's gap separates the reading from the list once.
        <div className={styles.statExtras} data-stat-extras="">
          {entries.slice(1, extraRows + 1).map((entry) => (
            <div className={styles.statExtra} key={`${entry.name}-${entry.index}`}>
              <span>{entry.name}</span>
              <strong>
                {joinReading(formatReading(entry.point!.value, widget.unit, { decimals: widget.options?.decimals, keepSides: (thresholds ?? []).map(threshold => threshold.value) }))}
              </strong>
            </div>
          ))}
          {entries.length > shownSeries && (
            <span className={styles.notice} role="status">
              +{entries.length - shownSeries} more series. Switch to table to inspect.
            </span>
          )}
        </div>
      )}
      {/* In short cards the rows above are hidden and this one-line note stands in for them. It counts every extra series. */}
      {entries.length > 1 && (
        <span className={styles.statCompactNote} data-stat-compact-note="">
          {entries.length - 1} more series · Switch to table to inspect
        </span>
      )}
    </div>
  );
}

/**
 * A colour-only band: a dot in the band's hue, then its text when it has one. The dot is the named element, so the full
 * name ("Threshold ≥ 80%") reaches assistive technology even when the text is empty or cut by the card's width; the title
 * shows the same name on hover. Non-interactive, like the status chip.
 */
export function StatBandChip({ color, text, name }: { color: string; text: string; name: string }) {
  const full = `Threshold ${name}`;
  return (
    <span className={styles.statBandChip} data-stat-chip="band" title={full}>
      <span className={styles.statBandDot} role="img" aria-label={full} style={{ background: color }} />
      {text && <span className={styles.statBandText} aria-hidden="true">{text}</span>}
    </span>
  );
}

/**
 * A neutral notice chip for a stat: a stale value is old, not bad, and a partial response is incomplete, not breached.
 * The visible text is short; screen readers hear the full sentence.
 */
export function StatNoticeChip({ visible, full, dataAttribute }: { visible: string; full: string; dataAttribute: string }) {
  return (
    <span className={styles.statNoticeChip} role="status" {...{ [dataAttribute]: "" }}>
      <span className={styles.statBandDot} aria-hidden="true" />
      <span className={styles.statBandText}>{visible}</span>
      <span className={styles.statSrOnly}>{full}</span>
    </span>
  );
}
