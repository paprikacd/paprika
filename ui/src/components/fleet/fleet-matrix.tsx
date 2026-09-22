import Link from "next/link"
import type { ReactNode } from "react"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import type {
  FleetHealthStatus,
  FleetMatrixCell,
  FleetMatrixHeader,
  FleetMatrixResult,
} from "@/lib/fleet-client"
import { STATUS_TONES, toneRank, type StatusTone } from "@/lib/status-tone"
import { cn } from "@/lib/utils"

/**
 * The matrix is the fleet seen as a grid: one axis of rows, one of columns,
 * and an aggregate at every populated intersection. `QueryFleetMatrix`
 * returns exactly that shape, so nothing here is derived or estimated —
 * every number on screen is a field the server sent.
 *
 * Two rules shape the rendering.
 *
 * **Bounded DOM.** A fleet is allowed to be enormous; the page is not. Rows
 * and columns are capped, and a cell only draws one square per unit while
 * the whole mix fits inside `maxSquares`. Past that it draws one glyph per
 * health state carrying the exact count, which is both smaller and more
 * precise than a wall of squares. The node count is therefore a constant,
 * whether the index holds fifty applications or fifty thousand.
 *
 * **No invented figures.** Application counts are only summed inside a cell,
 * where the server deduplicates them. They are never added up across cells:
 * one application with targets in two stages is two targets but one
 * application, and the wire cannot tell us which. Targets do add up, so the
 * axis totals are stated in targets.
 */
export interface FleetMatrixProps {
  result: FleetMatrixResult
  /** Names the grid for assistive technology and titles the board. */
  label?: string
  /** Right-hand board meta. Defaults to the index totals. */
  meta?: ReactNode
  /** Destination for one populated cell, e.g. the filtered application list. */
  cellHref?: (row: FleetMatrixHeader, column: FleetMatrixHeader) => string
  maxRows?: number
  maxColumns?: number
  maxSquares?: number
}

const MAX_ROWS = 20
const MAX_COLUMNS = 10
const MAX_SQUARES = 16

const HEALTH_TONE: Record<FleetHealthStatus, StatusTone> = {
  healthy: "healthy",
  progressing: "progressing",
  degraded: "degraded",
  failed: "failed",
  missing: "missing",
  unknown: "unknown",
  unspecified: "unknown",
}

/** The states an operator is on the hook for. */
const UNHEALTHY_TONES: readonly StatusTone[] = ["failed", "missing", "degraded"]

interface ToneCount {
  tone: StatusTone
  count: number
}

const counter = new Intl.NumberFormat("en-US")

function fmt(value: number | bigint): string {
  return counter.format(value)
}

