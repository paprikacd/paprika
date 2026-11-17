# Observation tooltip widgets

Time series, bars, metrics tables, status heatmaps and geographic hex heatmaps can embed a time series, bar chart, single value, metrics table, trace explorer, status heatmap or trusted installed widget inside their observation tooltip. Metric observations retain their exact value, labels and timestamp; status heatmaps also retain their threshold status. A geographic hex exposes its displayed aggregate and the labels shared by every contributing record, but has no timestamp or history. Existing dashboards keep details-only tooltips unless a view is configured.

For a geographic hex, use a saved or provider query for a metric or trace tooltip. A record-type tooltip may instead reuse the parent query result: this shows up to ten **all-parent** records, not just the selected hex, and marks the result partial when more records were returned. Timestamp bindings fail locally for hexes rather than inventing a time. Activating a hex can also drive a dashboard selection or drilldown; hover and focus alone never apply the selection. A grouped hex cannot supply a label that differs across its contributing records.

## Configure it in the builder

1. Choose **Edit dashboard**, then the settings button on the widget to configure.
2. Open the **Tooltips** tab. Keep **Show tooltips** enabled. Choose **Use saved query** to open the library picker directly, or **Add tooltip widget** for another data source. The **Style** tab also has a **Configure tooltips** shortcut.
3. Choose the embedded visualization and **Data for this tooltip**: **Hovered series** reuses that series, **Existing widget query** reuses the full loaded parent result, **Custom query** uses an explicit provider and template, and **Saved query** references the live query library.
4. For **Saved query**, search the picker by name or query ID. **Create saved query** opens Explore when no compatible query exists; save it there and return to Dashboards to resume the same widget draft. **Manage saved queries** opens the library when entries exist. **Refresh saved queries** retries loading the library without changing the draft. Loading, failure and an empty compatible library have separate messages. Bind each required query parameter to a declared dashboard variable, constant, label or exact observation field. Reselecting the same query preserves its bindings.
5. For **Custom query**, choose **Add query mapping**. Give the query variable a name and select **Data from**: **Label**, **Value**, **Timestamp** or **Series**. A label mapping additionally selects the exact label name. For example, map `service` to label `service`, then use `up{service={{service}}}`.
6. Set the title, unit, precision, height and supported presentation options. **Single value** has an optional **Show sparkline** switch. Apply changes, inspect a point/bar/row/cell, then save the dashboard.

**Remove tooltip widget** restores details-only tooltips. Turning off **Show tooltips** suppresses the entire tooltip without deleting its configured view. Resetting appearance preserves tooltip settings. Trace visualizations need compatible trace results; a metric's existing history cannot become trace data. The editor retains separate metric and trace query drafts when switching visualization types.

**Details decimal places** sets the parent widget's `options.decimals`, also available under **Style → Decimal places**. Choose 0–8 digits or leave the field blank for Auto. The setting applies to displayed values and tooltip readings, including table extrema and trace durations. The tooltip widget's own **Decimal places** control sets `tooltipView.decimals` independently, including its single value and history minimum/maximum. Auto keeps observation details exact. Rounding is presentation only: source data, thresholds, query bindings and the chart data inspector keep the original numeric values.

Do not add quotes around placeholders: Paprika supplies complete quoted strings for labels/series names and numeric literals for values/timestamps. Time-series mappings use the exact historical point being inspected. Bars and table rows use their latest valid sample, matching their rendered value. Heatmaps use the latest sample, including missing values.

## JSON, YAML and AI documents

This example adds a queried trace explorer to any supported host widget's `options`:

```yaml
showTooltip: true
tooltipView:
  type: traces
  title: Recent requests
  height: 320
  source:
    type: query
    providerId: tempo
    query: '{ resource.service.name = {{service}} }'
    bindings:
      - variable: service
        label: service
```

Use actual configured provider IDs and queries supported by those providers. A metric example is `type: timeseries` with a Prometheus query `rate(http_requests_total{service={{service}}}[5m])`. A history-only view remains `{ "type": "timeseries", "height": 160, "showGrid": true, "showAxis": true }`; it issues no additional query.

