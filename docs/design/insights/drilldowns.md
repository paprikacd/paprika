# Dashboard variables and drilldowns

## Build a link in the UI

1. Open the destination dashboard, choose **Manage**, and add its variable declarations (for example, `service`). Apply the declarations and save the dashboard.
2. Use the variable in a destination widget query, such as `up{service={{service}}`.
3. Open a source widget's **Links** tab. Add a dashboard link, select the destination in the searchable Gamma picker, and bind `service` to the selected signal's `service` label. Apply the widget and save.
4. Select a heatmap cell, table row, or trace. For multi-series charts, choose a series in the widget picker. Open the arrow menu in the widget header and follow the named link. A single-series widget uses its latest observation automatically.

The destination shows editable view variables and a return link. Text inputs use **Apply values** to update queries once after editing; typing does not issue requests. Variables with authored dropdown choices apply that selection immediately and preserve keyboard focus; pending text edits remain staged until **Apply values**. Selecting filters updates the URL view, without changing saved defaults. Browser Back/Forward and reload restore the same URL context. **Copy dashboard link** copies that view. Selecting a series uses its latest value; individual historical time-series point selection is not currently implemented.

The carried time range and variable overrides are view state. Saving the destination keeps its own configured range and variable defaults. A manual time-range edit changes its saved configuration as usual. Missing signals, labels, destinations, and declarations are surfaced before navigation. Edits made while a destination loads are preserved, and a declined discard prompt keeps the current document and URL.

Library imports allocate all new IDs before rewriting links between imported dashboards. Partial retries preserve these mappings, including when a provider mapping is corrected. Links to dashboards outside the imported library retain their original target IDs.

## Document contract

Dashboards declare up to 20 named string variables. Each variable has a `name`, optional display `label`, optional `defaultValue`, and optional `options` for a dropdown. Names use letters, numbers and underscores, start with a letter or underscore, and are at most 64 characters. Values are at most 1,024 UTF-16 code units. Unset variables remain unset; a query that needs one reports an error before requesting data.

`options` contains 1–100 unique string choices, using the same value limit. An empty string is a valid choice. These choices guide selection; defaults and incoming dashboard links may still provide a value outside the list. The viewer retains that current value explicitly rather than silently replacing it or changing the saved choices. Omit `options` to keep a text field. Variable declarations and choices are saved with the dashboard; viewer selections stay in the URL.

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

Shareable links use the same local Insights route, including an optional deployment path prefix. Query parameters are `dashboard` (dashboard ID), `vars` (a JSON object of string values), and optional `from`/`to` ISO timestamps. Duplicate parameters, unsupported names, invalid ranges, reserved variable names, and links longer than 8,192 characters are rejected. External URLs and path traversal are not supported. Avoid putting credentials or other secrets in variable values, since shareable URLs are visible in browser history.

JSON, YAML, and OpenUI authoring all retain these fields. OpenUI appends the new optional positional arguments to preserve existing documents. The Go service validates the same bounded persistence contract; widget targets may refer to dashboards imported or created later, and the host checks target availability when following a link.
