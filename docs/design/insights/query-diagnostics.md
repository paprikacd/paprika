# Query execution receipts

Issue: [#230](https://github.com/paprikacd/paprika/issues/230).

The query inspector reads evidence from the existing session scheduler and the
normalized Insights query result. Inspecting or selecting a receipt must not
execute a query. Receipts are diagnostics, not persisted dashboard configuration.

## Service receipt contract

`POST /api/query` adds optional `diagnostics` to a successful `QueryResult`.
Failures after validation and authorized provider resolution keep an `error`
message and HTTP status, and add `code` and `diagnostics`. Older clients can
continue reading results and error messages without consuming receipts.

| Field | Meaning |
| --- | --- |
| `version` | Receipt schema version, currently `1`. |
| `executionId` | Random identity for one service execution attempt. Shared or cached consumers must retain it rather than claiming another backend execution. |
| `outcome` | `success`, `partial`, `error`, `cancelled`, `timeout` or `capacity`. |
| `source` | Public provider ID, provider type and `direct`/`gateway` transport. No endpoint, headers or credentials. |
| `requested` | Requested `start`, `end` and `step`, all in seconds; range endpoints are Unix seconds. |
| `effective` | Whether a query was dispatched, its `provider`/`gateway` scope, bounds sent by Insights and whether the range applies. |
| `phases` | Bounded phase ledger with name, measurement owner, clock, nullable milliseconds, and exclusive/nested relationship. |
| `totalMs` | Monotonic elapsed time from service admission through normalized result or failure. |
| `counts` | Returned series, points, traces, spans and record rows. Absent on failure; actual empty results contain zeros. |
| `truncated` | The normalized result's existing partial/truncation flag. Warnings and omitted data retain the same conservative behavior. |

The service receipt deliberately omits query text, variable values, raw upstream
messages and response headers. The authenticated browser already owns its
resolved query; its diagnostic view must sanitize and bound that separate
information. Do not add credentials or endpoint URLs to either receipt.

## Timing ownership

Measured service phases use `owner: "insights"`,
`clock: "server-monotonic"` and `relationship: "exclusive"`:

1. `admission`: acquiring the shared service execution slot, including any queue
   wait. A refused or cancelled admission has this phase only.
2. `upstream`: preparation and the entire upstream operation through receipt of
   the response body. This includes retries, network activity, provider work,
   body transfer and any gateway protocol processing; those components are not
   separately measured.
3. `normalization`: translating the returned payload into bounded metrics,
   traces, spans or records. This phase exists only when payload normalization
   was entered, including a normalization error.

Those intervals partition `totalMs`. The total excludes request-body decoding,
provider authorization/discovery, receipt construction, response serialization,
and network transfer back to the browser. It is not end-to-end request latency.
The browser's measured request interval contains service work and must never be
added to this ledger as another exclusive phase.

After query dispatch, the receipt includes a provider phase with
`owner: "provider"`, `clock: "unavailable"`, `durationMs: null`,
`relationship: "nested"` and `parent: "upstream"`. The current connectors do
not expose a trusted provider execution interval. Null remains **Unknown**;
neither HTTP duration nor residual arithmetic may be labelled provider time.

Gateway queue and provider execution details require future capability-specific
instrumentation. A gateway round trip does not establish either measurement.
Concurrent queries likewise cannot be summed to obtain dashboard wall time.

## Effective bounds and counts

Direct Prometheus preserves fractional Unix seconds and the requested step.
Direct Tempo search sends integer seconds, and the receipt shows that truncation.
Trace detail fetches the complete trace independently of the dashboard search
window: `rangeApplied: false`, with effective start/end/step absent.

`dispatched: false` means no provider query or gateway query tool call was
attempted. In that state, `rangeApplied` is false and effective start/end/step
are absent: planned bounds must not appear to have been applied. Admission
rejection, cancellation before dispatch and failed gateway setup retain the
requested range separately. `dispatched: true` establishes an attempt, not
successful provider receipt or execution; transport errors can still prevent it.

For a shared source, `scope: "gateway"` describes the bounds Insights forwarded.
It does not claim knowledge of transformations or additional limits inside the
gateway or final provider. Step is meaningful only for metric range queries.

Counts describe **returned normalized data**, including null metric points. They
are not input cardinality, scanned samples, physical storage I/O, RAM or billing
cost. Failure cannot be interpreted as an empty successful result. Existing
backend response and normalization caps continue to apply; receipt growth is
constant and contains at most four phase entries.

## Failure identity

Codes reuse the dashboard reader's public error vocabulary: `canceled`,
`timeout`, `rate_limited`, `forbidden`, `invalid_query`, `provider_not_found` and
`provider_error`. The receipt spells its cancellation outcome `cancelled`.
Cancellation returns HTTP 408 when a caller can still receive a response;
timeouts return 504 and exhausted capacity returns 429 with `Retry-After: 1`.
Gateway permission and availability statuses retain their existing mapping.

The service preserves cancellation and timeout causes without returning raw
HTTP errors, which can embed credentials, endpoint URLs or query parameters.
Authentication, malformed requests and provider-resolution errors remain on
their existing paths, before an execution receipt is created.
When the gateway operation deadline cancels a lower-level HTTP request or body
read, its deadline cause is preserved as a timeout even if the HTTP operation
reports only cancellation and the original browser request is still active.

## Browser lifecycle and privacy

The canonical query scheduler owns a passive, immutable receipt store. Its
default history is 100 entries, configurable from 1 to 200; evicted entries are
not restored by late completions. `performance.now()` measures browser queue,
request and total intervals. UTC timestamps are display metadata only. The
request interval includes transport, parsing and any existing capacity retries;
the attached service receipt describes the final returned attempt.

Identical pending queries have one execution receipt with separate shared and
cancelled consumer counts. Cancelling one consumer does not cancel the others.
A cache delivery points to the original execution and records zero new request
time. Cancelling the final consumer fixes that execution's outcome even if its
fetcher later resolves. A cancelled queued request remains **Not run**.

Receipts live only in the scheduler's memory, outside dashboard documents,
portable bundles and browser storage. Refreshing data, changing source
configuration or switching example/live mode creates a new scheduler. The
host remounts Insights on principal or permission-identity changes, preventing
receipt and query-cache reuse across those boundaries. Token renewal for the
same identity does not create a different principal.

Before retaining a query preview, the scheduler removes quoted and dollar-quoted
literals, nested comments, URLs and credential-shaped values. It limits scanning
to 64 KiB and retains at most 1,000 characters. Query-reference bindings and trace
IDs are not copied into receipts. Failure explanations are fixed local messages;
raw exception messages and error response bodies are not retained by diagnostics.

The client validates the optional versioned service receipt independently from
result data. Unknown fields are stripped, and malformed receipts are discarded
without losing otherwise valid metrics, traces or records. Version 1 permits
exclusive measured service phases and, when present, an explicitly unknown
nested provider phase. Phase names must be unique, and their exclusive sum cannot
exceed service elapsed time (within floating-point tolerance). Undispatched
queries cannot claim applied bounds. Missing failure counts remain unknown rather
than becoming observed zeros.

The inspector subscribes to this store through `useSyncExternalStore`; selecting,
hovering or expanding a receipt has no query action. Its fixed native modal must
preserve the canvas geometry, including scrollbar width, so visibility observers
and responsive layout changes do not cancel or restart underlying queries.
Keyboard dismissal and focus restoration must not scroll the canvas.

## Verification

`internal/insights/query_diagnostics_test.go` exercises service admission and
queue cleanup, phase reconciliation, explicit unknown provider timing, partial
results and null observations, execution identity, timeout/cancellation/error
separation, sanitization, direct Tempo bounds and gateway scope. These fixtures
are synthetic test data; they do not establish production latency.

Frontend tests cover monotonic queue arithmetic, sharing and cache attribution,
cancelled and late completions, redaction, strict receipt validation, typed safe
errors and session changes. The browser fixture exercises the actual client,
scheduler and inspector with synthetic service measurements in light, dark and
narrow layouts. Browser checks are required for modal focus, overflow and passive
execution across cache expiry; DOM unit tests do not establish layout behavior.

Run the focused checks from the repository root:

```sh
go test ./internal/insights -run 'Test(QueryDiagnostics|ObserveTransportReceipt)' -count=1

npm --prefix ui test -- \
  src/features/insights/query-diagnostics.test.ts \
  src/features/insights/query-diagnostics-client.test.ts \
  src/features/insights/query-inspector.test.tsx \
  src/features/insights/query.test.tsx \
  src/features/insights/query-series.test.tsx \
  src/features/insights/client.test.ts \
  src/features/insights/client-capacity.test.ts \
  src/features/insights/gamma/scroll-lock.test.ts

npm --prefix ui run test:e2e:insights -- e2e/insights-query-inspector.e2e.mjs
```

The browser command requires Playwright Chromium or an explicitly configured
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. `INSIGHTS_E2E_URL` can select an existing
server; otherwise the runner starts an isolated Next server.
`INSIGHTS_QUERY_INSPECTOR_OUTPUT` selects the screenshot directory. CI runs this
fixture and uploads the query-inspector artifacts; fixture registration alone
does not establish a passing browser run or live provider behavior.