| Property | Contract |
| --- | --- |
| `type` | Required: `timeseries`, `bar`, `stat`, `table`, `traces`, `heatmap` or `plugin`. |
| `height` | `120`, `160`, `200` or `320` pixels; default `160`. The containing tooltip remains viewport-bounded and scrollable. |
| `title` | Optional nonempty title, at most 120 characters. |
| `unit`, `color`, `decimals` | Optional suffix (24 characters), six-digit hex color and integer precision from 0–8. Unit/color inherit the parent when omitted. Units do not convert values. |
| `showGrid`, `showAxis`, `showLegend` | Optional presentation flags. The builder exposes only flags supported by the selected renderer. |
| `showSparkline` | Optional boolean, default `false`. Adds the same series' bounded history beside a `stat` value, using already loaded results. The main Single value widget has the same option under Style. |
| `source` | Omitted or `{type: "series"}` uses the hovered metric series. `{type: "widget"}` reuses the complete loaded parent result. `{type: "query", providerId, query, bindings?}` requests separate data. `{type: "saved", ref: {id, bindings?}}` resolves a saved definition and its explicit parameter bindings. |
| query `bindings` | At most 20 mappings with unique valid variable names. Each mapping uses exactly one of `{variable, label}` or `{variable, field: "value" \| "timestamp" \| "series"}`. Label names are exact, case-sensitive strings of 1–128 characters. |
| query `query` | Nonempty template, at most 8,192 characters before and after interpolation. |
| `pluginId`, `dataKind`, `config` | Only for `type: "plugin"`: registered ID, required `metrics`/`traces`, and optional bounded JSON configuration. Plugin `parseConfig` validates its settings. The source must produce the required data kind. |

All objects are strict. Nested tooltip definitions, executable code and unknown fields are rejected. Details-only means no `tooltipView`; `details` is not a persisted type. JSON, YAML and OpenUI use the same shape; OpenUI places it inside the existing widget `options` argument without changing positional arguments. The canonical schema, generated [JSON Schema](dashboard.schema.json) and independent Go validator enforce the document contract. Runtime rules additionally validate binding uniqueness, template syntax and registered plugin settings.

Library import discovers and remaps nested tooltip provider references by capability alongside parent widget providers. Portable saves may retain a provider ID that is unavailable in the current workspace; querying then reports an actionable local error. Removing a provider does not rewrite saved widget or tooltip queries.

## Binding and query lifecycle

Custom-query bindings read only the selected observation's explicit context. They do not implicitly inherit dashboard variables or labels from another observation. Saved-query bindings can also explicitly select a declared dashboard variable or constant; omitted saved parameters use the definition's typed default, if present. A missing label is an error; an existing empty string remains valid. String values use the shared 1,024-character variable limit. A missing/non-finite value or invalid timestamp fails locally without querying; it never falls back to a different point.

| Mapping | Resolved query literal |
| --- | --- |
| `label: service` | Exact label as a quoted string |
| `field: series` | Displayed series name as a quoted string |
| `field: value` | Exact finite value as a number, including zero and negatives |
| `field: timestamp` | That sample's timestamp as Unix seconds, retaining fractional seconds |

For example, a point-specific Prometheus query can be `up{service={{service}}} @ {{at}} > {{value}}`, with `service` mapped to label `service`, `at` to field `timestamp` and `value` to field `value`. The dashboard range remains unchanged; the explicit `@` in this query anchors evaluation to the selected point.

Unmapped variables, placeholders inside quotes/comments, and token fragments are rejected. `interpolateQueryLiterals` encodes each value once as a complete literal. Quotes, backslashes, newlines and literal `{{text}}` within a label remain data, and the resolved query is never interpolated a second time. Existing string-only dashboard interpolation remains unchanged.

The host owns access to providers. `TooltipQueryProvider` receives the host's shared query scheduler, configured providers and current dashboard range/step; no renderer creates a client. Requests run only while the tooltip is open, never while editing a query. They use the current relative, fixed or drilldown-carried dashboard range, in Unix seconds. Provider results use normalized timestamps in milliseconds.

The scheduler shares concurrency, deduplication and its bounded cache with normal widgets. Closing the tooltip or switching point/row/source/range cancels the old subscription. A query identity change masks old data immediately; a late response cannot replace the current result. Loading, empty, failed and missing-provider/binding states are distinct, and a failed request can be retried without losing the observation details. Parent refresh also refreshes the tooltip's query environment.

## Bounded rendering and interaction

