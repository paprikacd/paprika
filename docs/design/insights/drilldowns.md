# Dashboard variables and drilldowns

## Build a link in the UI

1. Open the destination dashboard, choose **Manage**, and add its variable declarations (for example, `service`). Apply the declarations and save the dashboard.
2. Use the variable in a destination widget query, such as `up{service={{service}}`.
3. Open a source widget's **Links** tab. Add a dashboard link, select the destination in the searchable Gamma picker, and bind `service` to the selected signal's `service` label. Apply the widget and save.
4. Select a heatmap cell, table row, or trace. For multi-series charts, choose a series in the widget picker. To follow a link from a specific historical time-series point, pin its tooltip and choose the named link directly. Alternatively choose **Use sample for dashboard links**, then open the arrow menu in the widget header. Without an explicit point, a single-series widget uses its latest observation automatically.

The destination shows editable view variables and a return link. Text inputs use **Update view** to update queries once after editing; typing does not issue requests. Variables with authored dropdown choices apply that selection immediately and preserve keyboard focus; pending text edits remain staged until **Update view**. Selecting filters updates the URL view, without changing saved defaults. Each dropdown apply, **Update view**, selected signal and brushed window adds a Back/Forward step; re-selecting the value already applied adds none. Toolbar time range and auto refresh changes replace the current entry, so they do not add steps: one Back after them returns to the last filter step and undoes them too. Browser Back/Forward and reload restore the same URL context, including on a new or duplicated dashboard that has not been saved. **Copy dashboard link** copies that view, including the toolbar time range and refresh. Selecting a series in the picker uses its latest valid value. A deliberately selected time-series sample uses that exact point's labels and value for dashboard links; the source widget identifies its observation time. Direct tooltip links use the same validated context and carry the current dashboard range when configured, not a range centered on the sample. A missing binding disables the link and explains why. The selection expires when the query result changes, returning to the latest available value for that series. Hovering or focusing an unpinned tooltip does not change the link context.

The carried time range and variable overrides are view state. Saving the destination keeps its own configured range and variable defaults. The toolbar time range (a preset or a fixed window) and auto refresh are view state too: changing them never sets the dashboard dirty and never enters edit mode. A fixed window pauses auto refresh; a relative preset keeps refreshing at the view's interval. In edit mode, **Set as dashboard default** copies the current view's time range and refresh into the dashboard; it is the only way a view edits the document. Refresh does not apply to a fixed window: copying a fixed window sets the range and variables and leaves the saved refresh interval unchanged, while copying a relative preset copies its active refresh. Missing signals, labels, destinations, and declarations are surfaced before navigation. Edits made while a destination loads are preserved, and a declined discard prompt keeps the current document and URL.

Library imports allocate all new IDs before rewriting links between imported dashboards. Partial retries preserve these mappings, including when a provider mapping is corrected. Links to dashboards outside the imported library retain their original target IDs.

## Document contract

A widget's `drilldowns` entry is either a dashboard link (`dashboardId`, optional `carryTimeRange` and `bindings`) or an application link. An application link has `id`, `title` and `application: {namespace, name}`. Each of `namespace` and `name` is `{source: "label" | "constant", value}`: a label names a key of the signal, and a constant is a fixed name of 1 to 253 characters. An application link opens the Paprika application page. It never carries a dashboard ID, and a link with both is refused. The Go validator (`validateApplicationLink`) and Zod (`widgetLinkSchema`) reach the same verdict.

### Filter this dashboard from a selection

Timeseries, bar, table, heatmap and trace widgets, and the record treemap, table, list, matrix, record line/bar chart, pie, status-history, geo-heatmap and connection-map plugins, can set dashboard variables from a selection. Add the variable first, then add a selection binding on the widget's **Links** tab and choose its field or label. Activating a mark applies the filter to other queries:

- A table row, trace row, heatmap cell or plugin mark: click it, or press Enter or Space.
- A bar: click it, or press Enter on it or on its legend entry.
- A timeseries: click a legend entry or press Enter or Space on it, or use **Filter dashboard by** in its pinned tooltip. Clicking a plot point only pins its tooltip.

