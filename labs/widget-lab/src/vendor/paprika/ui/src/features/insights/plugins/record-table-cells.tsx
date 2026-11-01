import type { CSSProperties, ReactNode } from "react"
import { z } from "zod"
import { exactMetric } from "../chart-data"
import { thresholdForValue } from "../chart-renderers"
import { contrastRatio, readableTextColor } from "../appearance"
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
    if (column.type !== "number") return `Cell styling requires a numeric column; “${style.column}” is ${column.type}.`
  }
}

export function StyledRecordCell({ value, formatted, column, style, thresholds, color, textColors }: {
  value: unknown
  formatted: ReactNode
  column: RecordFrame["columns"][number]
  style: TableCellStyle
  thresholds?: readonly Threshold[]
  color?: string
  textColors: ReadonlyMap<string, string>
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
  const foreground = finite && style.display === "color-text" ? textColors.get(fill)
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
