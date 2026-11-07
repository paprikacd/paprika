"use client"

import { createContext, useContext, useEffect, useId, useMemo, useState, type ReactNode } from "react"
import type { QueryResult } from "./schema"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import styles from "./trace-waterfall.module.css"

type FetchTrace = (id: string, signal: AbortSignal) => Promise<QueryResult>
const TraceFetcherContext = createContext<FetchTrace | undefined>(undefined)
export function TraceFetcherProvider({ fetchTrace, children }: { fetchTrace: FetchTrace; children: ReactNode }) {
  return <TraceFetcherContext.Provider value={fetchTrace}>{children}</TraceFetcherContext.Provider>
}
export function useTraceFetcher() { return useContext(TraceFetcherContext) }

type Span = NonNullable<QueryResult["spans"]>[number]
const spanTime = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" })
function formatMilliseconds(value: number) {
  if (value === 0 || Math.abs(value) >= 1) return value.toFixed(2)
  if (Math.abs(value) >= 0.001) return value.toFixed(3)
  return value.toPrecision(2)
}
export function traceRows(spans: Span[]) {
  const sorted = [...spans].sort((a, b) => a.startTime - b.startTime || a.spanId.localeCompare(b.spanId))
  const ids = new Set(sorted.map(span => span.spanId))
  const children = new Map<string, Span[]>()
  for (const span of sorted) {
    const parent = span.parentSpanId && ids.has(span.parentSpanId) && span.parentSpanId !== span.spanId ? span.parentSpanId : ""
    children.set(parent, [...(children.get(parent) ?? []), span])
  }
  const rows: { span: Span; depth: number; guides: boolean[]; linked: boolean; last: boolean; orphan: boolean; unresolved: boolean }[] = [], seen = new Set<string>()
  function visit(span: Span, depth: number, guides: boolean[], last: boolean, linked: boolean) {
    if (seen.has(span.spanId)) return
    seen.add(span.spanId); rows.push({ span, depth: Math.min(depth, 6), guides: guides.slice(0, 6), linked, last, orphan: !!span.parentSpanId && !linked && !ids.has(span.parentSpanId), unresolved: !!span.parentSpanId && !linked && ids.has(span.parentSpanId) })
    const descendants = children.get(span.spanId) ?? []
    descendants.forEach((child, index) => visit(child, depth + 1, depth === 0 ? guides : [...guides, !last], index === descendants.length - 1, true))
  }
  const roots = children.get("") ?? []
  roots.forEach((span, index) => visit(span, 0, [], index === roots.length - 1, false))
  // Broken or cyclic parent relationships remain visible rather than vanishing.
  for (const span of sorted) visit(span, 0, [], true, false)
  const visibleParents = new Set(rows.filter(row => row.linked).map(row => row.span.parentSpanId))
  return rows.map(row => ({ ...row, hasChildren: visibleParents.has(row.span.spanId) }))
}

/** Filter recorded spans without losing the ancestry needed to interpret them.
 * Missing/cyclic parents remain represented by traceRows; traversal is bounded. */
export function filterTraceRows(rows: ReturnType<typeof traceRows>, text: string, errorsOnly: boolean) {
  const search = text.trim().toLocaleLowerCase()
  const byId = new Map(rows.map(row => [row.span.spanId, row.span]))
  const matched = rows.filter(({ span }) => {
    if (errorsOnly && span.status !== "error") return false
    if (!search) return true
    return [span.service, span.operation, span.spanId, span.status, ...(span.attributes ?? []).flatMap(attribute => [attribute.key, attribute.value])]
      .some(value => value.toLocaleLowerCase().includes(search))
  })
  const matches = new Set(matched.map(({ span }) => span.spanId)), visible = new Set(matches)
  for (const { span } of matched) {
    let parent = span.parentSpanId
    const visited = new Set([span.spanId])
    while (parent && !visited.has(parent)) {
      visited.add(parent)
      const ancestor = byId.get(parent)
      if (!ancestor) break
      visible.add(parent)
      parent = ancestor.parentSpanId
    }
  }
  const retained = rows.filter(row => visible.has(row.span.spanId))
  // Rebuild connectors for the visible tree so a filtered-out sibling never
  // leaves a branch apparently continuing to a row that is not displayed.
  return { rows: retained.length === rows.length ? rows : traceRows(retained.map(row => row.span)), matches }
}

