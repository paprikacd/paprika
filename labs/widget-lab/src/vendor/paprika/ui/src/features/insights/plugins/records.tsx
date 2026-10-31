"use client"

import { useMemo, useState } from "react"
import { hierarchy, treemap } from "d3-hierarchy"
import { z } from "zod"
import {
  getWidgetDefinition,
  registerWidgetPlugin,
  type WidgetRendererProps,
} from "../widget-registry"
import { EmptyState, formatMetric } from "../chart-renderers"
import type { RecordFrame } from "../schema"
import styles from "./records.module.css"
import { StyledRecordCell, tableCellStyleError, tableCellStylesSchema, tableTextPalette } from "./record-table-cells"
import { useInsightsTheme } from "../insights-theme"

const key = z.string().min(1).max(128)
const tableConfig = z.strictObject({
  columns: z.array(key).min(1).max(64).optional(),
  pageSize: z.number().int().min(5).max(100).optional(),
  density: z.enum(["compact", "comfortable"]).default("comfortable"),
  showSearch: z.boolean().default(true),
  cellStyles: tableCellStylesSchema.optional(),
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
})
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
  const config = tableConfig.parse(widget.config ?? {})
  const activeSearch = !embedded && config.showSearch ? search : ""
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
  if (!frame?.rows.length) return <EmptyState />
  const cellStyleError = tableCellStyleError(frame, config.cellStyles ?? [])
  if (cellStyleError) return <p role="alert" className={styles.note}>{cellStyleError}</p>
  const cellStyles = new Map((config.cellStyles ?? []).map(style => [style.column, style]))
  const indexes =
    config.columns?.map((name) => column(frame, name)) ??
    frame.columns.map((_, i) => i)
  const pageSize = embedded ? 10 : (config.pageSize ?? 20)
  const current = Math.min(
    page,
    Math.max(0, Math.ceil(rows.length / pageSize) - 1),
  )
  return (
    <div className={`${styles.wrapper}${config.density === "compact" ? ` ${styles.compactTable}` : ""}`} data-table-density={config.density}>
      {!embedded && config.showSearch && (
        <div className={styles.toolbar}>
          <input
            aria-label={`Filter ${widget.title}`}
            placeholder="Filter records…"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value)
              setPage(0)
            }}
          />
          <span>{rows.length} loaded rows</span>
        </div>
      )}
      <div
        className={styles.scroll}
        tabIndex={0}
        role="region"
        aria-label={`${widget.title} records`}
      >
        <table>
          <thead>
            <tr>
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
                  {embedded ? (
                    (frame.columns[index].label ?? frame.columns[index].key)
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        setSort({
                          index,
                          descending: sort?.index === index && !sort.descending,
                        })
                      }
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
            </tr>
          </thead>
          <tbody>
            {rows
              .slice(current * pageSize, (current + 1) * pageSize)
              .map((row, i) => (
                <tr key={i}>
                  {indexes.map((index) => {
                    const field = frame.columns[index]
                    const style = cellStyles.get(field.key)
                    const formatted = cell(frame, row, index, widget.options?.decimals)
                    return <td key={index} title={text(row[index])} data-numeric={field.type === "number" || undefined} data-styled-cell={style?.display}>
                      {style ? <StyledRecordCell value={row[index]} formatted={formatted} column={field} style={style}
                        thresholds={widget.options?.thresholds} color={widget.color} textColors={textColors} /> : formatted}
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
                </tr>
              ))}
          </tbody>
        </table>
        {!rows.length && (
          <p className={styles.note}>No records match this filter.</p>
        )}
      </div>
      {(frame.truncated || !embedded && rows.length > pageSize) && <Note frame={frame}>
        {!embedded && rows.length > pageSize && (
          <>
            <button
              type="button"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </button>
            <span>
              Page {current + 1} of {Math.ceil(rows.length / pageSize)}
            </span>
            <button
              type="button"
              disabled={(current + 1) * pageSize >= rows.length}
              onClick={() => setPage(current + 1)}
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
}: WidgetRendererProps) {
  const frame = result.records
  if (!frame?.rows.length) return <EmptyState />
  const config = treeConfig.parse(widget.config ?? {})
  const label = column(frame, config.label),
    value = column(frame, config.value),
    group = config.group ? column(frame, config.group) : -1
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
  type Node = { row?: RecordFrame["rows"][number]; children?: Node[] }
  const groups = new Map<string, Node[]>()
  for (const row of positive) {
    const name = group >= 0 ? text(row[group]) : "all"
    const entries = groups.get(name) ?? []
    entries.push({ row })
    groups.set(name, entries)
  }
  const root = hierarchy<Node>({
    children: [...groups.values()].map((children) => ({ children })),
  })
    .sum((node) => (node.row ? (node.row[value] as number) : 0))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
  const leaves = treemap<Node>()
    .size([600, 300])
    .paddingInner(3)
    .paddingOuter(2)(root)
    .leaves()
  return (
    <div className={styles.wrapper}>
      <svg
        viewBox="0 0 600 300"
        className={styles.treemap}
        role="group"
        aria-label={widget.title}
      >
        {leaves.map((leaf, index) => {
          const row = leaf.data.row!,
            name = text(row[label]),
            formatted = cell(frame, row, value, widget.options?.decimals)
          const selected = () =>
            onContextChange?.({
              labels: labels(frame, row),
              value: row[value] as number,
              series: name,
            })
          return (
            <g
              key={index}
              role={onContextChange ? "button" : "img"}
              tabIndex={onContextChange ? 0 : undefined}
              aria-label={`${name}: ${formatted}`}
              onClick={selected}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault()
                  selected()
                }
              }}
            >
              <title>
                {name}: {formatted}
                {group >= 0 ? ` · ${text(row[group])}` : ""}
              </title>
              <rect
                x={leaf.x0}
                y={leaf.y0}
                width={leaf.x1 - leaf.x0}
                height={leaf.y1 - leaf.y0}
                rx={3}
                fill={`var(--record-color-${index % 6})`}
              />
              {leaf.x1 - leaf.x0 > 60 && leaf.y1 - leaf.y0 > 32 && (
                <text
                  x={leaf.x0 + 8}
                  y={leaf.y0 + 18}
                  className={styles.tileText}
                >
                  {name.slice(0, Math.floor((leaf.x1 - leaf.x0 - 16) / 7))}
                  <tspan x={leaf.x0 + 8} dy={17}>
                    {formatted}
                  </tspan>
                </text>
              )}
            </g>
          )
        })}
      </svg>
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
          styleControls: ["decimals", "color"] as const,
          configFields: [
            { key: "density", label: "Row density", kind: "select" as const, options: [{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }] },
            { key: "showSearch", label: "Show search", kind: "boolean" as const, help: "Show a filter for the loaded records. Hiding it restores every loaded row." },
            { key: "pageSize", label: "Rows per page", kind: "number" as const, min: 5, max: 100, placeholder: "Default: 20" },
          ],
        } : {}),
      })
}
