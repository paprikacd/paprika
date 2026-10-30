import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, ChevronDown, Code2, Plus, Play, SlidersHorizontal, Trash2 } from "lucide-react"
import type { InsightsClient, ProviderMetadata } from "./client"
import {
  widgetKind,
  type QueryRequest,
  type QueryResult,
  type Provider,
  type Widget,
} from "./schema"
import { WidgetVisualization } from "./charts"
import { SearchCombobox } from "./gamma/search-combobox"
import { GammaButton } from "./gamma/button"
import { GammaInput } from "./gamma/input"
import { GammaSelect } from "./gamma/select"
import { GammaTabs } from "./gamma/tabs"
import { ObserveQueryBinding } from "./observe-query-binding"
import { MetricInspector } from "./metric-inspector"
import { QueryCodeEditor } from "./query-code-editor"
import { providerQueryLanguage, queryLanguageNames, type QueryEditorParameter } from "./query-editor-language"
import { assertProviderQueryTemplate } from "./provider-query-template"
import styles from "./query-builder.module.css"

export interface GuidedQuery {
  metric: string
  filters: {
    label: string
    operator: "=" | "!=" | "=~" | "!~"
    value: string
  }[]
  rate: "none" | "rate" | "irate" | "increase"
  window: string
  aggregation: "none" | "sum" | "avg" | "min" | "max" | "count"
  groupBy: string
}
const metricName = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/
const labelName = /^[a-zA-Z_][a-zA-Z0-9_]*$/
export function buildPromQL(query: GuidedQuery): string {
  if (!metricName.test(query.metric))
    throw new Error(
      "Choose a metric using letters, digits, underscores or colons. Use code for UTF-8 names.",
    )
  if (query.filters.length > 20)
    throw new Error("Use at most 20 label filters.")
  const filters = query.filters.map((filter) => {
    if (!labelName.test(filter.label))
      throw new Error("Choose a valid label for every filter.")
    if (!["=", "!=", "=~", "!~"].includes(filter.operator))
      throw new Error("Choose a valid label operator.")
    return `${filter.label}${filter.operator}${JSON.stringify(filter.value)}`
  })
  let expression =
    query.metric + (filters.length ? `{${filters.join(",")}}` : "")
  if (query.rate !== "none") {
    if (
      !["rate", "irate", "increase"].includes(query.rate) ||
      !/^[1-9][0-9]*(ms|s|m|h|d|w|y)$/.test(query.window)
    )
      throw new Error("Choose a rate function and a positive range such as 5m.")
    expression = `${query.rate}(${expression}[${query.window}])`
  }
  if (query.aggregation !== "none") {
    if (!["sum", "avg", "min", "max", "count"].includes(query.aggregation))
      throw new Error("Choose a valid aggregation.")
    const groups = query.groupBy.trim()
      ? query.groupBy.split(",").map((item) => item.trim())
      : []
    if (
      groups.some((group) => !labelName.test(group)) ||
      new Set(groups).size !== groups.length
    )
      throw new Error("Group by unique label names, separated by commas.")
    expression = `${query.aggregation}${groups.length ? ` by (${groups.join(", ")})` : ""} (${expression})`
  }
  if (expression.length > 8192)
    throw new Error("Generated queries must be under 8192 characters.")
  return expression
}

function useMetadata(
  client: InsightsClient | undefined,
  providerId: string,
  kind: "metrics" | "labels" | "values",
  label?: string,
  metric?: string,
) {
  const key = `${providerId}:${kind}:${label ?? ""}:${metric ?? ""}`
  const [state, setState] = useState<{
    key: string
    data?: ProviderMetadata
    error?: string
  }>()
  useEffect(() => {
    if (!client || (kind === "values" && !label)) return
    const controller = new AbortController()
    client
      .metadata(providerId, { kind, label, metric }, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setState({ key, data })
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setState({
            key,
            error:
              error instanceof Error ? error.message : "Discovery unavailable",
          })
      })
    return () => controller.abort()
  }, [client, providerId, kind, label, metric, key])
  return {
    values: state?.key === key ? (state.data?.values ?? []) : [],
    truncated: state?.key === key && state.data?.truncated,
    error: state?.key === key ? state.error : undefined,
    loading: !!client && !(kind === "values" && !label) && state?.key !== key,
  }
}

