import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryScheduler } from "./query";
import { createQueryDiagnosticLedger } from "./query-diagnostics";
import { QueryInspector } from "./query-inspector";
import type { QueryDiagnostics, QueryRequest, QueryResult } from "./schema";

const request: QueryRequest = {
  providerId: "prometheus",
  kind: "metrics",
  query: 'queue_duration_seconds{service="private-customer"}',
  start: 1000,
  end: 2000,
  step: 15,
};
const result: QueryResult = {
  series: [{ name: "api", labels: {}, points: [{ timestamp: 1000, value: 0 }, { timestamp: 2000, value: null }] }],
};
const backend: QueryDiagnostics = {
  version: 1,
  executionId: "service-q7",
  outcome: "success",
  source: { providerId: "prometheus", providerType: "prometheus", transport: "direct" },
  requested: { start: 1000, end: 2000, step: 15 },
  effective: { start: 1000, end: 2000, step: 15, rangeApplied: true, scope: "provider", dispatched: true },
  phases: [
    { name: "admission", owner: "insights", clock: "server-monotonic", durationMs: 0, relationship: "exclusive" },
    { name: "upstream", owner: "insights", clock: "server-monotonic", durationMs: 860, relationship: "exclusive" },
    { name: "normalization", owner: "insights", clock: "server-monotonic", durationMs: 40, relationship: "exclusive" },
    { name: "provider", owner: "provider", clock: "unavailable", durationMs: null, relationship: "nested", parent: "upstream" },
  ],
  totalMs: 900,
  counts: { series: 1, points: 2, traces: 0, spans: 0, rows: 0 },
  truncated: false,
};

