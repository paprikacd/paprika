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

On success, the CLI stores the ID token and its expiration time in the selected Paprika config file, preserving unrelated configuration. It does not persist the OAuth access token, authorization code, PKCE verifier, state, or refresh token. Re-running `paprika login` replaces the saved ID token. Bearer tokens take precedence over saved Basic credentials for all API commands, so a successful login is immediately effective without deleting a user's fallback Basic configuration.

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
5. The callback accepts only `GET /callback`, validates the returned state before using the code, and hands the result to the command. Error callbacks are handled without attempting exchange. Wrong paths and methods receive a local error response but do not consume the pending login flow.
6. The callback response waits while the CLI posts the code, verifier, and exact loopback redirect URI to `/auth/token`. The token endpoint applies the same exact redirect allowlist before contacting the provider and continues to validate the returned ID token.
7. The CLI reports the exchange outcome back to the waiting callback. Only then does the browser render a terminal success or failure page, so it cannot claim success for a failed exchange.
8. The CLI parses the validated ID token only to display identity and record expiration. Display identity falls back in this order: `email`, `preferred_username`, then `sub`. The API remains responsible for authenticating the token on every request.
9. Temporary values are released when the command completes. Callback and token-exchange errors never include codes, tokens, verifier values, provider response bodies, or client secrets.

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
- Exact counts for every health enum, including unspecified, healthy, progressing, degraded, failed, unknown, and missing.
- Exact counts for every sync enum, including unspecified, synced, out of sync, and unknown.
- A deterministic, impact-ordered list of authorized applications needing attention, capped by `attention_limit`.
- The exact total number of applications needing attention.
- Whether more attention records exist beyond the returned list.

An application needs attention when any of the following is true:

- Health is progressing, degraded, failed, unknown, or missing.
- Sync state is out of sync or unknown.
- A gate is blocked.
- The current release or rollout is failed, degraded, rolled back, aborted, paused, or awaiting approval.
- A referenced cluster, repository, or observability connection is unhealthy.

Each attention record reuses the existing `ApplicationSummary` protobuf so consumers receive stable identity, project, health, sync, release, rollout, resource, connection, and transition fields without a parallel model.

Impact ordering is a descending lexicographic tuple followed by an ascending identity tie-breaker:

1. Health severity: failed, missing, degraded, progressing, unknown, unspecified, healthy.
2. Sync severity: out of sync, unknown, unspecified, synced.
3. Blocked gate count.
4. Change severity, taking the maximum rank across current release and rollout: failed/degraded/aborted, rolled back, awaiting approval/paused, active pending/promoting/canarying/verifying/progressing, terminal complete/healthy/superseded, unspecified.
5. Number of unique unhealthy connection identities across clusters, repository, and observability source. Repeated stage targets referencing the same cluster count once.
6. Managed resource count.
7. Last transition time, newest first.
8. Application namespace and name, ascending.

`attention_limit=0` means the default of 20 because zero is the protobuf omitted value. Values from 1 through 100 are accepted; values above 100 return `InvalidArgument`. Version one does not provide a zero-detail mode.

## Server Architecture

Add `ProjectKeys(namespaces)` and `QueryStatus(scope, filter, limit)` methods to the immutable fleet snapshot. `ProjectKeys` derives candidates only from that snapshot, while `QueryStatus` performs authorization filtering, request filtering, aggregation, and attention ordering against the same snapshot. They return provider-neutral data and never perform live Kubernetes reads.

The API handler:

1. Validates `attention_limit` and the namespace value.
2. Calls the reader's existing `LoadSnapshot` exactly once.
3. Derives candidate projects from that immutable snapshot.
4. Builds an authorized query scope from those candidates with the authenticated principal and existing project authorizer.
5. Calls `QueryStatus` on the same snapshot.
6. Converts the result to protobuf and returns it.

The existing Connect auth interceptor classifies `GetSystemStatus` as a read operation on applications. The handler still builds a project-filtered scope because aggregate endpoints must not reveal unauthorized counts, names, projects, or health states.

## CLI Architecture

The login command is split into independently testable units:

