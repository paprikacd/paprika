import { useEffect, useId, useRef, useState } from "react"
import { ChartNoAxesCombined, ChevronDown, Plus, ScanSearch, Tags, X } from "lucide-react"
import type { InsightsClient, MetricSeriesMetadata, ProviderMetadata } from "./client"
import { GammaButton } from "./gamma/button"
import { lockBodyScroll } from "./gamma/scroll-lock"
import styles from "./metric-inspector.module.css"

interface InspectionProps {
  client?: InsightsClient
  providerId: string
  metric: string
  labels: string[]
  labelsLoading: boolean
  labelsUnavailable: boolean
  labelsTruncated: boolean
  canAddFilter: boolean
  onAddFilter: (label: string, value: string) => void
}

function LabelValues({ client, providerId, metric, name, known, canAddFilter, onAddFilter }: {
  client?: InsightsClient
  providerId: string
  metric: string
  name: string
  known?: MetricSeriesMetadata["labels"][number]
  canAddFilter: boolean
  onAddFilter: (label: string, value: string) => void
}) {
  const [result, setResult] = useState<ProviderMetadata>()
  const [error, setError] = useState(false)
  useEffect(() => {
    if (known || !client) return
    const controller = new AbortController()
    client.metadata(providerId, { kind: "values", label: name, metric }, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setResult(data) })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
  }, [client, providerId, metric, name, known])
  const values = known?.values ?? result?.values.slice(0, 12)
  return <div className={styles.values}>
    {!values && !error && <p role="status">Loading label values…</p>}
    {error && <p role="status">Values unavailable. You can still enter a filter manually.</p>}
    {values?.length === 0 && <p>No displayable values in this sample.</p>}
    {values?.map((value) => <GammaButton key={value} size="sm" variant="quiet"
      className={styles.value} disabled={!canAddFilter || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)}
      title={`Add filter ${name} = ${JSON.stringify(value)}`}
      aria-label={`Filter ${name} = ${JSON.stringify(value)}`}
      onClick={() => onAddFilter(name, value)}>
      <span>{value || '""'}</span><Plus size={12} aria-hidden="true" />
    </GammaButton>)}
    {(known?.valuesTruncated || result?.truncated || (result?.values.length ?? 0) > 12) && <p>Showing up to 12 short values. More values may be available in the filter picker.</p>}
    {!canAddFilter && <p>The builder supports up to 20 filters. Remove one to add another.</p>}
  </div>
}

