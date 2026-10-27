# Service overview HTTP metric repair

`queries.json` contains narrow patches for the six HTTP saved queries used by
the persisted `service-overview` dashboard. The trace query is unchanged.

The queries accept two observed instrumentation schemas:

- Uptime: custom counters and millisecond histograms under
  `service="telesis", otel_scope_name={{service}}`.
- Brandbrain: stable OTel HTTP duration counts and second histograms under
  `job="brandbrain-api", service="brandbrain", service_name={{service}}`.

Each branch aggregates separately. `or` chooses an existing branch without
adding both schemas together. Brandbrain latency is multiplied by 1000 after
the quantile calculation, keeping the dashboard's millisecond units. Missing
error classes become zero only against an observed request total. Missing
services remain empty; ratios and quantiles with no traffic remain undefined.

First deploy Brandbrain's OTel MeterProvider/Prometheus exporter and confirm
that Cuttlefish has collected these exact metric names and labels. Query
changes cannot repair an exporter that emits no HTTP metrics.

## Safe application through Observe MCP

Import `migrate` into an authenticated MCP maintenance harness:

```js
import { migrate } from "./hack/service-overview/migrate.mjs"

const preview = await migrate(call, { expectedProviderId })
// Review and retain the planned patches and exact before-documents.
const receipt = await migrate(call, { expectedProviderId, apply: true })
```

`call(name, args)` is an authenticated Observe MCP `tools/call` client that
returns `structuredContent` and throws on protocol/tool errors. It needs only
`get_saved_query` and `patch_saved_query`. Credentials stay in the caller's
private configuration; never save them in this directory or a receipt.

The helper validates all six current documents before writing, uses their
fresh exact ETags, changes only query/description/owned metadata keys, and reads
each result back. A concurrent edit stops the run without retrying. It is safe
to rerun after inspection: already matching documents receive no write.
The six-document operation is not transactional; retain the returned/read
before-documents and inspect current state after any partial failure.

## Verification

```sh
node --test hack/service-overview/*.test.mjs ui/e2e/service-overview-coverage.test.mjs
```

PromQL tests use the pinned official Prometheus image with networking disabled.
Set `PROMTOOL=/absolute/path/to/promtool` to use a local executable instead.
Fixtures evaluate both schemas, millisecond conversion, absent services,
scrape-target isolation, overlapping schemas, real and absent error classes,
and zero-traffic semantics.

After applying, run `ui/e2e/insights-service-overview.e2e.mjs` with private
`INSIGHTS_SERVICE_OVERVIEW_CONFIG` listing both `uptime-api` and
`brandbrain-api`. Remove historical `state: "empty"` expectations for
Brandbrain. Every widget now requires real data by default, chart/sparkline
series need multiple finite samples, and traces must match the chosen service.
Explicit empty expectations remain available for intentional missing-service
negative tests. The browser test remains read-only and checks light/dark,
desktop/mobile, precision, chart observations, and unchanged document ETags.
