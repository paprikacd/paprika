# Connect an agent to Paprika

Paprika exposes fleet inspection and delivery tools through remote MCP over
HTTP. An MCP client connects to an existing Paprika server; connecting does not
install an operator or create a fleet.

In this guide, **`https://paprika.example.com/mcp` is a placeholder**. Replace it
with the MCP endpoint supplied by the administrator of your Paprika installation.

## Connect your client

### Codex

```sh
codex mcp add paprika --url https://paprika.example.com/mcp
codex mcp login paprika
```

Complete the native browser OAuth flow, review the requested scopes, then start
a new chat. Ask for a read first: “Show fleet status and any unhealthy
applications.”

### Claude Code

```sh
claude mcp add --scope user --transport http paprika https://paprika.example.com/mcp
claude mcp login paprika
```

Complete the native browser OAuth flow and review the requested scopes before
asking for fleet status.

### Other remote MCP clients

Add a remote HTTP MCP server using your installation's `/mcp` endpoint. The
client needs to support Paprika's OAuth 2.1 / PKCE flow. Follow its native sign-in
and consent screens; do not paste access tokens into a chat or configuration
snippet. A setup prompt you can adapt is:

> Connect this app to the remote MCP endpoint
> https://paprika.example.com/mcp. Use the app's native OAuth flow so I can sign
> in and review scopes. Do not ask me to paste tokens. After connecting, call
> fleet_status once and report the result.

## Use the shipped skill and plugin

The repository ships one [Paprika skill](../../plugins/paprika/skills/paprika/SKILL.md)
with practical sequences for fleet health, drift diagnosis, release and rollout
inspection, pipeline runs, gates and controlled actions. The
[Claude and Codex plugin manifests](../../plugins/paprika/) bundle this skill with
an MCP server definition.

The shipped plugin currently targets **Ben's hosted fleet** at
`https://paprika.benebsworth.com/mcp`. That endpoint requires access to that
installation; it is not an endpoint for a newly created personal fleet. See the
[connector README](../../plugins/paprika/README.md) for its documented client
commands. For Claude Code, a local repository checkout can load the plugin with:

```sh
claude --plugin-dir /absolute/path/to/paprika/plugins/paprika
```

For your own installation, use the direct MCP routes above. If adapting a local
plugin copy, review both [`.mcp.json`](../../plugins/paprika/.mcp.json) and the
skill's endpoint instructions so they point to the same intended server.

## Choose access deliberately

- **`paprika:read`** permits inspection: fleet health and topology, applications,
  managed resources and logs, releases, rollouts, pipeline runs and clusters.
  Cost queries require a configured cost source.
- **`paprika:write`** permits delivery actions such as sync, gate decisions,
  rollout controls, pipeline retry/skip/cancel and workload restart. It does
  **not** include read access; grant both scopes if both are needed.

Read access never grants write access. To change granted scopes, use the
client's native reconnect/consent flow. Rollback, rollout promotion that skips
wait or analysis, abort, pipeline skip/cancel and workload restart require a
second confirmation bound to the exact action arguments. Only confirm actions
you intend to perform. See the [scope rules](../../internal/api/mcp/scope.go),
[action definitions](../../internal/api/mcp/tools_write.go) and
[confirmation implementation](../../internal/api/mcp/confirm.go).

## Requirements for a self-hosted endpoint

MCP is disabled by default. An administrator must configure an authenticated
installation before client connection:

- Use `deploymentMode: split` and explicitly enable `mcp.enabled`.
- Enable `auth.enabled` and supply a non-empty `PAPRIKA_AUTH_TOKEN_SECRET` through
  the API server's environment or secret references.
- Set `mcp.publicURL` to the externally reachable **base URL**, for example
  `https://paprika.example.com`; clients use that URL with `/mcp` appended.
- Configure the required static `mcp.oauth.clientId` and non-empty
  `mcp.oauth.redirectUris` for the installation's first-party client. Runtime
  setup also requires a cache for authorization codes, refresh tokens and
  confirmations.

These startup requirements coexist with dynamic client registration: supported
connectors can register their own OAuth client through `/mcp/register`, with
their own validated redirect URIs. They do not need to reuse the static
first-party client ID. Registration accepts HTTPS redirects or loopback redirects
for local clients.

Review the [chart settings](../../charts/chart/values.yaml#L859),
[chart validation](../../charts/chart/templates/api-server/deployment.yaml),
[runtime validation](../../cmd/main.go#L1200) and
[OAuth registration implementation](../../internal/api/mcp/oauth.go#L112) when
configuring the server. For operator installation, start with the
[getting started guide](../getting-started.md).
