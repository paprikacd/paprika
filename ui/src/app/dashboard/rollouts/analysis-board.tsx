"use client"

import { Blueprint, BoardHeader } from "@/components/ui/blueprint"
import { StatusPill } from "@/components/ui/status-chip"
import { cn } from "@/lib/utils"

import { Absent } from "./rollout-chrome"
import {
  analysisColumns,
  failingRowCount,
  type AnalysisRow,
} from "./rollout-model"

/**
 * The analysis table. METRIC, THRESHOLD and RESULT are typed fields and are
 * always trustworthy. BASELINE and CANARY are not: the API has no field for
 * them, only the free-form text a check author wrote, so a column appears only
 * when at least one row actually yielded a value and a cell stays blank when
 * its row did not.
 */
export function AnalysisBoard({
  rows,
  paused,
}: {
  rows: readonly AnalysisRow[]
  paused: boolean
}) {
  const columns = analysisColumns(rows)
  const failing = failingRowCount(rows)
  const explained = rows.filter((row) => row.tone === "failed" && row.message)

  return (
    <Blueprint>
      <BoardHeader
        title={paused && failing > 0 ? "Analysis — why it paused" : "Analysis"}
        meta={
          <span className={failing > 0 ? "text-status-failed-text" : undefined}>
            {failing > 0
              ? `${failing} of ${rows.length} ${rows.length === 1 ? "metric" : "metrics"} failing`
              : `${rows.length} ${rows.length === 1 ? "metric" : "metrics"}`}
          </span>
        }
      />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <caption className="sr-only">
            Analysis checks for this rollout, with the threshold each declares
            and the result it last reported.
          </caption>
          <thead>
            <tr className="border-b border-rule-strong bg-muted">
              <th
                scope="col"
                className="h-7 px-3.5 text-left font-mono text-kicker font-normal tracking-[0.14em] text-muted-foreground"
              >
                METRIC
              </th>
              {columns.baseline ? <NumericHead>BASELINE</NumericHead> : null}
              {columns.canary ? <NumericHead>CANARY</NumericHead> : null}
              {columns.threshold ? <NumericHead>THRESHOLD</NumericHead> : null}
              <NumericHead>RESULT</NumericHead>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-rule-soft">
                <td className="w-full max-w-0 px-3.5 py-[9px]">
                  <span className="block font-cond text-label font-semibold tracking-[0.02em]">
                    {row.name}
                  </span>
                  {row.query ? (
                    <span className="block truncate font-mono text-meta text-neutral-600">
                      {row.query}
                    </span>
                  ) : null}
                </td>
                {columns.baseline ? (
                  <NumericCell value={row.baseline} />
                ) : null}
                {columns.canary ? (
                  <NumericCell
                    value={row.canary}
                    className={cn(
                      row.tone === "failed" &&
                        "font-bold text-status-failed-text",
                    )}
                  />
                ) : null}
                {columns.threshold ? (
                  <NumericCell
                    value={row.threshold}
                    className="text-muted-foreground"
                  />
                ) : null}
                <td className="px-3.5 py-[9px] text-right whitespace-nowrap">
                  <StatusPill tone={row.tone} label={row.result} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {explained.length > 0 ? (
        <div className="border-t border-rule-soft bg-status-degraded-fill px-3.5 py-[11px]">
          <div className="flex gap-[9px]">
            <span
              aria-hidden="true"
              className="font-bold text-status-degraded-text"
            >
              !
            </span>
            <ul className="space-y-1 text-chip leading-[1.55] text-neutral-800">
              {explained.slice(0, 3).map((row) => (
                <li key={row.key}>
                  <strong className="font-semibold">{row.name}</strong>{" "}
                  {row.message}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </Blueprint>
  )
}

function NumericHead({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="h-7 px-3.5 text-right font-mono text-kicker font-normal tracking-[0.14em] whitespace-nowrap text-muted-foreground"
    >
      {children}
    </th>
  )
}

function NumericCell({
  value,
  className,
}: {
  value?: string
  className?: string
}) {
  return (
    <td
      className={cn(
        "px-3.5 py-[9px] text-right font-mono text-chip tabular-nums whitespace-nowrap",
        className,
      )}
    >
      {value ?? <Absent />}
    </td>
  )
}
