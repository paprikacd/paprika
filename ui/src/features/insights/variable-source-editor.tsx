"use client";

import { useEffect, useMemo, useState } from "react";
import { GammaInput } from "./gamma/input";
import { GammaSelect } from "./gamma/select";
import { SearchCombobox, type SearchComboboxOption } from "./gamma/search-combobox";
import type { DashboardVariable, Provider, SavedQuery, VariableSource } from "./schema";
import type { VariableValues } from "./drilldown";
import styles from "./drilldown.module.css";
import { planVariableSource, type VariableValueLoaders } from "./variable-options";

/** The data the editor reads to offer providers, label names, saved queries and a value preview. */
export interface VariableSourceCatalog {
  loaders: VariableValueLoaders;
  providers: Provider[];
  savedQueries: SavedQuery[];
  /** Label names of one provider, as the metadata endpoint lists them. */
  labels(providerId: string, signal: AbortSignal): Promise<string[]>;
  /** The dashboard's view range in Unix seconds. The preview covers it; without it the preview uses the last day. */
  range?: { start: number; end: number };
}

/** Where a variable's values come from. Typed choices and free text are the two without a source. */
export type VariableValuesFrom = "text" | "typed" | "labelValues" | "savedQuery";

export function valuesFromOf(variable: DashboardVariable): VariableValuesFrom {
  if (variable.source?.type === "labelValues") return "labelValues";
  if (variable.source?.type === "savedQuery") return "savedQuery";
  return variable.options ? "typed" : "text";
}

/** The source a chooser change starts from. Typed choices keep the variable's options as they are. */
export function sourceFor(from: VariableValuesFrom): VariableSource | undefined {
  if (from === "labelValues") return { type: "labelValues", providerId: "", label: "" };
  if (from === "savedQuery") return { type: "savedQuery", queryRef: { id: "" }, field: "" };
  return undefined;
}

/** The preview's window when the catalog names no view range: the last day. */
const PREVIEW_WINDOW_SECONDS = 24 * 60 * 60;
const PREVIEW_DEBOUNCE_MS = 300;
const PREVIEW_SHOWN = 5;

type Preview =
  | { state: "idle"; message: string }
  | { state: "loading" }
  | { state: "ready"; values: string[]; truncated: boolean }
  | { state: "error"; message: string };

/**
 * Previews the first values a source returns over the last day, through the planner the viewer uses. Defaults
 * stand in for the variables a selector reads, so a preview shows what the dashboard shows at its default values.
 * States known before a request are derived during render; only a settled request is kept in state, under its key,
 * so a result for earlier inputs is never shown.
 */