A selection on a variable with several values sets it to that one value. Hover and keyboard focus never filter. On the table and trace rows, heatmap cells and timeseries and bar legends, the mark whose selection the dashboard already shows is marked as applied (`data-filter-active` and `aria-current`). Bars in the plot and selectable plugins do not show that state yet. Re-selecting it adds no history step; clear the filter in the variable bar or with Back. Stat widgets cannot select. A binding kept on a stat or an unlisted plugin is retained but stays inactive, and lint warns about it. A missing field stops the whole update and displays an error. Other current filters and saved defaults are preserved. Existing drilldown links continue to work.

The document representation uses the same bounded sources as drilldowns:

```yaml
selectionBindings:
  - variable: company
    source: label
    value: symbol
```

Selection updates URL view state rather than the persisted dashboard
definition. Do not bind a widget's own query to the variable it selects:
selecting one of its marks narrows it to that one choice, and lint warns about
it. Build filtered panels from an unfiltered overview chart grouped by the same
label instead, for example a timeseries grouped by `service` with a `service`
selection binding, driving the other panels that read `{{service}}`.

Dashboards declare up to 20 named variables. Each variable has a `name`, optional display `label`, optional `defaultValue`, and optional `options` for a dropdown. A variable holds one string, or a list of strings when it allows several values (see the next section). Names use letters, numbers and underscores, start with a letter or underscore, and are at most 64 characters. Values are at most 1,024 UTF-16 code units. Unset variables remain unset; a query that needs one reports an error before requesting data.

`options` contains 1–100 unique string choices, using the same value limit. An empty string is a valid choice. These choices guide selection; defaults and incoming dashboard links may still provide a value outside the list. The viewer retains that current value explicitly rather than silently replacing it or changing the saved choices. Omit `options` to keep a text field. Variable declarations and choices are saved with the dashboard; viewer selections stay in the URL.

A variable may also declare `source`, which loads its choices in the viewer instead of from a typed list. `{"type":"labelValues","providerId","label","selector?","limit?"}` reads one label's values from a Prometheus or Tempo provider over the dashboard's view range. `{"type":"savedQuery","queryRef","field","limit?"}` reads one records column or one series label from a metrics or records saved query. A `selector` is a PromQL series selector and is allowed only on Prometheus providers. Its `{{name}}` placeholders follow the same complete-literal rule as queries, so a quoted or fused placeholder is refused when the dashboard is saved. A source may read only declared variables, and no chain of sources may depend on itself. With a source, `options` is a fallback shown when the source fails, and no value is chosen automatically. The console resolves a source in the viewer and in the variable's combobox, so its values are the ones a person can pick. `query_dashboard` resolves a sourced variable for each call as well, and reports the values it returned as `sourceOptions`, with a `sourceSummary`; `options` stays the fallback. An empty override of a sourced variable is still named in `warnings`.

Use `{{name}}` as a complete string literal in PromQL or TraceQL, without adding surrounding quotes:

```yaml
variables:
  - name: service
    label: Service
    defaultValue: api
    options: [api, worker, repo-server]
# A widget query:
query: 'sum(rate(http_requests_total{service={{service}}}[5m]))'
```

### Several values and All

A variable may allow several values. Set `multi: true`, with `options` or a `source`. Its value is then a list of strings, and an empty list means **All**. Set `allowAll: true` to offer All; it needs `multi`. The variable's `defaultValue` is a list for a multi variable (`[]` needs `allowAll`), and a string for a single one. A string given for a multi variable, in a URL, an MCP argument or a dry run, is one item. A list given for a single variable is refused.

Each list holds at most 100 unique values. Its values and one separator per gap total at most 1,024 UTF-16 code units, the same budget as one string value.

The template context decides how a list is written into a query. The rule is the same in the console and on the server:

| Text before `{{name}}` | Result for a list | Use |
|---|---|---|
| `=~` or `\|~` | Regex alternation: each value is regex-escaped, joined with `\|`, and written as one string. All is `".+"`. | `up{service=~{{service}}}`, `{ resource.service.name =~ {{service}} }`, `{app="x"} \|~ {{text}}` |
| `!~` | Negated alternation. All is refused, because it would exclude every value. | `up{service!~{{service}}}` |
| `[` or `,` | A JSON array of strings. All is `null`. Use it only as an element of a SQL `parameters` array. | `"parameters":[{{service}}]` |
| anything else, such as `=`, `!=`, `(` | Refused. The query is not run. | Use `=~` instead |