const signal = () => new AbortController().signal;
function deferred() {
  let resolve!: (data: QueryResult) => void;
  const promise = new Promise<QueryResult>(done => { resolve = done; });
  return { promise, resolve };
}
function details() {
  return screen.getByRole("complementary", { name: "Selected query receipt" });
}
function ledgerValue(scope: HTMLElement, label: string, value: string) {
  const term = within(scope).getByText(label, { exact: true });
  expect(term.closest("div")?.querySelector("dd")).toHaveTextContent(value);
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("passive query inspector", () => {
  it("explains an empty history and closes without offering an implicit query action", () => {
    const fetcher = vi.fn();
    const scheduler = createQueryScheduler(fetcher);
    const close = vi.fn();
    render(<QueryInspector store={scheduler.diagnostics} onClose={close} />);
    expect(screen.getByRole("heading", { name: "No query receipts yet" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Opening this inspector does not fetch data");
    expect(screen.queryByRole("list", { name: "Recent query executions" })).not.toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close query inspector" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows the exact exclusive browser ledger, separate server measurements, unknown provider timing and selectable receipts without fetching", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const first = deferred(), second = deferred();
    const fetcher = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const scheduler = createQueryScheduler(fetcher, { concurrency: 1 });
    const blocker = scheduler({ ...request, query: "active_query" }, signal());
    const queued = scheduler(request, signal());
    await Promise.resolve();
    now = 700;
    first.resolve(result);
    await blocker;
    await Promise.resolve();
    await Promise.resolve();
    now = 1600;
    second.resolve({ ...result, diagnostics: backend });
    await queued;
    const view = render(<QueryInspector store={scheduler.diagnostics} onClose={() => {}} />);
    expect(within(details()).getByRole("heading", { name: "q2 receipt" })).toBeInTheDocument();
    const browserLedger = screen.getByRole("region", { name: "Browser timing ledger" });
    ledgerValue(browserLedger, "Queue wait", "700 ms");
    ledgerValue(browserLedger, "Request, transfer & parsing", "900 ms");
    ledgerValue(browserLedger, "Browser elapsed", "1,600 ms");
    expect(browserLedger).toHaveTextContent("monotonic clock · exclusive intervals");
    const serverLedger = screen.getByRole("region", { name: "Server timing ledger" });
    ledgerValue(serverLedger, "Upstream round trip", "860 ms");
    ledgerValue(serverLedger, "Normalization", "40 ms");
    ledgerValue(serverLedger, "Provider execution", "Unknown");
    ledgerValue(serverLedger, "Service elapsed", "900 ms");
    expect(serverLedger).toHaveTextContent("Nested within the browser request; do not add these to browser elapsed");
    expect(serverLedger).toHaveTextContent("clock unavailable · nested");
    expect(browserLedger).not.toHaveTextContent("2,500 ms");
    const counts = screen.getByRole("region", { name: "Returned result counts" });
    ledgerValue(counts, "series", "1");
    ledgerValue(counts, "samples", "2");
    expect(counts).toHaveTextContent("not input cardinality, scanned storage or billing cost");
    const query = screen.getByRole("region", { name: "Resolved query details" });
    expect(query).toHaveTextContent('queue_duration_seconds{service="[redacted]"}');
    expect(query).not.toHaveTextContent("private-customer");
    fireEvent.click(within(query).getByText("Requested and effective bounds"));
    ledgerValue(query, "Requested step", "15 s");
    ledgerValue(query, "Effective step", "15 s");

    const q1 = screen.getByRole("button", { name: "Inspect q1, prometheus, Complete, 700 ms" });
    fireEvent.mouseOver(q1);
    fireEvent.focus(q1);
    fireEvent.click(q1);
    expect(q1).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Inspect q2, prometheus, Complete, 1,600 ms" })).toHaveAttribute("aria-pressed", "false");
    expect(within(details()).getByRole("heading", { name: "q1 receipt" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Server timing ledger" })).toHaveTextContent("This response has no server receipt");
    view.rerender(<QueryInspector store={scheduler.diagnostics} onClose={() => {}} synthetic />);
    expect(screen.getByText(/Synthetic example data/)).toBeInTheDocument();
    expect(within(details()).getByRole("heading", { name: "q1 receipt" })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("attributes shared consumers and cached data to the original execution without charging a second request", async () => {
    const pending = deferred();
    const fetcher = vi.fn(() => pending.promise);
    const scheduler = createQueryScheduler(fetcher);
    const first = scheduler(request, signal());
    const shared = scheduler(request, signal());
    await Promise.resolve();
    pending.resolve({ ...result, diagnostics: backend });
    await Promise.all([first, shared]);
    await scheduler(request, signal());
    render(<QueryInspector store={scheduler.diagnostics} onClose={() => {}} />);
    const summary = screen.getByLabelText("Query execution summary");
    expect(summary).toHaveTextContent("1 scheduled requests");
    expect(summary).toHaveTextContent("1 cache deliveries");
    expect(summary).toHaveTextContent("1 shared consumers");
    fireEvent.click(screen.getByRole("button", { name: "Inspect q2, prometheus, cached, 0 ms" }));
    expect(details()).toHaveTextContent("Reused execution query-1. This delivery made no upstream request.");
    expect(details()).toHaveTextContent("Server timings below belong to the original execution");
    ledgerValue(screen.getByRole("region", { name: "Browser timing ledger" }), "Request, transfer & parsing", "0 ms");
    ledgerValue(screen.getByRole("region", { name: "Browser timing ledger" }), "Browser elapsed", "0 ms");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("shows queued work as not run, then reflects its cancellation without inventing completed counts", () => {
    const ledger = createQueryDiagnosticLedger();
    const queued = ledger.add(request, 100);
    render(<QueryInspector store={ledger.store} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "Inspect q1, prometheus, Queued, in progress" })).toBeInTheDocument();
    const browserLedger = screen.getByRole("region", { name: "Browser timing ledger" });
    ledgerValue(browserLedger, "Queue wait", "Unknown");
    ledgerValue(browserLedger, "Request, transfer & parsing", "Not run");
    expect(screen.getByRole("region", { name: "Returned result counts" })).toHaveTextContent("No completed result counts are available");
    act(() => ledger.update(queued.id, { state: "cancelled", cancelledConsumers: 1, finishedAtMs: 400, queueMs: 300, requestMs: 0, totalMs: 300, error: "The query was cancelled." }));
    expect(screen.getByRole("button", { name: "Inspect q1, prometheus, Cancelled, 300 ms" })).toHaveAttribute("aria-pressed", "true");
    ledgerValue(browserLedger, "Queue wait", "300 ms");
    ledgerValue(browserLedger, "Request, transfer & parsing", "Not run");
    ledgerValue(browserLedger, "Browser elapsed", "300 ms");
    expect(details()).toHaveTextContent("The query was cancelled.");
    expect(screen.getByRole("region", { name: "Returned result counts" })).not.toHaveTextContent("0 series");
  });

  it("keeps an observed empty result distinct from a partial result", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ series: [] }).mockResolvedValueOnce({ series: [], truncated: true });
    const scheduler = createQueryScheduler(fetcher, { cacheSize: 0 });
    await scheduler(request, signal());
    await scheduler(request, signal());
    render(<QueryInspector store={scheduler.diagnostics} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Inspect q2, prometheus, Partial,/ }));
    const partial = screen.getByRole("region", { name: "Returned result counts" });
    ledgerValue(partial, "series", "0");
    expect(partial).toHaveTextContent("This response is partial or truncated");
    fireEvent.click(screen.getByRole("button", { name: /Inspect q1, prometheus, Complete,/ }));
    const empty = screen.getByRole("region", { name: "Returned result counts" });
    ledgerValue(empty, "series", "0");
    ledgerValue(empty, "samples", "0");
    expect(empty).not.toHaveTextContent("partial or truncated");
    expect(screen.queryByText("No query receipts yet")).not.toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: "provider_error", label: "Error", message: "The query failed. Check the query and provider connection." },
    { code: "timeout", label: "Timed out", message: "The query exceeded its execution deadline." },
    { code: "rate_limited", label: "At capacity", message: "The query could not start because capacity was unavailable." },
  ])("renders $label as a distinct sanitized outcome with unavailable result counts", async ({ code, label, message }) => {
    const secret = "https://user:private-token@private-provider.invalid";
    const fetcher = vi.fn().mockRejectedValue(Object.assign(new Error(secret), { code }));
    const scheduler = createQueryScheduler(fetcher);
    await expect(scheduler(request, signal())).rejects.toThrow(secret);
    render(<QueryInspector store={scheduler.diagnostics} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: new RegExp(`Inspect q1, prometheus, ${label},`) })).toBeInTheDocument();
    expect(details()).toHaveTextContent(message);
    expect(details()).not.toHaveTextContent("private-token");
    expect(screen.getByRole("region", { name: "Returned result counts" })).toHaveTextContent("No completed result counts are available");
    expect(screen.getByLabelText("Query execution summary")).toHaveTextContent("1 errors / timeouts / capacity");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("shows a pre-dispatch refusal without claiming effective provider bounds or a trace-specific limitation", async () => {
    const refused: QueryDiagnostics = {
      ...backend,
      outcome: "error",
      counts: undefined,
      effective: { dispatched: false, rangeApplied: false, scope: "provider" },
      totalMs: 20,
      phases: [
        { name: "admission", owner: "insights", clock: "server-monotonic", durationMs: 20, relationship: "exclusive" },
        { name: "upstream", owner: "insights", clock: "server-monotonic", durationMs: 0, relationship: "exclusive" },
        { name: "normalization", owner: "insights", clock: "server-monotonic", durationMs: 0, relationship: "exclusive" },
        { name: "provider", owner: "provider", clock: "unavailable", durationMs: null, relationship: "nested", parent: "upstream" },
      ],
    };
    const scheduler = createQueryScheduler(vi.fn().mockRejectedValue(Object.assign(new Error("Forbidden"), { code: "forbidden", diagnostics: refused })));
    await expect(scheduler(request, signal())).rejects.toThrow("Forbidden");
    render(<QueryInspector store={scheduler.diagnostics} onClose={() => {}} />);
    const query = screen.getByRole("region", { name: "Resolved query details" });
    fireEvent.click(within(query).getByText("Requested and effective bounds"));
    ledgerValue(query, "Requested step", "15 s");
    ledgerValue(query, "Upstream dispatch", "Not sent");
    ledgerValue(query, "Range applied", "No · request did not reach dispatch");
    expect(within(query).queryByText("Effective from", { exact: true })).not.toBeInTheDocument();
    expect(within(query).queryByText("Boundary owner", { exact: true })).not.toBeInTheDocument();
    expect(query).not.toHaveTextContent("trace detail is not range-filtered");
    expect(screen.getByRole("region", { name: "Returned result counts" })).toHaveTextContent("No completed result counts are available");
  });

  it("reveals additional retained receipts in bounded batches without losing the selected execution", () => {
    const ledger = createQueryDiagnosticLedger(30);
    for (let index = 0; index < 35; index++) {
      ledger.add({ ...request, query: `series_${index}` }, index * 100, {
        state: "complete",
        startedAtMs: index * 100,
        finishedAtMs: index * 100 + index + 1,
        queueMs: 0,
        requestMs: index + 1,
        totalMs: index + 1,
        counts: { series: 0, points: 0, rows: 0, traces: 0, spans: 0 },
      });
    }
    render(<QueryInspector store={ledger.store} onClose={() => {}} />);
    const list = screen.getByRole("list", { name: "Recent query executions" });
    expect(within(list).getAllByRole("button")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Inspect q30, prometheus, Complete, 30 ms" }));
    expect(within(details()).getByRole("heading", { name: "q30 receipt" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more requests" }));
    expect(within(list).getAllByRole("button")).toHaveLength(24);
    expect(within(details()).getByRole("heading", { name: "q30 receipt" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more requests" }));
    expect(within(list).getAllByRole("button")).toHaveLength(30);
    expect(screen.queryByRole("button", { name: "Show more requests" })).not.toBeInTheDocument();
    expect(screen.getByText("Slowest first · latest 30 of 30")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Inspect q1,/ })).not.toBeInTheDocument();
  });
});
