"use client";

import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  MAX_DASHBOARD_VARIABLES,
  type DataKind,
  type Provider,
  type TooltipQuerySource,
  type TooltipView,
  type Widget,
} from "./schema";
import { getWidgetDefinition, useWidgetDefinitions } from "./widget-registry";
import { GammaButton } from "./gamma/button";
import { GammaInput, GammaTextarea } from "./gamma/input";
import { GammaSelect, type GammaSelectOption } from "./gamma/select";
import { providerOption, QuerySourceIcon } from "./source-identity";
import { GammaSwitch } from "./gamma/switch";
import styles from "./tooltip-editor.module.css";
import { useSavedQueryLibrary } from "./saved-query-context";
import {
  SavedQueryPicker,
  SavedQueryBindingEditor,
} from "./saved-query-controls";
import { tooltipMappingSuggestions, type QueryFields } from "./query-connections";
import { GraphDataFields, GraphLabelPicker } from "./query-connection-controls";
import { QueryCodeEditor } from "./query-code-editor";
import type { InsightsClient } from "./client";

export interface TooltipEditorProps {
  view: TooltipView | undefined;
  providers: Provider[];
  client?: InsightsClient;
  parentProviderId?: string;
  parentColor?: string;
  parentFields?: QueryFields;
  parentQueryRef?: Widget["queryRef"];
  hostType?: Widget["type"];
  onChange: (view: TooltipView | undefined) => void;
  /** Kept with the widget draft so invalid JSON survives tab and tooltip changes. */
  pluginConfig: string;
  onPluginConfigChange: (source: string) => void;
}

