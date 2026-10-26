# Paprika Observe plugin

An optional plugin for Paprika's separate observability gateway. It bundles
provider discovery, bounded telemetry queries, and saved-query/dashboard authoring.
It does not add a connection to the existing fleet plugin automatically.

The packaged endpoint is `https://paprika.benebsworth.com/observe/mcp`.
Deployment and client access are separate: installing this source cannot
deploy the gateway or establish which providers the server can access.
For GKE or another origin, select the verified deployment URL and use the
endpoint-only connection instructions in the [integration guide](../../docs/guides/mcp-plugin.md#observability-gateway).

When the user explicitly requests installation, run from the repository root:

```sh
codex plugin marketplace add .
codex plugin add paprika-observe@paprika
```

Or in Claude Code:

```sh
claude plugin marketplace add .
claude plugin install paprika-observe@paprika --scope user
```

Complete native OAuth for this connection with `paprika:observe` for reads and
explicitly consent to `paprika:insights:write` to create or update saved queries
and dashboards. Authoring also requires your existing Insights write permission.
The server advertises the authoring scope only when Insights is configured.
Existing read-only tokens stay read-only, including on refresh: update the
plugin and reconnect through native OAuth to request the new scope. Clients
using the compatibility manifest must request `paprika:insights:write` in their
OAuth authorization flow; a request with no scope keeps the read-only default.
Never copy fleet tokens, service-account keys, or provider credentials into a manifest.
Then discover tools, call `list_observability_providers`, select an actual
provider identity, and run a small discovery/query. Native client sign-in,
real tool discovery, and real backend queries require independent validation.

Validate package structure without installing or authenticating:

```sh
claude plugin validate --strict plugins/paprika-observe
node --experimental-strip-types --test internal/api/mcp/ui/tests/observe-plugin.test.ts
```

Portable `mcp.json` uses `streamable-http` and the OpenAI per-server OAuth
extension; compatibility `.mcp.json` uses `http`. The Codex and Claude overlays
point to the compatibility file. No background hooks or credential scripts
are included.

## Authoring flow

Discover `list_insights_providers` for the actual provider IDs used by the UI.
Read existing documents with `list_saved_queries`, `get_saved_query`,
`list_dashboards`, and `get_dashboard`. Create saved queries before dashboards
that reference them, using `create_saved_query` and `create_dashboard`.
Updates use `update_saved_query` and `update_dashboard` with the exact ETag
returned by the last read. A conflict requires a fresh read and review of both
changes; do not retry an overwrite with a wildcard ETag. Query provider/kind
identity and existing dashboard parameter bindings remain protected by the
same service that handles UI edits.

These tools edit the shared Insights documents. An open UI refreshes external
changes while preserving unsaved local drafts. Returned dashboard links open
the saved workspace. Authoring grants no fleet writes, provider configuration,
credential management, or deletion tools.
