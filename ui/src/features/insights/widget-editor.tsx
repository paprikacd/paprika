import { useEffect, useRef, useState } from "react";
import { stringify as stringifyYaml } from "yaml";
import { providerOption, QuerySourceIcon } from "./source-identity";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Copy,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  widgetKind,
  widgetSchema,
  pluginConfigSchema,
  supportsTooltipView,
  type Dashboard,
  type Provider,
  type Widget,
  type WidgetOptions,
} from "./schema";
import { getWidgetDefinition, useWidgetDefinitions } from "./widget-registry";
import { PluginConfigEditor } from "./plugin-config-editor";
import type { InsightsClient } from "./client";
import { QueryBuilder, type QueryFetcher } from "./query-builder";
import { GammaTabs } from "./gamma/tabs";
import { GammaSwitch } from "./gamma/switch";
import { DrilldownEditor } from "./drilldown-editor";
import { GammaButton } from "./gamma/button";
import { GammaInput, GammaTextarea } from "./gamma/input";
import { GammaSelect } from "./gamma/select";
import styles from "./editor.module.css";
import {
  contrastRatio,
  DEFAULT_WIDGET_BACKGROUND,
  DEFAULT_WIDGET_TEXT,
  widgetTextColor,
} from "./appearance";
import { DEFAULT_HEATMAP_THRESHOLDS } from "./chart-renderers";
import { TooltipEditor } from "./tooltip-editor";
import { validateTooltipQueryTemplate } from "./tooltip-context";
import { useSavedQueryLibrary } from "./saved-query-context";
import { resolveSavedQueryReference } from "./saved-queries";
import {
  SavedQueryPicker,
  SavedQueryBindingEditor,
} from "./saved-query-controls";
import { validateLinkedTooltip } from "./saved-query-editor";

export const widgetLabels = {
  timeseries: "Time series",
  bar: "Bar chart",
  stat: "Single value",
  table: "Metrics table",
  traces: "Trace explorer",
  heatmap: "Status heatmap",
  plugin: "Plugin",
};

