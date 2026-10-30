"use client"

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { ArrowRight } from "lucide-react"
import { hierarchy, treemap } from "d3-hierarchy"
import { z } from "zod"
import {
  getWidgetDefinition,
  registerWidgetPlugin,
  type WidgetRendererProps,
} from "../widget-registry"
import { EmptyState, formatMetric, ObservationTooltip } from "../chart-renderers"
import { useEmbeddedWidget } from "../widget-presentation"
import type { RecordFrame } from "../schema"
import styles from "./records.module.css"
import { StyledRecordCell, parseRecordHistory, tableCellStyleError, tableCellStylesSchema, tableTextPalette } from "./record-table-cells"
import { useInsightsTheme } from "../insights-theme"
import { useDashboardWindow } from "../dashboard-window"

const key = z.string().min(1).max(128)
const tableConfig = z.strictObject({
  columns: z.array(key).min(1).max(64).optional(),
  pageSize: z.number().int().min(5).max(100).optional(),
  density: z.enum(["compact", "comfortable"]).default("comfortable"),
  showSearch: z.boolean().default(true),
  showRowNumbers: z.boolean().optional(),
  cellStyles: tableCellStylesSchema.optional(),
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
function text(value: unknown): string {
  return value === null || value === undefined ? "—" : String(value)
}
function cell(
  frame: RecordFrame,
  row: RecordFrame["rows"][number],
  index: number,
  decimals?: number,
) {
  const value = row[index]
  if (value === null) return "—"
  if (typeof value === "number")
    return formatMetric(
      value,
      frame.columns[index].unit === "percent"
        ? "%"
        : (frame.columns[index].unit ?? ""),
      false,
      decimals,
    )
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
  children,
}: {
  frame: RecordFrame
  children?: React.ReactNode
}) {
  return (
    <div className={styles.note} role="status">
      {children}
      {frame.truncated && <span>Partial result · source limit reached</span>}
    </div>
  )
}

export function RecordTable({
  widget,
  result,
  embedded,
  onContextChange,
}: WidgetRendererProps) {
  const { apply: applyTime } = useDashboardWindow()
  const { resolvedTheme } = useInsightsTheme()
  const textColors = useMemo(() => tableTextPalette(resolvedTheme, widget.options?.background, widget.options?.thresholds, widget.color),
    [resolvedTheme, widget.options?.background, widget.options?.thresholds, widget.color])
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(0)
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
  const [cellObservation, setCellObservation] = useState<{ anchor: HTMLTableCellElement; frame: RecordFrame; view: string; row: number; column: number; value: unknown; pinned: boolean }>()
  const cellPanel = useRef<HTMLDivElement | null>(null)
  const cellHideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cellInteraction = useRef({ panel: false, hovered: false, focused: false })
  const clearCellHide = () => clearTimeout(cellHideTimer.current)
  const hideCell = () => { clearCellHide(); cellInteraction.current.panel = false; setCellObservation(undefined) }
  const scheduleCellHide = () => { clearCellHide(); cellHideTimer.current = setTimeout(() => { const state = cellInteraction.current; if (!state.panel && !state.hovered && !state.focused) setCellObservation(previous => previous?.pinned ? previous : undefined) }, 180) }
  useEffect(() => () => clearTimeout(cellHideTimer.current), [])
  const [horizontalOverflow, setHorizontalOverflow] = useState(false)
  const config = tableConfig.parse(widget.config ?? {})
  const activeSearch = !embedded && config.showSearch ? search : ""
  const cellConfigIdentity = JSON.stringify([config.columns, config.cellStyles])
  const rows = useMemo(() => {
    if (!frame) return []
    const selected = frame.rows.filter(
      (row) =>
        !activeSearch ||
        row.some((v) =>
          text(v).toLocaleLowerCase().includes(activeSearch.toLocaleLowerCase()),
        ),
    )
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
  }, [frame, activeSearch, sort])
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
  const cellStyles = new Map((config.cellStyles ?? []).map(style => [style.column, style]))
  const thresholdIndexes = new Map((config.cellStyles ?? []).filter(style => style.thresholdColumn).map(style => [style.column, frame.columns.findIndex(column => column.key === style.thresholdColumn)]))
  const indexes =
    config.columns?.map((name) => column(frame, name)) ??
    frame.columns.map((_, i) => i)
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
  const view = JSON.stringify([activeSearch, sort, current, cellConfigIdentity])
  const activeCell = inspectCells && cellObservation?.frame === frame && cellObservation.view === view && cellObservation.anchor.isConnected ? cellObservation : undefined
  const focusRow = Math.min(cellFocus.row, Math.max(0, displayedRows.length - 1))
  const focusColumn = Math.min(cellFocus.column, Math.max(0, indexes.length - 1))
  const showCell = (anchor: HTMLTableCellElement, row: number, column: number, value: unknown, pinned = false) => {
    if (!inspectCells) return
    clearCellHide()
    setCellObservation({ anchor, frame, view, row, column, value, pinned })
  }
  const activeColumn = activeCell ? frame.columns[indexes[activeCell.column]] : undefined
  const activeStyle = activeColumn ? cellStyles.get(activeColumn.key) : undefined
  const cellMeaning = activeCell?.anchor.querySelector("[data-cell-display][aria-label]")?.getAttribute("aria-label") ?? activeCell?.anchor.querySelector("[data-history-color-meaning]")?.textContent
  const history = activeStyle?.display === "sparkline" ? parseRecordHistory(activeCell?.value) : undefined
  const activeUnit = activeStyle?.unit ?? (activeColumn?.unit === "percent" ? "%" : activeColumn?.unit ?? "")
  const activeValue = history?.state === "valid" ? history.points[history.points.length - 1].value : activeCell?.value
  const formattedValue = history && history.state !== "valid" ? history.state === "invalid" ? "Invalid history" : "No history" : activeValue == null ? "No data" : typeof activeValue === "number" ? formatMetric(activeValue, activeUnit, false, widget.options?.decimals) : typeof activeValue === "boolean" ? activeValue ? "Yes" : "No" : activeColumn?.type === "timestamp" ? new Date(String(activeValue)).toLocaleString() : String(activeValue)
  return (
    <div className={`${styles.wrapper}${config.density === "compact" ? ` ${styles.compactTable}` : ""}`} data-table-density={config.density} data-cell-inspection={inspectCells || undefined}>
      {inspectCells && <p id={cellHelpId} className={styles.cellHistoryMeaning}>Use arrow keys to move between cells and Enter to pin details.</p>}
      {!embedded && config.showSearch && (
        <div className={styles.toolbar}>
          <input
            aria-label={`Filter ${widget.title}`}
            placeholder="Filter records…"
            value={search}
            onChange={(event) => {
              hideCell()
              setSearch(event.target.value)
              setPage(0)
            }}
          />
          <span>{rows.length} loaded rows</span>
        </div>
      )}
      <div
        className={styles.scroll}
        ref={scrollRef}
        tabIndex={0}
        role="region"
        aria-label={`${widget.title} records`}
        aria-describedby={horizontalOverflow ? overflowHintId : undefined}
      >
        <table>
          <thead>
            <tr>
              {config.showRowNumbers && <th scope="col" className={styles.rowNumber} title="Position in the displayed records" aria-label="Row number">#</th>}
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
                    <button
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
                    </button>
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
                <tr key={i}>
                  {config.showRowNumbers && <td className={styles.rowNumber}>{current * pageSize + i + 1}</td>}
                  {indexes.map((index, visibleColumn) => {
                    const field = frame.columns[index]
                    const style = cellStyles.get(field.key)
                    const formatted = cell(frame, row, index, widget.options?.decimals)
                    return <td key={index} data-record-cell-row={i} data-record-cell-column={visibleColumn} tabIndex={inspectCells ? i === focusRow && visibleColumn === focusColumn ? 0 : -1 : undefined} aria-describedby={inspectCells ? `${cellHelpId}${activeCell?.row === i && activeCell.column === visibleColumn ? ` ${cellTooltipId}` : ""}` : undefined} data-numeric={field.type === "number" || undefined} data-styled-cell={style?.display}
                      onPointerEnter={event => { if (event.pointerType !== "touch") { cellInteraction.current.hovered = true; if (!activeCell?.pinned) showCell(event.currentTarget, i, visibleColumn, row[index]) } }}
                      onPointerLeave={() => { cellInteraction.current.hovered = false; scheduleCellHide() }}
                      onFocus={event => { cellInteraction.current.focused = true; setCellFocus({ row: i, column: visibleColumn }); showCell(event.currentTarget, i, visibleColumn, row[index], !!activeCell?.pinned) }}
                      onBlur={() => { cellInteraction.current.focused = false; scheduleCellHide() }}
                      onClick={event => { if (!inspectCells) return; event.currentTarget.focus({ preventScroll: true }); if (activeCell?.anchor === event.currentTarget && activeCell.pinned) hideCell(); else showCell(event.currentTarget, i, visibleColumn, row[index], true) }}
                      onKeyDown={event => {
                        if (!inspectCells) return
                        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); if (activeCell?.anchor === event.currentTarget && activeCell.pinned) hideCell(); else showCell(event.currentTarget, i, visibleColumn, row[index], true); return }
                        if (event.key === "Tab" && !event.shiftKey && activeCell?.pinned && cellPanel.current) { event.preventDefault(); cellPanel.current.focus({ preventScroll: true }); return }
                        const delta = event.key === "ArrowLeft" ? [0, -1] : event.key === "ArrowRight" ? [0, 1] : event.key === "ArrowUp" ? [-1, 0] : event.key === "ArrowDown" ? [1, 0] : undefined
                        if (!delta) return
                        event.preventDefault()
                        const nextRow = Math.max(0, Math.min(displayedRows.length - 1, i + delta[0])), nextColumn = Math.max(0, Math.min(indexes.length - 1, visibleColumn + delta[1]))
                        const next = scrollRef.current?.querySelector<HTMLTableCellElement>(`td[data-record-cell-row="${nextRow}"][data-record-cell-column="${nextColumn}"]`)
                        next?.focus({ preventScroll: true }); next?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
                      }}>
                      {style ? <StyledRecordCell value={row[index]} formatted={formatted} column={field} style={style}
                        thresholds={widget.options?.thresholds} color={widget.color} textColors={textColors} decimals={widget.options?.decimals} thresholdValue={thresholdIndexes.has(field.key) ? row[thresholdIndexes.get(field.key)!] : undefined} nativeTitle={false} /> : formatted}
                    </td>
                  })}
                  {onContextChange && !embedded && (
                    <td>
                      <button
                        type="button"
                        onClick={() =>
                          onContextChange({ labels: labels(frame, row) })
                        }
                        aria-label={`Select row ${current * pageSize + i + 1}`}
                      >
                        Select
                      </button>
                    </td>
                  )}
                  {timeConfig && applyTime && !embedded && (() => {
                    const start = typeof row[startIndex] === "string" ? Date.parse(row[startIndex] as string) : NaN
                    const duration = row[durationIndex]
                    const multiplier = timeConfig.durationUnit === "minutes" ? 60_000 : timeConfig.durationUnit === "seconds" ? 1000 : 1
                    const padding = timeConfig.paddingSeconds * 1000
                    const from = start - padding, to = start + (typeof duration === "number" ? duration * multiplier : NaN) + padding
                    const valid = Number.isFinite(from) && from > 0 && typeof duration === "number" && Number.isFinite(duration) && duration > 0 && Number.isFinite(to) && to > from && to - from <= 31 * 86400_000
                    return <td><button type="button" aria-label={`Focus time for row ${current * pageSize + i + 1}`} disabled={!valid} title={valid ? "Focus dashboard on this recorded interval" : "This row needs a valid start and duration within 31 days"} onClick={() => applyTime({ start: from, end: to })}>Focus time</button></td>
                  })()}
                </tr>
              ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className={styles.note}>No records match this filter.</p>
        )}
      </div>
      {horizontalOverflow && <div id={overflowHintId} className={styles.scrollHint}><ArrowRight size={12} aria-hidden="true" /> Scroll horizontally to see more columns</div>}
      {activeCell && activeColumn && <ObservationTooltip id={cellTooltipId} anchor={activeCell.anchor} className={styles.recordTooltip} avoidWidget pinned={activeCell.pinned} role={activeCell.pinned ? "region" : "tooltip"} ariaLabel={activeCell.pinned ? "Record cell details" : undefined} tabIndex={activeCell.pinned ? 0 : undefined} panelRef={element => { cellPanel.current = element }} onDismiss={() => { if (cellPanel.current?.contains(document.activeElement)) activeCell.anchor.focus({ preventScroll: true }); hideCell() }} onEnter={() => { cellInteraction.current.panel = true; clearCellHide() }} onLeave={() => { cellInteraction.current.panel = false; scheduleCellHide() }}>
        <div className={styles.recordCellDetails}><strong>{activeColumn.label ?? activeColumn.key}</strong><span>{formattedValue}</span>{typeof activeValue === "number" && Number.isFinite(activeValue) && <small>Recorded value: {String(activeValue)}</small>}{history?.state === "valid" && <small>{history.points.length} recorded {history.points.length === 1 ? "sample" : "samples"} · latest {new Date(history.points[history.points.length - 1].timestamp).toLocaleString()}</small>}{history?.state === "invalid" && <small>History must be an ordered JSON array of timestamped numeric or null observations.</small>}{cellMeaning && <small>{cellMeaning}</small>}{activeCell.pinned && <button type="button" onClick={() => { activeCell.anchor.focus({ preventScroll: true }); hideCell() }}>Close</button>}</div>
      </ObservationTooltip>}
      {(frame.truncated || !embedded && rows.length > pageSize) && <Note frame={frame}>
        {!embedded && rows.length > pageSize && (
          <>
            <button
              type="button"
              disabled={current === 0}
              onClick={() => { hideCell(); setPage(current - 1) }}
            >
              Previous
            </button>
            <span>
              Page {current + 1} of {Math.ceil(rows.length / pageSize)}
            </span>
            <button
              type="button"
              disabled={(current + 1) * pageSize >= rows.length}
              onClick={() => { hideCell(); setPage(current + 1) }}
            >
              Next
            </button>
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
                      {text(row[indexes.title])}
                    </a>
                  ) : (
                    text(row[indexes.title])
                  )}
                </strong>
                {config.status && (
                  <span className={styles.badge}>
                    {text(row[indexes.status])}
                  </span>
                )}
                {config.subtitle && (
                  <small>{text(row[indexes.subtitle])}</small>
                )}
                {config.body && <p>{text(row[indexes.body])}</p>}
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
      <Note frame={frame}>
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
  const [inspection, setInspection] = useState<{ frame: RecordFrame; revision: string; index: number; anchor: SVGGElement; pinned: boolean; name: string; sizeLabel: string; sizeValue: string; sizeRaw: number; groupLabel?: string; groupValue?: string; colorLabel?: string; colorValue?: string; colorRaw?: number | null }>()
  const interaction = useRef({ hovered: false, focused: false, panel: false })
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clearHide = () => clearTimeout(timer.current)
  const dismiss = () => { clearHide(); interaction.current.panel = false; setInspection(undefined) }
  const scheduleHide = () => {
    clearHide()
    timer.current = setTimeout(() => {
      const state = interaction.current
      if (!state.hovered && !state.focused && !state.panel) setInspection(current => current?.pinned ? current : undefined)
    }, 180)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  const frame = result.records
  if (inspection && (inspection.frame !== frame || inspection.revision !== revision || !detailsEnabled)) setInspection(undefined)
  const active = inspection && inspection.frame === frame && inspection.revision === revision && detailsEnabled ? inspection : undefined
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
    const name = group >= 0 ? text(row[group]) : "all"
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
  return (
    <div className={styles.wrapper}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${size.width} ${size.height}`}
        className={styles.treemap}
        role="group"
        aria-label={widget.title}
      >
        {colorMissing && <defs><pattern id={missingPattern} width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#e2e6e2" /><path d="M-2 2L2 -2M0 8L8 0M6 10L10 6" stroke="#a6b0a8" strokeWidth="1" /></pattern></defs>}
        {group >= 0 && tree.children?.map(node => node.x1 - node.x0 >= 60 && <text key={node.data.name} x={node.x0 + 4} y={node.y0 + 14} fill="currentColor" fontSize="11">{node.data.name}</text>)}
        {leaves.map((leaf, index) => {
          const row = leaf.data.row!,
            name = text(row[label]),
            formatted = formatMetric(row[value] as number, frame.columns[value].unit === "percent" ? "%" : frame.columns[value].unit || widget.unit, false, widget.options?.decimals)
          const colorValue = color >= 0 && typeof row[color] === "number" && Number.isFinite(row[color]) ? row[color] as number : null
          const colorLabel = color >= 0 ? frame.columns[color].label ?? frame.columns[color].key : undefined
          const colorDetail = color >= 0 ? `${colorLabel}: ${colorValue === null ? "No data" : cell(frame, row, color, widget.options?.decimals)}` : undefined
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
          const show = (anchor: SVGGElement, pinned = false) => {
            if (!detailsEnabled || (active?.pinned && !pinned)) return
            clearHide()
            setInspection({ frame, revision, index, anchor, pinned, name, sizeLabel: frame.columns[value].label ?? frame.columns[value].key, sizeValue: formatted, sizeRaw: row[value] as number,
              ...(group >= 0 ? { groupLabel: frame.columns[group].label ?? frame.columns[group].key, groupValue: text(row[group]) } : {}),
              ...(color >= 0 ? { colorLabel, colorValue: colorValue === null ? "No data" : cell(frame, row, color, widget.options?.decimals), colorRaw: colorValue } : {}) })
          }
          const actionable = interactive && (detailsEnabled || !!onContextChange)
          return (
            <g
              key={index}
              role={actionable ? "button" : "img"}
              tabIndex={actionable ? 0 : undefined}
              aria-label={`${name}: ${formatted}${colorDetail ? ` · ${colorDetail}` : ""}`}
              aria-describedby={active?.index === index ? `${missingPattern}-details` : undefined}
              aria-pressed={detailsEnabled ? (active?.index === index && active.pinned) : undefined}
              onPointerEnter={event => { if (event.pointerType === "touch") return; interaction.current.hovered = true; show(event.currentTarget) }}
              onPointerLeave={() => { interaction.current.hovered = false; scheduleHide() }}
              onFocus={event => { interaction.current.focused = true; show(event.currentTarget) }}
              onBlur={() => { interaction.current.focused = false; scheduleHide() }}
              onClick={event => { if (!interactive) return; selected(); if (active?.index === index && active.pinned) dismiss(); else show(event.currentTarget, true) }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  if (!interactive) return
                  selected()
                  if (active?.index === index && active.pinned) dismiss(); else show(event.currentTarget, true)
                }
              }}
            >
              <rect
                x={leaf.x0}
                y={leaf.y0}
                width={leaf.x1 - leaf.x0}
                height={leaf.y1 - leaf.y0}
                rx={3}
                fill={color < 0 ? `var(--record-color-${index % 6})` : colorStyle?.fill ?? `url(#${missingPattern})`}
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
                    style={color >= 0 ? { fill: colorStyle?.ink ?? "#000000" } : undefined}
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
      {active && <ObservationTooltip id={`${missingPattern}-details`} anchor={active.anchor} avoidWidget pinned={active.pinned} onDismiss={dismiss}
        onEnter={() => { interaction.current.panel = true; clearHide() }} onLeave={() => { interaction.current.panel = false; scheduleHide() }}>
        <div className={styles.treeTooltip}>
          <strong>{active.name}</strong>
          <dl><div><dt>{active.sizeLabel}</dt><dd data-treemap-observation={active.sizeRaw}>{active.sizeValue}</dd></div>
            {active.groupLabel && <div><dt>{active.groupLabel}</dt><dd>{active.groupValue}</dd></div>}
            {active.colorLabel && <div><dt>{active.colorLabel}</dt><dd data-treemap-color-observation={active.colorRaw === null ? "missing" : active.colorRaw}>{active.colorValue}</dd></div>}
          </dl>
          <small>{active.pinned ? "Pinned · select again to close" : "Click or press Enter to keep open"}</small>
        </div>
      </ObservationTooltip>}
      {color >= 0 && <div className={styles.treeColorLegend} role="group" aria-label="Treemap color scale">
        <span>{frame.columns[color].label ?? frame.columns[color].key}</span>
        {colorValues.length > 0 ? <><span>{formatMetric(colorMin, frame.columns[color].unit === "percent" ? "%" : (frame.columns[color].unit ?? ""), false, widget.options?.decimals)}</span><span className={styles.treeColorGradient} aria-hidden="true" /><span>{formatMetric(colorMax, frame.columns[color].unit === "percent" ? "%" : (frame.columns[color].unit ?? ""), false, widget.options?.decimals)}</span></> : <span>No numeric color values</span>}
        {colorMissing && <span className={styles.treeMissingKey}>No data</span>}
      </div>}
      <Note frame={frame}>
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
  const frame = result.records
  if (!frame?.rows.length) return <EmptyState />
  const config = matrixConfig.parse(widget.config ?? {})
  const x = column(frame, config.x),
    y = column(frame, config.y),
    value = column(frame, config.value)
  const xs = [...new Set(frame.rows.map((row) => text(row[x])))].slice(0, 25),
    ys = [...new Set(frame.rows.map((row) => text(row[y])))].slice(0, 25)
  const values = frame.rows.flatMap((row) =>
    typeof row[value] === "number" ? [row[value] as number] : [],
  )
  const min = config.min ?? Math.min(0, ...values),
    max = config.max ?? Math.max(1, ...values)
  if (min >= max)
    return (
      <p role="alert">
        Matrix minimum must be below its maximum. Set both scale bounds when a
        fixed bound is outside the returned values.
      </p>
    )
  const cells = new Map<string, RecordFrame["rows"][number]>()
  for (const row of frame.rows) {
    const id = JSON.stringify([text(row[x]), text(row[y])])
    if (cells.has(id))
      return (
        <p role="alert">
          Duplicate matrix coordinates. Aggregate the source query before
          rendering.
        </p>
      )
    cells.set(id, row)
  }
  return (
    <div className={styles.wrapper}>
      <div
        className={styles.scroll}
        tabIndex={0}
        role="region"
        aria-label={`${widget.title} matrix`}
      >
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th />
              {xs.map((name) => (
                <th key={name}>{name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ys.map((name) => (
              <tr key={name}>
                <th>{name}</th>
                {xs.map((xName) => {
                  const row = cells.get(JSON.stringify([xName, name])),
                    number = row?.[value]
                  const progress =
                    typeof number === "number"
                      ? Math.max(0, Math.min(1, (number - min) / (max - min)))
                      : undefined
                  const formatted = row
                    ? cell(frame, row, value, widget.options?.decimals)
                    : "—"
                  return (
                    <td
                      key={xName}
                      style={
                        progress === undefined
                          ? undefined
                          : {
                              background: `color-mix(in srgb, var(--gamma-accent, #53876a) ${Math.round(8 + progress * 45)}%, var(--gamma-bg, white))`,
                            }
                      }
                    >
                      {onContextChange && row ? (
                        <button
                          type="button"
                          aria-label={`${name}, ${xName}: ${formatted}`}
                          onClick={() =>
                            onContextChange({
                              labels: labels(frame, row),
                              value: typeof number === "number" ? number : null,
                            })
                          }
                        >
                          {formatted}
                        </button>
                      ) : (
                        formatted
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note frame={frame}>
        <span>
          Scale {min}–{max} · missing cells —
        </span>
        {(new Set(frame.rows.map((row) => text(row[x]))).size > 25 ||
          new Set(frame.rows.map((row) => text(row[y]))).size > 25) && (
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
        ...(entry.id === "record-table" ? {
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
