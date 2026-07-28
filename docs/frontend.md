# Paprika operations console

Paprika serves a compiled operations console on port `3000` by default, configurable with `--ui-bind-address`. It is designed for platform and SRE teams that need fleet-wide delivery health, an application inventory, and focused troubleshooting without loading every Kubernetes object into the browser.

## Access

The console is not exposed outside the cluster by default. Port-forward the deployment that owns the UI:

```sh
kubectl port-forward -n paprika-system deployment/paprika-controller-manager 3000:3000
```

For a split API deployment, forward the API instead:

```sh
kubectl port-forward -n paprika-system deployment/paprika-api 3000:3000
```

Open `http://localhost:3000/dashboard`. When `--auth-enabled=true`, the console uses the same Basic or OIDC authentication and project authorization rules as the Connect API. See the [authentication guide](guides/auth.md).

## Routes and navigation

| Route | Purpose |
| --- | --- |
| `/dashboard` | Authorized fleet posture, active delivery changes, dependency failures, highest-impact attention, pipelines, and releases. |
| `/dashboard/applications` | Fleet inventory with Treemap, Matrix, Table, and Queue presentations. |
| `/dashboard/application?namespace=<namespace>&name=<name>` | Focused application troubleshooting and delivery history. |
| `/dashboard#pipelines` | Pipeline list; pipeline rows link to the focused pipeline view. |
| `/dashboard#releases` | Recent release list and release drill-down entry points. |
| `/dashboard/rollouts` | Rollout inventory and rollout actions. |

Old `/dashboard#applications` links are redirected to `/dashboard/applications`. Activity and Admin appear as disabled, non-link placeholders labelled “Available in a later plan”; they are not partially implemented management pages.

## Fleet query semantics

The fleet pages use `QueryApplications`, `QueryFleetMap`, and `QueryFleetMatrix`. These RPCs query an immutable, cache-backed projection rather than listing Kubernetes resources per request.

- Authorization is applied before search, filters, facets, totals, aggregation, sorting, pagination, and per-row capabilities. A result count cannot reveal an unauthorized application.
- Different filter dimensions are combined with AND. Multiple values inside one dimension are combined with OR.
- Projects and clusters are namespaced identities. URL values use `namespace/name`; a bare name is rejected rather than guessed.
- Supported dimensions are project, namespace, cluster, stage, health, sync, release state, rollout state, and source type. Repeated URL parameters are canonicalized and preserved when switching presentation.
- Search is normalized and bounded at the API. Ranking is deterministic: exact, prefix, and substring matches precede fuzzy trigram matches. A search defaults to relevance ordering unless an explicit compatible sort is selected.
- Map and Matrix use the same authorized scope and filters as Table and Queue. Matrix row and column dimensions must differ.
- Treemap size defaults to managed resource count. Request-rate sizing falls back to resource count when no operational metric source is configured, and the response marks that fallback explicitly.

Facet counts describe the complete authorized search result, not only the loaded page. Facets are self-excluding: a health bucket applies every active filter except health, a project bucket applies every active filter except project, and so on. This lets an operator see viable alternatives without broadening any other part of the query.

### Pagination and cursors

Application pages default to 100 records and are capped at 500. The UI explicitly loads the next 100 records and de-duplicates by namespaced application identity.

Cursors are opaque, URL-safe values containing only a versioned deterministic sort boundary and a hash of the canonical filter/search/sort/direction/page-size inputs. They contain no credentials or Kubernetes objects. A cursor can resume on another replica or a later index generation; authorization is evaluated again against the current caller before seeking. Changing any bound query input invalidates the cursor. If a cursor is stale, malformed, or mismatched, the UI discards the accumulated pages and retries page one once.

`total`, facets, and `index_generation` always describe the snapshot used for that response. The UI retains a settled prior view while a replacement request is in flight and never reconciles filters from stale facets.

## Serving, readiness, and degraded operation

The fleet index registers informer handlers before the shared controller-runtime cache starts. `/healthz` reports process liveness; `/readyz` reports whether the fleet projection is current enough to accept new traffic.

- Before the initial cache sync and snapshot install, fleet queries return `Unavailable` and readiness fails.
- With `--api-cache-enabled=false` (or `PAPRIKA_API_CACHE_ENABLED=false`), legacy RPCs remain available, but enterprise fleet queries return `Unavailable` with the configuration reason. The console shows a configuration error rather than an empty fleet, and readiness remains failed.
- If a later rebuild fails, Paprika retains and continues serving the last good immutable snapshot. Readiness becomes degraded, metrics record the rebuild failure, and the console labels retained data as stale instead of clearing it.
- A successful rebuild atomically installs a new generation and clears degraded readiness.

This separation is intentional: liveness, readiness, and the availability of a previously good snapshot answer different operational questions.

## Refresh behavior

The browser does not open the legacy unauthenticated EventSource endpoint. Exact `GET /events` is fail-closed with `404` until an authorized watch transport is available.

Visible fleet and overview pages refresh every 60 seconds. Focused application and pipeline pages refresh every 15 seconds. Returning focus triggers an immediate single-flight refresh; hidden tabs stop scheduling requests. Failures use bounded exponential backoff up to 120 seconds. Operators can continue inspecting the last settled response during a transient refresh failure.

