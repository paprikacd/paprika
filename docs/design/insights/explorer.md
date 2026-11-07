# Data source explorer

Open **Explore** in the Insights sidebar, select a data source, and build a query using its metric and label metadata or the raw editor. Give it a name, define any parameters, and choose a time range. **Run query** is explicit: typing and saving never execute a provider query. Test values affect only the preview. Results retain the executed snapshot and are marked stale after query, parameter or time changes; changing views cancels an active request. Metrics can be previewed through the shared time-series, bars, table and heatmap renderers; trace providers use trace results. The result summary counts only returned series, samples, rows, columns or traces, and identifies missing values without treating zero as missing. Partial provider results remain marked even before record visualization columns are selected. A failed rerun identifies any retained result as an earlier successful result; cancelling a run is acknowledged without changing the saved query.

Saved queries belong to a single provider and kind. **Open saved query** provides a searchable Gamma selector above the workbench at every viewport size. Save creates or updates the definition, Save a copy creates a separate identity, and Delete checks usage. Switching provider or saved query protects unsaved edits. Returning to the dashboard preserves the explorer draft, and opening Explore refreshes the library. Manual dashboard refresh also reloads saved definitions.

On desktop, the query and results share the left column while query details occupy the full-height right column. **Overview** exposes the name, a multiline description and tags; **Parameters** contains typed parameters and defaults; **Metadata** holds the optional cover image and key/value fields. Save stays at the bottom of the details panel. Narrow viewports stack the query, results and details in reading and keyboard order.

## Language editor

Explore, custom widget queries and custom tooltip queries share a CodeMirror editor. Prometheus uses the official PromQL grammar, semantic diagnostics and completion engine; Tempo uses Grafana's TraceQL grammar with intrinsic, operation and provider attribute/value suggestions. The editor includes syntax highlighting, line numbers, bracket matching, undo/redo and search. **Ctrl Space** opens suggestions; **Enter** or **Tab** accepts the selected suggestion; **Escape** dismisses it. Tab leaves the editor when there is no active suggestion.

Provider completion uses the existing authenticated `InsightsClient.metadata` endpoint, with bounded caching and cancellation when the provider/editor changes. It never executes a data query. Unavailable metadata leaves language completion and freeform editing available. Completion popups inherit the current light/dark theme and stay in the active modal when applicable.

Declared saved-query parameters, dashboard variables and tooltip mappings are offered as `{{name}}` completions. Diagnostics analyze a shadow document with typed literals in place of parameter tokens; the authored text and exact-once runtime interpolation remain unchanged. Syntax messages are editing guidance; provider execution remains authoritative. The editor retains the existing 8,192-character query limit.

The reusable editor also accepts SQL mode with a dialect and schema through `sqlConfig`. Paprika currently exposes only Prometheus and Tempo connections; this change does not add a SQL provider or SQL execution.

### Library details

Descriptions and tags in **Overview**, plus the optional **Metadata** fields, describe a saved query wherever it is selected. These fields are optional and do not alter query execution:

- `description`: up to 500 characters.
- `imageUrl`: an HTTPS image URL or a same-origin path beginning with `/`, up to 2,048 UTF-16 units. Protocol-relative URLs, credentials, whitespace, control characters and backslashes are rejected. The image is referenced by URL, not uploaded into the query document; a failed preview remains visibly unavailable.
- `tags`: up to 12 unique, case-sensitive strings, each 1–32 UTF-16 units without surrounding whitespace. The editor trims a tag when it is added.
- `metadata`: up to 12 string entries with trimmed, nonempty keys up to 64 UTF-16 units and values up to 256. `__proto__`, `prototype`, and `constructor` are reserved keys. Empty values are allowed.

The complete saved query remains limited to 32 KiB. Rich details survive save/copy, service restarts, provider remapping and JSON/YAML bundle exports/imports. They participate in exact document comparisons, including confirmation after a lost save response. OpenUI remains reference-based and uses the details from the destination saved-query library.

Library rows and query selectors show artwork, descriptions, tags and metadata. Search includes these details. Saved-query bookmarks use the paprika accent; direct provider queries use a sage code icon. Provider selectors show metric/flame and trace/path identities alongside their names. These details stay in the library and editors, keeping the dashboard canvas focused on telemetry.

## Metric inspection

Choose a metric and select **Inspect metric** beside its name to see available labels, stored series over an approximate 24-hour window, and distinct values per label. Expand a label to browse values and add one as a filter. Inspection requests series metadata only when opened and cancels when closed. Counts are bounded to 1,000 unique returned series and explicitly become lower bounds when discovery is partial; they are not global active-series counts. Label and value browsing remains available if cardinality discovery fails.

## Live widget editing

Widget settings preview valid title, style, query, tooltip and layout changes immediately in the dashboard draft. Guided query adjustments preview automatically; typing queries coalesces requests for 350 ms and cancels stale work. **Save dashboard** persists the draft. Invalid edits retain the last valid canvas and prevent saving while the editor is open. Explore continues to require **Run query** explicitly.

