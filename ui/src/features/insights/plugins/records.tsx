"use client"

import { NO_DATA } from "../benign-states";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react"
import { ChartTable } from "../chart-table"
import { GammaButton } from "../gamma/button"
import { GammaInput } from "../gamma/input"
import { ArrowRight } from "lucide-react"
import { recordTableStyleEditor } from "./sub-editors"
import { hierarchy, treemap } from "d3-hierarchy"
import { z } from "zod"
import {
  getWidgetDefinition,
  registerWidgetPlugin,
  type WidgetRendererProps,
} from "../widget-registry"
import { EmptyState, ObservationTooltip } from "../chart-renderers"
import { useObservationOwner } from "../observation-owner"
import { isRestoringTooltipFocus, restoreTooltipFocus } from "../tooltip-focus"
import { ObservationDetails } from "../observation-tooltip"
import { exactMetric } from "../chart-data"
import { formatRecordValue, isIdentifierColumn, recordNumberText, sharedScale, unitSuffix, valueCellText } from "../units"
import { TooltipDetail, TooltipFact } from "../tooltip-content"
import { useEmbeddedWidget } from "../widget-presentation"
import type { RecordFrame } from "../schema"
import { truncationNote, type TruncationSource } from "../truncation"
import styles from "./records.module.css"
import { rankRows, rankSchema, rankTableError, railWidth, type RowStatus } from "./record-ranking"
import { StatusChip } from "../status-chip"
import { StyledRecordCell, parseRecordHistory, resolveColumnThresholds, tableCellStyleError, tableCellStylesSchema, tableTextPalette, type ColumnFormat } from "./record-table-cells"
import { useInsightsTheme } from "../insights-theme"
import { useDashboardWindow } from "../dashboard-window"
import { PlotHatchDefs, plotHatchFill } from "../plot-hatch"
import hatchStyles from "../plot-hatch.module.css"

// The stored value, exactly. A whole number in a unit-less identifier or date-part column is printed as stored
// ("2026", "10022"), the way its cell reads; everything else takes the exact formatter, which never rounds to zero.
function recordedValueText(value: number, unit: string, column: string) {
  if (unit === "" && Number.isInteger(value) && Math.abs(value) < 1e21 && isIdentifierColumn(column)) return `${value}`
  return exactMetric(value, unit)
}

/** A label on a missing-colour tile sits on the hatch, so its halo is the empty fill, which keeps the text legible. */
const missingLabelHalo = { paintOrder: "stroke", stroke: "var(--gamma-chart-empty)", strokeWidth: "3px", strokeLinejoin: "round" } as const

const key = z.string().min(1).max(128)
const tableConfig = z.strictObject({
  columns: z.array(key).min(1).max(64).optional(),
  pageSize: z.number().int().min(5).max(100).optional(),
  density: z.enum(["compact", "comfortable"]).default("comfortable"),
  showSearch: z.boolean().default(true),
  showRowNumbers: z.boolean().optional(),
  cellStyles: tableCellStylesSchema.optional(),
  rank: rankSchema.optional(),
  timeSelection: z.strictObject({ start: key, duration: key, durationUnit: z.enum(["milliseconds", "seconds", "minutes"]), paddingSeconds: z.number().finite().min(0).max(86400).default(0) }).optional(),
})
const listConfig = z.strictObject({
  title: key,
  body: key.optional(),
  subtitle: key.optional(),
  url: key.optional(),
  status: key.optional(),
})
const treeConfig = z.strictObject({
  label: key,
  value: key,
  group: key.optional(),
  colorField: key.optional(),
  colorMin: z.number().finite().optional(),
  colorMax: z.number().finite().optional(),
}).superRefine((config, context) => {
  const hasMin = config.colorMin !== undefined, hasMax = config.colorMax !== undefined
  if (hasMin !== hasMax || (hasMin && !config.colorField) || (hasMin && hasMax && config.colorMin! >= config.colorMax!))
    context.addIssue({ code: "custom", message: "Set both color bounds with a color field, and make the minimum smaller than the maximum." })
})