- A login client that calls `/auth/login` and `/auth/token` with bounded HTTP behavior.
- A loopback receiver that owns the fixed listener, validates method/path/state, and returns one result.
- A browser opener with a platform implementation and a printable-URL fallback.
- A config update function that persists only the server, ID token, and token expiration while preserving unrelated fields. It writes a temporary file in the same directory, sets mode `0600`, atomically renames it into place, and corrects an existing overly permissive config to `0600`.

The status command uses the generated Connect client and current config. The shared API client uses an explicit 30-second HTTP timeout, and `paprika status` applies a tighter 15-second overall request context. Login uses its own bounded client because its five-minute browser wait is not an API request. Table formatting is human-oriented; JSON and YAML use the protobuf response directly.

## Security Properties

- Authentication remains OIDC ID-token verification against the configured issuer, audience, signature, and expiry.
- Authorization remains fail-closed and project-scoped before aggregation.
- Redirect URIs are exact-allowlisted at login initiation and token exchange; arbitrary redirect URIs are rejected.
- OAuth state and PKCE values come from `crypto/rand`, remain in memory, and are never logged.
- The loopback listener binds only IPv4 loopback, handles one flow, has a five-minute deadline, and accepts only its fixed callback route.
- HTTP clients use explicit timeouts, close response bodies, and cap response size.
- The server-side provider exchange uses an injected bounded HTTP client, caps the provider body, and returns redacted status errors without echoing provider bodies.
- Tokens and authorization codes do not appear in URLs generated by Paprika, logs, process arguments, or command output.
- The CLI config remains mode `0600`. Only the validated ID token is persisted; short-lived exchange material is not.
- No API response contains Kubernetes Secrets, provider credentials, raw manifests, or inaccessible fleet metadata.

## Deployment Credential Hardening

The existing chart documents `auth.oidc.existingSecretName` and `existingSecretKey`, but current templates do not consume them and instead render the client secret in container arguments. This rollout completes that contract:

- The binary reads `PAPRIKA_OIDC_CLIENT_SECRET` as the default OIDC client secret.
- API and monolith workloads populate that variable from the configured Kubernetes Secret key.
- The chart no longer supports inline `auth.oidc.clientSecret`; a non-empty legacy value fails rendering with migration guidance.
- OIDC deployments that need a confidential-client secret must set `existingSecretName` and `existingSecretKey` together. Partial or conflicting configuration fails rendering.
- Helm never renders `--auth-oidc-client-secret`.
- The deployment values use the Secret reference, not an inline client secret.
- The currently exposed Google OAuth client secret is rotated before final live verification.

The non-secret issuer URL and client ID may remain in arguments. The Secret value must not appear in rendered manifests, pod arguments, logs, test snapshots, or command output.

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
- Provider exchange uses the injected timeout, rejects oversized responses, and redacts provider bodies.
- Config updates preserve unrelated fields, use atomic replacement, correct permissions, and maintain `0600` permissions.
- Saved bearer tokens take precedence over saved Basic credentials.
- Status aggregation is exact for every health/sync value and attention reason.
- Attention total, ordering, truncation, zero/default limit, and maximum limit are deterministic.
- Authentication rejects missing, malformed, invalid, and expired bearer tokens.
- Authorization tests prove cross-project applications and aggregate counts are absent.
- Snapshot consistency tests replace the index between candidate derivation and aggregation and prove one request remains bound to one generation.
- Chart rendering tests prove a referenced OIDC Secret becomes `PAPRIKA_OIDC_CLIENT_SECRET` and never a container argument or inline value.
- Chart validation tests reject inline, partial, and conflicting OIDC client-secret configuration.
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
7. Confirm pod arguments and rendered workload manifests do not contain the OIDC client secret.
8. Confirm the deployed workloads are ready and the demo application remains healthy.

## Non-Goals

- MCP server or tool registration.
- Refresh-token storage or automatic background renewal.
- OS keychain integration.
- Device authorization grant.
- Multiple simultaneous login sessions on the fixed callback port.
- Direct Kubernetes API access from the CLI.
- Automated remediation, sync, rollback, or approval from `paprika status`.