The widget editor's **Source** tab shows the current validated widget as read-only JSON or YAML, including unsaved preview changes. When an edit is invalid, it identifies that the source is the last valid widget.

## Parameters and dashboards

Parameters have a unique name, optional display label, `string` or `number` type, and optional typed default. A missing default makes the parameter required. Every `{{parameter}}` token must be declared and stand alone as a complete unquoted literal:

```yaml
schemaVersion: 1
id: service-request-rate
name: Service request rate
providerId: prometheus
kind: metrics
query: 'sum(rate(http_requests_total{service={{service}}}[5m])) * {{factor}}'
parameters:
  - name: service
    label: Service
    type: string
    defaultValue: api
  - name: factor
    type: number
    defaultValue: 1
```

**Use in dashboard** adds a linked widget and maps each parameter to a same-name dashboard variable. It creates missing variable definitions from parameter labels/defaults while retaining existing variable values. The widget editor can instead bind parameters to a different dashboard variable, a constant or the saved default. Dashboard variables remain strings; numeric parameters accept only complete finite numeric values. A required numeric variable with no value blocks the query locally until populated.

```yaml
queryRef:
  id: service-request-rate
  bindings:
    - parameter: service
      source: variable
      variable: selected_service
    - parameter: factor
      source: constant
      value: 100
```

`queryRef` is authoritative, including the saved definition’s provider. The existing widget `query` and `providerId` remain a custom-query draft restored by **Use custom query**. A missing query, incompatible provider/kind, missing required binding or invalid number produces a local error; execution never falls back to the custom draft. Library updates invalidate visible results and cancel old requests. String literals are escaped once; a value containing quotes, newlines or `{{text}}` remains data.

**Connect matching parameters** fills unbound required parameters from compatible existing graph connections, exact graph-label names or declared dashboard variables. Each suggestion can also be applied individually, including an optional parameter with a saved default. Bulk connection preserves existing mappings and defaults. Numeric parameters only suggest compatible numeric values or exact observation fields; ambiguous provider placeholders remain manual choices.

Tooltip editors expose **Available graph data** from the selected graph’s already-loaded result: label names, sample values and how many series contain each label. Label pickers support discovered names and custom entries. No discovery query is issued for this panel, and query/range/variable changes invalidate the displayed fields. **Use graph’s saved query** copies its reference and explicit connections; **Existing widget query data** reuses the result without another request. Provider templates offer **Connect matching fields** for unbound placeholders. These helpers author ordinary explicit bindings, so execution, JSON/YAML/OpenUI and persistence use the existing contract.

## Tooltip data

Heatmap cells, time-series points, bars and table rows offer the same data choices under **Edit widget → Tooltips → Add sub-widget → Data**:

- **Hovered series** preserves the existing focused series behavior and makes no additional request.
- **Existing widget query data** reuses the full normalized parent result, including all series, with no additional request. Changes to the parent result update the sub-widget. Its kind must match the selected visualization.
- **Provider query** executes its configured provider/query with explicit observation bindings.
- **Saved query** links a saved definition. Parameters can use saved defaults, constants, dashboard variables, hovered labels, series name, exact value or exact timestamp.

Saved tooltip references use `source: {type: saved, ref: {id, bindings}}`. Observation mappings use `{parameter, source: label, label}` or `{parameter, source: field, field: value|timestamp|series}`. Timestamp is Unix seconds, including fractional precision. Time-series uses the selected historical point; bar/table uses its displayed latest-valid point; heatmap keeps its actual selected latest point, including null. Missing exact context blocks the request. Hover queries share cancellation, concurrency and cache limits with normal widgets and cannot create recursive tooltips.

## Persistence, portability and hosts

The [saved-query JSON Schema](saved-query.schema.json) and TypeScript/Go validators define the strict document contract. The service persists saved queries separately from dashboards in `saved-queries/`, uses ETags for conditional create/update/delete and protects definitions used by dashboards. A provider’s kind or deletion cannot invalidate its saved library. Query text is data, and saved definitions cannot install code, endpoints or credentials. Read/write access follows the Insights RBAC permissions; connection administration remains separate.

Example mode stores its own query library in browser local storage and does not change the service. JSON, YAML and OpenUI preserve saved references and their bindings; the optional fourteenth OpenUI widget argument is `queryRef`, so existing positional documents continue to work. JSON/YAML exports now include the exact saved-query dependencies, including tooltip references, in a portable bundle. Import review maps the bundled providers, reuses identical definitions or copies conflicting IDs, then rewrites both widget and tooltip references. Legacy documents and OpenUI remain reference-based and require definitions in the destination library. Dormant custom-query drafts are preserved. See [portable dashboard bundles](portable-bundles.md) for conflict choices, partial results and retry behavior.

Custom hosts can use `SavedQueryLibraryProvider`, `resolveSavedQueryReference` and the exported schemas. Resolve a reference exactly once before calling the raw `InsightsClient.query` / shared scheduler; the raw HTTP client rejects unresolved references. `WidgetVisualization` supplies parent data automatically; custom rendering hosts can supply `TooltipWidgetDataProvider`. Do not pass provider APIs to tooltip renderers.
