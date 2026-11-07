import type { CSSProperties, ReactNode } from "react"
import { z } from "zod"
import { exactMetric, formatMetric } from "../chart-data"
import { thresholdForValue } from "../chart-renderers"
import { contrastRatio, readableTextColor } from "../appearance"
import type { RecordFrame, Threshold } from "../schema"
import { StatSparkline, MAX_SPARKLINE_POINTS } from "../stat-sparkline"
import styles from "./records.module.css"

const cellStyle = z.strictObject({
  column: z.string().min(1).max(128),
  display: z.enum(["bar", "bar-segments", "color-text", "color-background", "sparkline", "status-badge"]),
  barColorMode: z.enum(["gradient", "value"]).optional(),
  thresholdColumn: z.string().min(1).max(128).optional(),
  mappings: z.array(z.strictObject({ value: z.string().min(1).max(128), color: z.string().regex(/^#[\da-f]{6}$/i) })).max(16).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  unit: z.string().max(24).optional(),
  segments: z.number().int().min(4).max(60).optional(),
}).superRefine((style, context) => {
  const bar = style.display === "bar" || style.display === "bar-segments"
  if (bar &&
    (style.min === undefined || style.max === undefined || style.min >= style.max))
    context.addIssue({ code: "custom", message: "Bar cells need an explicit minimum below their maximum" })
  if (!bar && (style.min !== undefined || style.max !== undefined))
    context.addIssue({ code: "custom", message: "Only bar cells use a numeric scale" })
  if (style.display !== "bar-segments" && style.segments !== undefined)
    context.addIssue({ code: "custom", message: "Only segmented gauges use a segment count" })
  if (!bar && style.barColorMode !== undefined)
    context.addIssue({ code: "custom", message: "Only gauges use a bar color mode" })
  if (style.display !== "sparkline" && style.thresholdColumn !== undefined)
    context.addIssue({ code: "custom", message: "Only history sparklines use a threshold column" })
  if (style.display !== "status-badge" && style.mappings !== undefined)
    context.addIssue({ code: "custom", message: "Only status badges use value mappings" })
  if (style.display === "status-badge" && style.unit !== undefined)
    context.addIssue({ code: "custom", message: "Status badges do not use a unit" })
  if (style.mappings && new Set(style.mappings.map(mapping => mapping.value)).size !== style.mappings.length)
    context.addIssue({ code: "custom", message: "Each status value can have only one mapping" })
})

export const tableCellStylesSchema = z.array(cellStyle).max(16).superRefine((entries, context) => {
  const columns = new Set<string>()
  entries.forEach((entry, index) => {
    if (columns.has(entry.column)) context.addIssue({ code: "custom", path: [index, "column"], message: "Style each column once" })
    columns.add(entry.column)
  })
})
export type TableCellStyle = z.infer<typeof cellStyle>

// Match the scoped Gamma panel/chart tokens (guarded by the palette test).
const tableThemes = {
  light: { background: "#ffffff", color: "#bb5037" },
  dark: { background: "#182127", color: "#ed8d70" },
}

/** Retain an authored hue, changing only its rendered text tone when needed. */
export function tableTextColor(color: string, background: string) {
  if (contrastRatio(color, background) >= 4.5) return color
  const target = contrastRatio("#000000", background) > contrastRatio("#ffffff", background) ? 0 : 255
  const channels = [1, 3, 5].map(offset => Number.parseInt(color.slice(offset, offset + 2), 16))
  const mix = (amount: number) => `#${channels.map(channel => Math.round(channel + (target - channel) * amount).toString(16).padStart(2, "0")).join("")}`
  let low = 0, high = 1
  // Test rounded channel values, so the returned CSS color itself meets WCAG.
  for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2
    if (contrastRatio(mix(middle), background) >= 4.5) high = middle
    else low = middle
  }
  return mix(high)
}

/** One small palette per table/theme, rather than observing each rendered cell. */
export function tableTextPalette(theme: "light" | "dark", background?: string, thresholds?: readonly Threshold[], color?: string) {
  const surface = background ?? tableThemes[theme].background
  const colors = new Map((thresholds ?? []).map(threshold => [threshold.color, tableTextColor(threshold.color, surface)]))
  colors.set(color ?? "var(--gamma-chart-3)", tableTextColor(color ?? tableThemes[theme].color, surface))
  return colors
}

function positionOnScale(value: number, min: number, max: number) {
  const width = max - min
  // Opposite finite extremes can overflow their span. Normalize only that
  // case so ordinary narrow domains retain their full relative precision.
  const scale = Math.max(Math.abs(min), Math.abs(max))
  const position = Number.isFinite(width) ? (value - min) / width : (value / scale - min / scale) / (max / scale - min / scale)
  return Math.max(0, Math.min(1, position))
}

/** Explicit scales are stable across filtering, sorting and paging. Zero is the
 * baseline when it is inside the domain; otherwise use its nearest bound. */
export function tableBarGeometry(value: number, min: number, max: number) {
  const fraction = (point: number) => positionOnScale(point, min, max)
  const baseline = fraction(0)
  const end = fraction(value)
  return { baseline, start: Math.min(baseline, end), end: Math.max(baseline, end), outside: value < min || value > max }
}

function barGradient(min: number, max: number, thresholds: readonly Threshold[] | undefined, color: string) {
  if (!thresholds?.length) return color
  let previous = thresholdForValue(min, thresholds)!.color
  const stops = [`${previous} 0%`]
  for (const threshold of thresholds) {
    if (threshold.value > min && threshold.value < max) {
      const stop = positionOnScale(threshold.value, min, max) * 100
      stops.push(`${previous} ${stop}%`, `${threshold.color} ${stop}%`)
      previous = threshold.color
    }
  }
  stops.push(`${previous} 100%`)
  return `linear-gradient(90deg, ${stops.join(", ")})`
}

export function tableCellStyleError(frame: RecordFrame, cellStyles: TableCellStyle[]) {
  for (const style of cellStyles) {
    const column = frame.columns.find(entry => entry.key === style.column)
    if (!column) return `The query result has no “${style.column}” column for its cell style.`
    if (style.display === "status-badge" && column.type !== "string") return `Status badge styling requires a string column; “${style.column}” is ${column.type}.`
    if (style.display === "sparkline" && column.type !== "string") return `Sparkline styling requires a string column; “${style.column}” is ${column.type}.`
    if (style.thresholdColumn) {
      const thresholdColumn = frame.columns.find(entry => entry.key === style.thresholdColumn)
      if (!thresholdColumn) return `The query result has no “${style.thresholdColumn}” threshold column for its sparkline.`
      if (thresholdColumn.type !== "number") return `Sparkline threshold coloring requires a numeric column; “${style.thresholdColumn}” is ${thresholdColumn.type}.`
    }
    if (style.display !== "sparkline" && style.display !== "status-badge" && column.type !== "number") return `Cell styling requires a numeric column; “${style.column}” is ${column.type}.`
  }
}

const historySchema = z.array(z.strictObject({
  timestamp: z.iso.datetime({ offset: true }),
  value: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
})).max(MAX_SPARKLINE_POINTS)

/** Record frames remain scalar-only. History is an explicitly configured JSON
 * string, not an inferred trend or a second query. Ordering must be deliberate
 * so duplicate timestamps cannot silently manufacture a line. */
export function parseRecordHistory(value: unknown) {
  if (value === null || value === "") return { state: "empty" as const }
  if (typeof value !== "string" || value.length > 16 * 1024) return { state: "invalid" as const }
  try {
    const history = historySchema.parse(JSON.parse(value))
    const points = history.map(point => ({ timestamp: Date.parse(point.timestamp), value: point.value }))
    if (points.some((point, index) => !Number.isFinite(point.timestamp) || index > 0 && point.timestamp <= points[index - 1].timestamp)) return { state: "invalid" as const }
    return points.length ? { state: "valid" as const, points } : { state: "empty" as const }
  } catch {
    return { state: "invalid" as const }
  }
}

function RecordHistoryCell({ value, column, color, decimals, unit: authoredUnit, colorMeaning, nativeTitle }: {
  value: unknown, column: RecordFrame["columns"][number], color?: string, decimals?: number, unit?: string, colorMeaning?: string, nativeTitle: boolean,
}) {
  const history = parseRecordHistory(value)
  if (history.state !== "valid") return <span className={styles.cellHistoryState} data-cell-display="sparkline" data-history-state={history.state} title={nativeTitle && history.state === "invalid" ? "History must be an ordered JSON array of timestamped numeric or null observations." : undefined}>{history.state === "invalid" ? "Invalid history" : "No history"}</span>
  const name = column.label ?? column.key, unit = authoredUnit ?? (column.unit === "percent" ? "%" : column.unit ?? "")
  const latest = history.points[history.points.length - 1]
  return <span className={styles.cellHistory} data-cell-display="sparkline" data-history-state="valid" title={nativeTitle ? colorMeaning : undefined}>
    <span className={styles.cellHistoryPlot}><StatSparkline series={{ name, labels: {}, points: history.points }} name={name} unit={unit} color={color ?? "var(--gamma-chart-1)"} latestLabel="Latest valid sample in history" /></span>
    <span className={styles.cellHistoryReading}>{latest.value === null ? "No data" : formatMetric(latest.value, unit, false, decimals)}</span>
    {colorMeaning && <span className={styles.cellHistoryMeaning} data-history-color-meaning>{colorMeaning}</span>}
  </span>
}

export function StyledRecordCell({ value, formatted, column, style, thresholds, color, textColors, decimals, thresholdValue, nativeTitle = true }: {
  value: unknown
  formatted: ReactNode
  column: RecordFrame["columns"][number]
  style: TableCellStyle
  thresholds?: readonly Threshold[]
  color?: string
  textColors: ReadonlyMap<string, string>
  decimals?: number
  thresholdValue?: unknown
  nativeTitle?: boolean
}) {
  if (style.display === "status-badge") {
    const missing = value === null || value === undefined || value === ""
    const mapping = typeof value === "string" ? style.mappings?.find(entry => entry.value === value) : undefined
    return <span className={styles.statusBadge} data-cell-display="status-badge" data-status-state={missing ? "missing" : mapping ? "mapped" : "unmapped"}
      title={nativeTitle ? `${column.label ?? column.key}: ${missing ? "No data" : String(value)}` : undefined}>
      <span className={styles.statusDot} aria-hidden="true" style={mapping ? { backgroundColor: mapping.color } : undefined} />
      <span>{missing ? "No data" : formatted}</span>
    </span>
  }
  if (style.display === "sparkline") {
    const sourceValue = typeof thresholdValue === "number" && Number.isFinite(thresholdValue) ? thresholdValue : undefined
    const threshold = sourceValue === undefined ? undefined : thresholdForValue(sourceValue, thresholds)
    const colorMeaning = style.thresholdColumn ? sourceValue === undefined
      ? `Color by ${style.thresholdColumn}: no data`
      : threshold ? `Color by ${style.thresholdColumn}: ${sourceValue}${threshold.label ? ` · ${threshold.label}` : ""}`
        : `Color by ${style.thresholdColumn}: ${sourceValue} · no thresholds configured`
      : undefined
    return <RecordHistoryCell value={value} column={column} color={style.thresholdColumn ? threshold?.color ?? "var(--gamma-muted)" : color} decimals={decimals} unit={style.unit} colorMeaning={colorMeaning} nativeTitle={nativeTitle} />
  }
  const finite = typeof value === "number" && Number.isFinite(value)
  const unit = style.unit ?? (column.unit === "percent" ? "%" : column.unit ?? "")
  const threshold = finite ? thresholdForValue(value, thresholds) : undefined
  const fill = threshold?.color ?? color ?? "var(--gamma-chart-3)"
  const isBar = style.display === "bar" || style.display === "bar-segments"
  const geometry = finite && isBar ? tableBarGeometry(value, style.min!, style.max!) : undefined
  const exact = finite ? exactMetric(value, unit) : "No data"
  const scale = isBar ? ` · Scale ${exactMetric(style.min!, unit)} to ${exactMetric(style.max!, unit)}${geometry?.outside ? " · Outside scale" : ""}` : ""
  const label = `${column.label ?? column.key}: ${exact}${threshold?.label ? ` · ${threshold.label}` : ""}${scale}`
  const background = finite && style.display === "color-background"
    ? /^#[\da-f]{6}$/i.test(fill) ? fill : `color-mix(in srgb, ${fill} 18%, var(--widget-background, var(--gamma-bg)))`
    : undefined
  const foreground = finite && style.display === "color-text" ? textColors.get(fill)
    : background && /^#[\da-f]{6}$/i.test(background) ? readableTextColor(background) : undefined
  return <span className={styles.visualCell} data-cell-display={style.display} data-cell-missing={!finite || undefined}
    role="img" aria-label={label} title={nativeTitle ? label : undefined}
    style={{ "--cell-color": fill, background, color: foreground } as CSSProperties}>
    {isBar && <span className={styles.cellBar} aria-hidden="true" data-segmented={style.display === "bar-segments" || undefined} style={{ "--cell-segments": style.segments ?? 24 } as CSSProperties}>
      {geometry && <>
        <span className={styles.cellBarFill} data-bar-start={geometry.start} data-bar-end={geometry.end}
          style={{ background: style.barColorMode === "value" ? fill : barGradient(style.min!, style.max!, thresholds, fill), clipPath: `inset(0 ${(1 - geometry.end) * 100}% 0 ${geometry.start * 100}%)` }} />
        {geometry.baseline > 0 && geometry.baseline < 1 && <span className={styles.cellBarZero} style={{ left: `${geometry.baseline * 100}%` }} />}
      </>}
    </span>}
    <span className={styles.cellReading} aria-hidden="true">{finite && style.unit !== undefined ? formatMetric(value, unit, false, decimals) : formatted}{geometry?.outside && <span className={styles.cellOverflow}>{(value as number) < style.min! ? " ↙" : " ↗"}</span>}</span>
  </span>
}