/** Accessible ink chosen from contrast against the actual interpolated fill. */
export function treemapColor(value: number, min: number, max: number) {
  const ratio = min === max ? .5 : Math.max(0, Math.min(1, (value - min) / (max - min)))
  const low = [220, 238, 225], high = [180, 61, 50]
  const channels = low.map((channel, i) => Math.round(channel + (high[i] - channel) * ratio))
  const luminance = channels.map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2)
  const light = .2126 * luminance[0] + .7152 * luminance[1] + .0722 * luminance[2]
  // Choosing the larger of black/white contrast guarantees at least 4.58:1
  // for every possible background luminance, including the midpoint.
  const ink = (light + .05) / .05 >= 1.05 / (light + .05) ? "#000000" : "#ffffff"
  return { fill: `rgb(${channels.join(", ")})`, ink }
}
const matrixConfig = z
  .strictObject({
    x: key,
    y: key,
    value: key,
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .refine(
    (c) => c.min === undefined || c.max === undefined || c.min < c.max,
    "Minimum must be smaller than maximum",
  )

function column(frame: RecordFrame, name: string) {
  const index = frame.columns.findIndex((c) => c.key === name)
  if (index < 0) throw new Error(`The query result has no “${name}” column.`)
  return index
}
/**
 * Display text. Non-integer numbers take the widget's decimal places. Integers are identifiers as often as measurements
 * (years, order numbers), so they keep their stored digits and are never grouped. Use `keyText` for keys, search and context.
 */
function text(value: unknown, decimals?: number): string {
  if (typeof value === "number" && Number.isFinite(value) && !Number.isInteger(value)) return formatRecordValue(value, "", decimals)
  return keyText(value)
}
/** A list field: numbers take the column's unit and the widget's decimals, as a table cell does; other values keep their text. */
function listText(frame: RecordFrame, row: RecordFrame["rows"][number], index: number, decimals?: number): string {
  const value = row[index]
  if (typeof value === "number" && Number.isFinite(value)) return String(cell(frame, row, index, decimals))
  return text(value, decimals)
}
const columnFormatterCache = new WeakMap<RecordFrame, Map<string, (ColumnFormat | undefined)[]>>()
/**
 * One formatter per column that has a scalable unit. Each cell (`text`) takes the unit step its own value reads in, so
 * "1.000 KiB" and "269.486 TiB" can sit in one column. The column's scale (from its largest absolute value) is used for
 * `bound` only, so a column's scale bounds read on one unit. Columns without a unit keep their stored digits (see
 * `recordNumberText`); an identifier column has no unit, so it never reaches a scale.
 */
export function columnFormatters(frame: RecordFrame, decimals?: number): (ColumnFormat | undefined)[] {
  const key = String(decimals)
  let byDecimals = columnFormatterCache.get(frame)
  if (!byDecimals) columnFormatterCache.set(frame, (byDecimals = new Map()))
  const cached = byDecimals.get(key)
  if (cached) return cached
  const formatters = frame.columns.map((column, index) => {
    const unit = column.unit === "percent" ? "%" : (column.unit ?? "")
    if (unit === "") return undefined
    const values = frame.rows.flatMap(row => (typeof row[index] === "number" && Number.isFinite(row[index]) ? [row[index] as number] : []))
    const scale = sharedScale(values, unit, { decimals })
    return {
      // Each value takes the unit step it reads in; the column's one scale is kept for bounds, where it bounds the cells.
      text: (value: number) => valueCellText(value, unit, decimals),
      bound: (value: number) => `${scale.bound(value)}${unitSuffix(scale.unit)}`,
    }
  })
  byDecimals.set(key, formatters)
  return formatters
}
/**
 * The raw text of a cell, never reformatted. Grouping, coordinates, search and drill-down context compare on it, so two
 * values that differ in their digits stay distinct and a drill-down binding receives the stored value.
 */
function keyText(value: unknown): string {
  return value === null || value === undefined ? "—" : String(value)
}
/**
 * A number as its table cell prints it: a column with a unit gives each value its own unit step, and a unit-less column
 * keeps its identifier or count rules (`recordNumberText`).
 */
function numberCellText(frame: RecordFrame, index: number, value: number, decimals?: number): string {
  const scaled = columnFormatters(frame, decimals)[index]?.text(value)
  if (scaled !== undefined) return scaled
  return recordNumberText(
    value,
    frame.columns[index].unit === "percent" ? "%" : (frame.columns[index].unit ?? ""),
    frame.columns[index].key,
    decimals,
  )
}
function cell(
  frame: RecordFrame,
  row: RecordFrame["rows"][number],
  index: number,
  decimals?: number,
) {
  const value = row[index]
  if (value === null) return "—"
  if (typeof value === "number") return numberCellText(frame, index, value, decimals)
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (frame.columns[index].type === "timestamp")
    return new Date(value).toLocaleString()
  return value
}
function labels(frame: RecordFrame, row: RecordFrame["rows"][number]) {
  return Object.fromEntries(
    frame.columns.flatMap((col, i) =>
      row[i] === null ? [] : [[col.key, String(row[i])]],
    ),
  )
}
function Note({
  frame,
  result,
  children,
}: {
  frame: RecordFrame
  result: TruncationSource
  children?: React.ReactNode
}) {
  const note = frame.truncated ? truncationNote(result) : undefined
  return (
    <div className={styles.note} role="status">
      {children}
      {note && <span>{note}</span>}
    </div>
  )
}

function railName(level: RowStatus["level"] | undefined) {
  const width = level ? railWidth(level) : 0
  return width === 2 ? "critical" : width === 1 ? "warning" : undefined
}

/** A row's status as a glyph and a word. A missing or undeclared value says so, rather than borrowing a level. */
function RankStatus({ status }: { status: RowStatus }) {
  if (status.level === "missing") return <span className={styles.rankNone}>No status</span>
  if (status.level === "undeclared") return <span className={styles.rankNone}>Not declared</span>
  return <StatusChip status={status.level} label={status.label} />
}

/** The footer counts for a ranked table: hidden rows, hidden critical and warning rows, rows without a status, and the truncation basis. */
function RankSummary({ ranking, rank, truncated }: { ranking: { hidden: { rows: number; critical: number; warning: number }; searched: number; counts: Record<string, number> }; rank: { limit?: number }; truncated: boolean }) {
  const parts: string[] = []
  if (ranking.hidden.rows) parts.push(`Top ${rank.limit} of ${ranking.searched} loaded rows`)
  const hiddenLevels = [ranking.hidden.critical && `${ranking.hidden.critical} critical`, ranking.hidden.warning && `${ranking.hidden.warning} warning`].filter(Boolean)
  if (hiddenLevels.length) parts.push(`${hiddenLevels.join(" · ")} not shown`)
  const missing = ranking.counts.missing ?? 0
  parts.push(`${missing} ${missing === 1 ? "row has" : "rows have"} no status`)
  if (truncated) parts.push("Ranked among loaded rows only; order the query to rank the whole source.")
  // A live region, so a search that changes what the limit hides is announced as the old footer note was.
  return <span data-rank-summary="" role="status">{parts.join(" · ")}</span>
}

export function RecordTable({
  widget,
  result,
  embedded,
  onContextChange,
}: WidgetRendererProps) {
  const { apply: applyTime } = useDashboardWindow()
  const { resolvedTheme } = useInsightsTheme()
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(0)
  const rankBarRef = useRef<HTMLDivElement>(null)
  const [sort, setSort] = useState<{
    index: number
    descending: boolean
  } | null>(null)
  const frame = result.records
  const scrollRef = useRef<HTMLDivElement>(null)
  const overflowHintId = useId()
  const cellTooltipId = useId()
  const cellHelpId = useId()
  const parentEmbedded = useEmbeddedWidget()
  const inspectCells = !embedded && !parentEmbedded && widget.options?.showTooltip !== false
  const [cellFocus, setCellFocus] = useState({ row: 0, column: 0 })
  const cellPanel = useRef<HTMLDivElement | null>(null)
  const [horizontalOverflow, setHorizontalOverflow] = useState(false)
  const config = useMemo(() => tableConfig.parse(widget.config ?? {}), [widget.config])
  // Text paint covers every band set the table draws: the widget's and each column's own.
  const paletteThresholds = useMemo(() => [...(widget.options?.thresholds ?? []), ...(config.cellStyles ?? []).flatMap(style => style.thresholds ?? [])],
    [widget.options?.thresholds, config.cellStyles])
  const textColors = useMemo(() => tableTextPalette(resolvedTheme, widget.options?.background, paletteThresholds, widget.color),
    [resolvedTheme, widget.options?.background, paletteThresholds, widget.color])
  const activeSearch = !embedded && config.showSearch ? search : ""
  const cellConfigIdentity = JSON.stringify([config.columns, config.cellStyles, config.rank])
  // A new frame, search, sort, page or cell setup closes the open cell panel.
  const cellRevision = useMemo(() => ({ frame, view: [activeSearch, sort, page, cellConfigIdentity] }), [frame, activeSearch, sort, page, cellConfigIdentity])
  const cellOwner = useObservationOwner({ enabled: inspectCells, retention: { revision: cellRevision } })
  const hideCell = () => cellOwner.dismiss()
  const searchedRows = useMemo(() => {
    if (!frame) return []
    const needle = activeSearch.toLocaleLowerCase()
    return frame.rows.filter((row) => !activeSearch || row.some((v) => keyText(v).toLocaleLowerCase().includes(needle) || text(v).toLocaleLowerCase().includes(needle)))
  }, [frame, activeSearch])
  const rankError = useMemo(() => frame && config.rank ? rankTableError(frame, config.rank, config.cellStyles ?? [], widget.options?.thresholds) : undefined,
    [frame, config.rank, config.cellStyles, widget.options?.thresholds])
  // Ranks run over the loaded rows that search keeps. Each row's position is its rank among them, so a hidden row keeps its number.
  const ranking = useMemo(() => {
    if (!frame || !config.rank || rankError) return undefined
    const ranked = rankRows(frame, searchedRows, config.rank, config.cellStyles ?? [], widget.options?.thresholds)
    const positions = new Map<RecordFrame["rows"][number], { position: number; status: RowStatus }>()
    ranked.order.forEach((source, position) => positions.set(searchedRows[source], { position: position + 1, status: ranked.statuses[source] }))
    return { ...ranked, searched: searchedRows.length, positions, shownRows: ranked.shown.map(source => searchedRows[source]) }
  }, [frame, config.rank, config.cellStyles, widget.options?.thresholds, rankError, searchedRows])
  // The limit keeps the top of the rank. A header sort then reorders those rows; without one they stay in rank order.
  const rows = useMemo(() => {
    if (!frame) return []
    const selected = ranking ? [...ranking.shownRows] : [...searchedRows]
    if (sort)
      selected.sort((a, b) => {
        const left = a[sort.index],
          right = b[sort.index]
        if (left === null) return right === null ? 0 : 1
        if (right === null) return -1
        const order =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right))
        return sort.descending ? -order : order
      })
    return selected
  }, [frame, searchedRows, ranking, sort])
  useEffect(() => {
    const region = scrollRef.current
    if (!region) return
    const measure = () => setHorizontalOverflow(region.clientWidth > 0 && region.scrollWidth > region.clientWidth + 1)
    const animationFrame = requestAnimationFrame(measure)
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
    observer?.observe(region)
    const table = region.querySelector("table")
    if (table) observer?.observe(table)
    return () => { cancelAnimationFrame(animationFrame); observer?.disconnect() }
  }, [frame, activeSearch, sort, page, widget.config])
  if (!frame?.rows.length) return <EmptyState />
  const cellStyleError = tableCellStyleError(frame, config.cellStyles ?? [])
  if (cellStyleError) return <p role="alert" className={styles.note}>{cellStyleError}</p>
  if (rankError) return <p role="alert" className={styles.note}>{rankError}</p>
  const cellStyles = new Map((config.cellStyles ?? []).map(style => [style.column, style]))
  const thresholdIndexes = new Map((config.cellStyles ?? []).filter(style => style.thresholdColumn).map(style => [style.column, frame.columns.findIndex(column => column.key === style.thresholdColumn)]))
  const indexes =
    config.columns?.map((name) => column(frame, name)) ??
    frame.columns.map((_, i) => i)
  // A status column the table draws as a badge carries its own chip; any other rank gets a leading status cell.
  const leadingStatus = !!ranking && !(config.rank && indexes.some(index => frame.columns[index].key === config.rank!.status && cellStyles.get(config.rank!.status)?.display === "status-badge"))
  const columnName = (key: string) => frame.columns.find(column => column.key === key)?.label ?? key
  const numberOf = (row: RecordFrame["rows"][number], i: number) => ranking?.positions.get(row)?.position ?? current * pageSize + i + 1
  const timeConfig = config.timeSelection
  const startIndex = timeConfig ? column(frame, timeConfig.start) : -1
  const durationIndex = timeConfig ? column(frame, timeConfig.duration) : -1
  if (timeConfig && (frame.columns[startIndex].type !== "timestamp" || frame.columns[durationIndex].type !== "number"))
    return <p role="alert">Time selection requires a timestamp start column and numeric duration column.</p>
  const pageSize = embedded ? 10 : (config.pageSize ?? 20)
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / pageSize) - 1),
  )
  const displayedRows = rows.slice(current * pageSize, (current + 1) * pageSize)
  // A cell's key is its position on the page: "row,column". The owner's revision already closes the panel on a page change.
  const openCell = cellOwner.active && cellOwner.active.anchor.isConnected ? cellOwner.active : undefined
  const openPosition = openCell ? openCell.key.split(",").map(Number) : undefined
  const activeCell = openCell && openPosition ? { anchor: openCell.anchor as HTMLTableCellElement, pinned: openCell.pinned, row: openPosition[0], column: openPosition[1], value: displayedRows[openPosition[0]]?.[indexes[openPosition[1]]] } : undefined
  const focusRow = Math.min(cellFocus.row, Math.max(0, displayedRows.length - 1))
  const focusColumn = Math.min(cellFocus.column, Math.max(0, indexes.length - 1))
  const activeColumn = activeCell ? frame.columns[indexes[activeCell.column]] : undefined
  const activeStyle = activeColumn ? cellStyles.get(activeColumn.key) : undefined
  const cellMeaning = activeCell?.anchor.querySelector("[data-cell-display][aria-label]")?.getAttribute("aria-label") ?? activeCell?.anchor.querySelector("[data-history-color-meaning]")?.textContent
  const history = activeStyle?.display === "sparkline" ? parseRecordHistory(activeCell?.value) : undefined
  const activeUnit = activeStyle?.unit ?? (activeColumn?.unit === "percent" ? "%" : activeColumn?.unit ?? "")
  const activeValue = history?.state === "valid" ? history.points[history.points.length - 1].value : activeCell?.value
  // The panel heading reads as the cell does: a styled unit (or a sparkline's history) reads on that unit, otherwise the column.
  const cellNumber = (value: number) => activeColumn && activeStyle && (history || activeStyle.unit !== undefined)
    ? activeUnit ? valueCellText(value, activeUnit, widget.options?.decimals) : recordNumberText(value, activeUnit, activeColumn.key, widget.options?.decimals)
    : numberCellText(frame, activeCell ? indexes[activeCell.column] : 0, value, widget.options?.decimals)
  const formattedValue = history && history.state !== "valid" ? history.state === "invalid" ? "Invalid history" : "No history" : activeValue == null ? NO_DATA : typeof activeValue === "number" ? cellNumber(activeValue) : typeof activeValue === "boolean" ? activeValue ? "Yes" : "No" : activeColumn?.type === "timestamp" ? new Date(String(activeValue)).toLocaleString() : String(activeValue)
  return (
    <div className={`${styles.wrapper}${config.density === "compact" ? ` ${styles.compactTable}` : ""}`} data-record-table="" data-table-density={config.density} data-cell-inspection={inspectCells || undefined}>
      {inspectCells && <p id={cellHelpId} className={styles.cellHistoryMeaning}>Use arrow keys to move between cells; Enter opens the details of a cell.</p>}
      {!embedded && config.showSearch && (
        <div className={styles.toolbar}>
          <GammaInput size="sm"
            aria-label={`Filter ${widget.title}`}
            placeholder="Filter records…"
            value={search}
            onChange={(event) => {
              hideCell()
              setSearch(event.target.value)
              setPage(0)
            }}
          />
          <span>{ranking ? ranking.searched : rows.length} loaded rows</span>
        </div>
      )}
      {ranking && config.rank && <div className={styles.rankBar} data-rank-caption="" ref={rankBarRef} tabIndex={-1}>
        <span>{sort ? `Sorted by ${columnName(frame.columns[sort.index].key)}. Ranked order is hidden.` : `Ranked by ${columnName(config.rank.status)}${config.rank.value ? `, then ${columnName(config.rank.value)}, ${config.rank.order === "ascending" ? "lowest" : "highest"} first` : ", then source order"}.`}</span>
        {sort && <GammaButton size="sm" variant="quiet" type="button" onClick={() => { hideCell(); rankBarRef.current?.focus(); setSort(null) }}>Ranked order</GammaButton>}
        <RankSummary ranking={ranking} rank={config.rank} truncated={!!frame.truncated} />
      </div>}
      <div
        className={styles.scroll}
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label={`${widget.title} records`}
        aria-describedby={horizontalOverflow ? overflowHintId : undefined}
      >
        <ChartTable density={config.density} aria-label={widget.title}>
          <thead>
            <tr>
              {config.showRowNumbers && (ranking
                ? <th scope="col" className={styles.rowNumber} title={`Rank among ${ranking.searched} loaded rows`} aria-label="Rank">Rank</th>
                : <th scope="col" className={styles.rowNumber} title="Position in the displayed records" aria-label="Row number">#</th>)}
              {leadingStatus && <th scope="col" data-rank-status-column="">Status</th>}
              {indexes.map((index) => (
                <th
                  key={frame.columns[index].key}
                  data-numeric={frame.columns[index].type === "number" || undefined}
                  aria-sort={
                    sort?.index === index
                      ? sort.descending
                        ? "descending"
                        : "ascending"
                      : "none"
                  }
                >
                  {embedded || cellStyles.get(frame.columns[index].key)?.display === "sparkline" ? (
                    (frame.columns[index].label ?? frame.columns[index].key)
                  ) : (
                    <GammaButton size="sm" variant="quiet"
                      type="button"
                      onClick={() => {
                        hideCell()
                        setSort({
                          index,
                          descending: sort?.index === index && !sort.descending,
                        })
                      }}
                    >
                      {frame.columns[index].label ?? frame.columns[index].key}
                      {sort?.index === index
                        ? sort.descending
                          ? " ↓"
                          : " ↑"
                        : ""}
                    </GammaButton>
                  )}
                </th>
              ))}
              {onContextChange && !embedded && <th>Explore</th>}
              {timeConfig && applyTime && !embedded && <th>Time</th>}
            </tr>
          </thead>
          <tbody>
            {displayedRows
              .map((row, i) => (
                <tr key={i} data-rank-status={ranking?.positions.get(row)?.status.level} data-status-rail={ranking && config.rank?.rail !== false ? railName(ranking.positions.get(row)?.status.level) : undefined}>
                  {config.showRowNumbers && <td className={styles.rowNumber}>{numberOf(row, i)}</td>}
                  {leadingStatus && <td data-rank-status-cell=""><RankStatus status={ranking?.positions.get(row)?.status ?? { level: "missing" }} /></td>}
                  {indexes.map((index, visibleColumn) => {
                    const field = frame.columns[index]
                    const style = cellStyles.get(field.key)
                    const formatted = cell(frame, row, index, widget.options?.decimals)
                    const cellKey = `${i},${visibleColumn}`, cellTrigger = cellOwner.trigger(cellKey), openHere = activeCell?.row === i && activeCell.column === visibleColumn
                    return <td key={index} data-record-cell-row={i} data-record-cell-column={visibleColumn} tabIndex={inspectCells ? i === focusRow && visibleColumn === focusColumn ? 0 : -1 : undefined} aria-describedby={inspectCells ? `${cellHelpId}${openHere ? ` ${cellTooltipId}` : ""}` : undefined} data-numeric={field.type === "number" || undefined} data-styled-cell={style?.display}
                      onPointerEnter={cellTrigger.onPointerEnter}
                      onPointerLeave={cellTrigger.onPointerLeave}
                      onFocus={event => {
                        setCellFocus({ row: i, column: visibleColumn })
                        // Focus returned after a dismissal holds the cell without reopening its panel.
                        if (isRestoringTooltipFocus()) cellOwner.holdFocus(event.currentTarget)
                        else if (activeCell?.pinned) cellOwner.pin(cellKey, event.currentTarget)
                        else cellTrigger.onFocus(event)
                      }}
                      onBlur={cellTrigger.onBlur}
                      onClick={event => { if (!inspectCells) return; event.currentTarget.focus({ preventScroll: true }); if (openHere && activeCell?.pinned) hideCell(); else cellOwner.pin(cellKey, event.currentTarget) }}
                      onKeyDown={event => {
                        if (!inspectCells) return
                        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (openHere && activeCell?.pinned) hideCell(); else cellOwner.pin(cellKey, event.currentTarget); return }
                        if (event.key === "Tab" && !event.shiftKey && activeCell?.pinned && cellPanel.current) { event.preventDefault(); cellPanel.current.focus({ preventScroll: true }); return }
                        const delta = event.key === "ArrowLeft" ? [0, -1] : event.key === "ArrowRight" ? [0, 1] : event.key === "ArrowUp" ? [-1, 0] : event.key === "ArrowDown" ? [1, 0] : undefined
                        if (!delta) return
                        event.preventDefault()
                        const nextRow = Math.max(0, Math.min(displayedRows.length - 1, i + delta[0])), nextColumn = Math.max(0, Math.min(indexes.length - 1, visibleColumn + delta[1]))
                        const next = scrollRef.current?.querySelector<HTMLTableCellElement>(`td[data-record-cell-row="${nextRow}"][data-record-cell-column="${nextColumn}"]`)
                        next?.focus({ preventScroll: true }); next?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
                      }}>
                      {style ? <StyledRecordCell value={row[index]} formatted={formatted} format={columnFormatters(frame, widget.options?.decimals)[index]} column={field} style={style}
                        thresholds={resolveColumnThresholds(style, widget.options?.thresholds)} color={widget.color} textColors={textColors} decimals={widget.options?.decimals} thresholdValue={thresholdIndexes.has(field.key) ? row[thresholdIndexes.get(field.key)!] : undefined} nativeTitle={false} /> : formatted}
                    </td>
                  })}
                  {onContextChange && !embedded && (
                    <td>
                      <GammaButton size="sm" variant="quiet"
                        type="button"
                        onClick={() =>
                          onContextChange({ labels: labels(frame, row) })
                        }
                        aria-label={`Select row ${numberOf(row, i)}`}
                      >
                        Select
                      </GammaButton>
                    </td>
                  )}
                  {timeConfig && applyTime && !embedded && (() => {
                    const start = typeof row[startIndex] === "string" ? Date.parse(row[startIndex] as string) : NaN
                    const duration = row[durationIndex]
                    const multiplier = timeConfig.durationUnit === "minutes" ? 60_000 : timeConfig.durationUnit === "seconds" ? 1000 : 1
                    const padding = timeConfig.paddingSeconds * 1000
                    const from = start - padding, to = start + (typeof duration === "number" ? duration * multiplier : NaN) + padding
                    const valid = Number.isFinite(from) && from > 0 && typeof duration === "number" && Number.isFinite(duration) && duration > 0 && Number.isFinite(to) && to > from && to - from <= 31 * 86400_000
                    return <td><GammaButton size="sm" variant="quiet" type="button" aria-label={`Focus time for row ${numberOf(row, i)}`} disabled={!valid} title={valid ? "Focus dashboard on this recorded interval" : "This row needs a valid start and duration within 31 days"} onClick={() => applyTime({ start: from, end: to })}>Focus time</GammaButton></td>
                  })()}
                </tr>
              ))}
          </tbody>
        </ChartTable>
        {!rows.length && (
          <p className={styles.note}>No records match this filter.</p>
        )}
      </div>
      {horizontalOverflow && <div id={overflowHintId} className={styles.scrollHint}><ArrowRight size={12} aria-hidden="true" /> Scroll horizontally to see more columns</div>}
      {activeCell && activeColumn && <ObservationTooltip id={cellTooltipId} anchor={activeCell.anchor} className={styles.recordTooltip} avoidWidget pinned={activeCell.pinned} pinHint={false} role={activeCell.pinned ? "region" : "tooltip"} ariaLabel={activeCell.pinned ? "Record cell details" : undefined} tabIndex={activeCell.pinned ? 0 : undefined} panelRef={element => { cellPanel.current = element }} onDismiss={() => { if (cellPanel.current?.contains(document.activeElement)) restoreTooltipFocus(activeCell.anchor); hideCell() }} onEnter={() => cellOwner.panelEnter()} onLeave={() => cellOwner.panelLeave()}>
        <TooltipDetail title={activeColumn.label ?? activeColumn.key}>
          <span className={styles.recordCellValue}>{formattedValue}</span>
          {typeof activeValue === "number" && Number.isFinite(activeValue) && <TooltipFact label="Recorded value">{recordedValueText(activeValue, activeUnit, activeColumn.key)}</TooltipFact>}
          {history?.state === "valid" && <small>{history.points.length} recorded {history.points.length === 1 ? "sample" : "samples"} · latest {new Date(history.points[history.points.length - 1].timestamp).toLocaleString()}</small>}
          {history?.state === "invalid" && <small>History must be an ordered JSON array of timestamped numeric or null observations.</small>}
          {cellMeaning && <small>{cellMeaning}</small>}
          {activeCell.pinned && <GammaButton size="sm" variant="quiet" type="button" onClick={() => { restoreTooltipFocus(activeCell.anchor); hideCell() }}>Close</GammaButton>}
        </TooltipDetail>
      </ObservationTooltip>}
      {(frame.truncated || !embedded && rows.length > pageSize) && <Note frame={frame} result={result}>
        {!embedded && rows.length > pageSize && (
          <>
            <GammaButton size="sm" variant="quiet"
              type="button"
              disabled={current === 0}
              onClick={() => { hideCell(); setPage(current - 1) }}
            >
              Previous
            </GammaButton>
            <span>
              Page {current + 1} of {Math.ceil(rows.length / pageSize)}
            </span>
            <GammaButton size="sm" variant="quiet"
              type="button"
              disabled={(current + 1) * pageSize >= rows.length}
              onClick={() => { hideCell(); setPage(current + 1) }}
            >
              Next
            </GammaButton>
          </>
        )}
      </Note>}
    </div>
  )
}