Embedded views receive copied, frozen results: at most **12 metric series**, **240 points per series**, or **100 traces**. Downsampling preserves gaps and meaningful extrema. Notices identify truncated results. These bounds protect rendering; they are not a production-provider load benchmark.

The history-only time-series view retains its exact full-history summary before downsampling, including counts, minimum/maximum, missing observations and timestamp endpoints. A missing latest value remains **No data**, even when older history contains valid values. Zero, negative and singleton observations remain visible; all-missing data does not become an invented zero line. Queried views use the shared widget renderers and their established value semantics.

Single value uses its established latest-valid observation. When enabled, its sparkline shows the history of that same series, with null gaps preserved and a bounded 240-point rendering path. It handles zero, negative, constant and singleton history without inventing a comparison or percentage change. Its accessible history summary distinguishes a missing latest observation from the older latest-valid value. The sparkline creates no extra request and no nested tooltip. Keep it off for a plain number; the omitted option preserves existing documents.

Hover or focus opens a tooltip; chart arrow keys explore historical observations or bars, and Enter/click/tap pins the selection. Pointer transfer into its contents keeps it open. Escape, a second click/tap on its trigger, or outside interaction dismisses it. Page Up/Down and Home/End scroll long content while focus remains on the trigger. The viewport-aware portal avoids tile clipping, including on narrow and short screens.

Each host groups its complete parent value, labels and timestamp before the child visualization so metadata remains clearly associated. Embedded presentation suppresses nested tooltips, data-inspector dialogs and drilldown selection. A nested heatmap is a static result view, not a new hover navigation surface. Trusted widget plugins receive `embedded: true`, bounded data and no selection callback; they must respect this presentation contract. Renderer failures leave the original observation details available.

## Trusted extension and ownership

`registerWidgetPlugin` is the normal extension point for selectable installed widgets. Documents reference its ID and validated settings; they cannot supply or load code. `registerTooltipRenderer`, `getTooltipRenderer`, `getTooltipRenderers` and `TooltipSubWidget` remain trusted application composition APIs. Registration does not by itself expand the persisted type allowlist, and builtin tooltip renderer IDs cannot be replaced.

`TooltipRendererContext` contains bounded readonly results, presentation settings, hovered labels, an optional readonly exact observation and history summary. It omits query/provider definitions and APIs. A depth guard prevents recursive `TooltipSubWidget` composition. This trusted-code boundary is not a sandbox for third-party executable content.

| Responsibility | Owner |
| --- | --- |
| Persisted contract | `schema.ts`, generated JSON Schema, `internal/insights/schema_extensions.go` |
| Builder | `tooltip-editor.tsx`, mounted by `widget-editor.tsx`; existing Gamma adapters |
| Safe binding, lifecycle | `tooltip-context.ts`, `tooltip-query.tsx`; host context in `canvas.tsx` and shared scheduler in `insights-app.tsx` |
| Bounded rendering | `tooltip-widgets.tsx`, `widget-presentation.tsx`, existing widget registry/renderers |
| Hover, pin, focus and viewport | `chart-renderers.tsx`, `plot-tooltip.tsx`; public TanStack focus/select/tooltip extension APIs |
| AI and portability | `openui.ts`, `workspace-transfer.ts` |

## Verification

Focused contract, editor, query and renderer tests cover round trips, invalid definitions, safe substitution, stale/aborted requests, bounded data, plugins and failure isolation. `insights-builder.e2e.mjs` retains history-only behavior checks. `insights-tooltip-query.e2e.mjs` exercises the production frontend against the actual Go service and deterministic Prometheus/Tempo fixtures, including exact historical/row context in upstream query text, cancellation, persistence, first-time heatmap setup and desktop/mobile Gamma controls. See [validation](validation.md) for the latest completed results and their limits.

## Saved query example

This example references an existing metrics query named by its ID and supplies its `service` parameter from the hovered label. The query definition must already exist in the library; a document reference does not create it.

```yaml
tooltipView:
  type: stat
  height: 120
  unit: ms
  showSparkline: true
  source:
    type: saved
    ref:
      id: service-latency
      bindings:
        - parameter: service
          source: label
          label: service
```

JSON, YAML and OpenUI preserve the reference and sparkline flag. Portable bundles include the referenced definition. See [the explorer contract](explorer.md) for the complete binding shapes and exact-context semantics, and [the saved-tooltip review](tooltip-saved-review.md) for this authoring change's verification evidence.
