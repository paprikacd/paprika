"use client";

import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, Clock3, Database, Layers2, X } from "lucide-react";
import { GammaButton } from "./gamma/button";
import { lockBodyScroll } from "./gamma/scroll-lock";
import type { QueryDiagnosticStore, QueryExecutionReceipt, QueryExecutionState } from "./query-diagnostics";
import type { QueryDiagnostics } from "./schema";
import styles from "./query-inspector.module.css";

const EMPTY_RECEIPTS: readonly QueryExecutionReceipt[] = [];
const emptySnapshot = () => EMPTY_RECEIPTS;
const emptySubscribe = () => () => {};
const stateLabels: Record<QueryExecutionState, string> = {
  queued: "Queued", running: "Running", complete: "Complete", partial: "Partial",
  error: "Error", timeout: "Timed out", cancelled: "Cancelled", capacity: "At capacity",
};
const phaseLabels = { admission: "Service admission", upstream: "Upstream round trip", normalization: "Normalization", provider: "Provider execution" };

export function queryDuration(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return "Unknown";
  if (value === 0) return "0 ms";
  if (value < 0.1) return "<0.1 ms";
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })} ms`;
}

function utc(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "Unknown";
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString().replace("T", " ").replace("Z", " UTC") : "Unknown";
}

function shortId(receipt: QueryExecutionReceipt): string {
  return receipt.id.replace(/^query-/, "q");
}

function State({ receipt }: { receipt: QueryExecutionReceipt }) {
  return <span className={styles.state} data-state={receipt.state}>
    {receipt.reuse === "cache" ? <Database size={12} aria-hidden="true" /> : receipt.state === "complete" ? <Check size={12} aria-hidden="true" /> : null}
    {receipt.reuse === "cache" ? `Cached${receipt.state === "partial" ? " · partial" : ""}` : stateLabels[receipt.state]}
  </span>;
}

/** A passive view of the host scheduler. It never owns or replays a query. */
export function QueryInspector({ store, onClose, synthetic = false }: {
  store?: QueryDiagnosticStore;
  onClose: () => void;
  synthetic?: boolean;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const opener = document.activeElement;
    element.showModal();
    close.current?.focus({ preventScroll: true });
    const unlock = lockBodyScroll();
    return () => {
      const restore = element.contains(document.activeElement) || document.activeElement === document.body;
      element.close();
      unlock();
      if (restore && opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const receipts = useSyncExternalStore(store?.subscribe ?? emptySubscribe, store?.getSnapshot ?? emptySnapshot, emptySnapshot);
  const [selectedId, setSelectedId] = useState<string>();
  const [limit, setLimit] = useState(12);
  const rows = useMemo(() => receipts.slice(-limit).sort((a, b) =>
    (b.totalMs ?? 0) - (a.totalMs ?? 0) || b.queuedAtMs - a.queuedAtMs,
  ), [receipts, limit]);
  const selected = rows.find(receipt => receipt.id === selectedId) ?? rows[0];
  const origin = rows.length ? Math.min(...rows.map(receipt => receipt.queuedAtMs)) : 0;
  const last = rows.length ? Math.max(...rows.map(receipt => receipt.finishedAtMs ?? receipt.startedAtMs ?? receipt.queuedAtMs)) : 0;
  const extent = Math.max(1, last - origin);
  const executionCount = receipts.filter(receipt => receipt.reuse === "none").length;
  const cacheCount = receipts.length - executionCount;
  const sharedCount = receipts.reduce((total, receipt) => total + receipt.sharedConsumers, 0);
  const failures = receipts.filter(receipt => ["error", "timeout", "capacity"].includes(receipt.state)).length;

  return <dialog ref={dialog} id="insights-query-inspector" className={styles.inspector} aria-labelledby={`${id}-title`} data-testid="query-inspector"
    onKeyDown={event => event.stopPropagation()}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className={styles.header}>
      <div>
        <h2 id={`${id}-title`}><ActivityMark /> Query inspector</h2>
        <p>Recent workspace requests · {synthetic ? "Synthetic example data" : "Current session"}</p>
      </div>
      <GammaButton ref={close} size="sm" variant="quiet" onClick={onClose} aria-label="Close query inspector"><X size={15} /> Close</GammaButton>
    </header>
    <div className={styles.summary} aria-label="Query execution summary">
      <span><strong>{executionCount}</strong> scheduled requests</span>
      <span><Database size={13} aria-hidden="true" /><strong>{cacheCount}</strong> cache deliveries</span>
      <span><Layers2 size={13} aria-hidden="true" /><strong>{sharedCount}</strong> shared consumers</span>
      <span data-attention={failures > 0 || undefined}><strong>{failures}</strong> errors / timeouts / capacity</span>
    </div>
    {!rows.length ? <div className={styles.empty} role="status">
      <Clock3 size={24} aria-hidden="true" />
      <h3>No query receipts yet</h3>
      <p>Receipts appear when dashboard queries run. Opening this inspector does not fetch data. Use Refresh data to start a new query session.</p>
    </div> : <div className={styles.body}>
      <div className={styles.timeline}>
        <div className={styles.sectionHeading}>
          <h3>Scheduler timeline</h3><span>Slowest first · latest {rows.length} of {receipts.length}</span>
        </div>
        <p id={`${id}-timing-note`} className={styles.note}>One browser clock. Concurrent requests are not added into a dashboard duration.</p>
        <div className={styles.legend} aria-label="Browser timing legend">
          <span><i className={styles.queueKey} /> Scheduler queue</span>
          <span><i className={styles.requestKey} /> Request, transfer &amp; parsing</span>
          <span><i className={styles.cacheKey} /> Cache delivery</span>
        </div>
        <div className={styles.rowHead} aria-hidden="true">
          <span>Query / source</span><span>State</span>
          <div className={styles.ruler}>{[0, 0.25, 0.5, 0.75, 1].map(fraction => <span key={fraction} style={{ left: `${fraction * 100}%` }}>{queryDuration(extent * fraction)}</span>)}</div>
          <span>Elapsed</span>
        </div>
        <ol className={styles.rows} aria-label="Recent query executions" aria-describedby={`${id}-timing-note`}>
          {rows.map(receipt => {
            const offset = Math.max(0, receipt.queuedAtMs - origin) / extent * 100;
            const queueWidth = (receipt.queueMs ?? 0) / extent * 100;
            const requestWidth = (receipt.requestMs ?? 0) / extent * 100;
            return <li key={receipt.id}>
              <GammaButton variant="quiet" className={styles.receiptRow} aria-pressed={selected?.id === receipt.id}
                aria-label={`Inspect ${shortId(receipt)}, ${receipt.source.providerId}, ${receipt.reuse === "cache" ? "cached" : stateLabels[receipt.state]}, ${receipt.totalMs === undefined ? "in progress" : queryDuration(receipt.totalMs)}`}
                onClick={() => setSelectedId(receipt.id)}>
                <span className={styles.queryLabel}><strong>{shortId(receipt)}</strong><span>{receipt.source.providerId}</span></span>
                <State receipt={receipt} />
                <span className={styles.track} aria-hidden="true">
                  {[0, 25, 50, 75, 100].map(tick => <i key={tick} className={styles.gridLine} style={{ left: `${tick}%` }} />)}
                  {receipt.reuse === "cache" ? <i className={styles.cacheMarker} style={{ left: `${Math.min(99, offset)}%` }} /> : <>
                    <i className={styles.queueBar} style={{ left: `${offset}%`, width: `${queueWidth}%` }} />
                    <i className={styles.requestBar} style={{ left: `${offset + queueWidth}%`, width: `${requestWidth}%` }} />
                    {receipt.totalMs === undefined && <i className={styles.pendingMarker} style={{ left: `${Math.min(99, offset + queueWidth)}%` }} />}
                  </>}
                </span>
                <span className={styles.elapsed}>{receipt.totalMs === undefined ? stateLabels[receipt.state] : queryDuration(receipt.totalMs)}
                  {receipt.sharedConsumers > 0 && <small>{receipt.sharedConsumers} shared</small>}
                </span>
              </GammaButton>
            </li>;
          })}
        </ol>
        <div className={styles.timelineFooter}>
          <span>Bounded in-memory history. Refresh or a source change starts a new session.</span>
          {limit < receipts.length && <GammaButton size="sm" variant="secondary" onClick={() => setLimit(value => value + 12)}>Show more requests</GammaButton>}
        </div>
      </div>
      {selected && <ReceiptDetails receipt={selected} />}
    </div>}
  </dialog>;
}

function ActivityMark() {
  return <Clock3 size={17} aria-hidden="true" />;
}

function ReceiptDetails({ receipt }: { receipt: QueryExecutionReceipt }) {
  const backend = receipt.backend;
  const counts = receipt.counts ?? backend?.counts;
  return <aside className={styles.details} aria-label="Selected query receipt">
    <div className={styles.detailHeading}><h3>{shortId(receipt)} receipt</h3><State receipt={receipt} /></div>
    <p className={styles.observed}>Requested <time dateTime={new Date(receipt.observedAt).toISOString()}>{utc(receipt.observedAt / 1000)}</time></p>
    {receipt.error && <p className={styles.error}>{receipt.error}</p>}
    {receipt.reuse === "cache" && <p className={styles.callout}>Reused execution <strong>{receipt.executionId}</strong>. This delivery made no upstream request. Server timings below belong to the original execution.</p>}
    {receipt.sharedConsumers > 0 && <p className={styles.callout}>{receipt.consumers} consumers shared this execution; it is counted once. {receipt.cancelledConsumers > 0 ? `${receipt.cancelledConsumers} consumers cancelled.` : ""}</p>}
    <section aria-label="Browser timing ledger">
      <h4>Browser phases</h4>
      <p className={styles.note}>Browser scheduler · monotonic clock · exclusive intervals</p>
      <dl className={styles.ledger}>
        <div><dt><i className={styles.queueKey} />Queue wait</dt><dd>{queryDuration(receipt.queueMs)}</dd></div>
        <div><dt><i className={styles.requestKey} />Request, transfer &amp; parsing</dt><dd>{receipt.startedAtMs === undefined && receipt.reuse !== "cache" ? "Not run" : queryDuration(receipt.requestMs)}</dd></div>
        <div className={styles.total}><dt>Browser elapsed</dt><dd>{queryDuration(receipt.totalMs)}</dd></div>
      </dl>
      <p className={styles.note}>The request interval includes network time, response parsing and any capacity retries.</p>
    </section>
    <section aria-label="Server timing ledger">
      <h4>Server phases</h4>
      {backend ? <>
        <p className={styles.note}>Insights service · server monotonic clock. Nested within the browser request; do not add these to browser elapsed.</p>
        <dl className={styles.ledger}>
          {backend.phases.map((phase, index) => <div key={`${phase.name}-${index}`} data-relationship={phase.relationship}>
            <dt>{phaseLabels[phase.name]}<small>{phase.owner === "insights" ? "Insights" : "Provider"} · {phase.clock === "unavailable" ? "clock unavailable" : "server monotonic"} · {phase.relationship}</small></dt>
            <dd>{queryDuration(phase.durationMs)}</dd>
          </div>)}
          <div className={styles.total}><dt>Service elapsed</dt><dd>{queryDuration(backend.totalMs)}</dd></div>
        </dl>
        {!backend.phases.some(phase => phase.name === "provider") && <p className={styles.note}>Provider execution timing: Unknown.</p>}
      </> : <p className={styles.unknown}>Provider execution timing: <strong>Unknown</strong>. This response has no server receipt. Browser request time does not establish provider duration.</p>}
    </section>
    <section aria-label="Resolved query details">
      <h4>Resolved query</h4>
      <p className={styles.note}>Literal values, variables and comments are redacted from this inspection-only preview.</p>
      <pre className={styles.query}><code>{receipt.query}</code></pre>
      <dl className={styles.metadata}>
        <div><dt>Source</dt><dd>{receipt.source.providerId} · {receipt.source.kind}</dd></div>
        <div><dt>Execution</dt><dd>{receipt.executionId}</dd></div>
        {backend && <div><dt>Service receipt</dt><dd>{backend.executionId}</dd></div>}
      </dl>
      <Bounds receipt={receipt} backend={backend} />
    </section>
    <section aria-label="Returned result counts">
      <h4>Returned results</h4>
      {counts ? <>
        <dl className={styles.counts}>
          {(receipt.source.kind === "metrics" ? ["series", "points"] : receipt.source.kind === "traces" ? ["traces", "spans"] : ["rows"]).map(key =>
            <div key={key}><dt>{key === "points" ? "samples" : key}</dt><dd>{counts[key as keyof typeof counts].toLocaleString("en-US")}</dd></div>)}
        </dl>
        <p className={styles.note}>Returned counts describe this response, not input cardinality, scanned storage or billing cost.</p>
      </> : <p className={styles.note}>No completed result counts are available.</p>}
      {receipt.truncated && <p className={styles.partial}>This response is partial or truncated. A provider warning or result limit can reduce its coverage.</p>}
      {receipt.state === "partial" && !receipt.truncated && <p className={styles.partial}>The service returned a partial result.</p>}
    </section>
  </aside>;
}

function Bounds({ receipt, backend }: { receipt: QueryExecutionReceipt; backend?: QueryDiagnostics }) {
  return <details className={styles.bounds}>
    <summary>Requested and effective bounds</summary>
    <dl className={styles.metadata}>
      <div><dt>Requested from</dt><dd>{utc(receipt.requested.start)}</dd></div>
      <div><dt>Requested to</dt><dd>{utc(receipt.requested.end)}</dd></div>
      <div><dt>Requested step</dt><dd>{receipt.requested.step} s</dd></div>
      {backend ? <>
        <div><dt>Upstream dispatch</dt><dd>{backend.effective.dispatched ? "Dispatch attempted" : "Not sent"}</dd></div>
        <div><dt>Range applied</dt><dd>{!backend.effective.dispatched ? "No · request did not reach dispatch" : backend.effective.rangeApplied ? "Yes" : "No · trace detail is not range-filtered"}</dd></div>
        {backend.effective.rangeApplied && <>
          <div><dt>Effective from</dt><dd>{utc(backend.effective.start)}</dd></div>
          <div><dt>Effective to</dt><dd>{utc(backend.effective.end)}</dd></div>
          <div><dt>Effective step</dt><dd>{backend.effective.step === undefined ? "Unknown" : `${backend.effective.step} s`}</dd></div>
        </>}
        {backend.effective.dispatched && <div><dt>Boundary owner</dt><dd>{backend.effective.scope === "gateway" ? "Forwarded to gateway; provider bounds unverified" : "Provider request"}</dd></div>}
      </> : <div><dt>Effective bounds</dt><dd>Unknown · no service receipt</dd></div>}
    </dl>
  </details>;
}
