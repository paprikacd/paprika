import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { useDraftHistory } from "./history";
import { ChartAppearancePresets } from "./chart-appearance-presets";
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
  Undo2,
  Redo2,
  X,
} from "lucide-react";
import {
  widgetKind,
  widgetSchema,
  pluginConfigSchema,
  supportsTooltipView,
  supportsAnnotationSource,
  type Dashboard,
  type Provider,
  type Widget,
  type QueryResult,
  type WidgetOptions,
} from "./schema";
import { getWidgetDefinition, useWidgetDefinitions } from "./widget-registry";
import { PluginConfigEditor } from "./plugin-config-editor";
import { SeriesColorEditor } from "./plugins/series-color-editor";
import type { InsightsClient } from "./client";
import { QueryBuilder, type QueryFetcher } from "./query-builder";
import { GammaTabs } from "./gamma/tabs";
import { GammaSwitch } from "./gamma/switch";
import { DrilldownEditor } from "./drilldown-editor";
import { SelectionEditor } from "./selection-editor";
import { GammaButton } from "./gamma/button";
import { GammaActionMenu } from "./gamma/action-menu";
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
import { thresholdHex, type StatusTheme } from "./status";
import { useInsightsTheme } from "./insights-theme";

const THEME_BLOCKS: readonly StatusTheme[] = ["light", "dark", "compact"];
import { TooltipEditor } from "./tooltip-editor";
import { validateTooltipQueryTemplate } from "./tooltip-context";
import { useSavedQueryLibrary } from "./saved-query-context";
import { AnnotationSourceEditor } from "./annotation-source-editor";
import { resolveSavedQueryReference } from "./saved-queries";
import {
  SavedQueryPicker,
  SavedQueryBindingEditor,
} from "./saved-query-controls";
import { validateLinkedTooltip } from "./saved-query-editor";
import { gridPlacement, layoutMoveBlockers, moveLayout, savedLayout, type LayoutMove } from "./layout-edit";
import type { Layout } from "react-grid-layout";
import type { CanvasMode } from "./responsive-layout";

export const widgetLabels = {
  timeseries: "Time series",
  bar: "Bar chart",
  stat: "Single value",
  table: "Metrics table",
  traces: "Trace explorer",
  heatmap: "Status heatmap",
  plugin: "Plugin",
};

function tooltipPresentation(options?: WidgetOptions): Partial<WidgetOptions> {
  return {
    ...(options?.tooltipTitle !== undefined ? { tooltipTitle: options.tooltipTitle } : {}),
    ...(options?.tooltipValueLabel !== undefined ? { tooltipValueLabel: options.tooltipValueLabel } : {}),
    ...(options?.tooltipShowUnit !== undefined ? { tooltipShowUnit: options.tooltipShowUnit } : {}),
    ...(options?.tooltipDecimals !== undefined ? { tooltipDecimals: options.tooltipDecimals } : {}),
    ...(options?.tooltipPlacement !== undefined ? { tooltipPlacement: options.tooltipPlacement } : {}),
    ...(options?.tooltipOffset !== undefined ? { tooltipOffset: options.tooltipOffset } : {}),
    ...(options?.tooltipMaxWidth !== undefined ? { tooltipMaxWidth: options.tooltipMaxWidth } : {}),
    ...(options?.tooltipMaxHeight !== undefined ? { tooltipMaxHeight: options.tooltipMaxHeight } : {}),
  };
}

/** Tooltip settings also belong to renderers that do not support embedded tooltip widgets. */
function supportsTooltipSettings(widget: Pick<Widget, "type" | "pluginId">): boolean {
  return widget.type !== "plugin" ||
    getWidgetDefinition(widget.type, widget.pluginId)?.styleControls?.includes("tooltips") === true;
}

/** Widgets whose observation inspector reads tooltipPlacement, tooltipOffset, tooltipMaxWidth and tooltipMaxHeight. */
const RICH_INSPECTOR_PLUGINS = ["distribution-heatmap", "stacked-timeseries", "directional-traffic"];
function rendersInspectorPlacement(widget: Widget): boolean {
  return widget.type === "timeseries" || widget.type === "bar" || (widget.type === "plugin" && RICH_INSPECTOR_PLUGINS.includes(widget.pluginId ?? ""));
}

