# Observe MCP authoring validation

Date: 2026-10-26.

**Status: implemented and validated locally; live deployment and native-client
acceptance are pending.** The earlier [Omega validation](omega-validation.md)
covers provider/query integration, not this new MCP authoring capability.

## Implemented contract

When `PAPRIKA_INSIGHTS_URL` is configured, `/observe/mcp` registers nine Insights
tools and advertises the additional `paprika:insights:write` scope. Without that
configuration, the existing Observe surface remains read-only. Invalid authoring
configuration fails startup rather than exposing partially configured tools.
The Helm gateway Deployment receives the existing Insights URL and Secret
reference; NetworkPolicies allow only the intended gateway/Insights pod port.

| Tools | OAuth scopes | Global Insights permission |
| --- | --- | --- |
| `list_insights_providers` | `paprika:observe` | `read` |
| `list_saved_queries`, `get_saved_query` | `paprika:observe` | `read` |
| `list_dashboards`, `get_dashboard` | `paprika:observe` | `read` |
| `create_saved_query`, `update_saved_query` | `paprika:observe` and `paprika:insights:write` | `write` |
| `create_dashboard`, `update_dashboard` | `paprika:observe` and `paprika:insights:write` | `write` |

The authoring scope implies neither Observe reads nor fleet writes. Existing
Observe-only and fleet tokens cannot author documents. There are no provider
configuration, credential-management, or delete tools in this addition.
Project-scoped wildcard RBAC grants do not become global Insights permissions.

Each call preserves the authenticated human subject and exact groups, including
an explicitly empty set. The gateway signs a short-lived, console-audience token
for the same authenticated Insights proxy used by the UI. That proxy enforces
human RBAC before attaching its storage-service credential. Shared-provider
resolution uses a separate short-lived Observe delegation for the same human;
provider and cross-namespace credential authorization still run in the gateway.
Neither credential is included in tool responses or manifests.

### Documents and concurrency

- `list_insights_providers` supplies the actual provider IDs used by UI documents.
  Saved-query lists return metadata and ETags without query bodies; dashboard
  lists return summaries with widget counts. Get a document before editing it.
- Get/create/update return `{document, etag, uiUrl}`. `document` is the canonical
  Insights JSON, including metadata, tags, typed parameters, bindings and widget
  options. Dashboard URLs select the saved dashboard; query URLs open Insights.
- Create requires a document with its own ID and uses `If-None-Match: *`, so it
  cannot overwrite an existing ID. Update requires the exact quoted SHA-256
  ETag returned by a read. Missing, wildcard and weak ETags are rejected.
- The same persistent stores and validation used by UI edits enforce the write.
  Preconditions are checked under the store lock. A stale write or duplicate
  create returns an actionable MCP error asking for a fresh read and review;
  retrying an unconditional overwrite is not supported.
- Saved-query provider/kind identity and compatibility with existing dashboard
  bindings remain protected. Dashboard imports can retain unresolved references
  for portability; authoring should create saved queries before referencing
  them. An unresolved reference produces a UI error rather than an invented
  successful query.
- Mutation audit records contain the human subject, action, collection,
  document ID and bounded outcome, without document bodies or credentials.

The gateway retains four shared request slots for MCP/query/explore responses,
plus a separate four-slot pool for `GET /observe/api/providers`. The bounded
catalogue reserve lets authoring complete its nested provider discovery when
all four MCP slots are occupied. Provider queries retain the backend I/O budget.

### UI synchronization

Visible live workspaces check the shared store every five seconds and on focus
or return from a hidden tab. Conditional ETags avoid transferring unchanged
collections/documents. Requests do not overlap; hidden/unmounted views cancel
pending work. Session identity and generation checks prevent cached snapshots
from being adopted by a different session or overwriting a newer local save.

A clean dashboard adopts external changes without a browser reload. Saved-query
changes update the library and rerun affected widgets, including single values
and sparklines. Active editors and unsaved drafts retain their original contents
and concurrency version; the UI offers an explicit reload and stale saves still
conflict. A same-content rewrite can update a clean editor's ETag without
resetting its results or test parameter values. Service selections remain view
state unless explicitly saved as defaults.

## Native OAuth and plugin upgrade

The Observe plugin is version **0.2.0**, advertises Read and Write capabilities,
and requests both scopes in the portable OpenAI OAuth manifest. The existing
fleet plugin remains separate.

