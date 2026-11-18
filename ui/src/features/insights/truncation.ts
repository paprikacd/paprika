import type { QueryResult } from "./schema";

/**
 * How a query result is incomplete. "limit" is a bounded page that shows the
 * first N units by design; "partial" and "warning" mean the source itself
 * was incomplete or warned. "unknown" is truncated with no reason, from an
 * older backend or a custom fetcher, and keeps the general notice.
 */
export type TruncationKind = "none" | "limit" | "partial" | "warning" | "unknown";

export type TruncationUnit = "series" | "traces" | "points" | "rows";

const TRUNCATION_REASONS = ["row_limit", "partial", "provider_warning"] as const
const TRUNCATION_UNITS = ["series", "traces", "points", "rows"] as const

/**
 * Keep a wire truncation object only when its reason and unit are known, so a
 * malformed or future value degrades to "unknown" rather than a wrong notice.
 */
export function parseTruncation(value: unknown): QueryResult["truncation"] | undefined {
  if (!value || typeof value !== "object") return undefined
  const { reason, limit, unit } = value as Record<string, unknown>
  if (!TRUNCATION_REASONS.includes(reason as (typeof TRUNCATION_REASONS)[number])) return undefined
  return {
    reason: reason as string,
    ...(typeof limit === "number" && Number.isFinite(limit) ? { limit } : {}),
    ...(TRUNCATION_UNITS.includes(unit as TruncationUnit) ? { unit: unit as string } : {}),
  }
}

export type TruncationSource = Pick<QueryResult, "truncated" | "truncation" | "records"> | null | undefined;

export function truncationOf(result: TruncationSource): TruncationKind {
  if (!result || !(result.truncated || result.records?.truncated)) return "none";
  switch (result.truncation?.reason) {
    case "row_limit":
      return "limit";
    case "partial":
      return "partial";
    case "provider_warning":
      return "warning";
    default:
      return "unknown";
  }
}

/** The neutral fact for a row-capped result, such as "Showing the first 100 traces". */
export function limitFact(result: TruncationSource): string {
  const unit = result?.truncation?.unit as TruncationUnit | undefined;
  const limit = result?.truncation?.limit;
  const noun = unit ?? "rows";
  if (!limit) return "Source row limit reached · narrow the query to see others";
  if (noun === "series") return `First ${limit.toLocaleString("en-US")} series shown`;
  // A points cap applies to each series, so it must not read as a total.
  if (noun === "points") return `Up to ${limit.toLocaleString("en-US")} points per series shown`;
  return `Showing the first ${limit.toLocaleString("en-US")} ${noun} · narrow the query to see others`;
}

/**
 * A plugin's own footer note for a truncated result. A row cap is the neutral
 * source row limit; a partial or warned source says so; a reason-free result
 * says only that it may be incomplete. Returns undefined for a complete result.
 */
export function truncationNote(result: TruncationSource): string | undefined {
  const kind = truncationOf(result);
  if (kind === "none") return undefined;
  if (kind === "limit") return "Source row limit reached · narrow the query to see others";
  // A reason-free truncation is not known to be a source fault, so it does not claim one.
  if (kind === "unknown") return "Provider response may be incomplete";
  return "Partial source response";
}

/** Amber copy for a source that was partial, warned or unknown. */
export function sourceNotice(kind: TruncationKind): string {
  switch (kind) {
    case "partial":
      return "The data source returned a partial response. Narrow the query or check the data source.";
    case "warning":
      return "The data source returned warnings for this query. Narrow the query or check the data source.";
    default:
      return "Provider response may be incomplete. Narrow the query or check the data source.";
  }
}