function useSourcePreview(variable: DashboardVariable, loaders: VariableValueLoaders, defaults: VariableValues, refusal: string | undefined, range: { start: number; end: number } | undefined): Preview {
  const source = variable.source;
  const complete = source?.type === "labelValues"
    ? Boolean(source.providerId && source.label)
    : Boolean(source?.type === "savedQuery" && source.queryRef.id && source.field);
  const key = JSON.stringify([source, defaults, complete, refusal, range ?? null]);
  // The plan's state does not depend on the range, so a zero range plans during render. A fetch is planned in the
  // effect, where the time window is read.
  const plan = useMemo(() => {
    if (refusal || !source || !complete) return undefined;
    return planVariableSource(variable, defaults, { start: 0, end: 0 }, "preview");
    // The key carries every input the plan reads; the variable object is recreated on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const [settled, setSettled] = useState<{ key: string; preview: Preview } | undefined>(undefined);
  useEffect(() => {
    if (plan?.state !== "fetch") return;
    const now = Math.floor(Date.now() / 1000);
    const sourceWindow = range ?? { start: now - PREVIEW_WINDOW_SECONDS, end: now };
    const fetchPlan = planVariableSource(variable, defaults, sourceWindow, "preview");
    if (fetchPlan?.state !== "fetch") return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetchPlan.run(loaders, controller.signal).then(
        (result) => setSettled({ key, preview: { state: "ready", values: result.values, truncated: result.truncated } }),
        (cause: unknown) => {
          if (controller.signal.aborted) return;
          setSettled({ key, preview: { state: "error", message: cause instanceof Error ? cause.message : "Preview failed" } });
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // The key carries the inputs; the planned variable and defaults are read from the same render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, plan, loaders]);
  if (refusal) return { state: "idle", message: refusal };
  if (!source || !complete) return { state: "idle", message: "Choose a source to preview its values." };
  if (!plan) return { state: "idle", message: "" };
  if (plan.state === "needs_variable") return { state: "idle", message: `Preview needs a default value for ${plan.parent}.` };
  if (plan.state === "invalid") return { state: "error", message: plan.error };
  if (settled?.key === key) return settled.preview;
  return { state: "loading" };
}

/** Names the window the preview read: the dashboard's view range when the catalog has one, else the last day. */
function previewWindowText(range: { start: number; end: number } | undefined): string {
  return range ? "in the dashboard's time range" : "in the last 24 hours";
}

function PreviewLine({ preview, windowText }: { preview: Preview; windowText: string }) {
  if (preview.state === "loading") return <p className={styles.help} role="status">Loading preview…</p>;
  if (preview.state === "error") return <p className={styles.error} role="alert">Preview failed: {preview.message}</p>;
  if (preview.state === "idle") return <p className={styles.help} role="status">{preview.message}</p>;
  const count = preview.values.length;
  const shown = preview.values.slice(0, PREVIEW_SHOWN).map((value) => value || "Empty value").join(", ");
  const more = count > PREVIEW_SHOWN ? ", …" : "";
  return <p className={styles.help} role="status">
    {count === 0 ? `No values ${windowText}` : `${count}${preview.truncated ? "+" : ""} ${count === 1 ? "value" : "values"} ${windowText} · ${shown}${more}`}
  </p>;
}

export interface VariableSourceFieldsProps {
  index: number;
  variable: DashboardVariable;
  /** Defaults of the other variables, which a selector or saved query binding can read. */
  defaults: VariableValues;
  catalog: VariableSourceCatalog;
  onChange: (next: DashboardVariable) => void;
}

/** The fields for a label-values or saved-query source, with a live preview of its first values. */
export function VariableSourceFields({ index, variable, defaults, catalog, onChange }: VariableSourceFieldsProps) {
  const source = variable.source;
  const providerType = source?.type === "labelValues" ? catalog.providers.find((provider) => provider.id === source.providerId)?.type : undefined;
  const refusal = source?.type === "labelValues" && source.selector !== undefined && providerType !== undefined && providerType !== "prometheus"
    ? "A selector needs a Prometheus provider, so no values are requested."
    : undefined;
  const preview = useSourcePreview(variable, catalog.loaders, defaults, refusal, catalog.range);
  if (!source) return null;
  const label = `Variable ${index + 1}`;
  if (source.type === "labelValues") {
    return <LabelValuesFields label={label} source={source} catalog={catalog} preview={preview} onChange={(next) => onChange({ ...variable, source: next })} />;
  }
  const savedQueries = catalog.savedQueries.filter((query) => query.kind !== "traces");
  return <div className={styles.field}>
    <label className={styles.field}>
      <span>Saved query</span>
      <GammaSelect
        aria-label={`${label} saved query`}
        value={source.queryRef.id}
        placeholder="Choose a saved query"
        options={savedQueries.map((query) => ({ value: query.id, label: query.name, description: query.kind }))}
        onValueChange={(id) => onChange({ ...variable, source: { ...source, queryRef: { ...source.queryRef, id } } })}
      />
    </label>
    <label className={styles.field}>
      <span>Column or label</span>
      <GammaInput
        aria-label={`${label} column or label`}
        value={source.field}
        maxLength={128}
        placeholder="service"
        onChange={(event) => onChange({ ...variable, source: { ...source, field: event.target.value } })}
      />
    </label>
    <p className={styles.help}>Records saved queries use a column name; metrics saved queries use a series label. Bindings stay as they are.</p>
    <PreviewLine preview={preview} windowText={previewWindowText(catalog.range)} />
  </div>;
}

function LabelValuesFields({ label, source, catalog, preview, onChange }: {
  label: string;
  source: Extract<VariableSource, { type: "labelValues" }>;
  catalog: VariableSourceCatalog;
  preview: Preview;
  onChange: (next: VariableSource) => void;
}) {
  const providers = catalog.providers.filter((provider) => provider.type === "prometheus" || provider.type === "tempo");
  const chosen = catalog.providers.find((provider) => provider.id === source.providerId);
  const [labels, setLabels] = useState<{ providerId: string; names: string[]; failed: boolean } | undefined>(undefined);
  useEffect(() => {
    if (!source.providerId) return;
    const controller = new AbortController();
    catalog.labels(source.providerId, controller.signal).then(
      (names) => { if (!controller.signal.aborted) setLabels({ providerId: source.providerId, names, failed: false }); },
      () => { if (!controller.signal.aborted) setLabels({ providerId: source.providerId, names: [], failed: true }); },
    );
    return () => controller.abort();
    // Labels load once per provider; the catalog object is recreated on each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source.providerId]);
  const loadedLabels = labels?.providerId === source.providerId ? labels : undefined;
  const labelOptions: SearchComboboxOption[] = (loadedLabels?.names ?? []).map((name) => ({ value: name, label: name }));
  const selectorNeedsPrometheus = Boolean(source.selector !== undefined && chosen && chosen.type !== "prometheus");
  return <div className={styles.field}>
    <label className={styles.field}>
      <span>Provider</span>
      <GammaSelect
        aria-label={`${label} provider`}
        value={source.providerId}
        placeholder="Choose a provider"
        options={providers.map((provider) => ({ value: provider.id, label: provider.name, description: provider.type }))}
        onValueChange={(providerId) => onChange({ ...source, providerId, label: "" })}
      />
    </label>
    <label className={styles.field} htmlFor={`${label}-label-name`}>
      <span>Label</span>
    </label>
    <SearchCombobox
      id={`${label}-label-name`}
      aria-label={`${label} label name`}
      options={labelOptions}
      value={source.label || null}
      clearable={false}
      placeholder="Choose or type a label"
      loading={Boolean(source.providerId) && !loadedLabels}
      loadingMessage="Loading labels…"
      emptyMessage={loadedLabels?.failed ? "Could not load labels" : "No labels for this provider"}
      onValueChange={(next) => { if (next !== null) onChange({ ...source, label: next }) }}
      onQueryInput={(next) => onChange({ ...source, label: next })}
    />
    <label className={styles.field}>
      <span>Selector <small>Optional</small></span>
      <GammaInput
        aria-label={`${label} selector`}
        value={source.selector ?? ""}
        maxLength={1024}
        placeholder="up{cluster={{cluster}}}"
        onChange={(event) => {
          const next = { ...source };
          if (event.target.value) next.selector = event.target.value;
          else delete next.selector;
          onChange(next);
        }}
      />
    </label>
    <p className={styles.help}>
      A PromQL series selector narrows the values, and <code>{"{{name}}"}</code> reads another variable&apos;s value.
      {" "}Only Prometheus providers take a selector.
    </p>
    {selectorNeedsPrometheus && <p className={styles.error} role="alert">This provider is not Prometheus, so the save warns and this selector will not load values.</p>}
    <PreviewLine preview={preview} windowText={previewWindowText(catalog.range)} />
  </div>;
}
