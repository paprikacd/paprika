# Recorded chart events

Time-based widgets can overlay recorded events from a saved records query: time
series, stat sparklines, and plugins that declare the `annotations` capability in
`ui/src/features/insights/plugins/plugin-capabilities.ts` (for example stacked
time series, directional traffic, the distribution heatmap, small multiples and
status history). The document field is `annotationSource`: `queryRef`,
`timestampColumn`, `labelColumn`, and optional `endColumn` (for an interval) and
`severityColumn`. A dashboard-level `annotationSource` applies to every
time-based widget that does not declare its own. In the widget's Query tab, choose **Add event query**, select a records
saved query, bind its parameters to dashboard variables or constants, and name
the returned timestamp and label columns. A severity column is optional.

The timestamp must be an ISO datetime with an explicit timezone or Unix
milliseconds. Only recorded events within the displayed series extent are
shown. The chart shows at most 20 queried events in that extent and discloses
additional events, invalid records and partial provider responses. Severity
values `info`, `warning` and `critical` receive matching markers; other values
remain unclassified. Authored static events can coexist with query events.
Marker lines never intercept chart pointer interactions. The event list shows
local times with the timezone, while its timestamp and tooltip retain exact UTC.

The event query uses the same authenticated provider resolver, saved-query
bindings, scheduler and cancellation as the primary widget. Errors are shown
independently and do not replace a successful metric chart. The annotation
reference is part of portable dashboard bundles, copy remapping and saved-query
deletion/replacement protection. Dashboard and saved-query ETags remain the
write preconditions.

Observe MCP's `query_dashboard` includes the annotation query as a separate
`annotationSignalId`, with `annotationColumns` identifying timestamp, label
and severity fields, and includes the referenced saved-query ETag. A missing
query, failed provider or invalid mapped column reports `annotationError` and
a partial bundle without hiding the main signal. Compact records expose the
first 12 columns and a bounded row preview; put event fields in those first
12 columns so a machine can interpret the result.