function DiscoveryField({
  label,
  value,
  onChange,
  values,
  loading = false,
  visualLabel,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  values: string[]
  loading?: boolean
  visualLabel?: string
}) {
  const [text, setText] = useState("")
  const options = values.map((value) => ({ value, label: value }))
  if (value && !values.includes(value)) options.unshift({ value, label: value })
  if (text && text !== value && !values.includes(text))
    options.unshift({ value: text, label: `Use “${text}”` })
  return (
    <div className={styles.field}>
      <span>{visualLabel ?? label}</span>
      <SearchCombobox
        label={label}
        value={value || null}
        options={options}
        loading={loading}
        onQueryChange={setText}
        onValueChange={(next) => onChange(next ?? "")}
        openOnFocus
        placeholder="Search or enter a name…"
        emptyMessage="Type a value, then choose Use to add it."
      />
    </div>
  )
}

function FilterRow({
  filter,
  index,
  labels,
  client,
  providerId,
  metric,
  onChange,
  onRemove,
}: {
  filter: GuidedQuery["filters"][number]
  index: number
  labels: string[]
  client?: InsightsClient
  providerId: string
  metric: string
  onChange: (filter: GuidedQuery["filters"][number]) => void
  onRemove: () => void
}) {
  const values = useMetadata(
    client,
    providerId,
    "values",
    filter.label,
    metric || undefined,
  )
  return (
    <div className={styles.filter}>
      <DiscoveryField
        label={`Filter ${index + 1} label`}
        visualLabel="Label"
        value={filter.label}
        values={labels}
        onChange={(label) => onChange({ ...filter, label, value: "" })}
      />
      <div className={styles.filterValue}>
        <GammaSelect
          aria-label={`Filter ${index + 1} operator`}
          value={filter.operator}
          onValueChange={(value) =>
            onChange({
              ...filter,
              operator: value as typeof filter.operator,
            })
          }
          options={["=", "!=", "=~", "!~"].map((value) => ({
            value,
            label: value,
          }))}
        />
        <DiscoveryField
          label={`Filter ${index + 1} value`}
          visualLabel="Value"
          value={filter.value}
          values={values.values}
          loading={values.loading}
          onChange={(value) => onChange({ ...filter, value })}
        />
        <GammaButton iconOnly
          type="button"
          variant="quiet" size="sm"
          aria-label={`Remove filter ${index + 1}`}
          onClick={onRemove}
        >
          <Trash2 size={14} />
        </GammaButton>
      </div>
      {values.error && (
        <p className={styles.hint}>
          Values unavailable; enter a value manually.
        </p>
      )}
      {values.truncated && (
        <p className={styles.hint}>
          Showing the first available values. You can enter another value.
        </p>
      )}
    </div>
  )
}

