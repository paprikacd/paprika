# Paprika Observe plugin

An optional read-only plugin for Paprika's separate observability gateway.
It bundles provider discovery and bounded logs, metrics, and traces workflows.
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

Complete native OAuth for this connection with `paprika:observe`. Never copy
fleet tokens, service-account keys, or provider credentials into a manifest.
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
