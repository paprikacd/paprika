import type {
  FleetHealthStatus,
  FleetMatrixCell,
  FleetMatrixHeader,
  FleetMatrixResult,
} from "@/lib/fleet-client"
import type { FleetDirection, FleetMatrixSort } from "@/lib/fleet-query"
import { cn } from "@/lib/utils"

export interface FleetMatrixProps {
  result: FleetMatrixResult
  sort?: FleetMatrixSort
  direction?: FleetDirection
}

const healthTone: Record<FleetHealthStatus, string> = {
  healthy: "border-success/35 bg-success/10 text-success",
  progressing: "border-warning/35 bg-warning/10 text-warning",
  degraded: "border-warning/35 bg-warning/10 text-warning",
  failed: "border-destructive/35 bg-destructive/10 text-destructive",
  missing: "border-destructive/35 bg-destructive/10 text-destructive",
  unknown: "border-border bg-muted text-muted-foreground",
  unspecified: "border-border bg-muted text-muted-foreground",
}

export function FleetMatrix({
  result,
  sort = "name",
  direction = "asc",
}: FleetMatrixProps) {
  if (result.cells.length === 0) {
    return (
      <section
        role="status"
        aria-live="polite"
        className="mx-4 my-8 border border-border bg-card px-5 py-8 text-center sm:mx-6"
      >
        <h2 className="text-base font-semibold text-foreground">No populated intersections</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Adjust the fleet scope or choose different row and column dimensions.
        </p>
      </section>
    )
  }

  const rowHeaders = new Map(result.rows.map((header) => [header.stableId, header]))
  const columnHeaders = new Map(
    result.columns.map((header) => [header.stableId, header]),
  )
  const orderedCells = orderMatrixCells(
    result.cells,
    rowHeaders,
    columnHeaders,
    sort,
    direction,
  )

  return (
    <section aria-labelledby="fleet-matrix-title" className="px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border pb-4">
        <div>
          <p className="font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-primary">
            Sparse comparison
          </p>
          <h2 id="fleet-matrix-title" className="mt-1 text-lg font-semibold text-foreground">
            Fleet matrix
          </h2>
        </div>
        <p className="font-mono text-xs tabular-nums text-muted-foreground">
          {result.total.toString()} applications · {result.cells.length} populated cells · generation{" "}
          {result.indexGeneration.toString()}
        </p>
      </div>

      <div
        data-testid="fleet-matrix-scroll"
        className="mt-4 min-w-0 overflow-x-hidden border border-border bg-background xl:overflow-x-auto"
      >
        <table
          aria-label="Fleet matrix"
          className="block w-full max-w-full border-collapse text-left text-sm xl:table"
        >
          <thead className="sr-only bg-card font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted-foreground xl:not-sr-only xl:table-header-group">
            <tr>
              <th scope="col" className="w-[26%] border-b border-border px-4 py-3">Row</th>
              <th scope="col" className="w-[22%] border-b border-border px-4 py-3">Column</th>
              <th scope="col" className="w-[12%] border-b border-border px-4 py-3 text-right">Applications</th>
              <th scope="col" className="w-[12%] border-b border-border px-4 py-3 text-right">Targets</th>
              <th scope="col" className="w-[28%] border-b border-border px-4 py-3">Health</th>
            </tr>
          </thead>
          <tbody className="block xl:table-row-group">
            {orderedCells.map((cell, cellIndex) => {
              const rowHeader = rowHeaders.get(cell.rowId)
              const columnHeader = columnHeaders.get(cell.columnId)
              const rowLabel = rowHeader?.label ?? cell.rowId
              const columnLabel = columnHeader?.label ?? cell.columnId
              const rowIdentity = matrixHeaderIdentity(rowHeader, cell.rowId)
              const columnIdentity = matrixHeaderIdentity(columnHeader, cell.columnId)
              const idPrefix = `fleet-matrix-cell-${cellIndex}`
              return (
                <tr
                  key={`${cell.rowId}:${cell.columnId}`}
                  className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-4 border-b border-border/70 px-4 py-4 transition-colors last:border-b-0 hover:bg-muted/40 sm:px-5 xl:table-row xl:px-0 xl:py-0"
                >
                  <th
                    scope="row"
                    className="col-span-2 block min-w-0 p-0 text-left xl:table-cell xl:px-4 xl:py-4"
                  >
                    <span className="block break-words font-semibold text-foreground [overflow-wrap:anywhere]">
                      {rowLabel}
                    </span>
                    <span className="mt-1 block break-all font-mono text-[0.6875rem] font-normal text-muted-foreground">
                      {rowIdentity}
                    </span>
                  </th>
                  <td className="col-span-2 block min-w-0 p-0 text-foreground xl:table-cell xl:px-4 xl:py-4">
                    <span className="block break-words [overflow-wrap:anywhere]">
                      {columnLabel}
                    </span>
                    <span className="mt-1 block break-all font-mono text-[0.6875rem] text-muted-foreground">
                      {columnIdentity}
                    </span>
                  </td>
                  <td
                    aria-labelledby={`${idPrefix}-applications-label ${idPrefix}-applications-value`}
                    className="block min-w-0 p-0 xl:table-cell xl:px-4 xl:py-4 xl:text-right"
                  >
                    <span
                      id={`${idPrefix}-applications-label`}
                      className="block font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only"
                    >
                      Applications
                    </span>
                    <span
                      id={`${idPrefix}-applications-value`}
                      data-application-count
                      className="mt-1 block font-mono font-semibold tabular-nums text-foreground xl:mt-0"
                    >
                      {cell.applicationCount.toString()}
                    </span>
                  </td>
                  <td
                    aria-labelledby={`${idPrefix}-targets-label ${idPrefix}-targets-value`}
                    className="block min-w-0 p-0 xl:table-cell xl:px-4 xl:py-4 xl:text-right"
                  >
                    <span
                      id={`${idPrefix}-targets-label`}
                      className="block font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only"
                    >
                      Targets
                    </span>
                    <span
                      id={`${idPrefix}-targets-value`}
                      data-target-count
                      className="mt-1 block font-mono font-semibold tabular-nums text-foreground xl:mt-0"
                    >
                      {cell.targetCount.toString()}
                    </span>
                  </td>
                  <td className="col-span-2 block min-w-0 p-0 xl:table-cell xl:px-4 xl:py-4">
                    <span className="mb-1.5 block font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-muted-foreground xl:sr-only">
                      Health
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {cell.health
                        .filter((bucket) => bucket.count > BigInt(0))
                        .map((bucket) => (
                          <span
                            key={bucket.health}
                            className={cn(
                              "inline-flex min-h-6 items-center border px-2 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.06em]",
                              healthTone[bucket.health],
                            )}
                          >
                            {healthLabel(bucket.health)} {bucket.count.toString()}
                          </span>
                        ))}
                    </div>
                    {cell.usedResourceFallback ? (
                      <span className="mt-2 block text-[0.6875rem] text-muted-foreground">
                        Traffic unavailable · sized by resources
                      </span>
                    ) : null}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function orderMatrixCells(
  cells: readonly FleetMatrixCell[],
  rows: ReadonlyMap<string, FleetMatrixHeader>,
  columns: ReadonlyMap<string, FleetMatrixHeader>,
  sort: FleetMatrixSort,
  direction: FleetDirection,
): FleetMatrixCell[] {
  return [...cells].sort((left, right) => {
    let selected = compareMatrixField(left, right, rows, columns, sort)
    if (direction === "desc") selected = -selected
    if (selected !== 0) return selected

    const row = compareText(left.rowId, right.rowId)
    return row || compareText(left.columnId, right.columnId)
  })
}

function compareMatrixField(
  left: FleetMatrixCell,
  right: FleetMatrixCell,
  rows: ReadonlyMap<string, FleetMatrixHeader>,
  columns: ReadonlyMap<string, FleetMatrixHeader>,
  sort: FleetMatrixSort,
): number {
  switch (sort) {
    case "name":
    {
      const row = compareText(
        rows.get(left.rowId)?.label ?? left.rowId,
        rows.get(right.rowId)?.label ?? right.rowId,
      )
      return row || compareText(
        columns.get(left.columnId)?.label ?? left.columnId,
        columns.get(right.columnId)?.label ?? right.columnId,
      )
    }
    case "health":
      return compareNumber(matrixHealthSeverity(left), matrixHealthSeverity(right))
    case "resource_count":
      return compareBigInt(left.resourceWeight, right.resourceWeight)
    case "impact": {
      const health = compareNumber(matrixHealthSeverity(left), matrixHealthSeverity(right))
      if (health !== 0) return health
      const applications = compareBigInt(left.applicationCount, right.applicationCount)
      return applications || compareBigInt(left.resourceWeight, right.resourceWeight)
    }
  }
}

function matrixHealthSeverity(cell: FleetMatrixCell): number {
  const order: Readonly<Record<FleetHealthStatus, number>> = {
    unspecified: 0,
    healthy: 1,
    unknown: 2,
    missing: 3,
    progressing: 4,
    degraded: 5,
    failed: 6,
  }
  return cell.health.reduce(
    (highest, bucket) => bucket.count > BigInt(0) ? Math.max(highest, order[bucket.health]) : highest,
    0,
  )
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function healthLabel(health: FleetHealthStatus): string {
  return health.charAt(0).toUpperCase() + health.slice(1).replaceAll("_", " ")
}

function matrixHeaderIdentity(
  header: FleetMatrixHeader | undefined,
  fallback: string,
): string {
  if (header?.object) return `${header.object.namespace}/${header.object.name}`
  if (header?.value) return header.value
  const separator = fallback.indexOf(":")
  return separator >= 0 ? fallback.slice(separator + 1) : fallback
}
