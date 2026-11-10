import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryScheduler, createResolvedQueryFetcher } from "./query";
import { sanitizeDiagnosticQuery } from "./query-diagnostics";
import type { QueryDiagnostics, QueryRequest, QueryResult } from "./schema";

const request: QueryRequest = { providerId: "prometheus", kind: "metrics", query: "queue_duration_seconds", start: 1000, end: 2000, step: 15 };
const result: QueryResult = { series: [{ name: "api", labels: {}, points: [{ timestamp: 1000, value: 0 }, { timestamp: 2000, value: null }] }] };
const signal = () => new AbortController().signal;
const backend: QueryDiagnostics = {
  version: 1,
  executionId: "server-query-7",
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

function deferred() {
  let resolve!: (data: QueryResult) => void;
  const promise = new Promise<QueryResult>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("scheduler execution receipts", () => {
  it("measures exclusive queue and browser-request intervals on a monotonic clock without adding nested backend time", async () => {
    let monotonic = 0;
    vi.spyOn(performance, "now").mockImplementation(() => monotonic);
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const first = deferred(), q7 = deferred();
    const fetcher = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => q7.promise);
    const scheduler = createQueryScheduler(fetcher, { concurrency: 1 });
    const blocker = scheduler({ ...request, query: "other" }, signal());
    const queued = scheduler(request, signal());
    await Promise.resolve();
    expect(scheduler.diagnostics!.getSnapshot().map(item => item.state)).toEqual(["running", "queued"]);
    monotonic = 700;
    first.resolve(result);
    await blocker;
    // Release the scheduler's slot and let the next provider request start.
    await Promise.resolve();
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
    wallClock.mockReturnValue(1_700_000_000_000); // UTC adjustment must not alter elapsed durations.
    monotonic = 1600;
    q7.resolve({ ...result, diagnostics: backend });
    await queued;
    const receipt = scheduler.diagnostics!.getSnapshot()[1];
    expect(receipt).toMatchObject({ state: "complete", clock: "browser-monotonic", owner: "browser-scheduler", queueMs: 700, requestMs: 900, totalMs: 1600, observedAt: 1_800_000_000_000 });
    expect(receipt.queueMs! + receipt.requestMs!).toBe(receipt.totalMs);
    expect(receipt.backend?.totalMs).toBe(900);
    expect(receipt.backend?.phases.find(phase => phase.name === "provider")?.durationMs).toBeNull();
    expect(receipt.counts).toEqual({ series: 1, points: 2, traces: 0, spans: 0, rows: 0 });
  });

  it("attributes shared subscribers and cache deliveries to one execution without recharging elapsed time", async () => {
    const pending = deferred();
    const fetcher = vi.fn(() => pending.promise);
    const scheduler = createQueryScheduler(fetcher);
    const first = scheduler(request, signal());
    const second = scheduler(request, signal());
    await Promise.resolve();
    pending.resolve({ ...result, diagnostics: backend });
    const [firstData, secondData] = await Promise.all([first, second]);
    const cachedData = await scheduler(request, signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(firstData).toBe(secondData);
    expect(firstData).toBe(cachedData);
    const [execution, cached] = scheduler.diagnostics!.getSnapshot();
    expect(execution).toMatchObject({ reuse: "none", consumers: 2, sharedConsumers: 1, cancelledConsumers: 0 });
    expect(cached).toMatchObject({ executionId: execution.id, reuse: "cache", requestMs: 0, queueMs: 0, totalMs: 0, backend });
    expect(cached.id).not.toBe(execution.id);
    expect(cached.startedAtMs).toBeUndefined();
  });

  it("records one consumer's cancellation without cancelling the shared execution", async () => {
    const pending = deferred();
    const fetcher = vi.fn(() => pending.promise);
    const scheduler = createQueryScheduler(fetcher);
    const cancelled = new AbortController();
    const first = scheduler(request, cancelled.signal);
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const second = scheduler(request, signal());
    await Promise.resolve();
    cancelled.abort();
    await rejected;
    expect(scheduler.diagnostics!.getSnapshot()[0]).toMatchObject({ state: "running", consumers: 2, sharedConsumers: 1, cancelledConsumers: 1 });
    pending.resolve(result);
    await expect(second).resolves.toBe(result);
    expect(scheduler.diagnostics!.getSnapshot()[0]).toMatchObject({ state: "complete", cancelledConsumers: 1 });
  });

  it("retains cancelled queue wait and never resurrects a cancelled result when a provider ignores abort", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const pending = deferred();
    const fetcher = vi.fn(() => pending.promise);
    const scheduler = createQueryScheduler(fetcher, { concurrency: 1 });
    const active = new AbortController(), waiting = new AbortController();
    const first = scheduler(request, active.signal);
    const second = scheduler({ ...request, query: "queued" }, waiting.signal);
    const rejectedFirst = expect(first).rejects.toMatchObject({ name: "AbortError" });
    const rejectedSecond = expect(second).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    now = 300;
    waiting.abort();
    now = 400;
    active.abort();
    await Promise.all([rejectedFirst, rejectedSecond]);
    expect(scheduler.diagnostics!.getSnapshot()[1]).toMatchObject({ state: "cancelled", queueMs: 300, requestMs: 0, totalMs: 300, cancelledConsumers: 1 });
    expect(scheduler.diagnostics!.getSnapshot()[1].startedAtMs).toBeUndefined();
    pending.resolve(result);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(scheduler.diagnostics!.getSnapshot()[0]).toMatchObject({ state: "cancelled", totalMs: 400 });
    expect(scheduler.diagnostics!.getSnapshot()[0].counts).toBeUndefined();
  });

  it("records an already cancelled request without starting transport", async () => {
    const fetcher = vi.fn();
    const scheduler = createQueryScheduler(fetcher);
    const controller = new AbortController();
    controller.abort();
    await expect(scheduler(request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(scheduler.diagnostics!.getSnapshot()[0]).toMatchObject({ state: "cancelled", totalMs: 0, requestMs: 0, cancelledConsumers: 1 });
  });

  it("distinguishes timeout, admission capacity and errors without retaining upstream messages", async () => {
    const secret = "https://user:password@private-provider.example/?token=secret";
    const fetcher = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error(secret), { code: "timeout", diagnostics: { ...backend, outcome: "timeout", counts: undefined } }))
      .mockRejectedValueOnce(Object.assign(new Error(secret), { status: 429 }))
      .mockRejectedValueOnce(new Error(secret));
    const scheduler = createQueryScheduler(fetcher);
    for (let index = 0; index < 3; index++) await expect(scheduler(request, signal())).rejects.toThrow(secret);
    const receipts = scheduler.diagnostics!.getSnapshot();
    expect(receipts.map(receipt => receipt.state)).toEqual(["timeout", "capacity", "error"]);
    expect(receipts[0].backend?.outcome).toBe("timeout");
    expect(receipts.every(receipt => receipt.counts === undefined)).toBe(true);
    expect(JSON.stringify(receipts)).not.toContain(secret);
    expect(JSON.stringify(receipts)).not.toContain("private-provider");
  });

  it("settles even an undefined rejection as an error, without diagnostic parsing breaking the scheduler", async () => {
    const scheduler = createQueryScheduler(vi.fn().mockRejectedValue(undefined));
    await expect(scheduler(request, signal())).rejects.toBeUndefined();
    expect(scheduler.diagnostics!.getSnapshot()[0]).toMatchObject({ state: "error", error: "The query failed. Check the query and provider connection." });
  });

  it("keeps observed empty, partial and unavailable backend timing distinct", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce({ series: [] }).mockResolvedValueOnce({ records: { columns: [], rows: [], truncated: true }, diagnostics: { ...backend, outcome: "partial", truncated: true } });
    const scheduler = createQueryScheduler(fetcher, { cacheSize: 0 });
    await scheduler(request, signal());
    await scheduler(request, signal());
    const [empty, partial] = scheduler.diagnostics!.getSnapshot();
    expect(empty).toMatchObject({ state: "complete", truncated: false, counts: { series: 0, points: 0, traces: 0, spans: 0, rows: 0 } });
    expect(empty.backend).toBeUndefined();
    expect(partial).toMatchObject({ state: "partial", truncated: true, counts: { rows: 0 } });
    expect(partial.backend?.phases.find(phase => phase.name === "provider")?.durationMs).toBeNull();
  });

  it("bounds the history and does not reinsert an evicted in-flight receipt", async () => {
    const pending = deferred();
    const fetcher = vi.fn().mockImplementationOnce(() => pending.promise).mockResolvedValue(result);
    const scheduler = createQueryScheduler(fetcher, { diagnosticsLimit: 3 });
    const first = scheduler(request, signal());
    for (let index = 0; index < 5; index++) await scheduler({ ...request, query: `series_${index}` }, signal());
    const before = scheduler.diagnostics!.getSnapshot();
    expect(before).toHaveLength(3);
    expect(before.map(receipt => receipt.id)).toEqual(["query-4", "query-5", "query-6"]);
    pending.resolve(result);
    await first;
    expect(scheduler.diagnostics!.getSnapshot()).toBe(before);
    const single = createQueryScheduler(vi.fn().mockResolvedValue(result), { diagnosticsLimit: 1 });
    await single(request, signal());
    await single(request, signal());
    expect(single.diagnostics!.getSnapshot()).toHaveLength(1);
  });

  it("offers stable passive snapshots and shares them through the resolved-query wrapper", async () => {
    const fetcher = vi.fn().mockResolvedValue(result);
    const scheduler = createQueryScheduler(fetcher);
    const resolved = createResolvedQueryFetcher(scheduler, value => ({ ...value, query: 'rate(requests_total{service="private-service"}[5m])', queryRef: undefined }));
    expect(resolved.diagnostics).toBe(scheduler.diagnostics);
    const store = resolved.diagnostics!;
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    const empty = store.getSnapshot();
    expect(store.getSnapshot()).toBe(empty);
    expect(fetcher).not.toHaveBeenCalled();
    await resolved(request, signal());
    const complete = store.getSnapshot();
    expect(complete).not.toBe(empty);
    expect(store.getSnapshot()).toBe(complete);
    expect(Object.isFrozen(complete)).toBe(true);
    expect(Object.isFrozen(complete[0])).toBe(true);
    expect(Object.isFrozen(complete[0].counts)).toBe(true);
    expect(complete[0].query).toContain('service="[redacted]"');
    expect(complete[0].query).not.toContain("private-service");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalled();
    unsubscribe();
    const notifications = notify.mock.calls.length;
    await resolved(request, signal());
    expect(notify).toHaveBeenCalledTimes(notifications);
  });

  it("retains only sanitized query structure, public source identity and validated backend fields", async () => {
    const query = "select duration from requests where customer='secret-customer' and password=unquoted-secret /* private-comment */ -- another-secret\n and host=https://user:secret@private.example order by duration";
    const fetcher = vi.fn().mockResolvedValue({ ...result, diagnostics: { ...backend, token: "backend-secret", source: { ...backend.source, endpoint: "https://private.example" } } });
    const scheduler = createQueryScheduler(fetcher);
    await scheduler({ ...request, query, traceId: "private-trace-identity", queryRef: { id: "saved", bindings: [{ parameter: "token", source: "constant", value: "binding-secret" }] } }, signal());
    const serialized = JSON.stringify(scheduler.diagnostics!.getSnapshot());
    for (const secret of ["secret-customer", "unquoted-secret", "private-comment", "another-secret", "private.example", "binding-secret", "private-trace-identity", "backend-secret"]) expect(serialized).not.toContain(secret);
    expect(scheduler.diagnostics!.getSnapshot()[0].query).toContain("select duration from requests");
    expect(scheduler.diagnostics!.getSnapshot()[0].backend?.executionId).toBe("server-query-7");
  });
});