## Presentations and accessibility

- **Treemap** uses one Canvas and one focus controller, not one DOM element per application. Health is represented by text and status symbols as well as color. Arrow keys move spatially, Home and End jump through reading order, Enter or Space selects an application, double-clicking a group zooms, and Escape exits zoom.
- **Matrix** is a semantic table with textual health labels plus application and target counts in every populated cell.
- **Table** is the complete semantic equivalent of the Canvas. It exposes row and column counts, virtual row positions, all status text, and capability-gated actions. Enter or Space selects the focused application.
- **Queue** uses the same authorized records ordered by server-ranked impact and remains available when a visual grouping is not useful.

Presentation switches preserve filters, search, selection, and focus by stable application identity. If that identity disappears, focus moves to the presentation heading and a live-region announcement explains the change. Reduced-motion preferences disable non-essential motion.

## Operational metric-source direction

Plan 1 keeps operational sources provider-neutral. The fleet projector has an optional source seam that can register one additional cached resource type and project only a source identity plus connection state into application summaries. With no adapter registered, observability is `NotConfigured`; that is absence, not a failure.

Prometheus is the first planned concrete adapter for request rate and golden signals. Later adapters can implement the same source/projector contract without changing fleet query or UI semantics. User-provided arbitrary PromQL is not accepted by these fleet RPCs. Paprika's own OTel instruments continue to be exported through the controller-runtime Prometheus registry at `/metrics` independently of this future operational-data adapter.

## Controlled 10,000-application scale gate

The reproducible scale gate intentionally runs only when the Docker server reports `linux/amd64` and at least 8 GiB of memory. Cross-architecture emulation and smaller Docker Desktop allocations fail preflight because their timings are not comparable.

Run from the repository root:

```sh
bash hack/test-fleet-scale.sh
```

The runner locks the Linux amd64 manifests to these committed references:

- `golang:1.26.0-bookworm@sha256:4f7e5f23bfacf4c2934ba70c132532742b6a53f01a4209e2c2eb7bd06c16f0bc`
- `mcr.microsoft.com/playwright:v1.61.1-noble@sha256:cf0daee9b994042e011bc29f20cdff1a9f682a039b43fcd738f7d8a9d3bcd9d6`

The runner verifies each pulled repository digest before executing it. Both containers run with `--platform linux/amd64 --cpus 4 --memory 8g`. The Go process runs with `GOMAXPROCS=4` and a controlled-environment flag that the test verifies. The API gate seeds 10,000 applications, warms the index, measures cached queries, and checks retained heap after an identical rebuild. The browser gate builds the compiled UI, starts the real same-origin Go fixture with 10,000 applications, and measures cold Treemap readiness plus presentation switching without Connect route mocks.

The enforced thresholds are:

| Measurement | p95 limit |
| --- | ---: |
| Cached fleet API queries | 300 ms |
| Initial fleet query plus Canvas render | 2,000 ms |
| Post-load presentation switch | 250 ms |

Evidence is preserved under `artifacts/fleet-scale/`:

- `environment.txt` — UTC, host and Docker kernel/platform/memory, pinned image references and pulled digests, Go/Node/Playwright/Chromium versions, cgroup limits, and API/UI container peak memory.
- `api-scale.log` — API latency, heap, allocation, runtime, and `GOMAXPROCS` measurements.
- `ui-scale.json` and `ui-scale.log` — raw UI samples, calculated p95 values, and threshold results.
- `fixture-build.log`, `fixture.log`, `npm-ci.log`, and `ui-build.log` — build and server diagnostics.
- `test-results/` and `playwright-report/` — traces, screenshots, and report output when Playwright produces them.

CI runs the same script in the `fleet-scale` job and uploads this directory even when the gate fails. The separate `fleet-ui-smoke` job builds the compiled UI and Go fixture, then exercises the normal, reduced-motion, and keyboard-only Playwright projects against the real same-origin Connect server.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Console blank or `404` | Confirm the operator/API mode serves the UI, the port-forward targets port `3000`, and the compiled assets are present. |
| Fleet configuration error | Check `--api-cache-enabled`, `PAPRIKA_API_CACHE_ENABLED`, and the `/readyz` reason. There is no direct-read fallback for fleet queries. |
| Stale-data banner | Inspect `/readyz`, fleet rebuild failures, informer/cache sync, and fleet index metrics. The prior snapshot remains intentionally visible. |
| Empty inventory | Clear or inspect URL filters first; an authorized zero-result query is distinct from `Unavailable` and unauthorized states. |
| Filter removed after refresh | The selected value is no longer present in the settled authorized facets. The reconciliation notice identifies the removed value. |
| Application action disabled | Capabilities are computed per project and caller. Verify RBAC rather than assuming the shared snapshot contains action rights. |
| Updates appear delayed | Visible fleet pages poll at 60 seconds and focused pages at 15 seconds. Focus the window or use the manual refresh; `/events` is intentionally disabled. |
| Scale script fails preflight | Use a Docker server reporting `linux/amd64` with at least 8 GiB allocated. Do not compare results from emulation or a smaller runtime. |
