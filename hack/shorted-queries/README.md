# Shorted native metric query adaptations

`queries.json` contains targeted adaptations for the imported Shorted Operations
and Stealth dashboards. Native discovery in Shorted's Grafana Cloud stack on
2026-10-27 confirmed these metric names in the previous hour:

- `rpc_server_duration_milliseconds_count`
- `shorted_stealth_fetch_total`
- `shorted_stealth_fetch_errors_total`
- `shorted_stealth_fetch_bytes_total`
- `shorted_stealth_fetch_duration_seconds_bucket`

The original source inventories and generated source queries remain unchanged.
Each entry is keyed by its canonical source saved-query ID and supplies a **new**
saved-query `id`, adapted query, description and provenance metadata. The caller
must explicitly supply the verified Shorted Grafana Cloud provider. Its read
credential needs `metrics:read`; discovery or ingestion access alone is insufficient.

The RPC duration histogram count records one completed RPC call. It replaces the
unobserved `rpc_server_requests_total` for call rate and estimated 24-hour calls.
`rpc_server_requests_per_rpc` measures messages within an RPC and is not a
substitute for the call count. The existing service parameter and source windows
are preserved. A 24-hour `increase` with partial history is an estimate, not proof
of complete history coverage.

Stealth errors and byte counters use their observed `_total` suffix. Duration
buckets use `_seconds_bucket`; output stays in seconds. Error ratios aggregate
both sides `without(status)`, because the total counter adds a status label that
the error counter lacks. Other labels, including host, engine and workload,
remain distinct. There is no global zero fallback: absent error telemetry stays
empty, and a zero-fetch denominator is filtered out.

## Remaining evidence requirements

- Observed RPC duration series have no `rpc_connect_status_code` or
  `grpc_status_code` label. RPC error rate and 24-hour errors therefore need a
  separately verified error signal or an instrumentation change. Never replace
  their source metric with the duration count while retaining
  `rpc_connect_status_code!="ok"`: that matcher also selects absent labels and
  would misclassify every RPC as an error.
- No `shorted_logo*` series were found in the observed hour. Logo metric renames
  are intentionally absent until native discovery establishes them.
- Sync metrics were absent in that hour; longer-window availability is unverified.
- Short batch jobs may export only one observation. `rate` and `increase` need
  multiple samples; the adapters do not invent history or turn absent data into zero.
- The remaining HTTP metrics and existing source queries are not changed by this
  catalog. Discovery of a name does not establish complete dashboard coverage.

## Apply as new saved queries

Saved-query provider identity is immutable. Do not patch an existing query to a
different provider. An authenticated Observe MCP maintenance flow should:

1. Read the actual saved queries and owning dashboards with their exact ETags.
   Match canonical source IDs to the deployed documents by their recorded
   provenance; imported copies may have different IDs.
2. Copy each source query's name, tags, image and parameters. Overlay the matching
   adaptation, merge its metadata, and set the verified Grafana Cloud provider ID.
   Create the new ID only if absent; an existing ID must match the reviewed
   document before it can be reused.
3. Update only the intended dashboard query references to the new IDs, retaining
   variable bindings and unrelated widgets. Use the dashboard's exact read ETag
   as the write precondition; stop on conflicts.
4. Read back and compare both documents. Query the native provider, the Observe
   dashboard bundle and the UI with at least two real service selections. Leave
   the original saved queries available to other dashboards.

These files perform no live mutations and contain no credentials. The operation
is not transactional: retain creation and update receipts, and inspect current
state before resuming after a partial failure.

## Tests

```sh
node --test hack/shorted-queries/queries.test.mjs
```

The tests use the pinned official Prometheus image with networking disabled, or
`PROMTOOL=/absolute/path/to/promtool`. Fixtures cover native names, completed-RPC
count semantics, seconds and bytes, vector matching, independent workload labels,
missing metrics, insufficient samples, expired windows and zero denominators.
They validate expressions, not live provider availability.