function GuidedBuilder({
  query,
  onChange,
  client,
  providerId,
  compact = false,
  live = false,
  active = true,
  codeRevision = 0,
  onValidityChange,
}: {
  query: string
  onChange: (value: string) => void
  client?: InsightsClient
  providerId: string
  compact?: boolean
  live?: boolean
  active?: boolean
  codeRevision?: number
  onValidityChange?: (valid: boolean) => void
}) {
  const [draft, setGuidedDraft] = useState<GuidedQuery>({
    metric: metricName.test(query) ? query : "",
    filters: [],
    rate: "none",
    window: "5m",
    aggregation: "none",
    groupBy: "",
  })
  const [touched, setTouched] = useState(false)
  const [lastCodeRevision, setLastCodeRevision] = useState(codeRevision)
  if (lastCodeRevision !== codeRevision) {
    setLastCodeRevision(codeRevision)
    setTouched(false)
  }
  function setDraft(next: GuidedQuery | ((current: GuidedQuery) => GuidedQuery)) {
    setTouched(true)
    setGuidedDraft(next)
  }
  const draftKey = JSON.stringify(draft)
  const previousDraft = useRef(draftKey)
  const metrics = useMetadata(client, providerId, "metrics")
  const labels = useMetadata(
    client,
    providerId,
    "labels",
    undefined,
    metricName.test(draft.metric) ? draft.metric : undefined,
  )
  let generated = "",
    error = ""
  try {
    generated = buildPromQL(draft)
  } catch (cause) {
    error = (cause as Error).message
  }
  useEffect(() => {
    onValidityChange?.(!live || !active || !touched || !!generated)
  }, [live, active, touched, generated, onValidityChange])
  useEffect(() => () => onValidityChange?.(true), [onValidityChange])
  useEffect(() => {
    if (previousDraft.current === draftKey) return
    previousDraft.current = draftKey
    if (live && generated) onChange(generated)
  }, [draftKey, generated, live, onChange])
  return (
    <div className={styles.guided}>
      {!compact && <p className={styles.hint}>
        {live ? "Valid changes update the widget preview automatically." : "Build an expression, then choose Use generated query to apply it below."}
      </p>}
      <section className={styles.step} aria-label="Choose a metric">
        <div className={styles.stepHeading}>
          <span className={styles.stepNumber} aria-hidden="true">1</span>
          <div><h3>Metric</h3><p>Choose the signal to measure.</p></div>
        </div>
        <div className={styles.stepBody}>
          <div className={styles.metricSelection}>
          <DiscoveryField
            label="Metric"
            value={draft.metric}
            values={metrics.values}
            loading={metrics.loading}
            onChange={(metric) => setDraft({ ...draft, metric })}
          />
          <MetricInspector
            client={client}
            providerId={providerId}
            metric={draft.metric}
            labels={labels.values}
            labelsLoading={labels.loading}
            labelsUnavailable={!!labels.error}
            labelsTruncated={!!labels.truncated}
            canAddFilter={draft.filters.length < 20}
            onAddFilter={(label, value) => setDraft((current) => ({
              ...current, filters: [...current.filters, { label, operator: "=", value }],
            }))}
          />
          </div>
          {(metrics.error || labels.error) && (
            <p className={styles.notice}>
              Discovery is unavailable. Enter metric and label names manually.
            </p>
          )}
          {metrics.truncated && (
            <p className={styles.hint}>
              Provider discovery is limited. Enter a metric name to use one outside
              these results.
            </p>
          )}
        </div>
      </section>
      <section className={styles.step} aria-label="Filter metric labels">
        <div className={styles.stepHeading}>
          <span className={styles.stepNumber} aria-hidden="true">2</span>
          <div><h3>Label filters</h3><p>Narrow down your series.</p></div>
        </div>
        <div className={styles.stepBody}>
          {!draft.filters.length && <p className={styles.emptyFilters}>All labels included. Add a filter to focus your query.</p>}
          <div className={compact && draft.filters.length ? styles.filterGroup : styles.filterStack}>
            <div className={styles.filterRows}>
          {draft.filters.map((filter, index) => (
            <FilterRow
              key={index}
              filter={filter}
              index={index}
              labels={labels.values}
              client={client}
              providerId={providerId}
              metric={draft.metric}
              onChange={(filter) =>
                setDraft({
                  ...draft,
                  filters: draft.filters.map((item, i) => i === index ? filter : item),
                })
              }
              onRemove={() =>
                setDraft({
                  ...draft,
                  filters: draft.filters.filter((_, i) => i !== index),
                })
              }
            />
          ))}
            </div>
          <GammaButton
            type="button"
            variant="secondary"
            size="sm"
            className={styles.addFilter}
            iconOnly={compact && draft.filters.length > 0}
            aria-label="Add label filter"
            disabled={draft.filters.length >= 20}
            onClick={() =>
              setDraft({
                ...draft,
                filters: [...draft.filters, { label: "", operator: "=", value: "" }],
              })
            }
          >
            <Plus size={13} />
            {(!compact || !draft.filters.length) && "Add label filter"}
          </GammaButton>
          </div>
        </div>
      </section>
      <section className={styles.step} aria-label="Transform the metric">
        <div className={styles.stepHeading}>
          <span className={styles.stepNumber} aria-hidden="true">3</span>
          <div><h3>Transform</h3><p>Apply a function and aggregation.</p></div>
        </div>
        <div className={styles.stepBody}>
          <div className={styles.transforms} data-fields={2 + Number(draft.rate !== "none") + Number(draft.aggregation !== "none")}>
            <label className={styles.field}>
              <span>Function</span>
              <GammaSelect
                aria-label="Function"
                value={draft.rate}
                onValueChange={(value) => setDraft({ ...draft, rate: value as GuidedQuery["rate"] })}
                options={[
                  { value: "none", label: "Raw values" },
                  { value: "rate", label: "Rate per second" },
                  { value: "irate", label: "Instant rate" },
                  { value: "increase", label: "Increase" },
                ]}
              />
            </label>
            {draft.rate !== "none" && (
              <label className={styles.field}>
                <span>{compact ? "Range" : "Rate window"}</span>
                <GammaInput aria-label="Rate window" value={draft.window} onChange={(event) => setDraft({ ...draft, window: event.target.value })} />
              </label>
            )}
            <label className={styles.field}>
              <span>Aggregation</span>
              <GammaSelect
                aria-label="Aggregation"
                value={draft.aggregation}
                onValueChange={(value) => setDraft({ ...draft, aggregation: value as GuidedQuery["aggregation"] })}
                options={[
                  { value: "none", label: "No aggregation" },
                  ...["sum", "avg", "min", "max", "count"].map((value) => ({ value, label: value })),
                ]}
              />
            </label>
            {draft.aggregation !== "none" && (
              <label className={styles.field}>
                <span>{compact ? "Group by" : "Group by labels"}</span>
                <GammaInput aria-label="Group by labels" placeholder={compact ? "Group by labels" : "job, instance"} value={draft.groupBy} onChange={(event) => setDraft({ ...draft, groupBy: event.target.value })} />
              </label>
            )}
          </div>
          {!compact && draft.rate !== "none" && (
            <p className={styles.hint}>
              Use counter metrics for rate and increase. Allow several scrape intervals in the rate window.
            </p>
          )}
        </div>
      </section>
      <div className={styles.generated}>
        <div className={styles.generatedHeading}><Code2 size={14} aria-hidden="true" /><span>Generated expression</span></div>
        <pre className={styles.code} aria-label="Generated query" title={generated || undefined}>
          {generated || (draft.metric ? error : "Choose a metric to start building your query.")}
        </pre>
        <GammaButton
          type="button"
          variant="secondary"
          size="sm"
          aria-label="Use generated query"
          disabled={!generated}
          onClick={() => onChange(generated)}
        >
          <ArrowDown size={13} /> {compact ? "Apply" : "Use generated query"}
        </GammaButton>
      </div>
    </div>
  )
}

