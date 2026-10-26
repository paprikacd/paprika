# Observability / Insights integration validation

Date: 2026-10-26. Base: `origin/master` at `648f4e0b`.
Working branch: `issue/observability-dashboard-integration`.

## Recovery and rebase

Fetched and rebased onto the current remote default branch. The previous branch's
remote had been removed. Original history is retained on
`issue/insights-pre-rebase-20261026`; the pre-rebase tracked and untracked work is
retained in `stash@{0}`. All 1,016 stashed untracked files were checked against
Git blob hashes and recovered unchanged before integration edits. Merge
conflicts were resolved against the current authentication and dashboard shell;
no unmerged index entries remain.

## Implemented path

The dashboard and query editor discover authorized Prometheus/Tempo providers
from the Observe gateway. Insights uses stable SHA-256-derived IDs and preserves
the canonical namespace/name reference in its transient provider listing. Local
standalone providers remain supported. Shared sources are configured through the
Observability board rather than copied into the Insights configuration store.

The Paprika API signs a 30-second Observe token carrying the human subject and
exact groups. It discards incoming delegation headers and browser credentials.
Insights forwards only the delegated token to the gateway. HTTP and MCP share
one authorized backend, bounded execution and credential resolution. OAuth code
exchange and refresh preserve the same groups, including explicitly empty sets.

Existing saved queries and parameter mappings continue through the existing
scheduler. PromQL and TraceQL completion, metric labels/cardinality, timestamp
conversion, missing samples and explicit partial-result indicators are retained.
The `query_metrics` MCP tool accepts `step_seconds` so callers can reproduce the
dashboard's range query precisely.

## Verification

- Full frontend suite: **1,321 tests in 137 files passed**.
- Production Next.js build: passed, including `/dashboard/insights` and
  `/dashboard/observability`.
- `go build ./...`: passed.
- `go test ./cmd ./internal/api ./internal/api/auth -count=1`: passed.
- Required engine and pipeline controller tests: passed.
- `go vet ./internal/... ./cmd/...`: passed.
- Gateway and connector suites: **710 tests across 19 packages passed**;
  focused gateway command suite: **23 tests passed**.
- Insights and MCP package race suites: passed. The Insights suite also proves
  a blocked remote provider lookup cannot block unrelated dashboard saves and
  cancellation cannot persist the interrupted saved query. Additional focused
  gateway/proxy/delegation race run: **37 tests passed**.
- Helm 3.21.2 lint and `task chart:validate`: passed, including the new shared
  Insights/Observe configuration. A separate rendered-manifest assertion checked
  a customized Service port (`18090`), both API/Insights destinations, the issuer,
  and Insights network egress to the actual gateway pod port (`8090`).
- Required CRD regeneration and `task chart:crds`: passed with no generated diff.
- `git diff --check`: passed.

## Browser evidence

**93 scenarios passed, with zero page errors:**

| Suite | Passed | Report |
| --- | ---: | --- |
| Authenticated Observe integration | 11 | `artifacts/insights/observability/report.json` |
| Query workspace/editor | 38 | `artifacts/insights/explorer/report.json` |
| Queried tooltip | 24 | `artifacts/insights/tooltip-query/report.json` |
| Live widget editing | 8 | `artifacts/insights/live-editing/report.json` |
| Service variables/filter | 12 | `artifacts/insights/variable-filter/report.json` |

The integration fixture runs the real API proxy, Insights storage, Observe HTTP
and MCP handlers, namespace authorizer, Kubernetes provider resolver, and native
connectors. Its Kubernetes storage and telemetry backends are deterministic
local fixtures; this is not a live-cluster deployment test. Provider credentials
are resolved from labelled fixture Secrets. No local provider configuration is
needed. Denied callers cannot discover or execute shared providers or reach the
telemetry backend.

The browser tests save parameterized queries and dashboards through the
authenticated API, select services, verify two-decimal values and changed
sparkline paths, inspect metric cardinality, accept provider-aware completions,
and search Tempo traces. MCP discovery matches dashboard-visible providers and
MCP queries return exactly the same samples for identical expression/range/step.
Light/dark and 1512px/390px layouts were exercised; screenshots were inspected.
Temporary fixture processes and credentials were removed after testing.

## Scope

Shared dashboard adapters currently support Prometheus metrics and Tempo trace
searches. Other Observe connectors remain available through MCP. Saved-query
persistence remains in Insights; this change does not add saved-query MCP tools,
SQL connections, or log widgets. The checks in this report use local fixtures.
Live-cluster acceptance is documented separately in [omega-validation.md](omega-validation.md).