function safeURL(value: unknown) {
  if (typeof value !== "string") return undefined
  try {
    const url = new URL(value)
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined
  } catch {
    return undefined
  }
}
export function RecordList({
  widget,
  result,
  embedded,
  onContextChange,
}: WidgetRendererProps) {
  const frame = result.records
  if (!frame?.rows.length) return <EmptyState />
  const config = listConfig.parse(widget.config ?? {})
  const indexes = Object.fromEntries(
    Object.entries(config).map(([name, field]) => [name, column(frame, field)]),
  )
  const limit = embedded ? 10 : 100
  return (
    <div className={styles.wrapper}>
      <div
        className={styles.scroll}
        tabIndex={0}
        role="region"
        aria-label={`${widget.title} records`}
      >
        <ul className={styles.list}>
          {frame.rows.slice(0, limit).map((row, i) => {
            const url = config.url ? safeURL(row[indexes.url]) : undefined
            return (
              <li key={i}>
                <strong>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {listText(frame, row, indexes.title, widget.options?.decimals)}
                    </a>
                  ) : (
                    listText(frame, row, indexes.title, widget.options?.decimals)
                  )}
                </strong>
                {config.status && (
                  <span className={styles.badge}>
                    {listText(frame, row, indexes.status, widget.options?.decimals)}
                  </span>
                )}
                {config.subtitle && (
                  <small>{listText(frame, row, indexes.subtitle, widget.options?.decimals)}</small>
                )}
                {config.body && <p>{listText(frame, row, indexes.body, widget.options?.decimals)}</p>}
                {onContextChange && !embedded && (
                  <button
                    type="button"
                    onClick={() =>
                      onContextChange({ labels: labels(frame, row) })
                    }
                  >
                    Select record
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </div>
      <Note frame={frame} result={result}>
        {frame.rows.length > limit && (
          <span>
            Showing {limit} of {frame.rows.length} loaded records
          </span>
        )}
      </Note>
    </div>
  )
}

export function RecordTreemap({
  widget,
  result,
  onContextChange,
  embedded,
}: WidgetRendererProps) {
  const missingPattern = useId()
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 600, height: 300 })
  const parentEmbedded = useEmbeddedWidget()
  const interactive = !embedded && !parentEmbedded
  const detailsEnabled = interactive && widget.options?.showTooltip !== false
  const revision = JSON.stringify([widget.config, widget.unit, widget.options?.decimals])
  const frame = result.records
  // Tiles are kept by their layout position; a new frame or a changed config closes the open panel.
  const tileRevision = useMemo(() => ({ frame, revision }), [frame, revision])
  const owner = useObservationOwner({ enabled: detailsEnabled, retention: { revision: tileRevision } })
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const measure = () => {
      const bounds = svg.getBoundingClientRect()
      const width = Math.round(bounds.width), height = Math.round(bounds.height)
      if (width > 0 && height > 0) setSize(previous => previous.width === width && previous.height === height ? previous : { width, height })
    }
    measure()
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure)
    observer?.observe(svg)
    return () => observer?.disconnect()
  }, [frame, widget.config])
  if (!frame?.rows.length) return <EmptyState />
  const config = treeConfig.parse(widget.config ?? {})
  const label = column(frame, config.label),
    value = column(frame, config.value),
    group = config.group ? column(frame, config.group) : -1,
    color = config.colorField ? column(frame, config.colorField) : -1
  if (color >= 0 && frame.columns[color].type !== "number")
    return <p role="alert" className={styles.note}>Color field must be numeric.</p>
  const positive = frame.rows.filter(
    (row) =>
      typeof row[value] === "number" &&
      Number.isFinite(row[value]) &&
      (row[value] as number) > 0,
  )
  if (!positive.length)
    return (
      <div className={styles.note}>No positive values to size the treemap.</div>
    )
  const colorValues = color < 0 ? [] : positive.flatMap(row => typeof row[color] === "number" && Number.isFinite(row[color]) ? [row[color] as number] : [])
  const colorMin = config.colorMin ?? (colorValues.length ? Math.min(...colorValues) : 0)
  const colorMax = config.colorMax ?? (colorValues.length ? Math.max(...colorValues) : 0)
  const colorMissing = color >= 0 && colorValues.length < positive.length
  type Node = { name?: string; row?: RecordFrame["rows"][number]; children?: Node[] }
  const groups = new Map<string, Node[]>()
  for (const row of positive) {
    const name = group >= 0 ? keyText(row[group]) : "all"
    const entries = groups.get(name) ?? []
    entries.push({ row })
    groups.set(name, entries)
  }
  const root = hierarchy<Node>({
    children: [...groups.entries()].map(([name, children]) => ({ name, children })),
  })
    .sum((node) => (node.row ? (node.row[value] as number) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const tree = treemap<Node>()
    .size([size.width, size.height])
    .paddingInner(3)
    .paddingOuter(2)
    .paddingTop(node => group >= 0 && node.depth === 1 ? 20 : 2)(root)
  const leaves = tree.leaves()
  // One description per tile, shared by its label and the panel, so the panel reads exactly as the tile does.
  const describeTile = (leaf: (typeof leaves)[number]) => {
    const row = leaf.data.row!
    const name = keyText(row[label])
    const formatted = (typeof row[value] === "number" ? columnFormatters(frame, widget.options?.decimals)[value]?.text(row[value] as number) : undefined) ?? formatRecordValue(row[value] as number, frame.columns[value].unit === "percent" ? "%" : frame.columns[value].unit || widget.unit, widget.options?.decimals)
    const colorValue = color >= 0 && typeof row[color] === "number" && Number.isFinite(row[color]) ? row[color] as number : null
    const colorLabel = color >= 0 ? frame.columns[color].label ?? frame.columns[color].key : undefined
    const colorDetail = color >= 0 ? `${colorLabel}: ${colorValue === null ? NO_DATA : cell(frame, row, color, widget.options?.decimals)}` : undefined
    return { row, name, formatted, colorValue, colorLabel, colorDetail }
  }
  const openLeaf = owner.active ? leaves[Number(owner.active.key)] : undefined
  const openTile = openLeaf ? describeTile(openLeaf) : undefined
  return (
    <div className={styles.wrapper}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size.width} ${size.height}`}
        className={styles.treemap}
        role="group"
        aria-label={widget.title}
      >
        {colorMissing && <PlotHatchDefs id={missingPattern} />}
        {group >= 0 && tree.children?.map(node => node.x1 - node.x0 >= 60 && <text key={node.data.name} x={node.x0 + 4} y={node.y0 + 14} fill="currentColor" fontSize="11">{node.data.name}</text>)}
        {leaves.map((leaf, index) => {
          const { row, name, formatted, colorValue, colorDetail } = describeTile(leaf)
          const colorStyle = colorValue === null ? undefined : treemapColor(colorValue, colorMin, colorMax)
          const tileWidth = leaf.x1 - leaf.x0, tileHeight = leaf.y1 - leaf.y0
          const maxNameLength = Math.floor((tileWidth - 16) / 7)
          const visibleName = name.length > maxNameLength && maxNameLength > 1 ? `${name.slice(0, maxNameLength - 1)}…` : name
          const visibleValue = formatted.length > maxNameLength && maxNameLength > 1 ? `${formatted.slice(0, maxNameLength - 1)}…` : formatted
          const selected = () =>
            onContextChange?.({
              labels: labels(frame, row),
              value: row[value] as number,
              series: name,
            })
          const tileKey = String(index), tile = owner.trigger(tileKey), openHere = owner.active?.key === tileKey
          const actionable = interactive && (detailsEnabled || !!onContextChange)
          return (
            <g
              key={index}
              role={actionable ? "button" : "img"}
              tabIndex={actionable ? 0 : undefined}
              aria-label={`${name}: ${formatted}${colorDetail ? ` · ${colorDetail}` : ""}`}
              aria-describedby={openHere ? `${missingPattern}-details` : undefined}
              aria-pressed={detailsEnabled ? (openHere && !!owner.active?.pinned) : undefined}
              onPointerEnter={tile.onPointerEnter}
              onPointerLeave={tile.onPointerLeave}
              onFocus={tile.onFocus}
              onBlur={tile.onBlur}
              onClick={event => { if (!interactive) return; selected(); if (openHere && owner.active?.pinned) owner.dismiss(); else owner.pin(tileKey, event.currentTarget) }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  if (!interactive) return
                  selected()
                  if (openHere && owner.active?.pinned) owner.dismiss(); else owner.pin(tileKey, event.currentTarget)
                }
              }}
            >
              <rect
                x={leaf.x0}
                y={leaf.y0}
                width={leaf.x1 - leaf.x0}
                height={leaf.y1 - leaf.y0}
                rx={3}
                fill={color < 0 ? `var(--record-color-${index % 6})` : colorStyle?.fill ?? plotHatchFill(missingPattern)}
                data-treemap-color-value={colorValue ?? undefined}
              />
              {tileWidth > 52 && tileHeight > 26 && (
                <>
                  <clipPath id={`${missingPattern}-tile-${index}`}><rect x={leaf.x0 + 4} y={leaf.y0 + 2} width={Math.max(0, tileWidth - 8)} height={Math.max(0, tileHeight - 4)} /></clipPath>
                  <text
                    x={leaf.x0 + 8}
                    y={leaf.y0 + 18}
                    className={styles.tileText}
                    clipPath={`url(#${missingPattern}-tile-${index})`}
                    style={color >= 0 ? { fill: colorStyle?.ink ?? "var(--gamma-ink)", ...(colorStyle ? undefined : missingLabelHalo) } : undefined}
                  >
                    {visibleName}
                    {tileHeight > 43 && <tspan x={leaf.x0 + 8} dy={17}>
                      {visibleValue}
                    </tspan>}
                  </text>
                </>
              )}
            </g>
          )
        })}
      </svg>
      {owner.active && openLeaf && openTile && <ObservationTooltip id={`${missingPattern}-details`} anchor={owner.active.anchor} avoidWidget pinned={owner.active.pinned} onDismiss={() => owner.dismiss()}
        onEnter={() => owner.panelEnter()} onLeave={() => owner.panelLeave()}>
        <TooltipDetail title={openTile.name}>
          <TooltipFact label={frame.columns[value].label ?? frame.columns[value].key}><span data-treemap-observation={openTile.row[value] as number}>{openTile.formatted}</span></TooltipFact>
          {group >= 0 && <TooltipFact label={frame.columns[group].label ?? frame.columns[group].key}>{keyText(openTile.row[group])}</TooltipFact>}
          {color >= 0 && openTile.colorLabel && <TooltipFact label={openTile.colorLabel}><span data-treemap-color-observation={openTile.colorValue === null ? "missing" : openTile.colorValue}>{openTile.colorValue === null ? NO_DATA : cell(frame, openTile.row, color, widget.options?.decimals)}</span></TooltipFact>}
        </TooltipDetail>
      </ObservationTooltip>}
      {color >= 0 && <div className={styles.treeColorLegend} role="group" aria-label="Treemap color scale">
        <span>{frame.columns[color].label ?? frame.columns[color].key}</span>
        {colorValues.length > 0 ? <><span>{formatRecordValue(colorMin, frame.columns[color].unit === "percent" ? "%" : (frame.columns[color].unit ?? ""), widget.options?.decimals)}</span><span className={styles.treeColorGradient} aria-hidden="true" /><span>{formatRecordValue(colorMax, frame.columns[color].unit === "percent" ? "%" : (frame.columns[color].unit ?? ""), widget.options?.decimals)}</span></> : <span>No numeric color values</span>}
        {colorMissing && <span className={styles.treeMissingKey}><i className={`${hatchStyles.hatch} ${hatchStyles.swatch}`} aria-hidden="true" />{NO_DATA}</span>}
      </div>}
      <Note frame={frame} result={result}>
        {positive.length < frame.rows.length && (
          <span>
            {frame.rows.length - positive.length} zero, missing or negative
            values have no tile area
          </span>
        )}
      </Note>
    </div>
  )
}

