# Paprika CLI Login and System Status Design

## Goal

Make Paprika easy to inspect from a developer workstation or automation agent:

- `paprika login` completes the existing OIDC authorization-code flow in a browser.
- `paprika status` returns a concise, machine-readable view of the applications the caller is authorized to see.

The feature must reuse Paprika's existing fleet index, Connect API, OIDC validation, and project authorization. It must not introduce a second control plane, direct Kubernetes access from the CLI, a new credential format, or an MCP server.

## Context

Current `master` already provides:

- OIDC authorization-code initiation at `GET /auth/login` with PKCE and state.
- Code exchange and ID-token validation at `POST /auth/token`.
- Bearer-token authentication for Connect RPCs.
- Project-scoped authorization and an immutable fleet index.
- `QueryApplications`, `QueryFleetMap`, and `QueryFleetMatrix` RPCs.
- CLI configuration stored with mode `0600` and bearer-token support.

The missing pieces are a CLI-native browser login and a stable, compact operational summary.

## Approaches Considered

### Recommended: native CLI login plus a snapshot RPC

Add a loopback OIDC callback to the CLI and one read-only Connect RPC backed by a single fleet snapshot. This gives humans and agents a predictable command and JSON contract while preserving the existing auth boundary.

### MCP server over the API

An MCP server could expose tools such as `get_system_status`, but it would add another process lifecycle, protocol dependency, packaging path, and credential-loading surface. It can be added later as a thin adapter once the snapshot contract is stable.

### CLI-only composition of existing fleet queries

The CLI could page through `QueryApplications` and calculate a summary locally. This avoids a new RPC but duplicates summary semantics across clients, transfers more data, and can observe multiple fleet generations during one invocation.

## User Experience

### Login

```text
paprika login --server https://paprika.example.com
Opening your browser to sign in...
Logged in as ben@example.com
```

`--server` uses the existing persistent flag and is saved when supplied. If no server is configured, the command fails with a clear instruction. If a browser cannot be opened, the CLI prints the authorization URL and continues waiting for the callback.

The command listens only on `127.0.0.1:17632` and accepts exactly one callback at `/callback`. The OIDC provider must allow the exact redirect URI `http://127.0.0.1:17632/callback`.

On success, the CLI stores the ID token and its expiration time in the selected Paprika config file, preserving unrelated configuration. It does not persist the OAuth access token, authorization code, PKCE verifier, state, or refresh token. Re-running `paprika login` replaces the saved ID token.

### Status

```text
paprika status
APPLICATIONS  HEALTHY  PROGRESSING  DEGRADED  FAILED  OUT-OF-SYNC  ATTENTION
12            9        1            1         1       2            3

ATTENTION
NAMESPACE  APPLICATION  PROJECT  HEALTH      SYNC         RELEASE     UPDATED
apps       checkout     default  Failed      OutOfSync    Failed      4m ago
apps       payments     default  Degraded    Synced       Complete    8m ago
```

`paprika status -o json` and `-o yaml` return the RPC response without reconstructing the summary. The request supports the existing `--namespace` scope and an `--attention-limit` flag with default 20 and maximum 100. No mutation or remediation action is part of this feature.

## OIDC Login Flow

1. The CLI binds `127.0.0.1:17632` before starting authentication. If the port is unavailable, it fails without opening a browser.
2. It requests `GET /auth/login?redirect_uri=http%3A%2F%2F127.0.0.1%3A17632%2Fcallback` from the configured Paprika server using an HTTP client with explicit timeouts and bounded response reads.
3. Paprika validates the redirect URI against an exact allowlist containing its configured browser redirect and the fixed CLI loopback redirect. It generates cryptographically random state and PKCE verifier values and returns the provider URL as it does today.
4. The CLI retains state and verifier only in memory, opens the returned provider URL, and waits for the loopback callback for at most five minutes.
5. The callback accepts only `GET /callback`, validates the returned state before using the code, and renders a small success or failure page. Error callbacks are handled without attempting exchange.
6. The CLI posts the code, verifier, and exact loopback redirect URI to `/auth/token`. The token endpoint applies the same exact redirect allowlist before contacting the provider and continues to validate the returned ID token.
7. The CLI parses the validated ID token only to display identity and record expiration. The API remains responsible for authenticating it on every request.
8. Temporary values are released when the command completes. Callback and token-exchange errors never include codes, tokens, or verifier values.

The server accepts the CLI redirect only when OIDC is enabled. The callback listener is loopback-only and shuts down after one terminal result, timeout, or context cancellation.

## System Status Contract

Add a read-only `GetSystemStatus` RPC to `PaprikaService`.

### Request

- Optional namespace filter, populated by the CLI's existing namespace setting.
- `attention_limit`, default 20 and maximum 100.

The first version intentionally omits arbitrary search, sorting, and mutation controls. The full fleet query RPCs remain available for detailed exploration.

### Response

- Fleet index generation.
- Total authorized applications.
- Exact counts by health: healthy, progressing, degraded, failed, unknown, and missing.
- Exact counts by sync state: synced, out of sync, and unknown.
- A deterministic, impact-ordered list of authorized applications needing attention, capped by `attention_limit`.
- Whether more attention records exist beyond the returned list.

An application needs attention when any of the following is true:

- Health is progressing, degraded, failed, unknown, or missing.
- Sync state is out of sync or unknown.
- A gate is blocked.
- The current release or rollout is failed, degraded, rolled back, aborted, paused, or awaiting approval.
- A referenced cluster, repository, or observability connection is unhealthy.

Each attention record reuses the existing `ApplicationSummary` protobuf so consumers receive stable identity, project, health, sync, release, rollout, resource, connection, and transition fields without a parallel model.

## Server Architecture

Add a narrow `QueryStatus` method to the fleet reader and immutable snapshot. It performs authorization filtering, request filtering, aggregation, and attention ordering against one loaded snapshot. It returns provider-neutral data and never performs live Kubernetes reads.

The API handler:

1. Validates `attention_limit` and the namespace value.
2. Loads candidate projects from the fleet reader.
3. Builds an authorized query scope with the authenticated principal and existing project authorizer.
4. Calls `QueryStatus` once.
5. Converts the result to protobuf and returns it.

The existing Connect auth interceptor classifies `GetSystemStatus` as a read operation on applications. The handler still builds a project-filtered scope because aggregate endpoints must not reveal unauthorized counts, names, projects, or health states.

## CLI Architecture

The login command is split into independently testable units:

- A login client that calls `/auth/login` and `/auth/token` with bounded HTTP behavior.
- A loopback receiver that owns the fixed listener, validates method/path/state, and returns one result.
- A browser opener with a platform implementation and a printable-URL fallback.
- A config update function that persists only the server, ID token, and token expiration while preserving unrelated fields.

The status command uses the generated Connect client and current config. Table formatting is human-oriented; JSON and YAML use the protobuf response directly.

## Security Properties

- Authentication remains OIDC ID-token verification against the configured issuer, audience, signature, and expiry.
- Authorization remains fail-closed and project-scoped before aggregation.
- Redirect URIs are exact-allowlisted at login initiation and token exchange; arbitrary redirect URIs are rejected.
- OAuth state and PKCE values come from `crypto/rand`, remain in memory, and are never logged.
- The loopback listener binds only IPv4 loopback, handles one flow, has a five-minute deadline, and accepts only its fixed callback route.
- HTTP clients use explicit timeouts, close response bodies, and cap response size.
- Tokens and authorization codes do not appear in URLs generated by Paprika, logs, process arguments, or command output.
- The CLI config remains mode `0600`. Only the validated ID token is persisted; short-lived exchange material is not.
- No API response contains Kubernetes Secrets, provider credentials, raw manifests, or inaccessible fleet metadata.

## Error Handling

- Missing server configuration: fail before binding or opening a browser.
- Loopback port unavailable: report the fixed callback URI and stop.
- Login endpoint unavailable or malformed: return a bounded, redacted error.
- Browser open failure: print the URL and keep waiting.
- State mismatch, missing code, or provider error: render failure locally and stop without token exchange.
- Login timeout or cancellation: shut down the listener and do not modify config.
- Invalid or expired token: existing API authentication returns unauthenticated and the CLI suggests `paprika login`.
- Fleet index unavailable: return Connect `Unavailable`; the CLI reports that Paprika is still warming or unavailable.
- Invalid namespace or attention limit: return Connect `InvalidArgument`.
- No authorized projects: return an empty, successful snapshot rather than leaking whether other projects exist.

## Testing and Validation

### Unit and contract tests

- Login URL request uses the exact loopback redirect.
- Redirect allowlist accepts configured UI and CLI redirects and rejects scheme, host, port, path, and query variations.
- Loopback receiver rejects wrong methods, paths, missing codes, provider errors, and state mismatches.
- Login timeout and cancellation release the listener.
- Token exchange requests are bounded and secrets are absent from errors.
- Config updates preserve unrelated fields and maintain `0600` permissions.
- Status aggregation is exact for every health/sync value and attention reason.
- Attention ordering and truncation are deterministic.
- Authentication rejects missing, malformed, invalid, and expired bearer tokens.
- Authorization tests prove cross-project applications and aggregate counts are absent.
- Protobuf descriptor and generated-code drift checks pass.
- CLI table, JSON, and YAML golden/structural tests pass.

### Repository validation

- Targeted Go tests for CLI, auth, API, and fleet packages.
- Full `make test` and lint checks.
- `helm lint charts/chart/ --values deploy/test-values.yaml`.

### Live end-to-end validation

After pushing and deploying an amd64 image to `paprika-e2e`:

1. Configure the OIDC provider with the fixed loopback redirect URI.
2. Run `paprika login --server <deployed-url>` and complete the real browser flow.
3. Run `paprika status`, `paprika status -o json`, and an existing read command using the saved token.
4. Verify the snapshot matches the authorized applications visible in the dashboard and direct Kubernetes evidence.
5. Verify an unauthenticated status request is rejected.
6. Verify a restricted principal cannot infer another project's application names or counts.
7. Confirm the deployed workloads are ready and the demo application remains healthy.

## Non-Goals

- MCP server or tool registration.
- Refresh-token storage or automatic background renewal.
- OS keychain integration.
- Device authorization grant.
- Multiple simultaneous login sessions on the fixed callback port.
- Direct Kubernetes API access from the CLI.
- Automated remediation, sync, rollback, or approval from `paprika status`.
