"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Activity,
  Bookmark,
  Check,
  Database,
  Copy,
  Play,
  Plus,
  Save,
  Square,
  Trash2,
} from "lucide-react";
import type { InsightsClient } from "./client";
import {
  savedQuerySchema,
  type Dashboard,
  type Provider,
  type QueryResult,
  type SavedQuery,
  type SavedQueryEntry,
  type SavedQueryParameter,
  type Widget,
} from "./schema";
import {
  resolveSavedQueryTemplate,
  savedQueryParameterValue,
  validateSavedQueryTemplate,
} from "./saved-queries";
import { QueryBuilder } from "./query-builder";
import { summarizeExplorerResult } from "./explorer-result-summary";
import { assertProviderQueryTemplate } from "./provider-query-template";
import { WidgetVisualization } from "./charts";
import { dashboardRange, TimeRangeControl } from "./time-range";
import { GammaButton } from "./gamma/button";
import { GammaInput, GammaTextarea } from "./gamma/input";
import { GammaSelect } from "./gamma/select";
import { GammaSwitch } from "./gamma/switch";
import { GammaTabs } from "./gamma/tabs";
import { GammaConfirmation, useConfirmation } from "./gamma/confirmation";
import { providerOption, QuerySourceIcon } from "./source-identity";
import { savedQueryOption } from "./saved-query-presentation";
import { SavedQueryDetailsEditor } from "./saved-query-details-editor";
import styles from "./explorer.module.css";

interface ParameterDraft {
  name: string;
  label: string;
  type: "string" | "number";
  hasDefault: boolean;
  defaultText: string;
}
interface Draft {
  query: SavedQuery;
  parameters: ParameterDraft[];
}
function fromQuery(query: SavedQuery): Draft {
  return {
    query,
    parameters: (query.parameters ?? []).map((parameter) => ({
      name: parameter.name,
      label: parameter.label ?? "",
      type: parameter.type,
      hasDefault: parameter.defaultValue !== undefined,
      defaultText:
        parameter.defaultValue === undefined
          ? ""
          : String(parameter.defaultValue),
    })),
  };
}
function readDraft(draft: Draft): SavedQuery {
  const parameters = draft.parameters.map((parameter) => {
    const base: SavedQueryParameter = {
      name: parameter.name,
      ...(parameter.label ? { label: parameter.label } : {}),
      type: parameter.type,
    };
    return parameter.hasDefault
      ? {
          ...base,
          defaultValue: savedQueryParameterValue(base, parameter.defaultText),
        }
      : base;
  });
  const query = savedQuerySchema.parse({ ...draft.query, parameters });
  validateSavedQueryTemplate(query);
  return query;
}
function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, child) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(
          Object.keys(child)
            .sort()
            .map((key) => [key, child[key]]),
        )
      : child,
  );
}
function newQuery(provider?: Provider): SavedQuery {
  return {
    schemaVersion: 1,
    id: `query-${crypto.randomUUID()}`,
    name: "",
    providerId: provider?.id ?? "",
    kind: provider?.capabilities.includes("records") ? "records" : provider?.capabilities.includes("metrics") ? "metrics" : "traces",
    query: "",
    parameters: [],
  };
}
function message(error: unknown) {
  if (
    error &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray(error.issues)
  )
    return error.issues
      .map((issue) => `${issue.path?.join(" → ") || "Query"}: ${issue.message}`)
      .join(". ");
  return error instanceof Error
    ? error.message
    : "The request failed. Try again.";
}
function recordPreviewFields(type: string): { key: string; label: string; numeric?: boolean }[] {
  switch (type) {
    case "record-list": return [{ key: "title", label: "Title column" }];
    case "record-treemap": return [{ key: "label", label: "Label column" }, { key: "value", label: "Value column", numeric: true }];
    case "record-matrix": return [{ key: "x", label: "X column" }, { key: "y", label: "Y column" }, { key: "value", label: "Value column", numeric: true }];
    case "records-line":
    case "records-bar": return [{ key: "x", label: "X column" }, { key: "y", label: "Value column", numeric: true }];
    default: return [];
  }
}
function isRecordView(type: string) { return /^(record-|records-)/.test(type); }
function resultWidget(query: SavedQuery, type: string, config?: Widget["config"]): Widget {
  return {
    id: "explore-preview",
    title: query.name || "Query results",
    providerId: query.providerId,
    query: query.query,
    type: query.kind === "traces" ? "traces" : query.kind === "records" ? "plugin" : type as Widget["type"],
    ...(query.kind === "records" ? { pluginId: isRecordView(type) ? type : "record-table", dataKind: "records" as const, config } : {}),
    unit: "",
    layout: { x: 0, y: 0, w: 12, h: 6 },
  };
}