export function RecordMatrix({
  widget,
  result,
  onContextChange,
}: WidgetRendererProps) {
  // The one cell in the tab order (roving focus); arrow keys move it through the grid.
  const [tabKey, setTabKey] = useState<string>()
  const frame = result.records
  if (!frame?.rows.length) return <EmptyState />
  const config = matrixConfig.parse(widget.config ?? {})
  const x = column(frame, config.x),
    y = column(frame, config.y),
    value = column(frame, config.value)
  // Keys are the stored text: a coordinate names its cell, so rounding it would merge neighbouring columns. A label reads
  // the shortest form of the same number, so float noise (0.1 + 0.2) never shows on an axis; integers stay as stored.
  const axisValues = (index: number) => {
    const seen = new Map<string, string>()
    for (const row of frame.rows) {
      const raw = row[index]
      seen.set(keyText(raw), typeof raw === "number" && Number.isFinite(raw) && !Number.isInteger(raw) ? String(Number(raw.toPrecision(12))) : keyText(raw))
    }
    return [...seen].slice(0, 25).map(([key, label]) => ({ key, label }))
  }
  const xs = axisValues(x),
    ys = axisValues(y)
  const values = frame.rows.flatMap((row) =>
    typeof row[value] === "number" ? [row[value] as number] : [],
  )
  const min = config.min ?? Math.min(0, ...values),
    max = config.max ?? Math.max(1, ...values)
  // The legend reads on the value column's scale, as the cells do, so "269.486 TiB" is not printed as 15 raw digits.
  const valueFormat = columnFormatters(frame, widget.options?.decimals)[value]
  const scaleText = (bound: number) => valueFormat?.bound(bound) ?? formatRecordValue(bound, frame.columns[value].unit === "percent" ? "%" : (frame.columns[value].unit ?? ""), widget.options?.decimals)
  if (min >= max)
    return (
      <p role="alert">
        Matrix minimum must be below its maximum. Set both scale bounds when a
        fixed bound is outside the returned values.
      </p>
    )
  const cells = new Map<string, RecordFrame["rows"][number]>()
  for (const row of frame.rows) {
    const id = JSON.stringify([keyText(row[x]), keyText(row[y])])
    if (cells.has(id))
      return (
        <p role="alert">
          Duplicate matrix coordinates. Aggregate the source query before
          rendering.
        </p>
      )
    cells.set(id, row)
  }
  const cellAt = (yIndex: number, xIndex: number) =>
    cells.get(JSON.stringify([xs[xIndex]?.key, ys[yIndex]?.key]))
  // The first populated cell is the tab stop until the user moves it with the arrow keys.
  const populated = ys.flatMap((_, yIndex) => xs.flatMap((_, xIndex) => (cellAt(yIndex, xIndex) ? [`${yIndex}-${xIndex}`] : [])))
  const stopKey = tabKey && populated.includes(tabKey) ? tabKey : populated[0]
  // Arrow keys step one populated cell in their direction, skipping empty coordinates, and never leave the grid.
  const moveFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] }[event.key]
    const origin = event.target instanceof HTMLElement ? event.target.closest<HTMLTableCellElement>("td[data-matrix-key]") : null
    if (!step || !origin) return
    event.preventDefault()
    const [startY, startX] = origin.dataset.matrixKey!.split("-").map(Number)
    let yIndex = startY + step[0], xIndex = startX + step[1]
    while (yIndex >= 0 && yIndex < ys.length && xIndex >= 0 && xIndex < xs.length && !cellAt(yIndex, xIndex)) {
      yIndex += step[0]
      xIndex += step[1]
    }
    if (yIndex < 0 || yIndex >= ys.length || xIndex < 0 || xIndex >= xs.length || !cellAt(yIndex, xIndex)) return
    const next = `${yIndex}-${xIndex}`
    setTabKey(next)
    event.currentTarget.querySelector<HTMLElement>(`td[data-matrix-key="${next}"] button`)?.focus()
  }
  return (
    <div className={styles.wrapper}>
      <div
        className={styles.scroll}
        tabIndex={0}
        role="region"
        aria-label={`${widget.title} matrix`}
        onKeyDown={moveFocus}
      >
        <ChartTable className={styles.matrix}>
          <thead>
            <tr>
              <th />
              {xs.map((name) => (
                <th key={name.key}>{name.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ys.map((name, yIndex) => (
              <tr key={name.key}>
                <th>{name.label}</th>
                {xs.map((xName, xIndex) => {
                  const row = cellAt(yIndex, xIndex),
                    number = row?.[value],
                    cellKey = `${yIndex}-${xIndex}`
                  const progress =
                    typeof number === "number"
                      ? Math.max(0, Math.min(1, (number - min) / (max - min)))
                      : undefined
                  const formatted = row
                    ? cell(frame, row, value, widget.options?.decimals)
                    : "—"
                  return (
                    <td
                      key={xName.key}
                      data-matrix-key={cellKey}
                      // Focus, from a click or the keyboard, moves the tab stop, so Tab returns to the cell last used.
                      onFocus={row ? () => setTabKey(cellKey) : undefined}
                      style={
                        progress === undefined
                          ? undefined
                          : {
                              background: `color-mix(in srgb, var(--gamma-accent, #53876a) ${Math.round(8 + progress * 45)}%, var(--gamma-bg, white))`,
                            }
                      }
                    >
                      {row ? (
                        <ObservationDetails
                          label={`${name.label}, ${xName.label}: ${formatted}`}
                          observationKey={JSON.stringify([xName.key, name.key])}
                          enabled={widget.options?.showTooltip !== false}
                          avoidWidget
                          selectOnFocus={false}
                          tabIndex={cellKey === stopKey ? 0 : -1}
                          onSelect={
                            onContextChange
                              ? () =>
                                  onContextChange({
                                    labels: labels(frame, row),
                                    value: typeof number === "number" ? number : null,
                                  })
                              : undefined
                          }
                          details={
                            <TooltipDetail title={`${name.label} · ${xName.label}`}>
                              <TooltipFact label={frame.columns.find(column => column.key === config.x)?.label ?? config.x}>{xName.label}</TooltipFact>
                              <TooltipFact label={frame.columns.find(column => column.key === config.y)?.label ?? config.y}>{name.label}</TooltipFact>
                              <TooltipFact label={frame.columns.find(column => column.key === config.value)?.label ?? config.value}>{formatted}</TooltipFact>
                            </TooltipDetail>
                          }
                        >
                          {formatted}
                        </ObservationDetails>
                      ) : (
                        formatted
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </ChartTable>
      </div>
      <Note frame={frame} result={result}>
        <span>
          Scale {scaleText(min)}–{scaleText(max)} · missing cells —
        </span>
        {(new Set(frame.rows.map((row) => keyText(row[x]))).size > 25 ||
          new Set(frame.rows.map((row) => keyText(row[y]))).size > 25) && (
          <span>Showing first 25 rows and columns</span>
        )}
      </Note>
    </div>
  )
}

export function registerRecordWidgetPlugins() {
  const entries = [
    {
      id: "record-table",
      label: "Records table",
      description: "Sort, filter and inspect application or SQL records",
      render: RecordTable,
      schema: tableConfig,
    },
    {
      id: "record-list",
      label: "Record cards",
      description: "News, recommendations and narrative records",
      render: RecordList,
      schema: listConfig,
      styleControls: ["decimals"] as const,
    },
    {
      id: "record-treemap",
      label: "Treemap",
      description: "Compare positive sizes across entities and groups",
      render: RecordTreemap,
      schema: treeConfig,
    },
    {
      id: "record-matrix",
      label: "Matrix",
      description: "Compare paired entities without filling missing values",
      render: RecordMatrix,
      schema: matrixConfig,
      styleControls: ["decimals"] as const,
    },
  ] as const
  for (const entry of entries)
    if (!getWidgetDefinition("plugin", entry.id))
      registerWidgetPlugin({
        id: entry.id,
        label: entry.label,
        description: entry.description,
        render: entry.render,
        dataKind: "records",
        parseConfig: (config) => entry.schema.parse(config ?? {}),
        ...("styleControls" in entry ? { styleControls: entry.styleControls } : {}),
        ...(entry.id === "record-table" ? {
          sizing: {
            mode: "fill",
            minHeight: 240,
            // Tables longer than seven rows keep the tall table room; shorter ones read in the ordinary room.
            denseRoom: config => typeof config?.pageSize === "number" && config.pageSize > 7 ? "tall-table" : "reading",
            // A sparkline cell needs a taller row than text, and narrow tables reserve room for a scroll hint.
            narrowMinRows: config => Array.isArray(config?.cellStyles) && config.cellStyles.some(style =>
              typeof style === "object" && style !== null && "display" in style && style.display === "sparkline") ? 5 : undefined,
          },
          capabilities: {
            thresholds: true,
            compactDescription: (config) => {
              const cells = config?.cellStyles;
              return Array.isArray(cells) && ["sparkline", "bar-segments", "status-badge"].every((display) =>
                cells.some((style) => typeof style === "object" && style !== null && "display" in style && style.display === display));
            },
          },
          configEditors: [recordTableStyleEditor],
          // The config alone cannot show the widget's own thresholds, so a numeric status is assumed to have some here.
          // The render checks the real set and reports the same reason when it is missing.
          validateInput: (result, config) => {
            const parsed = tableConfig.safeParse(config ?? {})
            if (!parsed.success || !parsed.data.rank || !result.records) return []
            const reason = rankTableError(result.records, parsed.data.rank, parsed.data.cellStyles ?? [], [{ value: 0, status: "ok" }])
            return reason ? [{ field: "rank", message: reason }] : []
          },
          defaultConfig: { density: "comfortable", showSearch: true },
          styleControls: ["decimals", "color", "tooltips"] as const,
          configFields: [
            { key: "density", label: "Row density", kind: "select" as const, options: [{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }] },
            { key: "showSearch", label: "Show search", kind: "boolean" as const, help: "Show a filter for the loaded records. Hiding it restores every loaded row." },
            { key: "showRowNumbers", label: "Show row numbers", kind: "boolean" as const, help: "Number loaded rows in their current filtered and sorted order; numbers are not source-wide ranks." },
            { key: "pageSize", label: "Rows per page", kind: "number" as const, min: 5, max: 100, placeholder: "Default: 20" },
          ],
        } : entry.id === "record-treemap" ? {
          styleControls: ["unit", "decimals", "tooltips"] as const,
          configFields: [
            { key: "label", label: "Label field", kind: "text" as const, recordColumn: "any" as const, help: "A result column used to name each tile." },
            { key: "value", label: "Area field", kind: "text" as const, recordColumn: "number" as const, help: "A numeric result column; positive values determine tile area." },
            { key: "group", label: "Group field", kind: "text" as const, recordColumn: "any" as const, help: "Optional result column used to group tiles." },
            { key: "colorField", label: "Color field", kind: "text" as const, recordColumn: "number" as const, help: "Optional numeric column. Missing readings are hatched rather than assigned a value." },
            { key: "colorMin", label: "Color minimum", kind: "number" as const, step: 0.01, help: "Optional fixed scale: set both minimum and maximum. Otherwise use the displayed data range." },
            { key: "colorMax", label: "Color maximum", kind: "number" as const, step: 0.01 },
          ],
        } : {}),
      })
}