An existing read-only grant stays read-only on refresh. Authoring requires a
fresh native OAuth grant for the exact deployment's `/observe/mcp` resource.
The consent screen shows only requested scopes, explains document authoring,
and permits approving only reads. A request that omits scopes keeps the
read-only default; adding the new scope to server metadata does not widen an
old grant.

For an already configured endpoint-only Codex connection named
`paprika_observe`, request both scopes through native sign-in:

```sh
codex mcp login paprika_observe --scopes paprika:observe,paprika:insights:write
```

Use the actual connection name if it differs. Compatibility `.mcp.json` clients
must explicitly request `paprika:insights:write` along with `paprika:observe` in
their OAuth authorization flow; the compatibility manifest itself does not
supply an OAuth scope extension. Updating the plugin alone is not evidence of a
new grant. Keep the existing Insights RBAC requirement and never substitute a
copied fleet token, service credential, or provider key. See the
[connection guide](../../guides/mcp-plugin.md#observability-gateway) and
[plugin README](../../../plugins/paprika-observe/README.md).

## Local validation receipts

| Check | Observed result |
| --- | --- |
| MCP package race suite | Passed, including independent scopes, nonempty native OAuth issuer, partial read-only consent, unchanged refresh grants, tool hints and exact-group preservation |
| Insights, gateway and all connector packages, API and auth race suites | Passed |
| MCP conflict protocol regression | Passed; stale-version errors remain actionable at the MCP boundary |
| Gateway command race tests | Passed, including configuration gating, reserved provider capacity, existing shared caps and HTTP-disconnect cancellation |
| MCP UI/plugin tests | **37/37 passed**; includes execution of the embedded consent renderer for omitted, read-only and authoring requests |
| MCP UI TypeScript check | `npm run check` passed |
| Repository Go lint | `bin/golangci-lint` passed across all changed Go packages, including the E2E fixture, with zero issues and uncapped diagnostics |
| Required Go build | `go build ./...` passed after the final changes |
| Required Go vet | `go vet ./internal/... ./cmd/...` passed |
| Required controller regression tests | `go test ./internal/engine ./internal/controller/pipelines -count=1` passed |
| UI unit tests | Full suite **1,334 tests in 139 files** passed; final conditional-read changes passed **76 targeted tests** plus TypeScript and ESLint |
| Production UI build and existing Observe E2E | Build passed; **11/11** existing Observe integration scenarios passed with zero page errors |
| Helm 3.21.2 | Lint, default template and every `task chart:validate` matrix passed |
| CRD generation | `controller-gen@v0.20.1` and `task chart:crds` passed; SHA-256 comparison found all **42** base/wrapped files unchanged |
| Whitespace validation | `git diff --check` passed |

No live result is inferred from these local checks.

### Browser integration receipt

`artifacts/insights/observe-authoring/report.json`, timestamp
**2026-10-26T04:25:53.701Z**, records **15/15 scenarios passed and zero page
errors**. The test uses the real MCP transport, authenticated API proxy,
Insights file storage, Observe handlers, provider authorization and native
connectors against local deterministic telemetry/Kubernetes fixtures.

The scenarios prove:

- MCP-created queries and dashboards appear in an already-open UI without
  browser writes being used to seed those documents.
- OAuth scope and Insights RBAC independently deny writes. Invalid documents,
  inaccessible providers, duplicate creates and stale ETags cannot overwrite
  storage; conflict errors include useful reload guidance.
- MCP query updates change the visible single value and sparkline history;
  dashboard updates appear without a reload. Same-content ETag changes are
  adopted before the next UI save.
- Unsaved dashboard and saved-query drafts survive remote changes. Their stale
  saves receive HTTP 412 until the user explicitly reloads.
- Service filters update values and sparkline shapes in Light and Dark themes
  at 1512px and 390px widths, without changing the saved default selection.
- Canonical documents, references and ETags survive an actual local Insights
  service restart and browser reload.

These are local fixture results. OAuth protocol tests exercise native grant
semantics, while the browser fixture uses scoped test credentials. Neither is
proof that an installed Codex/Claude client has obtained the new live grant.

## Live acceptance pending

Before claiming live completion, record the deployed immutable image/commit,
verify the authoring scope and tool inventory on the live endpoint, complete
fresh native OAuth consent with both scopes, and exercise create/get/update and
stale-write rejection against the deployed shared store. Open the resulting
saved dashboard in the live UI and verify its saved query, service selector,
two-decimal value and sparkline against the real authorized providers. Confirm
Observe-only grants still cannot write, and record cleanup or retention of any
validation documents. Append those receipts here when completed.