function StyleEditor({
  widget,
  onChange,
  onConfigureTooltips,
}: {
  widget: Widget;
  onChange: (widget: Widget) => void;
  onConfigureTooltips: () => void;
}) {
  const options = widget.options ?? {};
  const update = (patch: Partial<WidgetOptions>) =>
    onChange({ ...widget, options: { ...options, ...patch } });
  const numeric = (
    label: string,
    field: "min" | "max" | "decimals" | "lineWidth" | "fillOpacity",
    min?: number,
    max?: number,
    step = 1,
  ) => (
    <label className={styles.field}>
      {label}
      <GammaInput
        type="number"
        value={options[field] ?? ""}
        placeholder="Auto"
        min={min}
        max={max}
        step={step}
        onChange={(event) =>
          update({
            [field]:
              event.target.value === ""
                ? undefined
                : Number(event.target.value),
          })
        }
      />
    </label>
  );
  const chart = widget.type === "timeseries" || widget.type === "bar";
  const gauge =
    widget.type === "plugin" && widget.pluginId === "threshold-gauge";
  const pluginControls = getWidgetDefinition(widget)?.styleControls ?? [];
  const hasStyleControl = (control: (typeof pluginControls)[number]) =>
    widget.type !== "plugin" || pluginControls.includes(control);
  const foreground = widgetTextColor(options) ?? DEFAULT_WIDGET_TEXT;
  const background = options.background ?? DEFAULT_WIDGET_BACKGROUND;
  const textContrast = contrastRatio(foreground, background);
  const heatmapTextVisible =
    widget.type === "heatmap" &&
    (options.showLabels !== false || options.showValues !== false);
  const lowContrastCells =
    heatmapTextVisible &&
    options.textColor &&
    (options.thresholds?.length
      ? options.thresholds
      : DEFAULT_HEATMAP_THRESHOLDS
    ).some(
      (threshold) => contrastRatio(options.textColor!, threshold.color) < 4.5,
    );
  const defaultColor = gauge
    ? "#53876a"
    : widget.type === "stat"
      ? "#27332e"
      : "#c46146";
  return (
    <div className={styles.stack}>
      {supportsTooltipView(widget.type) && (
        <div className={styles.tooltipShortcut}>
          <p className={styles.hint}>
            Add a widget or change the details shown when you inspect this
            visualization.
          </p>
          <GammaButton
            type="button"
            variant="secondary"
            onClick={onConfigureTooltips}
          >
            Configure tooltips <ArrowRight size={14} />
          </GammaButton>
        </div>
      )}
      {(hasStyleControl("unit") || hasStyleControl("decimals")) && (
        <div className={styles.row}>
          {widget.type !== "traces" && hasStyleControl("unit") && (
            <label className={styles.field}>
              Unit
              <GammaInput
                value={widget.unit}
                maxLength={24}
                placeholder="ms, %, req/s"
                onChange={(event) =>
                  onChange({ ...widget, unit: event.target.value })
                }
              />
            </label>
          )}
          {hasStyleControl("decimals") && numeric("Decimal places", "decimals", 0, 8)}
        </div>
      )}
      {hasStyleControl("decimals") && (
        <p className={styles.hint}>
          Decimal places apply to displayed values and tooltip details. Leave
          blank for Auto, or choose 0–8 places.
        </p>
      )}
      {widget.type === "traces" && (
        <p className={styles.hint}>
          Trace duration is displayed in milliseconds.
        </p>
      )}
      {(["timeseries", "bar", "stat"].includes(widget.type) || pluginControls.includes("color")) && (
        <div className={styles.row}>
          <label className={styles.field}>
            Series color
            <GammaInput
              type="color"
              value={widget.color ?? defaultColor}
              onChange={(event) =>
                onChange({ ...widget, color: event.target.value })
              }
            />
          </label>
          <GammaButton
            type="button"
            variant="quiet"
            onClick={() => onChange({ ...widget, color: undefined })}
          >
            Use palette
          </GammaButton>
        </div>
      )}
      <div className={styles.row}>
        <label className={styles.field}>
          Background
          <GammaInput
            type="color"
            value={background}
            onChange={(event) => update({ background: event.target.value })}
          />
        </label>
        <label className={styles.field}>
          Text color
          <GammaInput
            type="color"
            value={foreground}
            onChange={(event) => update({ textColor: event.target.value })}
          />
        </label>
      </div>
      {(textContrast < 4.5 || lowContrastCells) && (
        <p className={styles.contrastHint} role="status">
          {textContrast < 4.5
            ? `Text contrast is ${textContrast.toFixed(1)}:1 on this background. Aim for at least 4.5:1.`
            : "Text needs more contrast on a heatmap color. Choose a different text or threshold color."}
        </p>
      )}
      {widget.type === "timeseries" && (
        <>
          <div className={styles.row}>
            <label className={styles.field}>
              Display
              <GammaSelect
                aria-label="Display"
                value={options.display ?? "line"}
                onValueChange={(value) =>
                  update({
                    display: value as WidgetOptions["display"],
                  })
                }
                options={[
                  { value: "line", label: "Line" },
                  { value: "area", label: "Area" },
                ]}
              />
            </label>
            <label className={styles.field}>
              Curve
              <GammaSelect
                aria-label="Curve"
                value={options.curve ?? "linear"}
                onValueChange={(value) =>
                  update({
                    curve: value as WidgetOptions["curve"],
                  })
                }
                options={[
                  { value: "linear", label: "Linear" },
                  { value: "monotone", label: "Smooth" },
                  { value: "step", label: "Step" },
                ]}
              />
            </label>
          </div>
          <div className={styles.row}>
            {numeric("Line width", "lineWidth", 0.5, 8, 0.5)}
            {options.display === "area" &&
              numeric("Fill opacity", "fillOpacity", 0, 1, 0.05)}
          </div>
        </>
      )}
      {chart && (
        <>
          <div className={styles.row}>
            <label className={styles.field}>
              X axis label
              <GammaInput
                value={options.xAxisLabel ?? ""}
                maxLength={80}
                onChange={(event) => update({ xAxisLabel: event.target.value })}
              />
            </label>
            <label className={styles.field}>
              Y axis label
              <GammaInput
                value={options.yAxisLabel ?? ""}
                maxLength={80}
                onChange={(event) => update({ yAxisLabel: event.target.value })}
              />
            </label>
          </div>
          {chart && (
            <>
              <div className={styles.row}>
                {numeric("Y minimum", "min")}
                {numeric("Y maximum", "max")}
              </div>
              <GammaSwitch
                label="Show grid"
                checked={options.showGrid !== false}
                onChange={(showGrid) => update({ showGrid })}
              />
            </>
          )}
        </>
      )}
      {gauge && (
        <div className={styles.row}>
          {numeric("Minimum", "min")}
          {numeric("Maximum", "max")}
        </div>
      )}
      {widget.type === "stat" && (
        <GammaSwitch
          label="Show sparkline"
          checked={options.showSparkline === true}
          onChange={(showSparkline) => update({ showSparkline })}
        />
      )}
      {!chart && pluginControls.includes("grid") && (
        <GammaSwitch label="Show grid" checked={options.showGrid !== false} onChange={(showGrid) => update({ showGrid })} />
      )}
      {(["timeseries", "bar", "heatmap"].includes(widget.type) || pluginControls.includes("legend")) && (
        <GammaSwitch
          label="Show legend"
          checked={options.showLegend !== false}
          onChange={(showLegend) => update({ showLegend })}
        />
      )}
      {widget.type === "heatmap" && (
        <>
          <GammaSwitch
            label="Show labels"
            checked={options.showLabels !== false}
            onChange={(showLabels) => update({ showLabels })}
          />
          <GammaSwitch
            label="Show values"
            checked={options.showValues !== false}
            onChange={(showValues) => update({ showValues })}
          />
        </>
      )}
      {hasStyleControl("tooltips") && !supportsTooltipView(widget.type) && (
        <GammaSwitch
          label="Show tooltips"
          checked={options.showTooltip !== false}
          onChange={(showTooltip) => update({ showTooltip })}
        />
      )}
      {(["heatmap", "stat", "bar"].includes(widget.type) || gauge || widget.pluginId === "record-table") && (
        <fieldset className={styles.thresholds}>
          <legend>Value thresholds</legend>
          <p className={styles.hint}>
            List values in ascending order. A value uses the highest threshold
            it reaches. Below the first threshold, its color still applies.
            {widget.type === "heatmap" &&
              " Without custom thresholds, heatmaps are red below 1 and green from 1."}
          </p>
          {(options.thresholds ?? []).map((threshold, index) => (
            <div className={styles.threshold} key={index}>
              <label className={styles.field}>
                At least
                <GammaInput
                  aria-label={`Threshold ${index + 1} value`}
                  type="number"
                  step="any"
                  value={threshold.value}
                  onChange={(event) =>
                    update({
                      thresholds: options.thresholds!.map((item, i) =>
                        i === index
                          ? { ...item, value: Number(event.target.value) }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <label className={styles.field}>
                Color
                <GammaInput
                  aria-label={`Threshold ${index + 1} color`}
                  type="color"
                  value={threshold.color}
                  onChange={(event) =>
                    update({
                      thresholds: options.thresholds!.map((item, i) =>
                        i === index
                          ? { ...item, color: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <GammaButton
                type="button"
                variant="quiet"
                size="sm"
                iconOnly
                aria-label={`Remove threshold ${index + 1}`}
                onClick={() =>
                  update({
                    thresholds: options.thresholds!.filter(
                      (_, i) => i !== index,
                    ),
                  })
                }
              >
                <Trash2 size={14} />
              </GammaButton>
              <label className={styles.thresholdLabel}>
                Label
                <GammaInput
                  aria-label={`Threshold ${index + 1} label`}
                  value={threshold.label ?? ""}
                  maxLength={80}
                  placeholder="e.g. Healthy"
                  onChange={(event) =>
                    update({
                      thresholds: options.thresholds!.map((item, i) =>
                        i === index
                          ? { ...item, label: event.target.value }
                          : item,
                      ),
                    })
                  }
                />
              </label>
            </div>
          ))}
          <GammaButton
            type="button"
            variant="secondary"
            disabled={(options.thresholds?.length ?? 0) >= 12}
            onClick={() =>
              update({
                thresholds: [
                  ...(options.thresholds ?? []),
                  {
                    value: options.thresholds?.length
                      ? options.thresholds[options.thresholds.length - 1]
                          .value + 1
                      : 0,
                    color: options.thresholds?.length ? "#6e947a" : "#c46146",
                  },
                ],
              })
            }
          >
            <Plus size={13} /> Add threshold
          </GammaButton>
        </fieldset>
      )}
      <GammaButton
        type="button"
        variant="quiet"
        onClick={() =>
          onChange({
            ...widget,
            options: {
              ...getWidgetDefinition(widget)?.defaultOptions,
              ...(options.tooltipView
                ? { tooltipView: options.tooltipView }
                : {}),
              ...(options.showTooltip !== undefined
                ? { showTooltip: options.showTooltip }
                : {}),
            },
            color: undefined,
          })
        }
      >
        Reset appearance
      </GammaButton>
    </div>
  );
}

export function WidgetEditor({
  widget,
  providers,
  onApply,
  onDraftValidityChange,
  onClose,
  onDuplicate,
  onDelete,
  onMove,
  client,
  range,
  queryFetcher,
  dashboards = [],
  queryFields,
}: {
  widget: Widget;
  providers: Provider[];
  onApply: (widget: Widget) => void;
  onDraftValidityChange?: (valid: boolean) => void;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (dx: number, dy: number) => void;
  client?: InsightsClient;
  range?: { start: number; end: number };
  queryFetcher?: QueryFetcher;
  dashboards?: Dashboard[];
  queryFields?: import("./query-connections").QueryFields;
}) {
  const definitions = useWidgetDefinitions();
  const library = useSavedQueryLibrary();
  const editorRef = useRef<HTMLElement>(null);
  const [draft, setDraft] = useState(widget);
  const [base, setBase] = useState(widget);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [tab, setTab] = useState("query");
  const [sourceFormat, setSourceFormat] = useState("json");
  const [queryDraftValid, setQueryDraftValid] = useState(true);
  const [editorRevision, setEditorRevision] = useState(0);
  const [pluginConfig, setPluginConfig] = useState(
    JSON.stringify(widget.config ?? {}, null, 2),
  );
  const [tooltipPluginConfig, setTooltipPluginConfig] = useState(
    JSON.stringify(widget.options?.tooltipView?.config ?? {}, null, 2),
  );
  const contentKey = (value: Widget) => JSON.stringify({ ...value, layout: { w: value.layout.w, h: value.layout.h } });
  const draftKey = JSON.stringify([draft, size, pluginConfig, tooltipPluginConfig]);
  const [previewRevision, setPreviewRevision] = useState({ key: draftKey, widget });
  const emittedDraftKey = useRef(draftKey);
  const stale = contentKey(widget) !== contentKey(base) &&
    contentKey(widget) !== contentKey(previewRevision.widget);
  const dimensions = size ?? widget.layout;
  const compatible = providers.filter((provider) =>
    provider.capabilities.includes(widgetKind(draft)),
  );
  const linkedQuery = library.queries.find(
    (entry) => entry.id === draft.queryRef?.id,
  );
  function parseDraft(): Widget {
    let config: unknown;
    let tooltipView = draft.options?.tooltipView;
    try {
      if (draft.type === "plugin") {
        config = JSON.parse(pluginConfig);
        const definition = getWidgetDefinition(draft);
        if (!definition)
          throw new Error(
            "This plugin is not registered. Choose an available visualization.",
          );
        if (definition.parseConfig)
          config = definition.parseConfig(pluginConfigSchema.parse(config));
      }
      if (tooltipView?.type === "plugin") {
        const definition = getWidgetDefinition("plugin", tooltipView.pluginId);
        if (!definition)
          throw new Error(
            "Choose an available tooltip plugin before applying.",
          );
        if (definition.dataKind !== tooltipView.dataKind)
          throw new Error(
            "The tooltip plugin data kind does not match its registered definition.",
          );
        let tooltipConfig: Widget["config"] = pluginConfigSchema.parse(
          JSON.parse(tooltipPluginConfig),
        );
        if (definition.parseConfig)
          tooltipConfig = definition.parseConfig(tooltipConfig);
        tooltipView = { ...tooltipView, config: tooltipConfig };
      }
    } catch (cause) {
      throw new Error(
        cause instanceof Error
          ? cause.message
          : "Plugin configuration must be valid JSON.",
      );
    }
    const parsed = widgetSchema.safeParse({
      ...draft,
      ...(draft.type === "plugin" ? { config } : {}),
      ...(tooltipView ? { options: { ...draft.options, tooltipView } } : {}),
      layout: {
        ...widget.layout,
        w: dimensions.w,
        h: dimensions.h,
        x: Math.min(widget.layout.x, 12 - dimensions.w),
      },
    });
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("\n"),
      );
    }
    if (draft.queryRef) {
      try {
        if (library.loading)
          throw new Error("The saved query library is loading.");
        if (library.error) throw new Error(library.error);
        const resolved = resolveSavedQueryReference(
          draft.queryRef,
          library.queries,
          library.values,
          widgetKind(draft),
        );
        if (!compatible.some((provider) => provider.id === resolved.providerId))
          throw new Error(
            "Choose a saved query with an available compatible provider.",
          );
      } catch (cause) {
        throw new Error(
          cause instanceof Error
            ? cause.message
            : "Check the saved query mappings.",
        );
      }
    }
    if (
      !draft.queryRef &&
      !compatible.some((provider) => provider.id === draft.providerId)
    ) {
      throw new Error("Choose a provider compatible with this visualization.");
    }
    const tooltip = parsed.data.options?.tooltipView;
    if (tooltip?.source?.type === "query") {
      const source = tooltip.source;
      const kind = widgetKind(tooltip);
      if (
        !providers.some(
          (provider) =>
            provider.id === source.providerId &&
            provider.capabilities.includes(kind),
        )
      ) {
        throw new Error("Choose a compatible provider for the tooltip query.");
      }
      try {
        validateTooltipQueryTemplate(source);
      } catch (cause) {
        throw new Error(
          `Tooltip query: ${cause instanceof Error ? cause.message : "Check its variable mappings."}`,
        );
      }
    }
    if (tooltip?.source?.type === "saved") {
      try {
        validateLinkedTooltip(tooltip, library, providers);
      } catch (cause) {
        throw new Error(
          cause instanceof Error
            ? cause.message
            : "Check the saved tooltip query mappings.",
        );
      }
    }
    if (
      tooltip?.source?.type === "widget" &&
      widgetKind(tooltip) !== widgetKind(draft)
    ) {
      throw new Error(
        "The existing widget data is incompatible with this tooltip visualization.",
      );
    }
    return parsed.data;
  }
  let preview: Widget | undefined;
  let validationError = "";
  try {
    preview = parseDraft();
  } catch (cause) {
    validationError = cause instanceof Error ? cause.message : "Check the widget settings.";
  }
  const error = validationError || (!queryDraftValid ? "Finish the guided query or close the builder to keep the current expression." : "");
  // Keep an accepted revision alongside the local controls. Reconcile our own
  // host echo before rendering; external Undo/document changes remain stale.
  if (contentKey(widget) === contentKey(previewRevision.widget) && contentKey(widget) !== contentKey(base)) {
    setBase(widget);
  }
  if (!stale && preview && previewRevision.key !== draftKey) {
    setPreviewRevision({ key: draftKey, widget: preview });
  }
  // The host owns the unsaved document; only dashboard Save writes storage.
  useEffect(() => {
    if (emittedDraftKey.current === previewRevision.key) return;
    emittedDraftKey.current = previewRevision.key;
    onApply(previewRevision.widget);
  }, [previewRevision, onApply]);
  useEffect(() => {
    onDraftValidityChange?.(!stale && !validationError && queryDraftValid);
  }, [onDraftValidityChange, stale, validationError, queryDraftValid]);
  useEffect(() => () => onDraftValidityChange?.(true), [onDraftValidityChange]);

  function apply() {
    if (stale || !preview) return;
    setPreviewRevision({ key: draftKey, widget: preview });
    onApply(preview);
  }
  const source = preview ?? widget;
  const sourceText = sourceFormat === "yaml"
    ? stringifyYaml(source, { lineWidth: 0 })
    : JSON.stringify(source, null, 2);
  return (
    <section
      ref={editorRef}
      className={styles.editor}
      aria-label="Widget editor"
    >
      <div className={styles.heading}>
        <div>
          <h2>Widget settings</h2>
        </div>
        <GammaButton
          variant="quiet"
          size="sm"
          iconOnly
          aria-label="Close widget editor"
          onClick={onClose}
        >
          <X size={18} />
        </GammaButton>
      </div>
      {stale && (
        <div className={styles.error} role="alert">
          This widget changed on the canvas. Reload its latest settings before
          continuing the preview.
          <GammaButton
            variant="secondary"
            onClick={() => {
              setBase(widget);
              setDraft(widget);
              setQueryDraftValid(true);
              setEditorRevision(revision => revision + 1);
              setSize(null);
              setPluginConfig(JSON.stringify(widget.config ?? {}, null, 2));
              setTooltipPluginConfig(
                JSON.stringify(
                  widget.options?.tooltipView?.config ?? {},
                  null,
                  2,
                ),
              );
            }}
          >
            Reload widget
          </GammaButton>
        </div>
      )}
      <label className={styles.field}>
        Title
        <GammaInput
          value={draft.title}
          maxLength={120}
          onChange={(event) =>
            setDraft({ ...draft, title: event.target.value })
          }
        />
      </label>
      <label className={styles.field}>
        Visualization
        <GammaSelect
          aria-label="Visualization"
          value={
            draft.type === "plugin" ? `plugin:${draft.pluginId}` : draft.type
          }
          onValueChange={(value) => {
            const definition = definitions.find(
              (item) =>
                (item.type === "plugin" ? `plugin:${item.id}` : item.type) ===
                value,
            );
            if (!definition) return;
            const type = definition.type,
              capability = definition.dataKind;
            const provider =
              providers.find(
                (item) =>
                  item.id === draft.providerId &&
                  item.capabilities.includes(capability),
              ) ??
              providers.find((item) => item.capabilities.includes(capability));
            const next: Widget = {
              ...draft,
              type,
              providerId: provider?.id ?? "unconfigured",
              query:
                capability !== widgetKind(draft)
                  ? capability === "traces"
                    ? "{}"
                    : "up"
                  : draft.query,
            };
            if (capability !== widgetKind(draft)) delete next.queryRef;
            if (type === "plugin") {
              next.pluginId = definition.id;
              next.dataKind = capability;
              next.config = definition.defaultConfig ? structuredClone(definition.defaultConfig) : undefined;
              setPluginConfig(JSON.stringify(next.config ?? {}, null, 2));
              next.options = definition.defaultOptions ?? next.options;
            } else {
              delete next.pluginId;
              delete next.dataKind;
              delete next.config;
            }
            setDraft(next);
            if (tab === "tooltips" && !supportsTooltipView(type))
              setTab("style");
          }}
          options={[
            ...definitions.map((definition) => ({
              value:
                definition.type === "plugin"
                  ? `plugin:${definition.id}`
                  : definition.type,
              label: definition.label,
              description: definition.description,
            })),
            ...(draft.type === "plugin" && !getWidgetDefinition(draft)
              ? [
                  {
                    value: `plugin:${draft.pluginId}`,
                    label: `Unavailable plugin · ${draft.pluginId}`,
                  },
                ]
              : []),
          ]}
        />
      </label>
      <GammaTabs
        label="Widget settings"
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: "query",
            title: "Query",
            content: (
              <div className={styles.stack}>
                <label className={styles.field}>
                  Query source
                  <GammaSelect
                    aria-label="Widget query source"
                    value={draft.queryRef ? "saved" : "custom"}
                    options={[
                      { value: "custom", label: "Custom query", icon: <QuerySourceIcon kind="provider" /> },
                      { value: "saved", label: "Saved query", icon: <QuerySourceIcon kind="saved" /> },
                    ]}
                    onValueChange={(value) =>
                      setDraft({
                        ...draft,
                        queryRef: value === "saved" ? { id: "" } : undefined,
                      })
                    }
                  />
                </label>
                {draft.queryRef ? (
                  <>
                    <SavedQueryPicker
                      queries={library.queries}
                      kind={widgetKind(draft)}
                      value={draft.queryRef.id}
                      disabled={library.loading}
                      onChange={(id) => {
                        const saved = library.queries.find(
                          (entry) => entry.id === id,
                        );
                        setDraft({
                          ...draft,
                          providerId: saved?.providerId ?? draft.providerId,
                          queryRef: { id },
                        });
                      }}
                    />
                    {library.error && (
                      <p role="alert" className={styles.error}>
                        {library.error}
                      </p>
                    )}
                    {linkedQuery && (
                      <>
                        <label className={styles.field}>
                          Saved query template
                          <GammaTextarea
                            aria-label="Saved query template"
                            className={styles.codeInput}
                            value={linkedQuery.query}
                            rows={5}
                            readOnly
                          />
                        </label>
                        <SavedQueryBindingEditor
                          query={linkedQuery}
                          bindings={draft.queryRef.bindings}
                          variables={library.variables}
                          values={library.values}
                          onChange={(bindings) =>
                            setDraft({
                              ...draft,
                              queryRef: {
                                id: draft.queryRef!.id,
                                bindings: bindings.filter(
                                  (binding) =>
                                    binding.source === "variable" ||
                                    binding.source === "constant",
                                ),
                              },
                            })
                          }
                        />
                      </>
                    )}
                    <p className={styles.hint}>
                      This widget follows the saved query. Switching to a custom
                      query restores your previous custom draft.
                    </p>
                    <GammaButton
                      variant="secondary"
                      onClick={() =>
                        setDraft({ ...draft, queryRef: undefined })
                      }
                    >
                      Use custom query
                    </GammaButton>
                  </>
                ) : (
                  <>
                    <label className={styles.field}>
                      Data source
                      <GammaSelect
                        aria-label="Data source"
                        value={draft.providerId}
                        onValueChange={(providerId) =>
                          setDraft({ ...draft, providerId })
                        }
                        options={[
                          ...(!compatible.some(
                            (item) => item.id === draft.providerId,
                          )
                            ? [
                                {
                                  value: draft.providerId,
                                  label: "Choose a compatible provider",
                                },
                              ]
                            : []),
                          ...compatible.map(providerOption),
                        ]}
                      />
                    </label>
                    <QueryBuilder
                      key={editorRevision}
                      live
                      onValidityChange={setQueryDraftValid}
                      widget={draft}
                      provider={providers.find((provider) => provider.id === draft.providerId)}
                      parameters={library.variables?.map((variable) => ({ ...variable, type: "string" }))}
                      client={client}
                      range={range}
                      queryFetcher={queryFetcher}
                      onChange={(query) => setDraft({ ...draft, query })}
                    />
                  </>
                )}
                {draft.type === "plugin" && (
                  <PluginConfigEditor definition={getWidgetDefinition(draft)} value={pluginConfig} onChange={setPluginConfig} />
                )}
              </div>
            ),
          },
          {
            id: "style",
            title: "Style",
            content: (
              <StyleEditor
                widget={draft}
                onChange={setDraft}
                onConfigureTooltips={() => {
                  setTab("tooltips");
                  editorRef.current
                    ?.querySelector<HTMLButtonElement>(
                      '[role="tab"][id$="-tab-tooltips"]',
                    )
                    ?.focus();
                }}
              />
            ),
          },
          ...(supportsTooltipView(draft.type)
            ? [
                {
                  id: "tooltips",
                  title: "Tooltips",
                  content: (
                    <div className={styles.stack}>
                      <div className={styles.tooltipIntro}>
                        <h3>Details on demand</h3>
                        <p className={styles.hint}>
                          {draft.type === "timeseries"
                            ? "Inspect a chart point to see its value and time. Add a widget for more context."
                            : draft.type === "bar"
                              ? "Inspect a bar to see its latest valid value. Add a widget for more context."
                              : draft.type === "table"
                                ? "Inspect a row to see its latest valid value and labels. Add a widget for more context."
                                : "Inspect a heatmap cell to see its value, status and labels. Add a widget for more context."}
                        </p>
                      </div>
                      <GammaSwitch
                        label="Show tooltips"
                        checked={draft.options?.showTooltip !== false}
                        onChange={(showTooltip) =>
                          setDraft({
                            ...draft,
                            options: { ...draft.options, showTooltip },
                          })
                        }
                      />
                      {draft.options?.showTooltip === false ? (
                        <p className={styles.hint}>
                          Turn on tooltips to customize their content. Your
                          saved tooltip settings are kept.
                        </p>
                      ) : (
                        <>
                        <label className={styles.field}>
                          Details decimal places
                          <GammaInput
                            type="number"
                            min={0}
                            max={8}
                            step={1}
                            value={draft.options?.decimals ?? ""}
                            placeholder="Auto"
                            onChange={(event) => setDraft({
                              ...draft,
                              options: { ...draft.options, decimals: event.target.value === "" ? undefined : Number(event.target.value) },
                            })}
                          />
                        </label>
                        <p className={styles.hint}>
                          Also sets the widget’s value precision. Query bindings
                          and inspected source data keep their original values.
                        </p>
                        <TooltipEditor
                          view={draft.options?.tooltipView}
                          hostType={draft.type}
                          providers={providers}
                          client={client}
                          parentProviderId={draft.providerId}
                          parentColor={draft.color}
                          parentFields={queryFields}
                          parentQueryRef={draft.queryRef}
                          onChange={(tooltipView) =>
                            setDraft({
                              ...draft,
                              options: { ...draft.options, tooltipView },
                            })
                          }
                          pluginConfig={tooltipPluginConfig}
                          onPluginConfigChange={setTooltipPluginConfig}
                        />
                        </>
                      )}
                    </div>
                  ),
                },
              ]
            : []),
          {
            id: "layout",
            title: "Layout",
            content: (
              <div className={styles.stack}>
                <label className={styles.field}>
                  Description
                  <GammaInput
                    value={draft.description ?? ""}
                    maxLength={500}
                    placeholder="A little context for your team"
                    onChange={(event) =>
                      setDraft({ ...draft, description: event.target.value })
                    }
                  />
                </label>
                <div className={styles.row}>
                  <label className={styles.field}>
                    Width
                    <GammaSelect
                      aria-label="Width"
                      value={String(dimensions.w)}
                      onValueChange={(value) =>
                        setSize({
                          w: Number(value),
                          h: dimensions.h,
                        })
                      }
                      options={Array.from({ length: 12 }, (_, i) => ({
                        value: String(i + 1),
                        label: `${i + 1} columns`,
                      }))}
                    />
                  </label>
                  <label className={styles.field}>
                    Height
                    <GammaSelect
                      aria-label="Height"
                      value={String(dimensions.h)}
                      onValueChange={(value) =>
                        setSize({
                          w: dimensions.w,
                          h: Number(value),
                        })
                      }
                      options={Array.from({ length: 11 }, (_, i) => ({
                        value: String(i + 2),
                        label: `${i + 2} rows`,
                      }))}
                    />
                  </label>
                </div>
                <div className={styles.moveRow}>
                  <span>Move widget</span>
                  {[
                    [ArrowLeft, -1, 0, "left"],
                    [ArrowUp, 0, -1, "up"],
                    [ArrowDown, 0, 1, "down"],
                    [ArrowRight, 1, 0, "right"],
                  ].map(([Icon, x, y, label]) => {
                    const I = Icon as typeof ArrowLeft;
                    return (
                      <GammaButton
                        variant="quiet"
                        size="sm"
                        iconOnly
                        key={String(label)}
                        aria-label={`Move widget ${label}`}
                        onClick={() => onMove(Number(x), Number(y))}
                      >
                        <I size={15} />
                      </GammaButton>
                    );
                  })}
                </div>
              </div>
            ),
          },
          {
            id: "links",
            title: "Links",
            content: (
              <DrilldownEditor
                widget={draft}
                dashboards={dashboards}
                onChange={setDraft}
              />
            ),
          },
          {
            id: "source",
            title: "Source",
            content: (
              <div className={styles.stack}>
                <p className={styles.hint}>Inspect the current widget, including unsaved preview changes.</p>
                {error && <p className={styles.notice}>Showing the last valid widget. Fix the draft to inspect its changes.</p>}
                <label className={styles.field}>
                  Format
                  <GammaSelect aria-label="Widget source format" value={sourceFormat} onValueChange={setSourceFormat}
                    options={[{ value: "json", label: "JSON" }, { value: "yaml", label: "YAML" }]} />
                </label>
                <label className={styles.field}>
                  Widget {sourceFormat.toUpperCase()}
                  <GammaTextarea aria-label={`Widget ${sourceFormat.toUpperCase()}`} className={`${styles.codeInput} ${styles.sourceInput}`} value={sourceText} readOnly rows={18} spellCheck={false} />
                </label>
              </div>
            ),
          },
        ]}
      />
      {error && (
        <pre className={styles.error} role="alert">
          {error}
        </pre>
      )}
      <div className={styles.footer}>
        <p className={styles.previewStatus}><span aria-hidden="true" />Live preview · Save the dashboard to keep changes.</p>
        <GammaButton variant="primary" disabled={stale} onClick={apply}>
          Apply widget
        </GammaButton>
        <div className={styles.row}>
          <GammaButton variant="secondary" onClick={onDuplicate}>
            <Copy size={14} /> Duplicate
          </GammaButton>
          <GammaButton variant="danger" onClick={onDelete}>
            <Trash2 size={14} /> Remove
          </GammaButton>
        </div>
      </div>
    </section>
  );
}
