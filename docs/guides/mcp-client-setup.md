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

## Install Observe as a plugin without a manual clone

With Node.js 20+ and the selected agent CLI installed, use the GitHub-backed
npx installer:

```sh
npx --yes --package=github:paprikacd/paprika -- paprika-plugins install observe --client codex
# For Claude Code: use --client claude
```

This installs `paprika-observe@paprika` with its skill and registers the
Paprika marketplace, instead of registering only a raw endpoint. Restart
the client, finish native OAuth with `paprika:observe`, and call
`list_observability_providers`. Saved-query and dashboard authoring needs
a separate `paprika:insights:write` grant and Insights RBAC.

**ChatGPT uses a different setup:** register the HTTPS
`/observe/mcp` endpoint as a custom MCP app and complete OAuth there.
npx cannot register a ChatGPT app or grant access on the user's behalf.
See the [Observe plugin guide](../../plugins/paprika-observe/README.md).

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

### Registration survives a server replacement

The Helm chart defaults `mcp.oauth.persistClients` to `true`. Each enabled MCP
surface gets a separate, retained ConfigMap containing **public client IDs and
their exact redirect allowlists**, bound to that surface's resource URL. The API
server and observability gateway receive only `get`/`update` access to their
named registry. Missing, inaccessible or differently bound storage fails startup;
it never silently switches to an empty in-memory registry. Chart upgrades retain
registered clients. Keep these ConfigMaps when restoring the installation, and
review an issuer/resource migration explicitly rather than reusing registrations
for a different origin or surface.

Client registration does not grant account access. Console authentication,
consent, scopes and PKCE remain required. Authorization codes, pending consent,
refresh tokens and confirmations are **not** persisted in these ConfigMaps.

For local/test installations, leaving both `--mcp-client-registry-configmap` and
`--mcp-client-registry-namespace` unset retains process-local registration. Setting
only one is invalid. In Helm, `mcp.oauth.persistClients: false` explicitly opts
into that transient behavior.

If a connector was registered before persistence was enabled and its metadata
has already been lost, persistence cannot reconstruct it. Use the client's
supported registration/reconnect flow to obtain a new registration. Do not
whitelist an unknown client, broaden its redirect URI, disable PKCE or copy an
access token into chat. A consent request rejected after successful Google
sign-in may indicate a lost client registration rather than a failed login.
Check the native connector and server diagnostics separately before retrying.

The registry accepts at most 4,096 clients and a bounded data size below the
ConfigMap limit. Exhaustion rejects new registrations without evicting existing
clients. Investigate registration churn and review stale public metadata before
any cleanup; do not delete the registry to clear a connection error.

### Persist OAuth sessions across restarts

Set `mcp.oauth.persistSessions: true` for fleet MCP and/or
`observabilityGateway.persistSessions: true` for Observe. Each enabled surface
gets its own retained Kubernetes Secret. The server stores pending authorizations, one-use
codes, rotating refresh grants and short-lived confirmations there. Entries use
hashed cache keys and AES-GCM encryption derived from the existing token-signing
secret and the exact MCP resource URL. The Secret's Role grants only `get` and
`update` on that Secret. Missing, inaccessible, misbound or undecryptable
storage fails startup; it never silently falls back to process memory.

Refresh token rotation replaces the old grant and stores the successor in one
Kubernetes resource-version update. Concurrent refresh attempts have one winner;
an ordinary storage outage returns a retryable error instead of telling clients
to discard a valid grant. Storage is bounded, expired entries are cleared on
writes, and temporary login traffic has its own smaller capacity limit so it
cannot evict existing refresh grants.

The Helm chart creates an empty Secret once as a retained pre-install/upgrade
hook. Later upgrades leave its contents entirely to the running server; chart
rendering never snapshots mutable grants into a Helm release or overwrites them
with a stale copy. Back up the Secret and the token-signing secret together.
Replacing the signing secret or changing the MCP resource URL invalidates the
stored sessions and requires an intentional migration or fresh consent. Do not
delete the Secret to troubleshoot authentication.

**First enablement:** grants held only in an already running process cannot be
copied into the new store through the supported OAuth interface. Plan one fresh
native connection for each affected client after switching from process-local
storage. Existing access tokens can remain usable until they expire, so a
successful tool call immediately after rollout alone does not prove that its
refresh grant was migrated. Rollback to an in-memory build has the same
limitation. Once a client has connected against persistent storage, its grant
survives normal gateway and API-server replacements until its refresh lifetime
expires. Do not extract or copy credentials from a host to bypass this step.

For direct configuration, set both `--mcp-session-secret` and
`--mcp-session-namespace`; omitting both retains the existing cache backend.
This setting does not remove the chart's replica restrictions.

Review the [chart settings](../../charts/chart/values.yaml#L859),
[chart validation](../../charts/chart/templates/api-server/deployment.yaml),
[runtime validation](../../cmd/main.go#L1200) and
[OAuth registration implementation](../../internal/api/mcp/oauth.go#L112) when
configuring the server. For operator installation, start with the
[getting started guide](../getting-started.md).