export function Explorer({
  client,
  providers,
  queries,
  onQueriesChange,
  onUse,
  onClose,
  initialProviderId,
  active = true,
  onDirtyChange,
}: {
  client: InsightsClient;
  providers: Provider[];
  queries: SavedQueryEntry[];
  onQueriesChange: (entries: SavedQueryEntry[]) => void;
  onUse: (query: SavedQuery) => void;
  onClose: () => void;
  initialProviderId?: string;
  active?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() =>
    fromQuery(
      newQuery(
        providers.find((provider) => provider.id === initialProviderId) ??
          providers[0],
      ),
    ),
  );
  const [baseline, setBaseline] = useState(() => fingerprint(draft));
  const [persisted, setPersisted] = useState<SavedQueryEntry>();
  const [detailsTab, setDetailsTab] = useState("overview");
  const [testValues, setTestValues] = useState<Record<string, string>>({});
  const [time, setTime] = useState<Dashboard>({
    schemaVersion: 1,
    id: "explore",
    title: "Explore",
    timeRange: "1h",
    refreshInterval: 0,
    widgets: [],
  });
  const [view, setView] = useState<string>("timeseries");
  const [queryValid, setQueryValid] = useState(true);
  const [recordMappings, setRecordMappings] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [saveRecovery, setSaveRecovery] = useState(false);
  const [notice, setNotice] = useState("");
  const [runError, setRunError] = useState<{ key: string; message: string }>();
  const [runNotice, setRunNotice] = useState("");
  const [executed, setExecuted] = useState<{
    key: string;
    query: SavedQuery;
    result: QueryResult;
    start: number;
    end: number;
  }>();
  const controller = useRef<AbortController | null>(null);
  const copyAttempt = useRef<{ key: string; id: string } | null>(null);
  const alive = useRef(true);
  const currentQueries = useRef(queries);
  useEffect(() => {
    currentQueries.current = queries;
  }, [queries]);
  const confirmation = useConfirmation();
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (!active) {
      controller.current?.abort();
    }
  }, [active]);
  if (!active && running) setRunning(false);
  const dirty = fingerprint(draft) !== baseline;
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange]);
  const remoteEntry =
    persisted && queries.find((query) => query.id === persisted.id);
  useEffect(() => {
    // A same-content rewrite may change the server's byte-level ETag. A clean
    // editor can adopt that revision without resetting test values or results.
    if (dirty || busy || !persisted || !remoteEntry || persisted.etag === remoteEntry.etag ||
      fingerprint({ ...persisted, etag: undefined }) !== fingerprint({ ...remoteEntry, etag: undefined })) return;
    let active = true;
    queueMicrotask(() => { if (active) setPersisted(remoteEntry); });
    return () => { active = false; };
  }, [dirty, busy, persisted, remoteEntry]);
  const remoteChanged =
    !!persisted &&
    (!remoteEntry || fingerprint(remoteEntry) !== fingerprint(persisted));
  const provider = providers.find((item) => item.id === draft.query.providerId);
  const library = queries.filter(
    (query) => query.providerId === draft.query.providerId,
  );
  const executionKey = fingerprint([
    draft.query.providerId,
    draft.query.kind,
    draft.query.query,
    draft.parameters,
    testValues,
    time.timeRange,
    time.customTimeRange,
  ]);
  const stale = !!executed && executed.key !== executionKey;
  // Errors describe the exact inputs that were run. Editing a test value or
  // time range must not leave a previous request's failure on the new draft.
  const activeRunError = runError?.key === executionKey ? runError.message : "";
  const resultSummary = useMemo(() => executed ? summarizeExplorerResult(executed.query.kind, executed.result) : undefined, [executed]);
  const previewFields = recordPreviewFields(view);
  const previewColumns = executed?.result.records?.columns ?? [];
  const previewMapping = recordMappings[view] ?? {};
  const previewReady = previewFields.every(field => previewColumns.some(column => column.key === previewMapping[field.key] && (!field.numeric || column.type === "number")));
  const previewConfig = Object.fromEntries(previewFields.map(field => [field.key, field.key === "y" && view.startsWith("records-") ? [previewMapping[field.key]] : previewMapping[field.key]]));
  function cancel() {
    setRunNotice("");
    setRunError(undefined);
    controller.current?.abort();
    controller.current = null;
    setRunning(false);
  }
  function change(next: Draft) {
    cancel();
    setDraft(next);
    setRunError(undefined);
    setError("");
    setSaveRecovery(false);
    setNotice("");
  }
  function updateQuery(patch: Partial<SavedQuery>) {
    if (patch.kind && patch.kind !== draft.query.kind) setView(patch.kind === "records" ? "record-table" : "timeseries");
    change({ ...draft, query: { ...draft.query, ...patch } });
  }
  function updateParameter(index: number, patch: Partial<ParameterDraft>) {
    change({
      ...draft,
      parameters: draft.parameters.map((parameter, item) =>
        item === index ? { ...parameter, ...patch } : parameter,
      ),
    });
  }
  async function mayLeave() {
    return (
      !dirty ||
      (await confirmation.ask({
        title: "Discard query changes?",
        description:
          "Your unsaved query changes will be lost. Saved queries will remain unchanged.",
        action: "Discard changes",
      }))
    );
  }
  function load(query: SavedQuery, entry?: SavedQueryEntry) {
    cancel();
    setDetailsTab("overview");
    setView(query.kind === "records" ? "record-table" : "timeseries");
    const next = fromQuery(query);
    setDraft(next);
    setBaseline(fingerprint(next));
    setPersisted(entry);
    setTestValues({});
    setError("");
    setSaveRecovery(false);
    setNotice("");
    setRunError(undefined);
    setExecuted(undefined);
  }
  async function select(id: string) {
    if (id === persisted?.id) return;
    const query = queries.find((item) => item.id === id);
    if (!query || busy || !(await mayLeave()) || !alive.current) return;
    const document = { ...query };
    delete document.etag;
    load(document, query);
  }
  function publish(entry: SavedQueryEntry) {
    const next = [
      ...currentQueries.current.filter((query) => query.id !== entry.id),
      entry,
    ].sort((a, b) => a.name.localeCompare(b.name));
    currentQueries.current = next;
    onQueriesChange(next);
  }
  async function save(copy = false) {
    if (busy || !queryValid) return;
    setSaveRecovery(false);
    let query: SavedQuery;
    try {
      query = readDraft(draft);
      assertProviderQueryTemplate(provider?.type, query.query);
    } catch (error) {
      setError(message(error));
      return;
    }
    if (copy) {
      const key = fingerprint(query);
      if (copyAttempt.current?.key !== key)
        copyAttempt.current = { key, id: `query-${crypto.randomUUID()}` };
      query = {
        ...query,
        id: copyAttempt.current.id,
        name: `${query.name.slice(0, 113)} (copy)`,
      };
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let etag: string | undefined;
      try {
        etag = await client.saveSavedQuery(
          query,
          copy ? undefined : persisted?.etag,
        );
      } catch (saveError) {
        // A response may be lost after the server commits. Recover only an exact
        // document match; a different remote version remains a visible conflict.
        let confirmed:
          Awaited<ReturnType<InsightsClient["getSavedQuery"]>> | undefined;
        try {
          confirmed = await client.getSavedQuery(query.id);
        } catch {
          /* Keep the original error. */
        }
        if (!confirmed || fingerprint(confirmed.query) !== fingerprint(query))
          throw saveError;
        etag = confirmed.etag;
      }
      if (!alive.current) return;
      const entry = { ...query, etag };
      publish(entry);
      const next = fromQuery(query);
      setDraft(next);
      setBaseline(fingerprint(next));
      setPersisted(entry);
      setNotice(
        copy
          ? "Saved a separate copy."
          : "Query saved.",
      );
    } catch (error) {
      if (alive.current) { setError(message(error)); setSaveRecovery(true); }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function reload() {
    if (!persisted || busy || !(await mayLeave()) || !alive.current) return;
    setBusy(true);
    setError("");
    setSaveRecovery(false);
    setNotice("");
    try {
      const latest = await client.getSavedQuery(persisted.id);
      if (alive.current) {
        const entry = { ...latest.query, etag: latest.etag };
        publish(entry);
        load(latest.query, entry);
        setNotice("Loaded the latest saved version.");
      }
    } catch (error) {
      if (alive.current) setError(message(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function remove() {
    if (
      !persisted ||
      busy ||
      !(await confirmation.ask({
        title: `Delete “${persisted.name}”?`,
        description:
          "Saved dashboards must stop using this query before it can be deleted. Remove or replace their references first. Deletion cannot be undone.",
        action: "Delete saved query",
      })) ||
      !alive.current
    )
      return;
    setBusy(true);
    setError("");
    setSaveRecovery(false);
    setNotice("");
    try {
      await client.removeSavedQuery(persisted.id, persisted.etag);
      if (alive.current) {
        const next = currentQueries.current.filter(
          (query) => query.id !== persisted.id,
        );
        currentQueries.current = next;
        onQueriesChange(next);
        load(newQuery(provider));
        setNotice("Saved query deleted.");
      }
    } catch (error) {
      if (alive.current) setError(message(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function run() {
    if (!active || !queryValid) return;
    cancel();
    setRunError(undefined);
    let request: AbortController | undefined;
    try {
      // Names are required to save, but an ad-hoc query can run before naming it.
      const query = readDraft({
        ...draft,
        query: {
          ...draft.query,
          name: draft.query.name.trim() || "Untitled query",
        },
      });
      if (!provider?.capabilities.includes(query.kind))
        throw new Error(
          "Choose an available data source that supports this query.",
        );
      assertProviderQueryTemplate(provider?.type, query.query);
      const values = Object.fromEntries(
        (query.parameters ?? [])
          .filter((parameter) => Object.hasOwn(testValues, parameter.name))
          .map((parameter) => [parameter.name, testValues[parameter.name]]),
      );
      const resolved = {
        ...query,
        query: resolveSavedQueryTemplate(query, values),
      };
      const range = dashboardRange(
        time,
        Math.floor(new Date().getTime() / 1000),
      );
      request = new AbortController();
      controller.current = request;
      setRunning(true);
      const result = await client.query(
        {
          providerId: query.providerId,
          kind: query.kind,
          query: resolved.query,
          ...range,
          step: Math.max(1, Math.ceil((range.end - range.start) / 300)),
        },
        request.signal,
      );
      if (!request.signal.aborted && alive.current)
        setExecuted({ key: executionKey, query: resolved, result, ...range });
    } catch (error) {
      if (alive.current && !request?.signal.aborted)
        setRunError({ key: executionKey, message: message(error) });
    } finally {
      if (alive.current && (!request || controller.current === request))
        setRunning(false);
    }
  }
  return (
    <section className={styles.explorer} aria-label="Data source explorer">
      <header className={styles.header}>
        <div className={styles.headerIntro}>
          <GammaButton
            variant="quiet"
            size="sm"
            disabled={busy}
            onClick={() => {
              cancel();
              onClose();
            }}
          >
            <ArrowLeft size={15} />
            Dashboard
          </GammaButton>
          <div className={styles.pageTitle}><h1>Explore</h1><span>Query workspace</span></div>
        </div>
        <label className={styles.source}>
          <span className={styles.sourceLabel}><Database size={13} aria-hidden="true" /> Data source</span>
          <GammaSelect
            aria-label="Explore data source"
            size="sm"
            value={draft.query.providerId}
            disabled={busy}
            searchable
            options={providers.map(providerOption)}
            onValueChange={async (id) => {
              if (id === draft.query.providerId) return;
              if ((await mayLeave()) && alive.current) {
                load(
                  newQuery(providers.find((provider) => provider.id === id)),
                );
              }
            }}
          />
        </label>
      </header>
      <div className={styles.workspace} data-has-parameters={draft.parameters.length > 0}>
        <aside className={styles.library} aria-label="Saved query library">
          <h2><QuerySourceIcon kind="saved" /> Saved queries <span>{library.length}</span></h2>
          <GammaSelect
            aria-label="Open saved query"
            size="sm"
            value={persisted?.id ?? ""}
            placeholder={library.length ? "Choose a saved query" : "Your saved queries will appear here"}
            options={library.map(savedQueryOption)}
            searchable
            disabled={busy || !library.length}
            onValueChange={(id) => void select(id)}
          />
          <GammaButton
            className={styles.newQuery}
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={async () => {
              if ((await mayLeave()) && alive.current) load(newQuery(provider));
            }}
          >
            <Plus size={14} /> New query
          </GammaButton>
        </aside>
          <section className={styles.queryCard} aria-label="Query workbench">
            <div className={styles.sectionHeading}>
              <div className={styles.workbenchTitle}>
                <h2><QuerySourceIcon kind={persisted ? "saved" : "provider"} /> {draft.query.name || "New query"}</h2>
              </div>
              <span className={dirty ? styles.unsaved : styles.savedState}>
                {dirty ? <><span aria-hidden="true" /> Unsaved changes</> : persisted ? <><Check size={12} aria-hidden="true" /> Saved</> : "Draft"}
              </span>
            </div>
            <fieldset disabled={busy} className={styles.fields}>
                {provider && provider.capabilities.length > 1 ? (
                  <label className={styles.field}>
                    Query kind
                    <GammaSelect
                      aria-label="Explore query kind"
                      value={draft.query.kind}
                      disabled={busy || !!persisted}
                      options={provider.capabilities.map((value) => ({
                        value,
                        label: value === "records" ? "Records" : value === "metrics" ? "Metrics" : "Traces",
                      }))}
                      onValueChange={(kind) =>
                        updateQuery({
                          kind: kind as SavedQuery["kind"],
                          query: "",
                        })
                      }
                    />
                  </label>
                ) : null}
              <QueryBuilder
                key={`${draft.query.id}:${draft.query.kind}`}
                widget={resultWidget(draft.query, "timeseries")}
                client={provider ? client : undefined}
                provider={provider}
                parameters={draft.parameters}
                onValidityChange={setQueryValid}
                onChange={(query) => updateQuery({ query })}
                showRunControl={false}
                defaultExpanded={!persisted && !draft.query.query}
                compact
              />
            </fieldset>
          </section>
          <section
            className={styles.resultsCard}
            aria-label="Explore query results"
          >
            <div className={styles.sectionHeading}>
              <div>
                <h2>Results</h2>
                <p>{draft.parameters.length ? "Test values do not change the saved defaults." : "Run your query to preview the data."}</p>
              </div>
            <div className={styles.runActions}>
              <div className={styles.actions}>
                <GammaButton
                  variant="primary"
                  disabled={
                    running || busy || !provider || !draft.query.query.trim() || !queryValid
                  }
                  loading={running}
                  onClick={run}
                >
                  <Play size={14} />
                  {running ? "Running query…" : "Run query"}
                </GammaButton>
                {running && (
                  <GammaButton onClick={() => {
                    cancel();
                    setRunNotice(executed ? "Query cancelled. Showing the previous successful result below." : "Query cancelled.");
                  }}>
                    <Square size={13} />
                    Cancel query
                  </GammaButton>
                )}
              </div>
              <TimeRangeControl
                dashboard={time}
                onChange={(next) => {
                  cancel();
                  setTime({ ...time, ...next });
                }}
              />
              {draft.query.kind === "metrics" && (
                <GammaSelect
                  aria-label="Explore result visualization"
                  value={view}
                  options={[
                    { value: "timeseries", label: "Time series" },
                    { value: "bar", label: "Bar chart" },
                    { value: "table", label: "Table" },
                    { value: "stat", label: "Single value" },
                    { value: "heatmap", label: "Status heatmap" },
                  ]}
                  onValueChange={(value) => setView(value as Widget["type"])}
                />
              )}
              {draft.query.kind === "records" && <GammaSelect
                aria-label="Explore record visualization"
                value={isRecordView(view) ? view : "record-table"}
                options={[
                  { value: "record-table", label: "Records table" },
                  { value: "record-list", label: "Record cards" },
                  { value: "record-treemap", label: "Treemap" },
                  { value: "record-matrix", label: "Matrix" },
                  { value: "records-line", label: "Record line chart" },
                  { value: "records-bar", label: "Record bar chart" },
                ]}
                onValueChange={setView}
              />}
            </div>
            </div>
            <div className={styles.resultsBody}>
            {!!draft.parameters.length && (
              <div className={styles.testValues}>
                {draft.parameters.map((parameter, index) => (
                  <label className={styles.field} key={index}>
                    <span>{parameter.label ||
                      parameter.name ||
                      `Parameter ${index + 1}`}</span>
                    <GammaInput
                      aria-label={`Test value for ${parameter.name || `parameter ${index + 1}`}`}
                      size="sm"
                      value={
                        Object.hasOwn(testValues, parameter.name)
                          ? testValues[parameter.name]
                          : ""
                      }
                      placeholder={
                        parameter.hasDefault
                          ? `Default: ${parameter.defaultText || '""'}`
                          : "Required value"
                      }
                      inputMode={
                        parameter.type === "number" ? "decimal" : undefined
                      }
                      maxLength={1024}
                      onChange={(event) => {
                        cancel();
                        setTestValues({
                          ...testValues,
                          [parameter.name]: event.target.value,
                        });
                      }}
                    />
                    {Object.hasOwn(testValues, parameter.name) && (
                      <GammaButton
                        variant="quiet"
                        size="sm"
                        aria-label="Reset test value"
                        onClick={() => {
                          cancel();
                          setTestValues(
                            Object.fromEntries(
                              Object.entries(testValues).filter(
                                ([name]) => name !== parameter.name,
                              ),
                            ),
                          );
                        }}
                      >
                        Reset
                      </GammaButton>
                    )}
                  </label>
                ))}
              </div>
            )}
            {runNotice && <p role="status" className={styles.resultMeta}>{runNotice}</p>}
            {activeRunError && (
              <p role="alert" className={styles.error}>
                {activeRunError}{executed && !stale && " Showing the previous successful result below."}
              </p>
            )}
            {stale && (
              <p role="status" className={styles.stale}>
                {activeRunError
                  ? "Latest run failed. Showing the previous result for different inputs."
                  : "Inputs changed. Showing the previous result; run the query to update it."}
              </p>
            )}
            {executed ? (
              <>
                {running && <p className={styles.resultMeta}>Running query… Showing the previous successful result until it completes.</p>}
                {resultSummary && <div className={styles.resultSummary} role="status" aria-label="Result summary">
                  <span>{resultSummary.detail} returned</span>
                  {resultSummary.partial && <span>Partial provider response · data may be incomplete.</span>}
                </div>}
                {executed.query.kind === "records" && !!previewFields.length && <div className={styles.testValues} aria-label="Record preview columns">
                  {previewFields.map(field => <label className={styles.field} key={field.key}>
                    <span>{field.label}</span>
                    <GammaSelect aria-label={`Preview ${field.label.toLowerCase()}`} value={previewMapping[field.key] ?? ""}
                      options={[{ value: "", label: "Choose a column" }, ...previewColumns.filter(column => !field.numeric || column.type === "number").map(column => ({ value: column.key, label: column.label || column.key }))]}
                      onValueChange={value => setRecordMappings(current => ({ ...current, [view]: { ...current[view], [field.key]: value } }))} />
                  </label>)}
                </div>}
                <div className={styles.resultView}>
                  {executed.query.kind === "records" && !previewReady ? <p role="status" className={styles.resultMeta}>Choose the result columns to preview this visualization.</p> : <WidgetVisualization
                    widget={resultWidget(executed.query, view, previewConfig)}
                    result={executed.result}
                  />}
                </div>
                <details className={styles.executedQuery}>
                  <summary>Executed query</summary>
                  <p className={styles.resultMeta}>
                    {new Date(executed.start * 1000).toLocaleString()} —{" "}
                    {new Date(executed.end * 1000).toLocaleString()}
                  </p>
                  <pre>{executed.query.query}</pre>
                </details>
              </>
            ) : (
              <div className={styles.empty}>
                <span className={styles.emptyIcon}><Activity size={23} aria-hidden="true" /></span>
                <h3>{running ? "Running query…" : activeRunError ? "Query failed" : "Ready when you are"}</h3>
                <p>
                  {running
                    ? "You can cancel this request while it runs."
                    : activeRunError
                    ? "Check the query and test values, then run it again."
                    : "Write a query, then select Run query to see results."}
                </p>
              </div>
            )}
            </div>
          </section>
          <section className={styles.saveCard} aria-label="Save query">
            <div className={styles.sectionHeading}>
              <div>
                <h2><Bookmark size={16} aria-hidden="true" /> Query details</h2>
              </div>
              {persisted && (
                <GammaButton variant="quiet" size="sm" iconOnly aria-label="Delete query" disabled={busy} onClick={remove}>
                  <Trash2 size={14} />
                </GammaButton>
              )}
            </div>
            <fieldset disabled={busy} className={styles.detailsFields}>
              <GammaTabs
                label="Query details sections"
                value={detailsTab}
                onChange={setDetailsTab}
                tabs={[
                  {
                    id: "overview",
                    title: "Overview",
                    content: <div className={styles.detailsSection}>
                      <div>
                        <label className={styles.field}>
                          Query name
                          <GammaInput
                            aria-label="Query name"
                            value={draft.query.name}
                            maxLength={120}
                            placeholder="For example, Service availability"
                            onChange={(event) =>
                              updateQuery({ name: event.target.value })
                            }
                          />
                        </label>
                      </div>
                      <label className={styles.field}>
                        <span>Description <span className={styles.optional}>(optional)</span></span>
                        <GammaTextarea
                          aria-label="Query description"
                          value={draft.query.description ?? ""}
                          maxLength={500}
                          rows={4}
                          className={styles.description}
                          placeholder="What does this query measure?"
                          onChange={(event) =>
                            updateQuery({ description: event.target.value })
                          }
                        />
                      </label>
                      <SavedQueryDetailsEditor key={`${draft.query.id}:tags`} query={draft.query} onChange={updateQuery} disabled={busy} section="tags" collapsible={false} />
                    </div>,
                  },
                  {
                    id: "parameters",
                    title: `Parameters${draft.parameters.length ? ` (${draft.parameters.length})` : ""}`,
                    content: <div className={styles.detailsSection}>
                      <section
                        className={styles.parameters}
                        aria-label="Query parameters"
                      >
                        <div className={styles.sectionHeading}>
                          <div>
                            <h3>Parameters</h3>
                            <p>
                              Use <code>{"{{name}}"}</code> for a dashboard filter or widget context.
                            </p>
                          </div>
                          <GammaButton
                            size="sm"
                            disabled={draft.parameters.length >= 20}
                            onClick={() =>
                              change({
                                ...draft,
                                parameters: [
                                  ...draft.parameters,
                                  {
                                    name: "",
                                    label: "",
                                    type: "string",
                                    hasDefault: false,
                                    defaultText: "",
                                  },
                                ],
                              })
                            }
                          >
                            <Plus size={14} />
                            Add parameter
                          </GammaButton>
                        </div>
                        {draft.parameters.map((parameter, index) => (
                          <div className={styles.parameter} key={index}>
                            <div className={styles.parameterHeading}>
                              <strong>Parameter {index + 1}</strong>
                              <GammaButton
                                iconOnly
                                size="sm"
                                variant="quiet"
                                aria-label={`Remove parameter ${index + 1}`}
                                onClick={() =>
                                  change({
                                    ...draft,
                                    parameters: draft.parameters.filter(
                                      (_, item) => item !== index,
                                    ),
                                  })
                                }
                              >
                                <Trash2 size={14} />
                              </GammaButton>
                            </div>
                            <div className={styles.parameterFields}>
                              <label className={styles.field}>
                                Name
                                <GammaInput
                                  aria-label={`Parameter ${index + 1} name`}
                                  value={parameter.name}
                                  maxLength={64}
                                  onChange={(event) =>
                                    updateParameter(index, { name: event.target.value })
                                  }
                                />
                              </label>
                              <label className={styles.field}>
                                <span>Label <span className={styles.optional}>(optional)</span></span>
                                <GammaInput
                                  aria-label={`Parameter ${index + 1} label`}
                                  value={parameter.label}
                                  maxLength={80}
                                  onChange={(event) =>
                                    updateParameter(index, {
                                      label: event.target.value,
                                    })
                                  }
                                />
                              </label>
                              <label className={styles.field}>
                                Type
                                <GammaSelect
                                  aria-label={`Parameter ${index + 1} type`}
                                  value={parameter.type}
                                  disabled={busy}
                                  options={[
                                    { value: "string", label: "Text" },
                                    { value: "number", label: "Number" },
                                  ]}
                                  onValueChange={(type) =>
                                    updateParameter(index, {
                                      type: type as ParameterDraft["type"],
                                    })
                                  }
                                />
                              </label>
                            </div>
                            <GammaSwitch
                              label={`Default for parameter ${index + 1}`}
                              description="Required at run time when no default is set."
                              checked={parameter.hasDefault}
                              onChange={(hasDefault) =>
                                updateParameter(index, { hasDefault })
                              }
                            />
                            {parameter.hasDefault && (
                              <label className={styles.field}>
                                Saved default
                                <GammaInput
                                  aria-label={`Parameter ${index + 1} default`}
                                  value={parameter.defaultText}
                                  inputMode={
                                    parameter.type === "number" ? "decimal" : undefined
                                  }
                                  maxLength={1024}
                                  onChange={(event) =>
                                    updateParameter(index, {
                                      defaultText: event.target.value,
                                    })
                                  }
                                />
                              </label>
                            )}
                          </div>
                        ))}
                      </section>
                      {!draft.parameters.length && <p className={styles.parameterEmpty}>Add a parameter to reuse this query for different services, environments or other filters.</p>}
                    </div>,
                  },
                  {
                    id: "metadata",
                    title: "Metadata",
                    content: <div className={styles.detailsSection}>
                      <p className={styles.detailsIntro}>Add a cover and context to make this query easier to find in your library.</p>
                      <SavedQueryDetailsEditor key={`${draft.query.id}:metadata`} query={draft.query} onChange={updateQuery} disabled={busy} section="metadata" collapsible={false} />
                    </div>,
                  },
                ]}
              />
            </fieldset>
            {error && (
              <div role="alert" className={styles.error}>
                <p>{error}</p>
                {persisted && saveRecovery && (
                  <div className={styles.actions}>
                    <GammaButton size="sm" disabled={busy} onClick={reload}>
                      Load latest saved version
                    </GammaButton>
                    <GammaButton
                      size="sm"
                      disabled={busy || !queryValid}
                      onClick={() => save(true)}
                    >
                      <Copy size={14} />
                      Save as new query
                    </GammaButton>
                  </div>
                )}
              </div>
            )}
            {notice && (
              <p role="status" className={styles.hint}>
                {notice}
              </p>
            )}
            {remoteChanged && (
              <div className={styles.stale} role="status">
                The saved query changed or was removed elsewhere. Your draft is
                preserved.{" "}
                {(!error || !saveRecovery) && (
                  <GammaButton size="sm" disabled={busy} onClick={reload}>
                    Load latest saved version
                  </GammaButton>
                )}
              </div>
            )}
            <div className={styles.saveActions}>
              <div className={styles.actions}>
                <GammaButton
                  variant="primary"
                  disabled={busy || !provider || !queryValid}
                  loading={busy}
                  onClick={() => save()}
                >
                  <Save size={14} />
                  Save query
                </GammaButton>
                <GammaButton
                  disabled={busy || !persisted || dirty || remoteChanged}
                  onClick={() => {
                    if (!persisted) return;
                    setSaveRecovery(false);
                    setNotice("");
                    try {
                      const document = { ...persisted };
                      delete document.etag;
                      onUse(document);
                    } catch (error) {
                      setError(message(error));
                    }
                  }}
                >
                  <ArrowUpRight size={14} />
                  Use in dashboard
                </GammaButton>
              </div>

            </div>
            {!persisted || dirty ? (
              <p className={styles.hint}>
                Save first to use this query in a dashboard.
              </p>
            ) : null}
          </section>
      </div>
      <GammaConfirmation
        request={confirmation.request}
        onResolve={confirmation.resolve}
      />
    </section>
  );
}