export function FleetMatrix({
  result,
  label = "Fleet matrix",
  meta,
  cellHref,
  maxRows = MAX_ROWS,
  maxColumns = MAX_COLUMNS,
  maxSquares = MAX_SQUARES,
}: FleetMatrixProps) {
  if (result.cells.length === 0) {
    return (
      <Blueprint>
        <BoardHeader title={label} meta={meta ?? indexMeta(result)} />
        <div role="status" aria-live="polite" className="px-3.5 py-8 text-center">
          <h3 className="font-cond text-card font-semibold tracking-[0.02em]">
            No populated intersections
          </h3>
          <p className="mx-auto mt-1.5 max-w-prose text-reason text-muted-foreground">
            Every application in scope falls outside this pair of axes. Widen the
            scope or choose different row and column dimensions.
          </p>
        </div>
      </Blueprint>
    )
  }

  const noun = unitNoun(result.cells)
  const byIntersection = new Map<string, FleetMatrixCell>()
  const populatedRows = new Set<string>()
  const populatedColumns = new Set<string>()
  const columnTargets = new Map<string, number>()
  const rowTargets = new Map<string, number>()

  for (const cell of result.cells) {
    byIntersection.set(intersection(cell.rowId, cell.columnId), cell)
    populatedRows.add(cell.rowId)
    populatedColumns.add(cell.columnId)
    const targets = Number(cell.targetCount)
    columnTargets.set(cell.columnId, (columnTargets.get(cell.columnId) ?? 0) + targets)
    rowTargets.set(cell.rowId, (rowTargets.get(cell.rowId) ?? 0) + targets)
  }

  const rows = result.rows.filter((row) => populatedRows.has(row.stableId))
  const columns = result.columns.filter((column) =>
    populatedColumns.has(column.stableId)
  )
  const shownRows = rows.slice(0, maxRows)
  const shownColumns = columns.slice(0, maxColumns)
  const truncated =
    shownRows.length < rows.length || shownColumns.length < columns.length

  return (
    <Blueprint>
      <BoardHeader title={label} meta={meta ?? indexMeta(result)} />
      <div className="overflow-x-auto">
        <table aria-label={label} className="w-full border-collapse text-left">
          <thead>
            <tr>
              <th scope="col" className="w-32 border border-rule bg-muted p-0">
                <span className="sr-only">Row</span>
              </th>
              {shownColumns.map((column) => (
                <th
                  key={column.stableId}
                  scope="col"
                  className="min-w-40 border border-rule bg-muted px-3 py-2 align-bottom"
                >
                  <span className="block font-cond text-card font-semibold tracking-[0.04em]">
                    {column.label}
                  </span>
                  <span className="mt-px block font-mono text-meta font-normal text-muted-foreground">
                    {fmt(columnTargets.get(column.stableId) ?? 0)} targets
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shownRows.map((row) => (
              <tr key={row.stableId}>
                <th
                  scope="row"
                  className="border border-rule bg-muted px-3 py-2 align-middle"
                >
                  <span className="block truncate font-cond text-name font-semibold tracking-[0.04em]">
                    {row.label}
                  </span>
                  <span className="mt-px block font-mono text-meta font-normal text-muted-foreground">
                    {fmt(rowTargets.get(row.stableId) ?? 0)} targets
                  </span>
                </th>
                {shownColumns.map((column) => (
                  <td
                    key={column.stableId}
                    className="border border-rule bg-card p-0 align-top"
                  >
                    <MatrixCell
                      cell={byIntersection.get(
                        intersection(row.stableId, column.stableId)
                      )}
                      row={row}
                      column={column}
                      noun={noun}
                      maxSquares={maxSquares}
                      href={cellHref}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated ? (
        <p className="border-t border-rule px-3.5 py-2 text-note text-muted-foreground">
          Showing {fmt(shownRows.length)} of {fmt(rows.length)} rows and{" "}
          {fmt(shownColumns.length)} of {fmt(columns.length)} columns. Narrow the
          scope to bring the rest into view.
        </p>
      ) : null}
    </Blueprint>
  )
}

/**
 * One intersection. An absent cell is a real answer — the matrix is sparse
 * because the index found nothing there — so it says so in words rather than
 * drawing a zero.
 */
function MatrixCell({
  cell,
  row,
  column,
  noun,
  maxSquares,
  href,
}: {
  cell: FleetMatrixCell | undefined
  row: FleetMatrixHeader
  column: FleetMatrixHeader
  noun: string
  maxSquares: number
  href?: (row: FleetMatrixHeader, column: FleetMatrixHeader) => string
}) {
  if (!cell) {
    return (
      <div className="min-h-row-comfortable px-3 py-2.5">
        <span className="font-mono text-meta text-neutral-600">no {noun}s</span>
      </div>
    )
  }

  const units = cellUnits(cell)
  const total = units.reduce((sum, unit) => sum + unit.count, 0)
  const unhealthy = units
    .filter((unit) => UNHEALTHY_TONES.includes(unit.tone))
    .reduce((sum, unit) => sum + unit.count, 0)
  const applications = Number(cell.applicationCount)
  const summary = [
    applications === total ? null : `${fmt(applications)} apps`,
    `${fmt(total)} ${noun}${total === 1 ? "" : "s"}`,
    unhealthy > 0 ? `${fmt(unhealthy)} unhealthy` : "all healthy",
  ]
    .filter(Boolean)
    .join(" · ")
  const mix = units
    .map((unit) => `${STATUS_TONES[unit.tone].label} ${fmt(unit.count)}`)
    .join(", ")
  const description = `${row.label} · ${column.label} — ${summary}. ${mix}`
  const body = (
    <>
      {total <= maxSquares ? (
        <span className="flex flex-wrap gap-0.5">
          {expandUnits(units).map((tone, index) => (
            <ToneSquare key={index} tone={tone} />
          ))}
        </span>
      ) : (
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {units.map((unit) => (
            <span key={unit.tone} className="inline-flex items-center gap-1">
              <ToneSquare tone={unit.tone} />
              <span className="font-mono text-meta tabular-nums text-muted-foreground">
                {fmt(unit.count)}
              </span>
            </span>
          ))}
        </span>
      )}
      <span className="mt-2 block font-mono text-meta text-neutral-600">
        {summary}
      </span>
      {cell.usedResourceFallback ? (
        <span className="mt-1 block font-mono text-meta text-neutral-500">
          sized by resources
        </span>
      ) : null}
    </>
  )

  if (!href) {
    // The squares are decorative, so without a link to carry an accessible
    // name the health mix has to be readable as text.
    return (
      <div className="min-h-row-comfortable px-3 py-2.5">
        {body}
        <span className="sr-only">{mix}</span>
      </div>
    )
  }

  return (
    <Link
      href={href(row, column)}
      aria-label={description}
      className={cn(
        "block min-h-row-comfortable px-3 py-2.5 no-underline",
        "hover:bg-inset focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      )}
    >
      {body}
    </Link>
  )
}

/**
 * The unit mark. The glyph carries the state as well as the tint, so the mix
 * survives greyscale; the surrounding link or summary names it in words.
 */
function ToneSquare({ tone }: { tone: StatusTone }) {
  const spec = STATUS_TONES[tone]
  return (
    <span
      aria-hidden
      data-tone={tone}
      data-slot="matrix-square"
      className={cn(
        "inline-flex size-4 flex-none items-center justify-center border text-meta leading-none font-bold",
        spec.line,
        spec.fill,
        spec.text
      )}
    >
      {spec.glyph}
    </span>
  )
}

function indexMeta(result: FleetMatrixResult): string {
  return `${fmt(result.total)} applications · ${fmt(
    result.cells.length
  )} populated cells · gen ${result.indexGeneration.toString()}`
}

function intersection(rowId: string, columnId: string): string {
  return `${rowId}::${columnId}`
}

function cellUnits(cell: FleetMatrixCell): ToneCount[] {
  const totals = new Map<StatusTone, number>()
  for (const bucket of cell.health) {
    const count = Number(bucket.count)
    if (count <= 0) continue
    const tone = HEALTH_TONE[bucket.health] ?? "unknown"
    totals.set(tone, (totals.get(tone) ?? 0) + count)
  }
  return [...totals]
    .map(([tone, count]) => ({ tone, count }))
    .sort((left, right) => toneRank(left.tone) - toneRank(right.tone))
}

function expandUnits(units: readonly ToneCount[]): StatusTone[] {
  const squares: StatusTone[] = []
  for (const unit of units) {
    for (let index = 0; index < unit.count; index += 1) squares.push(unit.tone)
  }
  return squares
}

/**
 * Health buckets count targets when either axis is a target dimension and
 * applications otherwise, so the noun is read back off the response rather
 * than assumed. Getting this wrong would mislabel every summary on screen.
 */
function unitNoun(cells: readonly FleetMatrixCell[]): string {
  let units = 0
  let targets = 0
  let applications = 0
  for (const cell of cells) {
    for (const bucket of cell.health) units += Number(bucket.count)
    targets += Number(cell.targetCount)
    applications += Number(cell.applicationCount)
  }
  if (units === targets) return "target"
  if (units === applications) return "application"
  return "record"
}