/** Labelled horizontal rules on a time series. Each value joins the y range, so no rule is clipped. */
function ReferenceLinesEditor({ options, onChange }: {
  options: WidgetOptions;
  onChange: (options: Partial<WidgetOptions>) => void;
}) {
  const lines = options.referenceLines ?? [];
  const replace = (index: number, patch: Partial<NonNullable<WidgetOptions["referenceLines"]>[number]>) =>
    onChange({ referenceLines: lines.map((line, position) => (position === index ? { ...line, ...patch } : line)) });
  return <fieldset className={styles.thresholds}>
    <legend>Reference lines</legend>
    <p className={styles.hint}>Up to eight horizontal rules with an optional label. Explicit axis bounds can still hide a rule outside them.</p>
    {lines.map((line, index) => <div className={styles.threshold} key={index}>
      <label className={styles.field}>Value
        <GammaInput type="number" step="any" aria-label={`Reference line ${index + 1} value`} value={line.value}
          onChange={(event) => { if (event.target.value !== "" && Number.isFinite(Number(event.target.value))) replace(index, { value: Number(event.target.value) }); }} />
      </label>
      <label className={styles.field}>Label
        <GammaInput aria-label={`Reference line ${index + 1} label`} value={line.label ?? ""} maxLength={80} placeholder="Value only"
          onChange={(event) => replace(index, { label: event.target.value || undefined })} />
      </label>
      <label className={styles.field}>Colour
        <GammaInput type="color" aria-label={`Reference line ${index + 1} colour`} value={line.color ?? "#c08a2b"}
          onChange={(event) => replace(index, { color: event.target.value })} />
      </label>
      <GammaButton type="button" variant="quiet" size="sm" aria-label={`Remove reference line ${index + 1}`}
        onClick={() => onChange({ referenceLines: lines.filter((_, position) => position !== index) })}>
        <Trash2 size={14} aria-hidden="true" /> Remove
      </GammaButton>
    </div>)}
    <GammaButton type="button" variant="secondary" disabled={lines.length >= 8}
      onClick={() => onChange({ referenceLines: [...lines, { value: 0 }] })}>
      <Plus size={14} aria-hidden="true" /> Add reference line
    </GammaButton>
  </fieldset>;
}

/** Where the observation inspector opens, and how large it may grow. Unset values keep the renderer's defaults. */
function TooltipPlacementEditor({ options, onChange }: {
  options: WidgetOptions;
  onChange: (options: Partial<WidgetOptions>) => void;
}) {
  const bounded = (label: string, field: "tooltipOffset" | "tooltipMaxWidth" | "tooltipMaxHeight", min: number, max: number) => (
    <label className={styles.field}>{label}
      <GammaInput type="number" min={min} max={max} step={1} aria-label={label} value={options[field] ?? ""} placeholder="Default"
        onChange={(event) => onChange({ [field]: event.target.value === "" ? undefined : Number(event.target.value) })} />
    </label>
  );
  return <fieldset className={styles.thresholds}>
    <legend>Inspector placement</legend>
    <p className={styles.hint}>Where the reading opens beside its point. The viewport still limits it, and values outside these ranges are refused.</p>
    <div className={styles.row}>
      <label className={styles.field}>Preferred side
        <GammaSelect aria-label="Inspector side" value={options.tooltipPlacement ?? "auto"}
          onValueChange={(value) => onChange({ tooltipPlacement: value === "auto" ? undefined : value as WidgetOptions["tooltipPlacement"] })}
          options={[{ value: "auto", label: "Automatic" }, { value: "top", label: "Above" }, { value: "right", label: "Right" }, { value: "bottom", label: "Below" }, { value: "left", label: "Left" }]} />
      </label>
      {bounded("Gap (px)", "tooltipOffset", 0, 40)}
      {bounded("Maximum width (px)", "tooltipMaxWidth", 220, 640)}
      {bounded("Maximum height (px)", "tooltipMaxHeight", 160, 800)}
    </div>
  </fieldset>;
}

function TooltipPresentationEditor({ options, onChange }: {
  options: WidgetOptions;
  onChange: (options: Partial<WidgetOptions>) => void;
}) {
  return <fieldset className={styles.thresholds}>
    <legend>Reading presentation</legend>
    <p className={styles.hint}>Friendly text for the reading. Original series identity, unit and sample values remain available in source details.</p>
    <label className={styles.field}>Tooltip heading
      <GammaInput value={options.tooltipTitle ?? ""} maxLength={120} placeholder="Widget title"
        onChange={(event) => onChange({ tooltipTitle: event.target.value || undefined })} />
    </label>
    <label className={styles.field}>Tooltip value label
      <GammaInput value={options.tooltipValueLabel ?? ""} maxLength={80} placeholder="Optional caption"
        onChange={(event) => onChange({ tooltipValueLabel: event.target.value || undefined })} />
    </label>
    <label className={styles.field}>Tooltip decimal places
      <GammaInput type="number" min={0} max={8} step={1} value={options.tooltipDecimals ?? ""} placeholder="Use widget precision"
        onChange={(event) => onChange({ tooltipDecimals: event.target.value === "" ? undefined : Number(event.target.value) })} />
    </label>
    <GammaSwitch label="Show unit in tooltip reading" checked={options.tooltipShowUnit !== false}
      onChange={(tooltipShowUnit) => onChange({ tooltipShowUnit })} />
  </fieldset>;
}

