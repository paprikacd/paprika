import type {
  FleetHealthStatus,
  FleetMatrixResult,
} from "@/lib/fleet-client"
import { cn } from "@/lib/utils"

export interface FleetMatrixProps {
  result: FleetMatrixResult
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

export function FleetMatrix({ result }: FleetMatrixProps) {
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

  const rowLabels = new Map(result.rows.map((header) => [header.stableId, header.label]))
  const columnLabels = new Map(
    result.columns.map((header) => [header.stableId, header.label]),
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

      <div className="mt-4 overflow-x-auto border border-border bg-background">
        <table aria-label="Fleet matrix" className="w-full min-w-[48rem] border-collapse text-left text-sm">
          <thead className="bg-card font-mono text-[0.625rem] uppercase tracking-[0.12em] text-muted-foreground">
            <tr>
              <th scope="col" className="border-b border-border px-4 py-3">Row</th>
              <th scope="col" className="border-b border-border px-4 py-3">Column</th>
              <th scope="col" className="border-b border-border px-4 py-3 text-right">Applications</th>
              <th scope="col" className="border-b border-border px-4 py-3 text-right">Targets</th>
              <th scope="col" className="border-b border-border px-4 py-3">Health</th>
            </tr>
          </thead>
          <tbody>
            {result.cells.map((cell) => {
              const rowLabel = rowLabels.get(cell.rowId) ?? cell.rowId
              const columnLabel = columnLabels.get(cell.columnId) ?? cell.columnId
              return (
                <tr
                  key={`${cell.rowId}:${cell.columnId}`}
                  className="border-b border-border/70 transition-colors last:border-b-0 hover:bg-muted/40"
                >
                  <th scope="row" className="px-4 py-4 font-semibold text-foreground">
                    {rowLabel}
                  </th>
                  <td className="px-4 py-4 text-foreground">{columnLabel}</td>
                  <td
                    data-application-count
                    className="px-4 py-4 text-right font-mono font-semibold tabular-nums text-foreground"
                  >
                    {cell.applicationCount.toString()}
                  </td>
                  <td
                    data-target-count
                    className="px-4 py-4 text-right font-mono font-semibold tabular-nums text-foreground"
                  >
                    {cell.targetCount.toString()}
                  </td>
                  <td className="px-4 py-4">
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

function healthLabel(health: FleetHealthStatus): string {
  return health.charAt(0).toUpperCase() + health.slice(1).replaceAll("_", " ")
}