export type QueryFetcher = (
  request: QueryRequest,
  signal: AbortSignal,
) => Promise<QueryResult>
export function QueryBuilder({
  widget,
  onChange,
  client,
  provider,
  parameters,
  range,
  queryFetcher,
  showRunControl = true,
  defaultExpanded = false,
  compact = false,
  live = false,
  onValidityChange,
}: {
  widget: Widget
  onChange: (query: string) => void
  client?: InsightsClient
  provider?: Provider
  parameters?: readonly QueryEditorParameter[]
  range?: { start: number; end: number }
  queryFetcher?: QueryFetcher
  showRunControl?: boolean
  defaultExpanded?: boolean
  compact?: boolean
  /** Use valid guided changes immediately in the unsaved widget preview. */
  live?: boolean
  onValidityChange?: (valid: boolean) => void
}) {
  const [guided, setGuided] = useState(defaultExpanded)
  const language = providerQueryLanguage(provider, widgetKind(widget))
  const languageName = queryLanguageNames[language]
  const validityKey = `${widget.providerId}:${language}`
  const [editorValidation, setEditorValidation] = useState({ key: validityKey, valid: true })
  const editorValid = (language !== "sql" && language !== "json") || editorValidation.key !== validityKey || editorValidation.valid
  const editorValidity = useCallback((valid: boolean) => { setEditorValidation({ key: validityKey, valid }); onValidityChange?.(valid) }, [onValidityChange, validityKey])
  useEffect(() => { if (language !== "sql" && language !== "json") onValidityChange?.(true) }, [language, onValidityChange])
  const [codeRevision, setCodeRevision] = useState(0)
  useEffect(() => () => onValidityChange?.(true), [onValidityChange])
  const [hasOpened, setHasOpened] = useState(defaultExpanded)
  const [mode, setMode] = useState(defaultExpanded ? "builder" : "code")
  const request = useRef<AbortController | null>(null)
  const fetcher = queryFetcher ?? client?.query
  const key = JSON.stringify([
    widget.providerId,
    widget.query,
    widgetKind(widget),
    range?.start,
    range?.end,
  ])
  // The fetcher is scoped to the dashboard's current variable values and
  // provider/query configuration. A filter change creates a new context even
  // when the authored expression and time range are unchanged.
  const revision = useMemo(() => ({ key, fetcher }), [key, fetcher])
  const [preview, setPreview] = useState<{
    revision: typeof revision
    result?: QueryResult
    error?: string
    loading: boolean
  }>()
  useEffect(() => () => request.current?.abort(), [revision])
  async function run() {
    if (!fetcher || !widget.query.trim() || !editorValid) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    setPreview({ revision, loading: true })
    const end = range?.end ?? Math.floor(Date.now() / 1000),
      start = range?.start ?? end - 3600
    try {
      assertProviderQueryTemplate(provider?.type, widget.query)
      const result = await fetcher(
        {
          providerId: widget.providerId,
          kind: widgetKind(widget),
          query: widget.query,
          start,
          end,
          step: Math.max(1, Math.ceil((end - start) / 300)),
        },
        controller.signal,
      )
      if (!controller.signal.aborted)
        setPreview({ revision, result, loading: false })
    } catch (error) {
      if (!controller.signal.aborted)
        setPreview({
          revision,
          error: error instanceof Error ? error.message : "Query failed",
          loading: false,
        })
    }
  }
  const current = preview?.revision === revision ? preview : undefined
  const codeEditor = (
    <div className={styles.codeEditor}>
      <div className={styles.field}>
        <span className={styles.codeHeading}>
          <Code2 size={14} aria-hidden="true" />
          {languageName} query
          <span className={styles.codeBadge}>Code</span>
        </span>
        <QueryCodeEditor
          language={language}
          provider={provider}
          kind={widgetKind(widget)}
          providerId={widget.providerId}
          client={client}
          parameters={parameters}
          onValidityChange={language === "sql" || language === "json" ? editorValidity : undefined}
          value={widget.query}
          onChange={(query) => {
            setCodeRevision(revision => revision + 1)
            onChange(query)
          }}
          className={styles.codeInput}
        />
      </div>
      {language !== "sql" && <p className={styles.hint}>
        Reference {showRunControl ? "dashboard variables" : "query parameters"} as whole values, such as{" "}
        <code>{language === "json" ? provider?.type === "shorted" ? '"product_code": {{ticker}}' : '"serviceId": {{service}}' : "service={{service}}"}</code>, without surrounding quotes.
        {language === "json" && " Choose a read operation and its arguments. Metrics also require an explicit projection; records omit it."}
      </p>}
    </div>
  )
  const builder = hasOpened && language === "promql" ? (
    <GuidedBuilder
      key={widget.providerId}
      client={client}
      providerId={widget.providerId}
      query={widget.query}
      onChange={onChange}
      compact={compact}
      live={live}
      active={compact ? mode === "builder" : guided}
      codeRevision={codeRevision}
      onValidityChange={onValidityChange}
    />
  ) : null
  return (
    <div className={`${styles.query} ${compact ? styles.compact : ""}`}>
      <ObserveQueryBinding provider={provider} kind={widgetKind(widget)} />
      {compact && (language === "promql" ? (
        <GammaTabs
          label="Query editor mode"
          value={mode}
          onChange={(next) => {
            setMode(next)
            if (next === "builder") setHasOpened(true)
          }}
          tabs={[
            { id: "builder", title: "Builder", content: builder },
            { id: "code", title: "Code", content: codeEditor },
          ]}
        />
      ) : codeEditor)}
      {!compact && language === "promql" && (
        <details
          className={styles.builder}
          open={guided}
          onToggle={(event) => {
            setGuided(event.currentTarget.open)
            if (event.currentTarget.open) setHasOpened(true)
          }}
        >
          <summary>
            <SlidersHorizontal size={15} aria-hidden="true" />
            <span>Guided query builder</span>
            <ChevronDown className={styles.chevron} size={15} aria-hidden="true" />
          </summary>
          {builder}
        </details>
      )}
      {!compact && codeEditor}
      {showRunControl && fetcher && (
        <>
          <GammaButton
            type="button"
            variant="secondary"
            loading={current?.loading}
            disabled={current?.loading || !widget.query.trim() || !editorValid}
            onClick={run}
          >
            <Play size={13} />
            {current?.loading ? "Running query…" : "Run query"}
          </GammaButton>
          {current && (
            <div className={styles.preview} aria-label="Query preview">
              <WidgetVisualization
                widget={widget}
                result={current.result}
                loading={current.loading}
                error={current.error}
              />
            </div>
          )}
        </>
      )}
    </div>
  )
}
