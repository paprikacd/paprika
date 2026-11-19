import { z } from "zod"
import { thresholdForValue } from "../chart-renderer-shared"
import { STATUS_RANK, type StatusLevel } from "../status"
import type { RecordFrame } from "../schema"
import { resolveColumnThresholds, type TableCellStyle } from "./record-table-cells"

/**
 * A ranked record table orders its loaded rows by a status the author declared, then by one numeric column, then by the
 * source order. A status comes only from a status-badge mapping or from a threshold that names a status, so a status word
 * never decorates a row by inference. The shared conformance cases in docs/design/insights/conformance/record-ranking.json
 * pin this module; they run in record-ranking-conformance.test.ts.
 */
export const rankSchema = z.strictObject({
  /** The column that sets each row's status: a status-badge column with a status mapping, or a numeric column with thresholds that name a status. */
  status: z.string().min(1).max(128),
  /** A numeric column that orders rows inside one status. Absent, rows keep their source order inside a status. */
  value: z.string().min(1).max(128).optional(),
  /** "descending" (the default) puts higher values first, which is "higher is worse". */
  order: z.enum(["descending", "ascending"]).default("descending"),
  /** Keep only this many rows, the top of the rank, before paging. Rows beyond it are counted, never shown. */
  limit: z.number().int().min(1).max(100).optional(),
  /** Draw a status rail on each row's first cell. On by default. */
  rail: z.boolean().default(true),
}).refine(rank => rank.value === undefined || rank.value !== rank.status, "Order a ranked table by a different column than its status")
export type TableRank = z.infer<typeof rankSchema>

/** A row's status: a declared level, a value whose mapping or threshold has no status, or no value at all. */
export type RowLevel = StatusLevel | "undeclared" | "missing"
export type RowStatus = { level: RowLevel; label?: string }

/** Every level's position in the order. Undeclared rows rank below ok, missing rows below undeclared, so both sort last. */
export const ROW_RANK: Readonly<Record<RowLevel, number>> = { ...STATUS_RANK, undeclared: -1, missing: -2 }

/** The stroke width of a row's status rail, in px: a warning is 1 px, a critical is 2 px, and other levels have none. */
export function railWidth(level: RowLevel): 0 | 1 | 2 {
  return level === "critical" ? 2 : level === "warning" ? 1 : 0
}

/** The status of one row, read from the rank's status column. `row` and `frame.columns` are the loaded frame. */
export function rowStatus(frame: RecordFrame, row: RecordFrame["rows"][number], rank: TableRank, cellStyles: readonly TableCellStyle[], widgetThresholds?: readonly { value: number; status?: StatusLevel; label?: string; color?: string }[]): RowStatus {
  const index = frame.columns.findIndex(column => column.key === rank.status)
  if (index < 0) return { level: "missing" }
  const value = row[index]
  const style = cellStyles.find(entry => entry.column === rank.status)
  if (style?.display === "status-badge") {
    if (value === null || value === undefined || value === "") return { level: "missing" }
    const label = typeof value === "string" ? value : undefined
    const mapping = label === undefined ? undefined : style.mappings?.find(entry => entry.value === label)
    return mapping?.status ? { level: mapping.status, label } : { level: "undeclared", label }
  }
  if (typeof value !== "number" || !Number.isFinite(value)) return { level: "missing" }
  const band = thresholdForValue(value, resolveColumnThresholds(style, widgetThresholds))
  return band?.status ? { level: band.status, label: band.label } : { level: "undeclared" }
}

/**
 * Why a rank cannot be drawn, or undefined when it can. The same rules reject a rank that names no status source, so a
 * saved table never silently ranks by nothing.
 */
export function rankTableError(frame: RecordFrame, rank: TableRank, cellStyles: readonly TableCellStyle[], widgetThresholds?: readonly { value: number; status?: StatusLevel }[]): string | undefined {
  const column = frame.columns.find(entry => entry.key === rank.status)
  if (!column) return `The query result has no “${rank.status}” column to rank by.`
  const style = cellStyles.find(entry => entry.column === rank.status)
  if (style?.display === "status-badge") {
    if (!style.mappings?.some(mapping => mapping.status !== undefined)) return `Rank status “${rank.status}” needs a status mapping.`
  } else if (column.type !== "number") {
    return `Rank status needs a status-badge column or a numeric column with thresholds; “${rank.status}” is ${column.type}.`
  } else if (!resolveColumnThresholds(style, widgetThresholds)?.some(threshold => threshold.status !== undefined)) {
    return `Rank status “${rank.status}” needs thresholds that name a status.`
  }
  if (rank.value !== undefined) {
    const valueColumn = frame.columns.find(entry => entry.key === rank.value)
    if (!valueColumn) return `The query result has no “${rank.value}” column to order by.`
    if (valueColumn.type !== "number") return `Rank order requires a numeric column; “${rank.value}” is ${valueColumn.type}.`
  }
}

export type RankedRows = {
  /** Positions in the `rows` argument, in rank order: every row, before the limit. */
  order: number[]
  /** The status of each row in the `rows` argument, by position. */
  statuses: RowStatus[]
  /** How many loaded rows have each level. */
  counts: Record<RowLevel, number>
  /** Positions the limit keeps, in rank order. Equal to `order` when there is no limit. */
  shown: number[]
  /** What the limit hid, including the critical and warning rows it cut. */
  hidden: { rows: number; critical: number; warning: number }
}

/**
 * Ranks rows by status (worst first), then by the rank's value column in its order, then by source position, which keeps
 * the query's own ORDER BY as the final tiebreak. Missing values sort last inside their status. The limit keeps the top N.
 * Values compare as stored numbers, never as formatted text. Pass the rows after search, so a filter ranks what it keeps.
 */
export function rankRows(frame: RecordFrame, rows: readonly RecordFrame["rows"][number][], rank: TableRank, cellStyles: readonly TableCellStyle[], widgetThresholds?: readonly { value: number; status?: StatusLevel; label?: string; color?: string }[]): RankedRows {
  const statuses = rows.map(row => rowStatus(frame, row, rank, cellStyles, widgetThresholds))
  const valueIndex = rank.value === undefined ? -1 : frame.columns.findIndex(column => column.key === rank.value)
  const valueOf = (position: number) => {
    if (valueIndex < 0) return undefined
    const value = rows[position][valueIndex]
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }
  const direction = rank.order === "ascending" ? 1 : -1
  const order = rows.map((_, position) => position).sort((left, right) => {
    const byStatus = ROW_RANK[statuses[right].level] - ROW_RANK[statuses[left].level]
    if (byStatus !== 0) return byStatus
    const leftValue = valueOf(left), rightValue = valueOf(right)
    if (leftValue !== undefined || rightValue !== undefined) {
      if (leftValue === undefined) return 1
      if (rightValue === undefined) return -1
      const byValue = (leftValue - rightValue) * direction
      if (byValue !== 0) return byValue
    }
    return left - right
  })
  const counts = Object.fromEntries(Object.keys(ROW_RANK).map(level => [level, 0])) as Record<RowLevel, number>
  for (const status of statuses) counts[status.level]++
  const limit = rank.limit ?? order.length
  const shown = order.slice(0, limit)
  const cut = order.slice(limit).map(position => statuses[position].level)
  return {
    order,
    statuses,
    counts,
    shown,
    hidden: { rows: cut.length, critical: cut.filter(level => level === "critical").length, warning: cut.filter(level => level === "warning").length },
  }
}
