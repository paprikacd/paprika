# Paprika connector (Claude / Codex)

Connect an MCP-capable client to the hosted Paprika fleet at
**https://paprika.benebsworth.com/mcp**.

## One setup prompt

> Connect this app to Paprika using the remote MCP endpoint https://paprika.benebsworth.com/mcp. Use the app's native OAuth flow and open the Paprika sign-in page so I can authenticate and grant scopes. Never ask me to paste tokens. After connecting, call fleet_status once and report the result.

The server exposes read tools (fleet_status, fleet_map, list_applications,
get_application, investigate, get_resource_tree, get_logs, list_pipelines,
get_pipeline_run, list_releases, list_rollouts, get_rollout, query_cost,
list_clusters) and `paprika:write`-scoped action tools (sync_application,
gate approve/reject, rollout promote/hold/resume/abort, rollback_release,
pipeline retry/skip/cancel, restart_workload). Destructive actions require an
explicit confirmation step.

## Claude Code

```sh
claude --plugin-dir /absolute/path/to/paprika/plugins/paprika
```

or add the endpoint directly:

```sh
claude mcp add --scope user --transport http paprika_hosted https://paprika.benebsworth.com/mcp && claude mcp login paprika_hosted
```

## Codex

```sh
codex mcp add paprika_hosted --url https://paprika.benebsworth.com/mcp
```

then `codex mcp login paprika_hosted` to complete OAuth, and start a new chat.

## Notes

- The MCP surface runs on the split-mode api-server and requires the release
  to be deployed with `mcp.enabled=true`, `mcp.publicURL`, an OAuth
  `clientId`, and matching `redirectUris` (see `charts/chart/values.yaml`).
- Writes need the `paprika:write` scope granted at consent time; reconnect to
  change scopes.