function Inspection({ client, providerId, metric, labels, labelsLoading, labelsUnavailable, labelsTruncated, canAddFilter, onAddFilter }: InspectionProps) {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key: string; data?: MetricSeriesMetadata; error?: boolean }>()
  const [expanded, setExpanded] = useState<string[]>([])
  const key = `${providerId}\0${metric}\0${attempt}`
  useEffect(() => {
    if (!client) return
    const controller = new AbortController()
    client.metadata(providerId, { kind: "series", metric }, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data: data.series, error: !data.series })
      })
      .catch(() => { if (!controller.signal.aborted) setState({ key, error: true }) })
    return () => controller.abort()
  }, [client, providerId, metric, key])
  const current = state?.key === key ? state : undefined
  const stats = current?.data
  const names = [...new Set([...labels, ...(stats?.labels.map((label) => label.name) ?? [])])].filter((name) => name !== "__name__").sort()
  const date = (seconds: number) => new Date(seconds * 1000).toLocaleString()
  return <>
    <div className={styles.overview}>
      <div className={styles.stat}><ChartNoAxesCombined size={17} aria-hidden="true" />
        <div><strong>{stats ? `${stats.truncated ? "≥ " : ""}${stats.count.toLocaleString()}` : "—"}</strong><span>Stored series · last 24h</span></div>
      </div>
      <div className={styles.stat}><Tags size={17} aria-hidden="true" />
        <div><strong>{labelsLoading && !stats ? "—" : `${labelsTruncated || stats?.labelsTruncated ? "≥ " : ""}${names.length.toLocaleString()}`}</strong><span>Available labels</span></div>
      </div>
    </div>
    <p className={styles.explanation}>Cardinality is the number of distinct label values in the returned series. The 24-hour window is approximate and may include inactive series.</p>
    {stats?.sample && <p className={styles.notice}>Example metadata for the sample workspace.</p>}
    {!current && <p className={styles.status} role="status">Loading cardinality…</p>}
    {current?.error && <div className={styles.failure} role="status"><p>Cardinality unavailable. Available labels and their values can still be explored.</p><GammaButton size="sm" onClick={() => setAttempt((value) => value + 1)}>Retry cardinality</GammaButton></div>}
    {stats && <p className={styles.window}>{date(stats.start)} – {date(stats.end)}</p>}
    {stats?.truncated && <p className={styles.notice}>Partial discovery: series and cardinalities are lower bounds from up to {stats.limit.toLocaleString()} returned series, not global active-series counts.</p>}
    {(labelsTruncated || stats?.labelsTruncated) && <p className={styles.notice}>The label list is limited. Other labels may be available in the filter picker.</p>}
    <div className={styles.listHeading}><span>Label</span><span>Distinct values</span></div>
    <div className={styles.labels}>
      {names.map((name) => {
        const label = stats?.labels.find((item) => item.name === name)
        return <details key={name} className={styles.label} onToggle={(event) => {
          const open = event.currentTarget.open
          setExpanded((current) => open ? [...new Set([...current, name])] : current.filter((item) => item !== name))
        }}>
          <summary><ChevronDown size={13} aria-hidden="true" /><code>{name}</code><span>{label ? `${stats?.truncated ? "≥ " : ""}${label.cardinality.toLocaleString()}` : "View values"}</span></summary>
          {expanded.includes(name) && <LabelValues client={client} providerId={providerId} metric={metric} name={name} known={label} canAddFilter={canAddFilter} onAddFilter={onAddFilter} />}
        </details>
      })}
      {!names.length && <p className={styles.status}>{labelsLoading && !stats ? "Loading available labels…" : labelsUnavailable && !stats ? "Label discovery is unavailable. Enter label names manually in the builder." : "No labels found for this metric in the discovery window."}</p>}
    </div>
    <p className={styles.footer}>Expand a label, then select a value to add a filter to your draft.</p>
  </>
}

export function MetricInspector(props: InspectionProps) {
  const [open, setOpen] = useState(false)
  const id = useId()
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef<HTMLButtonElement>(null)
  const valid = /^[a-zA-Z_:][a-zA-Z0-9_:]{0,255}$/.test(props.metric)
  useEffect(() => {
    const element = dialog.current
    if (!open || !element) return
    const opener = document.activeElement
    element.showModal()
    close.current?.focus()
    const unlock = lockBodyScroll()
    return () => {
      const restore = element.contains(document.activeElement) || document.activeElement === document.body
      element.close()
      unlock()
      if (restore && opener instanceof HTMLElement && opener.isConnected) opener.focus()
    }
  }, [open])
  return <>
    <GammaButton size="sm" iconOnly variant="quiet" aria-label="Inspect metric" title={valid ? "Inspect metric labels and cardinality" : "Choose a metric to inspect its labels and cardinality"} disabled={!props.client || !valid} onClick={() => setOpen(true)}>
      <ScanSearch size={16} aria-hidden="true" />
    </GammaButton>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby={`${id}-title`}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => { event.preventDefault(); setOpen(false) }}>
      {open && <>
        <header className={styles.header}><div><span className={styles.eyebrow}>Metric explorer</span><h2 id={`${id}-title`}>{props.metric}</h2></div>
          <GammaButton ref={close} size="sm" iconOnly variant="quiet" aria-label="Close metric inspector" onClick={() => setOpen(false)}><X size={17} /></GammaButton>
        </header>
        <Inspection key={`${props.providerId}\0${props.metric}`} {...props} onAddFilter={(label, value) => { props.onAddFilter(label, value); setOpen(false) }} />
      </>}
    </dialog>
  </>
}