export function TooltipEditor({
  view,
  providers,
  client,
  parentProviderId,
  parentColor,
  parentFields,
  parentQueryRef,
  hostType = "heatmap",
  onChange,
  pluginConfig,
  onPluginConfigChange,
}: TooltipEditorProps) {
  const definitions = useWidgetDefinitions();
  const library = useSavedQueryLibrary();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<{ message: string; queries: typeof library.queries } | null>(null);
  const savedDrafts = useRef<
    Partial<
      Record<
        DataKind,
        Extract<NonNullable<TooltipView["source"]>, { type: "saved" }>
      >
    >
  >({});
  const queryDrafts = useRef<Partial<Record<DataKind, TooltipQuerySource>>>({});
  const labelDrafts = useRef<Partial<Record<DataKind, string[]>>>({});
  const observation =
    hostType === "timeseries"
      ? "point"
      : hostType === "table"
        ? "row"
        : hostType === "bar"
          ? "bar"
          : "cell";
  const kind: DataKind =
    view?.type === "traces" ||
    (view?.type === "plugin" && view.dataKind === "traces")
      ? "traces"
      : "metrics";
  const selected = view
    ? getWidgetDefinition(view.type, view.pluginId)
    : undefined;
  const compatible = providers.filter((provider) =>
    provider.capabilities.includes(kind),
  );
  const source = view?.source?.type === "query" ? view.source : undefined;
  const savedSource = view?.source?.type === "saved" ? view.source : undefined;
  const savedQuery = library.queries.find(
    (entry) => entry.id === savedSource?.ref.id,
  );
  const hasSavedQueries = library.queries.some((entry) => entry.kind === kind);
  const libraryLoading = library.loading || refreshing;
  const libraryError = (refreshError?.queries === library.queries ? refreshError.message : "") || library.error;
  const chart = view?.type === "timeseries" || view?.type === "bar";
  const gauge = view?.type === "plugin" && view.pluginId === "threshold-gauge";
  const knownRenderer = view?.type !== "plugin" || gauge;
  const sourceProvider =
    source && compatible.find((provider) => provider.id === source.providerId);
  const mappingSuggestions = source ? tooltipMappingSuggestions(source, parentFields) : [];
  const parentSavedQuery = library.queries.find((query) => query.id === parentQueryRef?.id);
  const parentBindings = parentQueryRef ? [
    ...(parentQueryRef.bindings ?? []),
    ...(parentSavedQuery?.parameters ?? []).flatMap((parameter) => parameter.defaultValue !== undefined && !parentQueryRef.bindings?.some((binding) => binding.parameter === parameter.name)
      ? [{ parameter: parameter.name, source: "constant" as const, value: parameter.defaultValue }] : []),
  ] : undefined;

  function queryDraft(dataKind: DataKind): TooltipQuerySource {
    return (
      queryDrafts.current[dataKind] ?? {
        type: "query",
        providerId:
          providers.find(
            (provider) =>
              provider.id === parentProviderId &&
              provider.capabilities.includes(dataKind),
          )?.id ??
          providers.find((provider) => provider.capabilities.includes(dataKind))
            ?.id ??
          "",
        query: "",
      }
    );
  }
  function update(patch: Partial<TooltipView>) {
    if (view) onChange({ ...view, ...patch });
  }
  function updateSource(patch: Partial<TooltipQuerySource>) {
    if (!view || !source) return;
    const next = { ...source, ...patch };
    queryDrafts.current[kind] = next;
    onChange({ ...view, source: next });
  }
  function chooseBindingSource(index: number, field: string) {
    if (!source?.bindings) return;
    const binding = source.bindings[index];
    const labels = (labelDrafts.current[kind] ??= []);
    if ("label" in binding) labels[index] = binding.label;
    updateSource({
      bindings: source.bindings.map((item, current) =>
        current !== index
          ? item
          : field === "label"
            ? { variable: item.variable, label: labels[index] ?? "" }
            : {
                variable: item.variable,
                field: field as "value" | "timestamp" | "series",
              },
      ),
    });
  }
  function chooseVisualization(value: string) {
    const definition = definitions.find(
      (item) =>
        (item.type === "plugin" ? `plugin:${item.id}` : item.type) === value,
    );
    if (!definition || !view) return;
    if (source) queryDrafts.current[kind] = source;
    if (savedSource) savedDrafts.current[kind] = savedSource;
    const next: TooltipView = { ...view, type: definition.type };
    delete next.pluginId;
    delete next.dataKind;
    delete next.config;
    if (definition.type === "plugin") {
      next.pluginId = definition.id;
      next.dataKind = definition.dataKind;
      if (view.pluginId === definition.id) next.config = view.config;
      else onPluginConfigChange("{}");
    }
    if (definition.dataKind !== kind)
      next.source =
        savedDrafts.current[definition.dataKind] ??
        (definition.dataKind === "traces" || queryDrafts.current.metrics
          ? queryDraft(definition.dataKind)
          : undefined);
    onChange(next);
  }
  const visualizationOptions = definitions.map((definition) => ({
    value:
      definition.type === "plugin"
        ? `plugin:${definition.id}`
        : definition.type,
    label: definition.label,
  }));
  if (view && !selected)
    visualizationOptions.unshift({
      value: `plugin:${view.pluginId}`,
      label: `Unavailable plugin: ${view.pluginId}`,
    });
  const providerOptions: GammaSelectOption[] = compatible.map(providerOption);
  if (source?.providerId && !sourceProvider)
    providerOptions.unshift({
      value: source.providerId,
      label: `Unavailable: ${source.providerId}`,
    });

  return (
    <fieldset className={styles.editor}>
      <legend>Tooltip widget</legend>
      {!view && (
        <>
          <p className={styles.hint}>
            Details are shown by default. Add a chart, value or table alongside
            them.
          </p>
          <GammaButton
            variant="primary"
            onClick={() => onChange({ type: "timeseries" })}
          >
            <Plus size={15} /> Add tooltip widget
          </GammaButton>
          <GammaButton
            variant="secondary"
            onClick={() => onChange({ type: "timeseries", source: { type: "saved", ref: { id: "" } } })}
          >
            Use saved query
          </GammaButton>
        </>
      )}
      {view && (
        <>
          <GammaButton
            variant="quiet"
            className={styles.removeWidget}
            onClick={() => onChange(undefined)}
          >
            <Trash2 size={14} /> Remove tooltip widget
          </GammaButton>
          <div className={styles.field}>
            <span>Visualization</span>
            <GammaSelect
              aria-label="Tooltip visualization"
              value={
                view.type === "plugin" ? `plugin:${view.pluginId}` : view.type
              }
              options={visualizationOptions}
              onValueChange={chooseVisualization}
            />
          </div>
          {!selected && (
            <p className={styles.error} role="alert">
              Choose an available tooltip visualization before applying.
            </p>
          )}
          <div className={styles.field}>
            <span>Data for this tooltip</span>
            <GammaSelect
              aria-label="Tooltip data source"
              value={view.source?.type ?? "series"}
              options={[
                {
                  value: "series",
                  label: "Hovered series",
                  icon: <QuerySourceIcon kind="series" />,
                  disabled: kind === "traces",
                },
                {
                  value: "widget",
                  label: "Existing widget query data",
                  icon: <QuerySourceIcon kind="widget" />,
                  disabled: kind === "traces",
                },
                { value: "query", label: "Provider query", icon: <QuerySourceIcon kind="provider" /> },
                { value: "saved", label: "Saved query", icon: <QuerySourceIcon kind="saved" /> },
              ]}
              onValueChange={(value) => {
                if (source) queryDrafts.current[kind] = source;
                if (savedSource) savedDrafts.current[kind] = savedSource;
                update({
                  source:
                    value === "query"
                      ? queryDraft(kind)
                      : value === "saved"
                        ? (savedDrafts.current[kind] ?? {
                            type: "saved",
                            ref: { id: "" },
                          })
                        : value === "widget"
                          ? { type: "widget" }
                          : undefined,
                });
              }}
            />
          </div>
          {savedSource ? (
            <section className={styles.query} aria-label="Tooltip saved query">
              {parentQueryRef && parentSavedQuery?.kind === kind && parentQueryRef.id !== savedSource.ref.id && <GammaButton size="sm" onClick={() => update({ source: { type: "saved", ref: { ...parentQueryRef, bindings: parentQueryRef.bindings?.map((binding) => ({ ...binding })) } } })}>Use graph’s saved query</GammaButton>}
              <SavedQueryPicker
                label="Tooltip saved query"
                queries={library.queries}
                kind={kind}
                value={savedSource.ref.id}
                disabled={libraryLoading}
                emptyMessage={null}
                onChange={(id) => {
                  if (id === savedSource.ref.id) return;
                  const next = { type: "saved" as const, ref: { id } };
                  savedDrafts.current[kind] = next;
                  update({ source: next });
                }}
              />
              {libraryLoading && <p className={styles.hint} role="status">Loading saved queries…</p>}
              {!libraryLoading && libraryError && (
                <p className={styles.error} role="alert">
                  {libraryError}
                </p>
              )}
              {!libraryLoading && !libraryError && !hasSavedQueries && (
                <p className={styles.hint}>
                  No saved {kind === "traces" ? "trace" : "metrics"} queries yet. Create one in Explore, then select it here.
                </p>
              )}
              {(library.onOpenExplorer || library.onRefresh) && (
                <>
                  <div className={styles.row}>
                    {library.onOpenExplorer && (
                      <GammaButton variant="secondary" onClick={() => { setRefreshError(null); library.onOpenExplorer!(); }}>
                        {hasSavedQueries || libraryLoading || libraryError ? "Manage saved queries" : "Create saved query"}
                      </GammaButton>
                    )}
                    {library.onRefresh && (
                      <GammaButton variant="quiet" disabled={libraryLoading} onClick={async () => {
                        setRefreshing(true);
                        setRefreshError(null);
                        try { await library.onRefresh!(); }
                        catch (error) { setRefreshError({ message: error instanceof Error ? error.message : "Could not refresh saved queries. Try again.", queries: library.queries }); }
                        finally { setRefreshing(false); }
                      }}>
                        Refresh saved queries
                      </GammaButton>
                    )}
                  </div>
                  {library.onOpenExplorer && (
                    <p className={styles.hint}>Save your query in Explore, then choose Dashboard to return here. Your widget draft stays intact.</p>
                  )}
                </>
              )}
              {savedQuery && (
                <>
                  <GraphDataFields fields={parentFields} />
                  <label className={styles.field}>
                    <span>Saved query template</span>
                    <GammaTextarea
                      aria-label="Tooltip saved query template"
                      className={styles.code}
                      rows={5}
                      value={savedQuery.query}
                      readOnly
                    />
                  </label>
                  <SavedQueryBindingEditor
                    query={savedQuery}
                    bindings={savedSource.ref.bindings}
                    variables={library.variables}
                    values={library.values}
                    fields={parentFields}
                    parentBindings={parentBindings}
                    allowObservation
                    onChange={(bindings) => {
                      const next = {
                        ...savedSource,
                        ref: { ...savedSource.ref, bindings },
                      };
                      savedDrafts.current[kind] = next;
                      update({ source: next });
                    }}
                  />
                </>
              )}
              <p className={styles.hint}>
                Runs the linked query when this tooltip opens. Switching to a
                custom query restores your previous provider query draft.
              </p>
              <GammaButton
                variant="secondary"
                onClick={() => {
                  savedDrafts.current[kind] = savedSource;
                  update({ source: queryDraft(kind) });
                }}
              >
                Use custom tooltip query
              </GammaButton>
            </section>
          ) : !source ? (
            <p className={styles.hint}>
              {view.source?.type === "widget"
                ? "Use the complete result already fetched by this widget, including all its series. Opening the tooltip does not run another query."
                : `Use the hovered ${observation}’s series already loaded for the dashboard’s current time range.`}
            </p>
          ) : (
            <section
              className={styles.query}
              aria-label="Tooltip provider query"
            >
              <div className={styles.field}>
                <span>Provider</span>
                <GammaSelect
                  aria-label="Tooltip provider"
                  value={source.providerId}
                  placeholder={
                    compatible.length
                      ? "Choose a provider"
                      : "No compatible provider"
                  }
                  options={providerOptions}
                  onValueChange={(providerId) => updateSource({ providerId })}
                />
              </div>
              {!sourceProvider && (
                <p className={styles.error} role="alert">
                  Choose a connected {kind === "traces" ? "trace" : "metrics"}{" "}
                  provider. Your query stays here while you configure it.
                </p>
              )}
              <div className={styles.field}>
                <span>
                  {kind === "traces" ? "TraceQL query" : "PromQL query"}
                </span>
                <QueryCodeEditor
                  label={
                    kind === "traces"
                      ? "Tooltip TraceQL query"
                      : "Tooltip PromQL query"
                  }
                  language={kind === "traces" ? "traceql" : "promql"}
                  provider={sourceProvider || undefined}
                  providerId={source.providerId}
                  client={client}
                  parameters={source.bindings?.map((binding) => ({
                    name: binding.variable,
                    type: "label" in binding || binding.field === "series" ? "string" : "number",
                  }))}
                  value={source.query}
                  onChange={(query) =>
                    updateSource({ query })
                  }
                />
              </div>
              <p className={styles.hint}>
                Runs when the tooltip opens, using the dashboard time range. Map{" "}
                <code>{"{{variables}}"}</code> to this {observation}’s labels or
                values below; use each placeholder as a whole value without
                surrounding quotes.
              </p>
              <p className={styles.hint}>
                {kind === "metrics" ? (
                  <>
                    Label matcher: <code>{"service={{service}}"}</code>. Numeric
                    filter: <code>{"> {{value}}"}</code>. Time:{" "}
                    <code>{"@ {{time}}"}</code>.
                  </>
                ) : (
                  <>
                    For example:{" "}
                    <code>{"{ resource.service.name = {{service}} }"}</code>.
                  </>
                )}
              </p>
              <div className={styles.bindingHeading}>
                <strong>Query mappings</strong>
                <span>
                  {source.bindings?.length ?? 0}/{MAX_DASHBOARD_VARIABLES}
                </span>
              </div>
              <GraphDataFields fields={parentFields} />
              {mappingSuggestions.length > 0 && <>
                <GammaButton size="sm" onClick={() => updateSource({ bindings: [...(source.bindings ?? []), ...mappingSuggestions] })}>
                  Connect {mappingSuggestions.length} matching {mappingSuggestions.length === 1 ? "field" : "fields"}
                </GammaButton>
                <p className={styles.hint}>Matches placeholders to loaded graph labels or exact observation fields. Existing mappings stay in place.</p>
              </>}
              {(source.bindings ?? []).map((binding, index) => (
                <div className={styles.binding} key={index}>
                  <div className={styles.bindingTop}>
                    <label className={styles.field}>
                      <span>Query variable</span>
                      <GammaInput
                        aria-label={`Tooltip mapping ${index + 1} variable`}
                        value={binding.variable}
                        maxLength={64}
                        placeholder="service"
                        onChange={(event) =>
                          updateSource({
                            bindings: source.bindings!.map((item, current) =>
                              current === index
                                ? { ...item, variable: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                    <GammaButton
                      iconOnly
                      variant="quiet"
                      aria-label={`Remove tooltip mapping ${index + 1}`}
                      onClick={() => {
                        labelDrafts.current[kind]?.splice(index, 1);
                        updateSource({
                          bindings: source.bindings!.filter(
                            (_, current) => current !== index,
                          ),
                        });
                      }}
                    >
                      <Trash2 size={15} />
                    </GammaButton>
                  </div>
                  <div className={styles.field}>
                    <span>Data from</span>
                    <GammaSelect
                      aria-label={`Tooltip mapping ${index + 1} source`}
                      value={"label" in binding ? "label" : binding.field}
                      options={[
                        { value: "label", label: "Label" },
                        { value: "value", label: "Value" },
                        { value: "timestamp", label: "Timestamp" },
                        { value: "series", label: "Series" },
                      ]}
                      onValueChange={(value) =>
                        chooseBindingSource(index, value)
                      }
                    />
                  </div>
                  {"label" in binding ? (
                    <label className={styles.field}>
                      <span>Label name</span>
                      <GraphLabelPicker
                        label={`Tooltip mapping ${index + 1} hovered label`}
                        value={binding.label}
                        fields={parentFields}
                        onChange={(label) =>
                          updateSource({
                            bindings: source.bindings!.map((item, current) =>
                              current === index
                                ? {
                                    variable: item.variable,
                                    label,
                                  }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                  ) : (
                    <p className={styles.hint}>
                      {binding.field === "value"
                        ? `The hovered ${observation}’s exact numeric value. Missing values do not run the query.`
                        : binding.field === "timestamp"
                          ? `The hovered ${observation}’s observation time as Unix seconds, including fractional seconds.`
                          : `The hovered ${observation}’s complete series name, safely quoted as text.`}
                    </p>
                  )}
                </div>
              ))}
              <GammaButton
                variant="secondary"
                disabled={
                  (source.bindings?.length ?? 0) >= MAX_DASHBOARD_VARIABLES
                }
                onClick={() => {
                  (labelDrafts.current[kind] ??= [])[
                    source.bindings?.length ?? 0
                  ] = "";
                  updateSource({
                    bindings: [
                      ...(source.bindings ?? []),
                      { variable: "", label: "" },
                    ],
                  });
                }}
              >
                <Plus size={14} /> Add query mapping
              </GammaButton>
              <p className={styles.hint}>
                Labels and series are quoted text; values and timestamps are
                numbers. If mapped data is missing on the hovered {observation},
                the tooltip explains the issue and does not run the query.
              </p>
            </section>
          )}
          <label className={styles.field}>
            <span>Title</span>
            <GammaInput
              aria-label="Tooltip title"
              value={view.title ?? ""}
              maxLength={120}
              placeholder="Use visualization title"
              onChange={(event) =>
                update({ title: event.target.value || undefined })
              }
            />
          </label>
          {view.type === "stat" && (
            <>
              <GammaSwitch
                label="Show sparkline"
                checked={view.showSparkline === true}
                onChange={(showSparkline) => update({ showSparkline })}
              />
              <p className={styles.hint}>Show the value’s history over the dashboard time range, using the same query result.</p>
            </>
          )}
          <div className={styles.field}>
            <span>Height</span>
            <GammaSelect
              aria-label="Tooltip chart height"
              value={String(view.height ?? 160)}
              options={[
                { value: "120", label: "Compact" },
                { value: "160", label: "Standard" },
                { value: "200", label: "Expanded" },
                { value: "320", label: "Tall" },
              ]}
              onValueChange={(value) =>
                update({ height: Number(value) as TooltipView["height"] })
              }
            />
          </div>
          <div className={styles.row}>
            {kind === "metrics" && (
              <label className={styles.field}>
                <span>Unit</span>
                <GammaInput
                  aria-label="Tooltip unit"
                  value={view.unit ?? ""}
                  maxLength={24}
                  placeholder="Use widget unit"
                  onChange={(event) =>
                    update({ unit: event.target.value || undefined })
                  }
                />
              </label>
            )}
            {knownRenderer && (
              <label className={styles.field}>
                <span>Decimal places</span>
                <GammaInput
                  aria-label="Tooltip decimal places"
                  type="number"
                  min={0}
                  max={8}
                  step={1}
                  value={view.decimals ?? ""}
                  placeholder="Auto"
                  onChange={(event) =>
                    update({
                      decimals:
                        event.target.value === ""
                          ? undefined
                          : Number(event.target.value),
                    })
                  }
                />
              </label>
            )}
          </div>
          {knownRenderer && (
            <p className={styles.hint}>
              Decimal places apply to this tooltip widget and its summaries.
              Leave blank for Auto, or choose 0–8 places.
            </p>
          )}
          {(chart || view.type === "stat" || gauge) && (
            <div className={styles.row}>
              <label className={styles.field}>
                <span>Series color</span>
                <GammaInput
                  aria-label="Tooltip series color"
                  type="color"
                  value={view.color ?? parentColor ?? "#c46146"}
                  onChange={(event) => update({ color: event.target.value })}
                />
              </label>
              <GammaButton
                variant="quiet"
                onClick={() => update({ color: undefined })}
              >
                Use widget color
              </GammaButton>
            </div>
          )}
          {chart && (
            <>
              <GammaSwitch
                label="Show tooltip chart grid"
                checked={view.showGrid !== false}
                onChange={(showGrid) => update({ showGrid })}
              />
              <GammaSwitch
                label="Show tooltip chart axes"
                checked={view.showAxis !== false}
                onChange={(showAxis) => update({ showAxis })}
              />
            </>
          )}
          {(chart || view.type === "heatmap" || gauge) && (
            <GammaSwitch
              label="Show tooltip legend"
              checked={
                view.type === "timeseries" &&
                (!view.source || view.source.type === "series")
                  ? view.showLegend === true
                  : view.showLegend !== false
              }
              onChange={(showLegend) => update({ showLegend })}
            />
          )}
          {view.type === "plugin" && (
            <label className={styles.field}>
              <span>Plugin configuration</span>
              <GammaTextarea
                aria-label="Tooltip plugin configuration"
                className={styles.code}
                rows={5}
                spellCheck={false}
                value={pluginConfig}
                onChange={(event) => onPluginConfigChange(event.target.value)}
              />
            </label>
          )}
        </>
      )}
    </fieldset>
  );
}