export function TraceWaterfall({ traceId }: { traceId: string }) {
  const fetchTrace = useTraceFetcher()
  const scrollHintId = useId()
  const [state, setState] = useState<{ traceId: string; fetchTrace: FetchTrace; result?: QueryResult; error?: string }>()
  const [selection, setSelection] = useState<{ traceId: string; spanId: string }>()
  const [filter, setFilter] = useState<{ traceId: string; text: string; errorsOnly: boolean }>({ traceId, text: "", errorsOnly: false })
  useEffect(() => {
    if (!fetchTrace) return
    const controller = new AbortController()
    fetchTrace(traceId, controller.signal).then(result => { if (!controller.signal.aborted) setState({ traceId, fetchTrace, result }) }, error => { if (!controller.signal.aborted) setState({ traceId, fetchTrace, error: error instanceof Error ? error.message : "Could not load trace" }) })
    return () => controller.abort()
  }, [fetchTrace, traceId])
  const current = state?.traceId === traceId && state.fetchTrace === fetchTrace ? state : undefined
  const spans = useMemo(() => (current?.result?.spans ?? []).filter(span => Number.isFinite(new Date(span.startTime).getTime()) && Number.isFinite(span.durationMs) && span.durationMs >= 0 && Number.isFinite(span.startTime + span.durationMs)), [current?.result])
  const rows = useMemo(() => traceRows(spans), [spans])
  const activeFilter = filter.traceId === traceId ? filter : { traceId, text: "", errorsOnly: false }
  const filtered = useMemo(() => filterTraceRows(rows, activeFilter.text, activeFilter.errorsOnly), [rows, activeFilter.text, activeFilter.errorsOnly])
  if (!fetchTrace) return null
  if (current?.error) return <div role="alert" className={styles.state}>Trace detail unavailable: {current.error}</div>
  if (!current?.result) return <div role="status" className={styles.state}>Loading trace spans…</div>
  const invalidCount = (current.result.spans?.length ?? 0) - spans.length
  if (!spans.length) return <div className={styles.state}>{invalidCount ? `${invalidCount} ${invalidCount === 1 ? "span has" : "spans have"} invalid timing; no spans can be displayed.` : "No recorded spans for this trace."}</div>
  const from = Math.min(...spans.map(span => span.startTime)), to = Math.max(...spans.map(span => span.startTime + span.durationMs)), observedExtent = Math.max(to - from, 0), extent = Math.max(observedExtent, 0.001)
  return <section className={styles.panel} aria-label={`Trace ${traceId} waterfall`}>
    <header><strong>Trace waterfall</strong><span>{rows.length} spans · {formatMilliseconds(observedExtent)} ms observed</span></header>
    <div className={styles.tools}>
      <GammaInput size="sm" type="search" aria-label="Filter trace spans" placeholder="Filter spans…" maxLength={120} value={activeFilter.text} onChange={event => setFilter({ ...activeFilter, text: event.target.value })} />
      <GammaButton variant="quiet" size="sm" aria-pressed={activeFilter.errorsOnly} onClick={() => setFilter({ ...activeFilter, errorsOnly: !activeFilter.errorsOnly })}>Errors only</GammaButton>
    </div>
    {(activeFilter.text.trim() || activeFilter.errorsOnly) && <p className={styles.filterSummary} role="status">{filtered.matches.size} matching {filtered.matches.size === 1 ? "span" : "spans"} of {rows.length} returned{filtered.rows.length > filtered.matches.size ? " · parents shown for context" : ""}</p>}
    <p id={scrollHintId} className={styles.scrollHint}>Scroll horizontally to see the entire timeline.</p>
    <div className={styles.timelineScroll} role="region" aria-label="Trace timeline" aria-describedby={scrollHintId} tabIndex={0}><div className={styles.timeline}>
    <p className={styles.axisCaption}>Time from first recorded span</p>
    <div className={styles.axis} role="img" aria-label={`Trace duration axis from 0 milliseconds to ${observedExtent} milliseconds`}>
      <div className={styles.axisTrack} aria-hidden="true">{[0, .25, .5, .75, 1].map((fraction, index) => <span key={index} className={index > 0 && index < 4 ? styles.axisIntermediate : undefined} style={{ left: `${fraction * 100}%` }}>{formatMilliseconds(observedExtent * fraction)} ms</span>)}</div>
    </div>
    {!filtered.rows.length && <p role="status">No matching spans. Clear the filter to see the trace.</p>}
    <ol className={styles.rows}>{filtered.rows.map(({span, depth, guides, linked, last, orphan, unresolved, hasChildren}) => <li key={span.spanId} className={styles.row} data-span-id={span.spanId} data-parent-span-id={span.parentSpanId} data-parent-context={!filtered.matches.has(span.spanId) || undefined}>
      <div className={styles.name} style={{ paddingInlineStart: `${depth * 14 + 14}px` }}>
        {guides.map((active, index) => active && <span key={index} aria-hidden="true" data-trace-guide className={styles.treeGuide} style={{ left: `${index * 14 + 7}px` }} />)}
        {linked && <span aria-hidden="true" data-trace-branch data-last={last || undefined} className={styles.treeBranch} style={{ left: `${(depth - 1) * 14 + 7}px` }} />}
        {hasChildren && <span aria-hidden="true" data-trace-stem className={styles.treeStem} style={{ left: `${depth * 14 + 7}px` }} />}
        <span aria-hidden="true" className={styles.treeNode} style={{ left: `${depth * 14 + 5}px` }} />
        <strong>{span.service || "Unknown service"}</strong><span>{span.operation || "Unnamed span"}</span>{span.status === "error" && <span className={styles.errorLabel}>Error</span>}{orphan && <span>Parent not returned</span>}{unresolved && <span>Parent relationship cannot be resolved</span>}{!filtered.matches.has(span.spanId) && <span>Parent context</span>}
      </div>
      <div className={styles.track} role="img" tabIndex={0} aria-label={`${span.service} ${span.operation}, started ${formatMilliseconds(span.startTime - from)} milliseconds after the first span, duration ${formatMilliseconds(span.durationMs)} milliseconds, ${span.status}`} title={`${span.service} · ${span.operation}\nStarted ${new Date(span.startTime).toISOString()} (+${formatMilliseconds(span.startTime - from)} ms)\nDuration ${formatMilliseconds(span.durationMs)} ms · ${span.status}`}><span className={styles.bar} data-span-status={span.status} data-instant={span.durationMs === 0 || undefined} style={{ left: `${Math.max(0, (span.startTime-from)/extent*100)}%`, width: `${Math.max(0, span.durationMs/extent*100)}%` }} /></div>
      <span className={styles.duration}><strong>{formatMilliseconds(span.durationMs)} ms</strong><span>+{formatMilliseconds(span.startTime - from)} ms</span></span>
      <GammaButton variant="quiet" size="sm" className={styles.detailsToggle} aria-label={`Span details for ${span.service || "Unknown service"} ${span.operation || "Unnamed span"} (${span.spanId})`} aria-expanded={selection?.traceId === traceId && selection.spanId === span.spanId}
        onClick={() => setSelection(previous => previous?.traceId === traceId && previous.spanId === span.spanId ? undefined : { traceId, spanId: span.spanId })}>Details</GammaButton>
      {selection?.traceId === traceId && selection.spanId === span.spanId && <section className={styles.details} aria-label={`Details for ${span.service || "Unknown service"} ${span.operation || "Unnamed span"}`}>
        <dl><div><dt>Span ID</dt><dd>{span.spanId}</dd></div>{span.parentSpanId && <div><dt>Parent span ID</dt><dd>{span.parentSpanId}</dd></div>}<div><dt>Started</dt><dd><time dateTime={new Date(span.startTime).toISOString()} title={new Date(span.startTime).toISOString()}>{spanTime.format(new Date(span.startTime))}</time> · +{formatMilliseconds(span.startTime - from)} ms</dd></div><div><dt>Duration</dt><dd>{formatMilliseconds(span.durationMs)} ms</dd></div><div><dt>Status</dt><dd>{span.status}</dd></div></dl>
        <strong>Safe recorded attributes</strong>
        {!!span.attributes?.length ? <dl>{span.attributes.slice(0, 8).map(attribute => <div key={attribute.key}><dt>{attribute.key}</dt><dd>{attribute.value}</dd></div>)}</dl> : <p>No supported attributes were recorded.</p>}
        {!!span.attributesOmitted && <p>{span.attributesOmitted} other {span.attributesOmitted === 1 ? "attribute was" : "attributes were"} withheld by the safe-dimension policy.</p>}
      </section>}
    </li>)}</ol></div></div>
    {!!invalidCount && <p role="status">{invalidCount} {invalidCount === 1 ? "span omitted because its timing is invalid" : "spans omitted because their timing is invalid"}.</p>}
    {current.result.truncated && <p>Partial trace: showing the first returned spans.</p>}
  </section>
}
