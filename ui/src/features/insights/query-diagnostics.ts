import { parseQueryDiagnostics, type QueryDiagnostics, type QueryRequest, type QueryResult } from "./schema";

export type QueryExecutionState = "queued" | "running" | "complete" | "partial" | "error" | "timeout" | "cancelled" | "capacity";

export interface QueryResultCounts {
  series: number;
  points: number;
  traces: number;
  spans: number;
  rows: number;
}

/** One actual scheduler execution, or one explicitly attributed cache delivery.
 * Shared consumers belong to their original execution; they are not new spans.
 * Browser phases are exclusive. Backend phases are a separate, nested ledger.
 */
export interface QueryExecutionReceipt {
  readonly id: string;
  readonly executionId: string;
  readonly reuse: "none" | "cache";
  readonly state: QueryExecutionState;
  readonly source: { readonly providerId: string; readonly kind: QueryRequest["kind"] };
  /** Resolved expression structure only; literal values and comments are removed. */
  readonly query: string;
  readonly requested: { readonly start: number; readonly end: number; readonly step: number };
  /** UTC Unix milliseconds for display. Never used to compute a duration. */
  readonly observedAt: number;
  /** All *AtMs fields share the browser's monotonic clock, not UTC. */
  readonly queuedAtMs: number;
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
  readonly queueMs?: number;
  readonly requestMs?: number;
  readonly totalMs?: number;
  readonly clock: "browser-monotonic";
  readonly owner: "browser-scheduler";
  readonly consumers: number;
  readonly sharedConsumers: number;
  readonly cancelledConsumers: number;
  readonly counts?: QueryResultCounts;
  readonly truncated?: boolean;
  readonly backend?: QueryDiagnostics;
  /** A fixed local explanation, never an arbitrary upstream exception message. */
  readonly error?: string;
}

export interface QueryDiagnosticStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => readonly QueryExecutionReceipt[];
}

/** Keep request identifiers bounded and exclude endpoints or credential-like text. */
function safeSource(value: string): string {
  if (/\b[a-z][a-z\d+.-]*:\/\/|@|\b(?:bearer|basic)\s/i.test(value)) return "[redacted source]";
  return value.replace(/[^a-z\d_.:/-]/gi, "_").slice(0, 160);
}

/** This is an inspection-safe query shape, not executable SQL/PromQL/TraceQL.
 * Quoted and dollar-quoted literals, comments, URLs and credential assignments
 * are removed before the bounded preview is retained. queryRef binding values
 * and trace IDs are deliberately never copied into the receipt.
 */
export function sanitizeDiagnosticQuery(expression: string): string {
  let result = "";
  // Scanning is bounded independently from the final preview; an oversized
  // custom fetcher cannot make diagnostics retain or scan an unbounded query.
  const input = expression.slice(0, 64 * 1024);
  for (let cursor = 0; cursor < input.length && result.length < 1200;) {
    const tail = input.slice(cursor);
    if (tail.startsWith("--") || tail.startsWith("#")) {
      const end = input.indexOf("\n", cursor);
      cursor = end < 0 ? input.length : end + 1;
      result += " ";
      continue;
    }
    if (tail.startsWith("/*")) {
      // PostgreSQL permits nested comments. Skipping only to the first */
      // would expose the rest of an outer comment in the diagnostic preview.
      let depth = 1;
      cursor += 2;
      while (cursor < input.length && depth > 0) {
        if (input.startsWith("/*", cursor)) { depth++; cursor += 2; }
        else if (input.startsWith("*/", cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
      result += " ";
      continue;
    }
    // PostgreSQL accepts non-ASCII identifier characters in dollar tags.
    // Treat all non-ASCII characters conservatively as possible tag content.
    const dollarQuote = /^\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/.exec(tail)?.[0];
    if (dollarQuote) {
      const end = input.indexOf(dollarQuote, cursor + dollarQuote.length);
      cursor = end < 0 ? input.length : end + dollarQuote.length;
      result += "[redacted]";
      continue;
    }
    const quote = input[cursor];
    if (quote === "'" || quote === '"' || quote === "`") {
      cursor++;
      while (cursor < input.length) {
        if (input[cursor] === "\\") { cursor += 2; continue; }
        if (input[cursor] === quote) {
          if (input[cursor + 1] === quote) { cursor += 2; continue; }
          cursor++;
          break;
        }
        cursor++;
      }
      result += `${quote}[redacted]${quote}`;
      continue;
    }
    result += input[cursor++];
  }
  return result
    .replace(/\b[a-z][a-z\d+.-]*:\/\/[^\s,;)]+/gi, "[redacted URL]")
    .replace(/\b(?:bearer|basic)\s+[a-z\d._~+\/-]+=*/gi, "[redacted credential]")
    .replace(/\b(?:password|passwd|secret|token|credential|authorization|api[_-]?key|access[_-]?key)\s*(?:=|:)\s*[^\s,;}\])]+/gi, "[redacted credential]")
    .replace(/\b(?:sk|ghp|github_pat|eyJ)[_-]?[a-z\d_.-]{16,}/gi, "[redacted credential]")
    .replace(/\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, "?")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1000) || "[expression omitted]";
}

