# Paprika plugin

Inspect application health and manage Kubernetes delivery through Paprika's
OAuth MCP connection at [paprika.benebsworth.com/mcp](https://paprika.benebsworth.com/mcp).
Version `0.2.0` adds a fleet console, application mentions, and a focused health
report with explicit missing, stale, truncated, and failed evidence.

The console's instance picker labels the authenticated deployment and offers
saved destinations, including Personal and StarfleetHub. Switching asks Codex
to open the exact named connection with its own OAuth; the current view keeps
its original instance identity while that handoff is pending. Use `get_connection`
to verify an endpoint before taking action. See the
[multi-instance guide](../../docs/guides/mcp-plugin.md#multiple-paprika-deployments).

This directory is the plugin source. Its new server tools and UI are implemented
in this checkout; updating or installing the package does not deploy an API-server
image. Discover the running server's tools before assuming `open_fleet` or
`get_application_health` is available. Host support and live deployment need
separate verification.

## Connect

Creating or cloning the marketplace catalogs does not register the marketplace
or install Paprika. From the Paprika repository root, install the packaged
skills and connection:

```sh
codex plugin marketplace add .
codex plugin add paprika@paprika
codex plugin marketplace list
codex plugin list
```

Verify that the marketplace list includes `paprika` and the plugin list includes
`paprika@paprika` as installed and enabled. Refresh Plugins if its list has not
updated, then open a new chat.

Or, for Claude Code:

```sh
claude plugin marketplace add .
claude plugin install paprika@paprika --scope user
```

Start a new chat and complete native OAuth sign-in (`/mcp` in Claude Code).
For complete installation steps, endpoint-only setup, first-use prompts,
and troubleshooting, see the [Paprika plugin guide](../../docs/guides/mcp-plugin.md).

Use the client's native OAuth connection flow so the user signs in and grants
scopes. A useful setup prompt is:

> Connect Paprika at https://paprika.benebsworth.com/mcp using this app's native
> OAuth flow. Let me sign in and grant read access, then call fleet_status once
> and report the result. Never ask me to paste tokens.

The optional `paprika-setup` skill covers setup and reconnection. In the Codex
CLI, endpoint-only connection is:

```sh
codex mcp add paprika_hosted --url https://paprika.benebsworth.com/mcp
codex mcp login paprika_hosted --scopes paprika:read
```

For requested delivery actions, grant both `paprika:read,paprika:write` through
native consent. Paprika's RBAC still governs which projects and objects are
accessible. Loading the full package uses the client's plugin installation flow;
adding the endpoint alone does not install the packaged skills.

### Codex Sidebar / Apps

Installing the package enables its skills and connection. The deployed API server
must also advertise `open_fleet` with a global MCP App entrypoint before Codex can
offer the console. If that tool is missing, upgrade the API server through the
normal deployment workflow; reinstalling the package does not deploy it.

After the server upgrade, open a new chat and verify tool discovery. If Codex
still lists the earlier tools, switch the Paprika plugin off and back on in
**Plugins**, then start a new chat; its saved OAuth sign-in is retained. Use
**Explore → Paprika → Pin to sidebar** to keep the discovered App in navigation.
The sidebar App's **Refresh** action reloads its widget; it does not add missing
server tools. See the
[sidebar troubleshooting steps](../../docs/guides/mcp-plugin.md#paprika-missing-from-the-codex-sidebar).

The portable [plugin.json](plugin.json) and [mcp.json](mcp.json) follow
[Agent Plugins 1.0](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json).
The `.codex-plugin`, `.claude-plugin`, and `.mcp.json` files retain compatibility
with clients using earlier manifests. Claude Code can load this directory with
`claude --plugin-dir /absolute/path/to/paprika/plugins/paprika`.

## Health and debugging

Start with `fleet_status`, find the exact app using `list_applications`, then call
`get_application_health` with `name` and `namespace`. The report preserves
controller health separately from drift and retry conditions. It includes recent
release failures, linked rollout progress, checks, and managed resource status.
`status.partial=true` or a missing/stale section means some evidence is incomplete;
empty findings do not prove health. `observedAt` is read time, not reconcile time.

`open_fleet` opens the MCP App in supporting hosts. It prefers fullscreen, which
Codex renders in the side panel. Namespace/search filters, application detail,
resources, checks, releases, investigation, and tailed logs share the same scoped
tools. Context attachment requires a user gesture. Mutation controls send an
action request into chat; the panel does not execute writes directly.

The mention picker searches authorized apps and resolves
`paprika://applications/{namespace}/{name}` to a health report. Attaching an app
provides context and does not grant permission to mutate it.

For targeted debugging use `get_resource_tree` (`name`, `namespace`,
`detailed=true`), then `investigate` or bounded `get_logs` on the selected resource.
Logs are fetched on demand. The [operational skill](skills/paprika/SKILL.md)
documents exact arguments, pagination, scopes, confirmation, and verification.
Current backend limitations include unavailable detailed drift/run-history sources
and unimplemented rollout hold/resume handlers; report their actual data states.

## Build and verify

From the repository root:

```sh
make build-mcp-ui
npm --prefix internal/api/mcp/ui run check
npm --prefix internal/api/mcp/ui test
go test ./internal/api/mcp -count=1
```

The UI bundle is embedded into the API-server binary. Full images use the normal
`make docker-build` workflow; production deployments use Helm. See the
[MCP plugin guide](../../docs/guides/mcp-plugin.md) for protocol, operational,
and deployment details. Package contract tests protect identity, metadata,
prompt ordering, endpoint configuration, contained assets, and documented tool
arguments.