function StyleEditor({
  widget,
  onChange,
  onConfigureTooltips,
}: {
  widget: Widget;
  onChange: (widget: Widget) => void;
  onConfigureTooltips: () => void;
}) {
  // The swatch shows the appearance the author is viewing.
  const { resolvedTheme } = useInsightsTheme();
  const options = widget.options ?? {};
  const update = (patch: Partial<WidgetOptions>) =>
    onChange({ ...widget, options: { ...options, ...patch } });
  // Turning on the value bar does not invent bounds. Focus the minimum field
  // once it renders; the existing draft alert explains what is missing.
  const barHintId = useId();
  const barMinimumRef = useRef<HTMLInputElement>(null);
  const barMaximumRef = useRef<HTMLInputElement>(null);
  const focusBarBound = useRef<"min" | "max" | null>(null);
  useEffect(() => {
    const target = focusBarBound.current;
    if (!target) return;
    focusBarBound.current = null;
    (target === "min" ? barMinimumRef : barMaximumRef).current?.focus();
  });
  const numeric = (
    label: string,
    field: "min" | "max" | "decimals" | "lineWidth" | "fillOpacity" | "staleAfterSeconds" | "plotInsetLeft" | "plotInsetRight" | "tooltipOffset" | "tooltipMaxWidth" | "tooltipMaxHeight",
    min?: number,
    max?: number,
    step: number | "any" = 1,
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
  // A value bar has no default scale. A missing bound stays empty, says what is
  // missing next to the input, and is wired to it for assistive technology.
  const barBound = (label: string, field: "min" | "max", inputRef: Ref<HTMLInputElement>) => {
    const missing = options[field] === undefined;
    const hintId = `${barHintId}-${field}`;
    return (
      <div className={styles.boundField}>
        <label className={styles.field}>
          {label}
          <GammaInput
            ref={inputRef}
            type="number"
            value={options[field] ?? ""}
            placeholder="Required"
            step="any"
            required={missing}
            aria-invalid={missing || undefined}
            aria-describedby={missing ? hintId : undefined}
            onChange={(event) =>
              update({
                [field]: event.target.value === "" ? undefined : Number(event.target.value),
              })
            }
          />
        </label>
        {missing && (
          <small id={hintId} className={styles.boundHint}>
            {field === "min" ? "Enter the minimum for the bar." : "Enter the maximum for the bar."}
          </small>
        )}
      </div>
    );
  };
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
    ).some((threshold) =>
      // A status resolves to a different mark in each appearance, so every block is checked, not only the active one.
      THEME_BLOCKS.some((theme) => {
        const hex = thresholdHex(threshold, theme);
        return hex !== undefined && contrastRatio(options.textColor!, hex) < 4.5;
      }),
    );
  const defaultColor = gauge
    ? "#53876a"
    : widget.type === "stat"
      ? "#27332e"
      : "#c46146";
  return (
    <div className={styles.stack}>
      {widget.type === "timeseries" && <ChartAppearancePresets options={options} onChange={update} />}
      {supportsTooltipSettings(widget) && (
        <div className={styles.tooltipShortcut}>
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
          Use 0–8 decimal places, or leave blank for automatic precision.
        </p>
      )}
      {(widget.type === "stat" || widget.type === "timeseries") && <>
        {numeric(widget.type === "stat" ? "Warn when last valid sample is older than (seconds)" : "Hatch after latest sample when older than (seconds)", "staleAfterSeconds", 1, 2678400)}
        <p className={styles.hint}>{widget.type === "stat" ? "Optional. Compared with the end of the selected time range; this describes returned samples, not the source’s scrape health." : "Time series: hatch the time after the latest sample when it is older than this before the range end. Leave blank to use two expected sample intervals."}</p>
      </>}
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
          <SeriesColorEditor config={{ seriesColors: options.seriesColors ?? [] }} onChange={(config) => update({ seriesColors: config.seriesColors as WidgetOptions["seriesColors"] })} />
          <div className={styles.row}>
            {numeric("Line width", "lineWidth", 0.5, 8, 0.5)}
            {options.display === "area" &&
              numeric("Fill opacity", "fillOpacity", 0, 1, 0.05)}
          </div>
          <div className={styles.row}>
            <label className={styles.field}>
              Time axis
              <GammaSelect
                aria-label="Time axis"
                value={options.timeAxis ?? "linear"}
                onValueChange={(value) => update({ timeAxis: value as WidgetOptions["timeAxis"] })}
                options={[
                  { value: "linear", label: "Elapsed time" },
                  { value: "calendar", label: "Calendar" },
                ]}
              />
            </label>
            {numeric("Left inset (px)", "plotInsetLeft", 8, 240)}
            {numeric("Right inset (px)", "plotInsetRight", 8, 120)}
          </div>
          <p className={styles.hint}>
            Calendar ticks fall on local days, weeks and months in the dashboard time zone, and each is placed at its true time, so a daylight-saving change shows as a jump in the labels. Matching insets line charts up on one time axis.
          </p>
          <GammaSwitch
            label="Vertical gridlines"
            checked={options.gridX === true}
            onChange={(gridX) => update({ gridX })}
          />
          <GammaSwitch
            label="Show zero line"
            checked={options.showZeroLine === true}
            onChange={(showZeroLine) => update({ showZeroLine })}
          />
          <ReferenceLinesEditor options={options} onChange={update} />
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
              <div className={styles.row}>
                <label className={styles.field}>
                  Y-axis unit
                  <GammaSelect
                    aria-label="Y-axis unit"
                    value={options.axisUnit ?? "auto"}
                    onValueChange={(value) => update({ axisUnit: value as WidgetOptions["axisUnit"] })}
                    options={[
                      { value: "auto", label: "Automatic" },
                      { value: "ticks", label: "In tick labels" },
                      { value: "caption", label: "Caption above the plot" },
                    ]}
                  />
                </label>
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
        <>
          <GammaSwitch
            label="Show value bar"
            description="Shows the current value on an explicit scale. Enter both bounds; threshold colors apply to the observed value."
            checked={options.showStatBar === true}
            onChange={(showStatBar) => {
              focusBarBound.current = showStatBar
                ? options.min === undefined ? "min" : options.max === undefined ? "max" : null
                : null;
              update({ showStatBar });
            }}
          />
          {options.showStatBar && <div className={styles.row}>
            {barBound("Bar minimum", "min", barMinimumRef)}
            {barBound("Bar maximum", "max", barMaximumRef)}
          </div>}
          <GammaSwitch
            label="Show sparkline"
            checked={options.showSparkline === true}
            onChange={(showSparkline) => update({ showSparkline, ...(showSparkline && !options.sparklinePlacement ? { sparklinePlacement: "side" } : {}) })}
          />
          {options.showSparkline && <label className={styles.field}>
            Sparkline placement
            <GammaSelect aria-label="Sparkline placement" value={options.sparklinePlacement ?? "background"}
              onValueChange={(value) => update({ sparklinePlacement: value as WidgetOptions["sparklinePlacement"] })}
              options={[{ value: "background", label: "Behind value" }, { value: "side", label: "Beside value" }]} />
          </label>}
          <label className={styles.field}>
            Icon
            <GammaSelect aria-label="Stat icon" value={options.statIcon ?? "none"}
              onValueChange={(value) => update({ statIcon: value === "none" ? undefined : value as WidgetOptions["statIcon"] })}
              options={[
                { value: "none", label: "None" }, { value: "arrow-down", label: "Arrow down" },
                { value: "arrow-up", label: "Arrow up" }, { value: "shield", label: "Shield" },
                { value: "network", label: "Network" }, { value: "activity", label: "Activity" },
                { value: "target", label: "Target" }, { value: "pie", label: "Pie" },
              ]} />
          </label>
        </>
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
      {(["heatmap", "stat", "bar", "timeseries"].includes(widget.type) || gauge || ["record-table", "status-grid", "uptime-calendar", "uptime-timeline", "connection-map"].includes(widget.pluginId ?? "") || (widget.pluginId === "incident-calendar" && widget.config?.colorMode === "thresholds")) && (
        <fieldset className={styles.thresholds}>
          <legend>Value thresholds</legend>
          <p className={styles.hint}>
            {widget.type === "timeseries" ? "List values in ascending order. Thresholds appear as horizontal guides; explicit axis bounds can hide guides outside the range." : "List values in ascending order. A value uses the highest threshold it reaches. Below the first threshold, its color still applies."}
            {(widget.type === "heatmap" || ["status-grid", "uptime-calendar", "uptime-timeline"].includes(widget.pluginId ?? "")) &&
              " Without custom thresholds, heatmaps are critical below 1 and ok from 1."}
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
                  value={thresholdHex(threshold, resolvedTheme)}
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
                          ? { ...item, label: event.target.value || undefined }
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
              ...tooltipPresentation(options),
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
  onPreview,
  onDirtyChange,
  workspace,
  onDraftValidityChange,
  onClose,
  onDuplicate,
  onDelete,
  onMove,
  moveBlocked,
  client,
  range,
  queryFetcher,
  dashboards = [],
  queryFields,
  result,
}: {
  widget: Widget;
  providers: Provider[];
  onApply: (widget: Widget, layout?: Layout) => void;
  onPreview?: (widget: Widget) => void;
  onDirtyChange?: (dirty: boolean) => void;
  workspace?: { preview: ReactNode; dashboardTitle: string; onDiscard: () => void; widgets?: Widget[]; canvasMode?: CanvasMode };
  onDraftValidityChange?: (valid: boolean) => void;
  onClose: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMove: (dx: number, dy: number) => void;
  /** Why a Layout-tab move is unavailable. Its button stays visible, disabled, with this reason as its title. */
  moveBlocked?: Partial<Record<LayoutMove, string>>;
  client?: InsightsClient;
  range?: { start: number; end: number };
  queryFetcher?: QueryFetcher;
  dashboards?: Dashboard[];
  queryFields?: import("./query-connections").QueryFields;
  /** The widget's loaded result, when the host has one. Plugin configuration checks use it. */
  result?: QueryResult;
}) {
  const definitions = useWidgetDefinitions();
  const library = useSavedQueryLibrary();
  const editorRef = useRef<HTMLElement>(null);
  const previewRef = useRef<HTMLElement>(null);
  const settingsRef = useRef<HTMLElement>(null);
  const queryRef = useRef<HTMLElement>(null);
  const errorId = useId();
  function jumpTo(target: HTMLElement | null) {
    if (!target) return;
    const headerHeight = editorRef.current?.querySelector("header")?.getBoundingClientRect().height ?? 0;
    const top = window.scrollY + target.getBoundingClientRect().top - headerHeight - 12;
    target.focus({ preventScroll: true });
    window.scrollTo({ top, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  const initialDraft = {
    draft: widget,
    size: null as { w: number; h: number } | null,
    pluginConfig: JSON.stringify(widget.config ?? {}, null, 2),
    tooltipPluginConfig: JSON.stringify(widget.options?.tooltipView?.config ?? {}, null, 2),
    layout: undefined as Layout | undefined,
  };
  const history = useDraftHistory(initialDraft);
  const { draft, size, pluginConfig, tooltipPluginConfig, layout: stagedLayout } = history.present;
  const setDraft = (draft: Widget) => history.update(current => ({ ...current, draft }));
  const setSize = (size: { w: number; h: number } | null) => history.update(current => ({ ...current, size }));
  const setPluginConfig = (pluginConfig: string) => history.update(current => ({ ...current, pluginConfig }));
  const setTooltipPluginConfig = (tooltipPluginConfig: string) => history.update(current => ({ ...current, tooltipPluginConfig }));
  const [base, setBase] = useState(widget);
  const [tab, setTab] = useState(workspace ? "style" : "query");
  const [queryTab, setQueryTab] = useState("query");
  const [sourceFormat, setSourceFormat] = useState("json");
  const [queryDraftValid, setQueryDraftValid] = useState(true);
  const [pendingVisualization, setPendingVisualization] = useState<string>();
  const [editorRevision, setEditorRevision] = useState(0);
  const contentKey = (value: Widget) => JSON.stringify({ ...value, layout: { w: value.layout.w, h: value.layout.h } });
  const draftKey = JSON.stringify([draft, size, pluginConfig, tooltipPluginConfig, stagedLayout]);
  const [previewRevision, setPreviewRevision] = useState({ key: draftKey, widget });
  const emittedDraftKey = useRef(draftKey);
  const stale = contentKey(widget) !== contentKey(base) &&
    contentKey(widget) !== contentKey(previewRevision.widget);
  const dimensions = { w: size?.w ?? widget.layout.w, h: size?.h ?? widget.layout.h };
  const position = stagedLayout?.find(item => item.i === widget.id) ?? widget.layout;
  const layoutWidgets = workspace?.widgets?.map(item => {
    const placed = stagedLayout?.find(box => box.i === item.id);
    return { ...item, layout: { ...item.layout, ...(placed ? { x: placed.x, y: placed.y, w: placed.w, h: placed.h } : {}), ...(item.id === widget.id ? dimensions : {}) } };
  });
  const blockedMoves = layoutWidgets ? layoutMoveBlockers(layoutWidgets, widget.id, workspace?.canvasMode ?? "wide") : moveBlocked;
  function move(dx: number, dy: number) {
    if (!layoutWidgets) { onMove(dx, dy); return; }
    const direction: LayoutMove = dy < 0 ? "up" : dy > 0 ? "down" : dx < 0 ? "left" : "right";
    const edit = moveLayout(savedLayout(layoutWidgets), widget.id, direction);
    if ("layout" in edit) history.update(current => ({ ...current, layout: edit.layout }));
  }
  const pendingDefinition = pendingVisualization && definitions.find((item) =>
    (item.type === "plugin" ? `plugin:${item.id}` : item.type) === pendingVisualization,
  );
  const pendingQueryLoss = !!pendingDefinition && pendingDefinition.dataKind !== widgetKind(draft);
  const pendingEventLoss = !!pendingDefinition && !!draft.annotationSource &&
    !supportsAnnotationSource(pendingDefinition.type, pendingDefinition.id);
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
        y: position.y,
        w: dimensions.w,
        h: dimensions.h,
        x: Math.min(position.x, 12 - dimensions.w),
      },
    });
    if (!parsed.success) {
      throw new Error(
        parsed.error.issues
          .map((issue) => issue.path.at(-1) === "showStatBar" ? issue.message : `${issue.path.join(".")}: ${issue.message}`)
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
    if (parsed.data.annotationSource) {
      if (library.loading) throw new Error("The saved query library is loading.");
      if (library.error) throw new Error(library.error);
      const resolved = resolveSavedQueryReference(parsed.data.annotationSource.queryRef, library.queries, library.values, "records");
      if (!providers.some(provider => provider.id === resolved.providerId && provider.capabilities.includes("records")))
        throw new Error("Choose an event query with an available records provider.");
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
  if (!stale && preview && queryDraftValid && previewRevision.key !== draftKey) {
    setPreviewRevision({ key: draftKey, widget: preview });
  }
  // Focused editing stages a last-valid preview; only Apply commits to the dashboard draft.
  useEffect(() => {
    if (emittedDraftKey.current === previewRevision.key) return;
    emittedDraftKey.current = previewRevision.key;
    (onPreview ?? onApply)(previewRevision.widget);
  }, [previewRevision, onApply, onPreview]);
  useEffect(() => {
    onDraftValidityChange?.(!stale && !validationError && queryDraftValid);
  }, [onDraftValidityChange, stale, validationError, queryDraftValid]);
  useEffect(() => () => onDraftValidityChange?.(true), [onDraftValidityChange]);

  const dirty = JSON.stringify(history.present) !== JSON.stringify(initialDraft) || !queryDraftValid;
  useEffect(() => { onDirtyChange?.(dirty); }, [onDirtyChange, dirty]);
  function travel(direction: "undo" | "redo") {
    history[direction]();
    setPendingVisualization(undefined);
    setQueryDraftValid(true);
    setEditorRevision(revision => revision + 1);
  }
  function apply() {
    if (stale || error || !preview) return;
    setPreviewRevision({ key: draftKey, widget: preview });
    if (stagedLayout) onApply(preview, stagedLayout);
    else onApply(preview);
  }
  function chooseVisualization(value: string, acceptReplacement = false) {
    const definition = definitions.find((item) =>
      (item.type === "plugin" ? `plugin:${item.id}` : item.type) === value,
    );
    if (!definition) return;
    const type = definition.type, capability = definition.dataKind;
    const replacesQuery = capability !== widgetKind(draft);
    const removesEvent = !!draft.annotationSource && !supportsAnnotationSource(type, definition.id);
    if ((replacesQuery || removesEvent) && !acceptReplacement) {
      setPendingVisualization(value);
      return;
    }
    const provider = providers.find((item) => item.id === draft.providerId && item.capabilities.includes(capability)) ??
      providers.find((item) => item.capabilities.includes(capability));
    const next: Widget = {
      ...draft,
      type,
      providerId: provider?.id ?? "unconfigured",
      query: capability !== widgetKind(draft) ? capability === "traces" ? "{}" : "up" : draft.query,
    };
    if (capability !== widgetKind(draft)) delete next.queryRef;
    if (!supportsAnnotationSource(type, definition.id)) delete next.annotationSource;
    if (type === "plugin") {
      next.pluginId = definition.id;
      next.dataKind = capability;
      next.config = definition.defaultConfig ? structuredClone(definition.defaultConfig) : undefined;
      next.options = definition.defaultOptions
        ? {
            ...definition.defaultOptions,
            ...tooltipPresentation(draft.options),
            ...(draft.options?.tooltipView
              ? { tooltipView: draft.options.tooltipView, ...(draft.options.showTooltip !== undefined ? { showTooltip: draft.options.showTooltip } : {}) }
              : {}),
          }
        : next.options;
    } else {
      delete next.pluginId;
      delete next.dataKind;
      delete next.config;
    }
    setPendingVisualization(undefined);
    history.update(current => ({ ...current, draft: next,
      ...(type === "plugin" ? { pluginConfig: JSON.stringify(next.config ?? {}, null, 2) } : {}),
      ...(type !== "stat" && dimensions.h < 2 ? { size: { w: dimensions.w, h: 2 } } : {}),
    }));
    if ((tab === "tooltips" && !supportsTooltipSettings(next)) || (tab === "options" && next.type !== "plugin")) setTab("style");
  }
  const source = preview && !error ? preview : previewRevision.widget;
  const sourceText = sourceFormat === "yaml"
    ? stringifyYaml(source, { lineWidth: 0 })
    : JSON.stringify(source, null, 2);
  const identity = <>
      {stale && (
        <div className={styles.error} role="alert">
          This widget changed on the canvas. Reload its latest settings before
          continuing the preview.
          <GammaButton
            variant="secondary"
            onClick={() => {
              setBase(widget);
              history.reset(initialDraft);
              setPendingVisualization(undefined);
              setQueryDraftValid(true);
              setEditorRevision(revision => revision + 1);
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
          aria-invalid={draft.title.length === 0 || undefined}
          aria-describedby={draft.title.length === 0 ? errorId : undefined}
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
          onValueChange={(value) => chooseVisualization(value)}
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
      {pendingDefinition && <div className={styles.stack} role="status">
        {pendingQueryLoss && <p className={styles.hint}>{draft.queryRef
          ? "This visualization uses a different data kind. The saved query connection and its mappings will be removed, and the current query will be replaced with a new query."
          : "This visualization uses a different data kind. The current query will be replaced with a new query."}</p>}
        {pendingEventLoss && <p className={styles.hint}>This visualization cannot show the configured event query. To switch, the event query will be removed from this draft.</p>}
        <p className={styles.hint}>The dashboard is not saved until you save it.</p>
        <div className={styles.row}>
          <GammaButton variant="secondary" size="sm" onClick={() => chooseVisualization(pendingVisualization!, true)}>{pendingQueryLoss ? "Replace query and switch" : "Remove event query and switch"}</GammaButton>
          <GammaButton variant="quiet" size="sm" onClick={() => setPendingVisualization(undefined)}>Keep current visualization</GammaButton>
        </div>
      </div>}
      {draft.options?.tooltipView && !supportsTooltipView(draft.type, draft.pluginId) && (
        <div className={styles.stack} role="status">
          <p className={styles.hint}>The configured tooltip widget is inactive for this visualization. Switch back to a supported visualization to use it, or remove it from this draft.</p>
          <GammaButton variant="secondary" size="sm" onClick={() => {
            setDraft({ ...draft, options: { ...draft.options, tooltipView: undefined } });
            setTooltipPluginConfig("{}");
          }}>Remove inactive tooltip widget</GammaButton>
        </div>
      )}
  </>;
  const tabs = [
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
                {!workspace && draft.type === "plugin" && (
                  <PluginConfigEditor definition={getWidgetDefinition(draft)} value={pluginConfig} onChange={setPluginConfig} queryFields={queryFields} result={result} />
                )}
                {supportsAnnotationSource(draft.type, draft.pluginId) && <AnnotationSourceEditor widget={draft} onChange={setDraft} />}
              </div>
            ),
          },
          ...(workspace && draft.type === "plugin" ? [{
            id: "options", title: "Options", content: <PluginConfigEditor definition={getWidgetDefinition(draft)} value={pluginConfig} onChange={setPluginConfig} queryFields={queryFields} result={result} />,
          }] : []),
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
          ...(supportsTooltipSettings(draft)
            ? [
                {
                  id: "tooltips",
                  title: "Tooltips",
                  content: (
                    <div className={styles.stack}>
                      <div className={styles.tooltipIntro}>
                        <h3>Details on demand</h3>
                        <p className={styles.hint}>
                          {draft.type === "plugin" && draft.pluginId === "geo-heatmap"
                            ? "Inspect a hex to see its recorded values and shared labels."
                            : draft.type === "timeseries"
                              ? "Inspect a chart point to see its value and time."
                              : draft.type === "bar"
                                ? "Inspect a bar to see its latest valid value."
                                : draft.type === "table"
                                  ? "Inspect a row to see its latest valid value and labels."
                                  : draft.type === "stat"
                                    ? "Inspect the sparkline to see recorded values and sample times."
                                    : draft.type === "traces"
                                      ? "Inspect a trace to see its duration and recorded attributes."
                                      : draft.type === "plugin"
                                        ? "Inspect a chart item to see its recorded values and labels."
                                        : "Inspect a heatmap cell to see its value, status and labels."}
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
                          <TooltipPresentationEditor
                            options={draft.options ?? {}}
                            onChange={(options) => setDraft({ ...draft, options: { ...draft.options, ...options } })}
                          />
                          {rendersInspectorPlacement(draft) && (
                            <TooltipPlacementEditor
                              options={draft.options ?? {}}
                              onChange={(options) => setDraft({ ...draft, options: { ...draft.options, ...options } })}
                            />
                          )}
                          {supportsTooltipView(draft.type, draft.pluginId) && (
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
                      options={Array.from({ length: draft.type === "stat" ? 12 : 11 }, (_, i) => {
                        const rows = i + (draft.type === "stat" ? 1 : 2);
                        return { value: String(rows), label: `${rows} ${rows === 1 ? "row" : "rows"}` };
                      })}
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
                    const blocked = blockedMoves?.[label as LayoutMove];
                    return (
                      <GammaButton
                        variant="quiet"
                        size="sm"
                        iconOnly
                        key={String(label)}
                        aria-label={`Move widget ${label}`}
                        disabled={!!blocked}
                        title={blocked}
                        onClick={() => move(Number(x), Number(y))}
                      >
                        <I size={15} />
                      </GammaButton>
                    );
                  })}
                </div>
                {workspace && <p className={styles.hint} role="status">Dashboard position: {gridPlacement({ ...position, ...dimensions })}. Size and placement are committed with Apply.</p>}
              </div>
            ),
          },
          {
            id: "links",
            title: "Links",
            content: (
              <><SelectionEditor widget={draft} onChange={setDraft} queryFields={queryFields} /><DrilldownEditor
                widget={draft}
                dashboards={dashboards}
                queryFields={queryFields}
                onChange={setDraft}
              /></>
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
        ];
  const settingsTabs = tabs.filter(item => item.id !== "query" && item.id !== "source")
    .sort((a, b) => ["style", "options", "tooltips", "links", "layout"].indexOf(a.id) - ["style", "options", "tooltips", "links", "layout"].indexOf(b.id));
  // Undo may restore a visualization without the currently selected settings.
  const settingsTab = settingsTabs.some(item => item.id === tab) ? tab : "style";
  const draftError = error && <pre id={errorId} className={styles.error} role="alert">{error}</pre>;
  if (workspace) return (
    <section ref={editorRef} className={`${styles.editor} ${styles.focusEditor}`} aria-label="Widget editor">
      <header className={styles.focusHeader}>
        <GammaButton variant="quiet" size="sm" onClick={onClose} aria-label="Back to dashboard">
          <ArrowLeft size={16} aria-hidden="true" /><span>Back to dashboard</span>
        </GammaButton>
        <div className={styles.focusIdentity}>
          <span>{workspace.dashboardTitle}</span>
          <h2>{draft.title || "Untitled chart"}</h2>
        </div>
        <span className={styles.draftState} role="status">{error ? "Draft needs attention" : dirty ? "Unapplied changes" : "Editing chart"}</span>
        <div className={styles.focusActions}>
          <GammaActionMenu label="Chart actions" items={[
            { id: "undo", label: "Undo chart change", icon: <Undo2 size={14} />, disabled: !history.canUndo, onSelect: () => travel("undo") },
            { id: "redo", label: "Redo chart change", icon: <Redo2 size={14} />, disabled: !history.canRedo, onSelect: () => travel("redo") },
            { id: "duplicate", label: "Duplicate chart", icon: <Copy size={14} />, disabled: stale || !!error, onSelect: onDuplicate },
            { id: "remove", label: "Remove chart", icon: <Trash2 size={14} />, onSelect: onDelete },
          ]} />
          <GammaButton className={styles.historyAction} variant="quiet" size="sm" iconOnly aria-label="Undo chart change" disabled={!history.canUndo} onClick={() => travel("undo")}><Undo2 size={16} /></GammaButton>
          <GammaButton className={styles.historyAction} variant="quiet" size="sm" iconOnly aria-label="Redo chart change" disabled={!history.canRedo} onClick={() => travel("redo")}><Redo2 size={16} /></GammaButton>
          <GammaButton variant="secondary" size="sm" onClick={workspace.onDiscard}>Discard</GammaButton>
          <GammaButton variant="primary" size="sm" disabled={stale || !!error} onClick={apply}>Apply changes</GammaButton>
        </div>
        <nav className={styles.editorSections} aria-label="Chart editor sections">
          <GammaButton variant="quiet" size="sm" onClick={() => jumpTo(previewRef.current)}>Preview</GammaButton>
          <GammaButton variant="quiet" size="sm" onClick={() => jumpTo(settingsRef.current)}>Settings</GammaButton>
          <GammaButton variant="quiet" size="sm" onClick={() => jumpTo(queryRef.current)}>Query</GammaButton>
        </nav>
      </header>
      <div className={styles.focusBody}>
        <div className={styles.previewWorkspace}>
          <section ref={previewRef} tabIndex={-1} className={styles.chartPreview} aria-label="Chart preview">
            <div className={styles.previewHeading}><h3>Preview</h3><span>{error ? "Last valid chart" : "Live preview"}</span></div>
            <div className={styles.previewCanvas}>{workspace.preview}</div>
          </section>
          <section ref={queryRef} tabIndex={-1} className={styles.queryWorkspace} aria-label="Chart data">
            <GammaTabs variant="underline" label="Chart data" value={queryTab} onChange={setQueryTab} tabs={tabs.filter(item => item.id === "query" || item.id === "source")} />
          </section>
        </div>
        <aside ref={settingsRef} tabIndex={-1} className={styles.chartSettings} aria-label="Chart settings">
          <div className={styles.chartIdentity}>{identity}</div>
          {draftError}
          <GammaTabs variant="underline" label="Widget settings" value={settingsTab} onChange={setTab} tabs={settingsTabs} />
          <p className={styles.focusSaveHint}>Apply returns to the dashboard. Save the dashboard to keep your changes.</p>
        </aside>
      </div>
    </section>
  );
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
      {identity}
      <GammaTabs label="Widget settings" value={tab} onChange={setTab} tabs={tabs} />

      {draftError}
      <div className={styles.footer}>
        <p className={styles.previewStatus}><span aria-hidden="true" />Live preview · Save the dashboard to keep changes.</p>
        <GammaButton variant="primary" disabled={stale || !!error} onClick={apply}>
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
