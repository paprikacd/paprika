import type { DataKind, QueryResult } from "./schema"

const count = (number: number, singular: string, plural = `${singular}s`) => `${number.toLocaleString()} ${number === 1 ? singular : plural}`

/** Counts only observations in the returned, bounded page, not provider totals. */
export function summarizeExplorerResult(kind: DataKind, result: QueryResult) {
  let detail: string
  if (kind === "metrics") {
    const series = result.series ?? []
    let samples = 0, missing = 0
    for (const entry of series) for (const point of entry.points) {
      samples++
      if (point.value === null || !Number.isFinite(point.value)) missing++
    }
    detail = `${count(series.length, "series", "series")} · ${count(samples, "sample")}${missing ? ` · ${count(missing, "missing sample")}` : ""}`
  } else if (kind === "records") {
    const frame = result.records
    let missing = 0
    for (const row of frame?.rows ?? []) for (const cell of row) if (cell === null) missing++
    detail = `${count(frame?.rows.length ?? 0, "row")} · ${count(frame?.columns.length ?? 0, "column")}${missing ? ` · ${count(missing, "missing cell")}` : ""}`
  } else {
    detail = count(result.traces?.length ?? 0, "trace")
  }
  return { detail, partial: !!result.truncated || !!result.records?.truncated }
}