describe("diagnostic expression redaction", () => {
  it.each([
    ["select 'secret-value'", "secret-value"],
    ['up{token="secret-value"}', "secret-value"],
    ["select 'unterminated-secret", "unterminated-secret"],
    ["select $$dollar-secret$$", "dollar-secret"],
    ["select $tag$tagged-secret$tag$", "tagged-secret"],
    ["select $é$private-customer-secret$é$", "private-customer-secret"],
    ["select $日本語$unicode-secret$日本語$", "unicode-secret"],
    ["select $tag$unterminated-secret", "unterminated-secret"],
    ["select 'escaped\\'private-value'", "private-value"],
    ["select 'sql''private-value'", "private-value"],
    ["up # comment-secret", "comment-secret"],
    ["up /* unterminated-secret", "unterminated-secret"],
    ["up /* outside /* nested */ private-comment-secret */", "private-comment-secret"],
    ["up /* outside /* nested */ unterminated-comment-secret", "unterminated-comment-secret"],
    ["select 123456789", "123456789"],
    ["select Authorization: Bearer header-secret", "header-secret"],
  ])("redacts literal and credential values from %s", (query, secret) => {
    expect(sanitizeDiagnosticQuery(query)).not.toContain(secret);
  });

  it("bounds oversized and malformed query previews", () => {
    expect(sanitizeDiagnosticQuery("metric ".repeat(100_000)).length).toBeLessThanOrEqual(1000);
    expect(sanitizeDiagnosticQuery("'" + "private-secret".repeat(100_000))).toBe("'[redacted]'");
    expect(sanitizeDiagnosticQuery("/* only a comment */")).toBe("[expression omitted]");
  });
});
