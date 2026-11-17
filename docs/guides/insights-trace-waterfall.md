# Trace waterfall

The trace explorer can expand a Tempo search result into an on-demand span
waterfall. Choose **View waterfall** on a trace row to load that trace through
the same authenticated Insights and delegated Observe provider path. Closing
the row cancels any in-flight read. Saved-query bindings and dashboard filters
continue to govern the original search; the selected trace ID is sent only for
the detail read.

Bars use the returned span start and end times, positioned against the earliest
start and latest end in the returned trace. Parent/child rows use recorded span
IDs; missing parents are retained as roots. Hover a bar for its exact timestamp
and duration, or focus it for its accessible description. Error spans are
distinguished from other statuses. The search list reports `unknown` where
Tempo search does not provide a trace-wide status.
The span detail shows its start in the viewer's local timezone, matching the
trace list; its machine-readable timestamp and title retain the exact UTC value.

Use **Filter spans** to search the returned service, operation, span ID,
status or allowed attribute values. **Errors only** restricts matches to spans
with recorded error status. Recorded parent spans remain visible as context,
including their timing; missing parents are never invented. Filtering operates
only on the already-loaded trace and does not issue another provider query.

Detail is currently supported for Tempo providers with 32-character hex trace
IDs. Other providers return a clear unavailable message. Responses are bounded
to 500 spans and marked partial when truncated. Each span's **Details** control
shows the recorded timing, IDs and status, plus at most eight safe semantic
dimensions. Only allowlisted HTTP methods/statuses and protocol versions, database and RPC systems,
database operations, messaging systems/operations, and network transport or
protocol values are returned. gRPC status codes are restricted to 0–16. Unknown values, duplicate attributes and other
attributes are withheld and counted; headers, query text, arbitrary strings and
resource attributes other than the existing service name are not returned. There is no
critical-path calculation or inferred missing span. The local gallery generates
synthetic four-span distributed traces, not production telemetry.
