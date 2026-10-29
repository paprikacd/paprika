import type { CSSProperties, ReactNode } from "react"
import { z } from "zod"
import { exactMetric } from "../chart-data"
import { thresholdForValue } from "../chart-renderers"
import { readableTextColor } from "../appearance"
import type { RecordFrame, Threshold } from "../schema"
import styles from "./records.module.css"

const cellStyle = z.strictObject({
  column: z.string().min(1).max(128),
  display: z.enum(["bar", "color-text", "color-background"]),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
}).superRefine((style, context) => {
  if (style.display === "bar" &&
    (style.min === undefined || style.max === undefined || style.min >= style.max))
    context.addIssue({ code: "custom", message: "Bar cells need an explicit minimum below their maximum" })
  if (style.display !== "bar" && (style.min !== undefined || style.max !== undefined))
    context.addIssue({ code: "custom", message: "Only bar cells use a numeric scale" })
})

export const tableCellStylesSchema = z.array(cellStyle).max(16).superRefine((entries, context) => {
  const columns = new Set<string>()
  entries.forEach((entry, index) => {
    if (columns.has(entry.column)) context.addIssue({ code: "custom", path: [index, "column"], message: "Style each column once" })
    columns.add(entry.column)
  })
})
export type TableCellStyle = z.infer<typeof cellStyle>

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
    if (column.type !== "number") return `Cell styling requires a numeric column; “${style.column}” is ${column.type}.`
  }
}

export function StyledRecordCell({ value, formatted, column, style, thresholds, color }: {
  value: unknown
  formatted: ReactNode
  column: RecordFrame["columns"][number]
  style: TableCellStyle
  thresholds?: readonly Threshold[]
  color?: string
}) {
  const finite = typeof value === "number" && Number.isFinite(value)
  const unit = column.unit === "percent" ? "%" : column.unit ?? ""
  const threshold = finite ? thresholdForValue(value, thresholds) : undefined
  const fill = threshold?.color ?? color ?? "var(--gamma-chart-3)"
  const geometry = finite && style.display === "bar" ? tableBarGeometry(value, style.min!, style.max!) : undefined
  const exact = finite ? exactMetric(value, unit) : "No data"
  const scale = style.display === "bar" ? ` · Scale ${exactMetric(style.min!, unit)} to ${exactMetric(style.max!, unit)}${geometry?.outside ? " · Outside scale" : ""}` : ""
  const label = `${column.label ?? column.key}: ${exact}${threshold?.label ? ` · ${threshold.label}` : ""}${scale}`
  const background = finite && style.display === "color-background"
    ? /^#[\da-f]{6}$/i.test(fill) ? fill : `color-mix(in srgb, ${fill} 18%, var(--widget-background, var(--gamma-bg)))`
    : undefined
  const foreground = finite && style.display === "color-text" ? fill
    : background && /^#[\da-f]{6}$/i.test(background) ? readableTextColor(background) : undefined
  return <span className={styles.visualCell} data-cell-display={style.display} data-cell-missing={!finite || undefined}
    role="img" aria-label={label} title={label}
    style={{ "--cell-color": fill, background, color: foreground } as CSSProperties}>
    {style.display === "bar" && <span className={styles.cellBar} aria-hidden="true">
      {geometry && <>
        <span className={styles.cellBarFill} data-bar-start={geometry.start} data-bar-end={geometry.end}
          style={{ background: barGradient(style.min!, style.max!, thresholds, fill), clipPath: `inset(0 ${(1 - geometry.end) * 100}% 0 ${geometry.start * 100}%)` }} />
        {geometry.baseline > 0 && geometry.baseline < 1 && <span className={styles.cellBarZero} style={{ left: `${geometry.baseline * 100}%` }} />}
      </>}
    </span>}
    <span className={styles.cellReading} aria-hidden="true">{formatted}{geometry?.outside && <span className={styles.cellOverflow}>{(value as number) < style.min! ? " ↙" : " ↗"}</span>}</span>
  </span>
}