The alternation has no anchors, because PromQL, LogQL label matchers and TraceQL `=~` match the whole value already.

**SQL All binds NULL.** A plain `= ANY($1::text[])` returns no rows for an empty list, because the query receives NULL. Every SQL query that takes a multi parameter must guard for All:

```sql
WHERE ($1::text[] IS NULL OR service = ANY($1::text[]))
```

Lint warns (`variables.multi-sql-all`) when an Include All variable fills a SQL parameters array whose statement never tests that `$n` for NULL, in a widget's own SQL or in a bound records saved query.

Clicking a mark on a multi variable sets the variable to that one value, as a one-item list. Other values are changed in the variable bar. Modifier-click to add a value is not offered yet.

A saved query parameter may also take several values. Declare it with `type: "string"` and `multi: true`, and give its default as a list. Bind it to a variable with several values, or to a single variable or fixed string, which fills it as one item. A variable with several values may not bind a single-value parameter; lint refuses that binding. Lint also refuses a list placed anywhere other than the table above, and a `[` or `,` position outside a SQL `parameters` array, such as a PromQL range or argument, which the runtime would write as a JSON array the provider rejects. Saving a saved query checks its placeholders the same way.

In `query_dashboard`, `variables` values are a string or a list of strings. Arrays come only from variables that declare `multi`. The result reports `multi`, `allowAll` and the list defaults in `variableDefinitions`, so output changes only for dashboards that declare a multi variable. This is a compatible widening: an existing string value still works.

The runtime substitutes a JSON-quoted string, escaping quotes, newlines and backslashes. Templates inside single, double or backtick strings, comments, or identifier fragments are rejected. Variables cannot inject raw query syntax; numeric context is passed as a string rather than as an executable query fragment.

Widgets may declare up to eight drilldowns. Every link targets a dashboard ID within Insights and may bind up to 20 of that dashboard's declared variables:

```yaml
drilldowns:
  - id: inspect-service
    title: Inspect service
    dashboardId: service-details
    carryTimeRange: true
    bindings:
      - variable: service
        source: label
        value: service
      - variable: environment
        source: constant
        value: production
```

Binding sources are `label` (its `value` is a label key), `constant` (its `value` is literal text), `value` (the exact finite numeric observation), or `series` (the selected series name). `value` and `series` bindings have no configured `value` field. Missing labels, observations, or series names produce a helpful error; they do not silently fall back to invented values. Unbound variables use the target dashboard's declared defaults.

`carryTimeRange` defaults to true. It captures the source's current bounds as a fixed ISO time range of at most 31 days. Set it to false to use the destination dashboard's own range. Links preserve the saved dashboard definitions; navigation variables and time overrides belong to the URL state.

Shareable links use the same local Insights route, including an optional deployment path prefix. Query parameters are `dashboard` (dashboard ID), `vars` (a JSON object of string values), an optional fixed window as `from`/`to` ISO timestamps, an optional relative preset as `range` (`15m`, `30m`, `1h`, `6h`, `24h`, `7d` or `30d`), and an optional `refresh` (`0`, `15`, `30` or `60` seconds; `0` is off). `range` and `from`/`to` cannot be combined. Each parameter may appear once.

Link parsing is strict about structure only. Duplicate parameters, malformed variable JSON, more than 20 variable values, a window with only one end, a window combined with a preset, and links longer than 8,192 characters are rejected, and the current view stays on screen. Anything else that is malformed is dropped, not fatal: a variable whose name or value is malformed, a `range` that is not a listed preset, and a `refresh` that is not 0, 15, 30 or 60 each leave the rest of the link applied, and a dismissible notice names what was ignored. A variable the target dashboard no longer declares is dropped the same way. The link still opens its own dashboard in every case, never a different one. The address is then corrected in place with a replace, so it no longer carries the ignored part. Reserved variable names and external URLs or path traversal are not supported. Avoid putting credentials or other secrets in variable values, since shareable URLs are visible in browser history.

JSON, YAML, and OpenUI authoring all retain these fields. OpenUI appends the new optional positional arguments to preserve existing documents. The Go service validates the same bounded persistence contract; widget targets may refer to dashboards imported or created later, and the host checks target availability when following a link.