export function resultCounts(data: QueryResult): QueryResultCounts {
  return {
    series: data.series?.length ?? 0,
    points: data.series?.reduce((total, series) => total + series.points.length, 0) ?? 0,
    traces: data.traces?.length ?? 0,
    spans: data.spans?.length ?? 0,
    rows: data.records?.rows.length ?? 0,
  };
}

const safeErrors: Record<Exclude<QueryExecutionState, "queued" | "running" | "complete" | "partial">, string> = {
  error: "The query failed. Check the query and provider connection.",
  timeout: "The query exceeded its execution deadline.",
  cancelled: "The query was cancelled.",
  capacity: "The query could not start because capacity was unavailable.",
};

export function diagnosticFailure(error: unknown): Pick<QueryExecutionReceipt, "state" | "error" | "backend"> {
  const detail = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; status?: unknown; diagnostics?: unknown } : undefined;
  const backend = parseQueryDiagnostics(detail?.diagnostics);
  const state = backend?.outcome === "cancelled" || detail?.name === "AbortError" || detail?.code === "canceled" || detail?.code === "cancelled" ? "cancelled" :
    backend?.outcome === "timeout" || detail?.name === "TimeoutError" || detail?.code === "timeout" || detail?.status === 504 ? "timeout" :
      backend?.outcome === "capacity" || detail?.code === "rate_limited" || detail?.status === 429 ? "capacity" : "error";
  return { state, error: safeErrors[state], ...(backend ? { backend } : {}) };
}

export function diagnosticResult(data: QueryResult): Pick<QueryExecutionReceipt, "state" | "counts" | "truncated" | "backend"> {
  const backend = parseQueryDiagnostics(data.diagnostics);
  const truncated = Boolean(data.truncated || data.records?.truncated || backend?.truncated);
  return {
    state: truncated || backend?.outcome === "partial" ? "partial" : "complete",
    counts: resultCounts(data),
    truncated,
    ...(backend ? { backend } : {}),
  };
}

/** Mutations are private to the scheduler; UI consumers receive only the store. */
export function createQueryDiagnosticLedger(requestedLimit = 100) {
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(200, Math.floor(requestedLimit))) : 100;
  let sequence = 0;
  let snapshot: readonly QueryExecutionReceipt[] = Object.freeze([]);
  const listeners = new Set<() => void>();
  const publish = (receipts: QueryExecutionReceipt[]) => {
    snapshot = Object.freeze(receipts);
    for (const listener of listeners) listener();
  };
  const store: QueryDiagnosticStore = {
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
  };
  function immutable(receipt: QueryExecutionReceipt): QueryExecutionReceipt {
    if (receipt.counts) Object.freeze(receipt.counts);
    if (receipt.backend) {
      Object.freeze(receipt.backend.source);
      Object.freeze(receipt.backend.requested);
      Object.freeze(receipt.backend.effective);
      for (const phase of receipt.backend.phases) Object.freeze(phase);
      Object.freeze(receipt.backend.phases);
      if (receipt.backend.counts) Object.freeze(receipt.backend.counts);
      Object.freeze(receipt.backend);
    }
    return Object.freeze(receipt);
  }
  function add(request: QueryRequest, queuedAtMs: number, initial?: Partial<QueryExecutionReceipt>) {
    const id = `query-${++sequence}`;
    const receipt: QueryExecutionReceipt = immutable({
      id,
      executionId: id,
      reuse: "none",
      state: "queued",
      source: Object.freeze({ providerId: safeSource(request.providerId), kind: request.kind }),
      query: sanitizeDiagnosticQuery(request.query),
      requested: Object.freeze({ start: request.start, end: request.end, step: request.step }),
      observedAt: Date.now(),
      queuedAtMs,
      clock: "browser-monotonic",
      owner: "browser-scheduler",
      consumers: 1,
      sharedConsumers: 0,
      cancelledConsumers: 0,
      ...initial,
    });
    const retained = limit > 1 ? snapshot.slice(-(limit - 1)) : [];
    publish([...retained, receipt]);
    return receipt;
  }
  function update(id: string, change: Partial<QueryExecutionReceipt> | ((receipt: QueryExecutionReceipt) => Partial<QueryExecutionReceipt>)) {
    const index = snapshot.findIndex(receipt => receipt.id === id);
    // An evicted receipt is never resurrected by a late request completion.
    if (index < 0) return;
    const next = [...snapshot];
    next[index] = immutable({ ...next[index], ...(typeof change === "function" ? change(next[index]) : change) });
    publish(next);
  }
  return { store, add, update };
}
