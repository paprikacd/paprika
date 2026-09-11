# Paprika MCP Server Design

## Status

**Ships disabled and is not functional end to end.** `--mcp-enabled` defaults
to `false`. Even when explicitly enabled, `/mcp/authorize` is presently a
dead end — see Follow-up work required before enabling — so no MCP client
can complete authentication against this branch today. Nothing described
here is reachable in production until that work lands. This section exists
so the design cannot be misread as describing a working feature.

## Goal

Expose Paprika's fleet API to MCP clients so an agent can answer operational
questions ("what is broken in staging?", "why is this rollout stuck?") and,
under explicit scope, act on the answer ("promote this rollout", "roll that
release back").

The server must reuse Paprika's existing Connect API, project authorization,
and audit trail rather than reimplementing any of them. It must not introduce a
second control plane, a second authorization path, or a second credential
format.

This design deliberately reverses a decision recorded in
`2026-08-12-cli-login-system-status-design.md`, which listed an MCP server as a
non-goal on four grounds: process lifecycle, protocol dependency, packaging
path, and credential-loading surface. That spec also stated the deferral
condition — "added later as a thin adapter once the snapshot contract is
stable". `GetSystemStatus` now ships, so the condition is met. Of the four
objections, this design eliminates the process-lifecycle and packaging
objections by embedding in the existing `api` mode, and addresses the
credential objection by extending the existing token rather than inventing a
new one. The protocol dependency is real and is accepted.

## Context

Current `master` already provides:

- A Connect service, `PaprikaService`, with 60 RPCs: 45 read, 15 mutating.
- An interceptor chain assembled at `cmd/main.go:682`:
  `connect.WithInterceptors(otelInterceptor, authInterceptor, AuditInterceptor())`.
- Project-scoped authorization via `apiserver.WithAuthorizer`
  (`internal/api/auth/project_authorizer.go`), enforced inside that chain.
- An audit interceptor (`internal/api/audit_middleware.go`) that records
  mutating RPCs with the acting principal.
- OIDC login at `GET /auth/login` and code exchange at `POST /auth/token`,
  federating identity to Google.
- Self-signed HS256 bearer tokens minted by `IssueToken`
  (`internal/api/auth/self_signed_token.go`), 24h TTL.
- A `[]func(*http.ServeMux)` handler-registrar pattern used by
  `buildAuthHandlers` and `buildGitHubActionsTokenExchangeHandlers`.
- Redis-backed shared cache (`internal/cache`, `BackendRedis`).

Two facts about the current state are load-bearing for this design.

**Paprika is already an authorization server.** `/auth/login` federates to
Google for identity, but `IssueToken` mints Paprika's own HS256 JWT. That token
— not a Google token — is what clients present. MCP-facing OAuth is therefore an
extension of an existing authorization server, not a new one. This matters
because Google supports neither dynamic client registration (RFC 7591) nor
resource indicators (RFC 8707), so Google cannot serve as the authorization
server of record for MCP clients.

**Six mutating RPCs are not audited.** `auditVerbs`
(`internal/api/audit_middleware.go:18`) prefix-matches on
`Sync|Apply|Approve|Reject|Rollback|Promote|Abort`. Everything else is treated
as read-only. These fall through:

```
CancelPipeline    HoldRollout    IgnoreDriftedField
ResumeRollout     RetryStep      SkipStep
```

That is a pre-existing defect independent of MCP — cancelling a pipeline today
leaves no audit record. It becomes security-critical here because the obvious
implementation of scope gating is to reuse `classifyAudit` to decide what
counts as a write. Doing so would classify all six as reads and let a
read-scoped MCP token mutate fleet state untraced. The fix ships with this work.

## Approaches Considered

### Deployment: local stdio vs. in-cluster remote

A local `paprika mcp` subcommand over stdio would reuse the token that
`paprika login` already writes to `~/.paprika/config.yaml`, answering three of
the four original objections outright. It was rejected because it serves one
workstation at a time and requires every team member to install and update a
binary.

**Chosen: in-cluster remote**, reachable over HTTP at the existing public
hostname, with per-user OAuth. Multi-user, nothing to install. The cost is that
Paprika must become a spec-compliant OAuth 2.1 resource server, which is the
bulk of the work in this design.

### Process topology

1. **Separate `--mode=mcp` process calling the Connect API as a client.**
   Clean isolation and independent scaling, but it must hold and forward the
   user's token to the api-server — the token-passthrough pattern the MCP
   specification identifies as a confused-deputy risk. It also creates a second
   place where authorization can drift from the first.
2. **Embedded in `--mode=api`.** *Chosen.*
3. **Separate mode sharing the service layer in-process.** Requires the fleet
   index and authorizer in a second process — effectively the second control
   plane that the CLI spec ruled out.

Topology 2 wins on one decisive point: authorization and audit live in the
Connect interceptor chain. Re-entering that chain in-process means MCP inherits
per-user project scoping, audit records, and tracing from a single
implementation. Topologies 1 and 3 both create a second enforcement path that
can silently diverge from the first, which is unacceptable when the surface can
mutate production state.

The accepted trade-off: MCP shares the api-server's release cadence and
resource envelope, and cannot be scaled or restarted independently. If that
becomes a real operational constraint, topology 1 becomes preferable — but it
would then require token exchange (RFC 8693) rather than passthrough.

### Tool granularity

A mechanical 1:1 mapping of all 60 RPCs was rejected: tool schemas cost roughly
100–300 tokens each on every request, so 60 tools impose a 6–18k token overhead
before the model reads anything, and selection accuracy degrades as the list
grows. Several RPCs are near-duplicates that would actively confuse selection
(`GetResourceTree` vs `GetResourceTreeDetailed`, `ListApplications` vs
`QueryApplications`).

A small set of generic tools (`paprika_query(kind, filters)`) was also
rejected: weak schemas give the model no guidance and produce malformed calls.

**Chosen: a curated, purpose-shaped set of roughly 25 tools**, named for what an
operator asks rather than for the underlying proto method, with near-duplicates
merged behind parameters.

## Architecture

MCP tool calls re-enter the existing Connect handler rather than calling the
service implementation directly.

`NewPaprikaServiceHandler` returns an ordinary `http.Handler`. The MCP layer
holds a generated `v1connect.PaprikaServiceClient` whose `http.Client` uses an
in-memory `http.RoundTripper` that dispatches directly into
`connectHandler.ServeHTTP`. There is no socket and no port, but every call
traverses otel → auth → audit exactly as a console request does.

```
MCP client
  └─ POST /mcp   (OAuth 2.1 bearer, aud=paprika-mcp)
       └─ internal/api/mcp
            ├─ validate token, derive Principal
            ├─ resolve tool, check declared scope
            └─ in-memory RoundTripper
                 └─ connectHandler → otel → auth → audit → PaprikaServer
```

Tool handlers marshal arguments into a typed request and call a client method.
They contain no authorization logic of their own.

New package `internal/api/mcp/`, mounted through a
`buildMCPHandlers(...) []func(*http.ServeMux)` registrar matching the existing
`buildAuthHandlers` shape, so it slots into `cmd/main.go` without inventing a
pattern.

The scope check sits above the Connect call. A denied write must not reach the
handler, so the audit log is not polluted with rejected attempts — those are
recorded separately (see Error Handling).

### Configuration

| Flag | Default | Purpose |
| --- | --- | --- |
| `--mcp-enabled` | `false` | Master switch. Off by default. |
| `--mcp-bind-address` | `:8090` | **As built, this is not a separate listener.** See the deviation note immediately below. |
| `--mcp-access-token-ttl` | `24h` | Access token lifetime. |
| `--mcp-refresh-token-ttl` | `720h` | Refresh token lifetime. |
| `--mcp-oauth-client-id` | none | Statically registered client. |
| `--mcp-oauth-redirect-uris` | none | Exact-match allowlist. |

Not shown in the table: `PAPRIKA_MCP_PUBLIC_URL` is a required environment
variable, not a `--mcp-*` flag (`cmd/main.go:388`, deliberately kept off the
flag surface to hold the flag count at six). It has no default and
`validateMCPConfig` refuses to start with `--mcp-enabled=true` when it is
unset. It is embedded verbatim in the RFC 9728/8414 discovery metadata and
used as the minted token's `iss` claim, so it is as security-relevant as any
flag in the table above.

Disabled by default is deliberate: this is the first surface that lets a
language model mutate fleet state.

**Deviation from this table, recorded here rather than left implicit:**
`--mcp-bind-address` exists and is documented as "a separate listener,
independently firewallable," but the flag is parsed and stored
(`cmd/main.go:410`) and never read again. MCP does not listen on it. MCP
routes are mounted on the same shared API mux that serves the console and
CLI (`cmd/main.go:1012`, `mux.Handle("/mcp", srv.Handler())`), behind
whatever address `--addr` already binds. An operator who firewalls `:8090`
believing that contains MCP traffic is wrong; MCP is reachable on the same
port and address as the rest of the API. This is disclosed in the flag's own
help text and in `values.yaml`, but this spec previously asserted the
opposite in Security Properties below, which is corrected there. The flag is
kept for the deployment-facing address it documents, not because it
functions as a bind address.

## Tool Registry

Each tool declares its required scope as a mandatory struct field. This is
**not** derived from `classifyAudit`; see Context for why that derivation is
unsafe. A missing declaration is a compile error.

```go
type Tool struct {
    Name        string
    Description string
    Scope       Scope // ScopeRead | ScopeWrite — required
    Destructive bool  // gates two-phase confirmation
    InputSchema any
    Invoke      func(context.Context, *v1connect.PaprikaServiceClient, json.RawMessage) (any, error)
}
```

### Read tools (14)

`fleet_status`, `list_clusters`, `fleet_map`, `list_applications`,
`get_application`, `investigate`, `get_resource_tree`, `get_logs`,
`list_pipelines`, `get_pipeline_run`, `list_releases`, `list_rollouts`,
`get_rollout`, `query_cost`.

### Write tools (11)

Each mutating operation is a distinct tool so that intent is explicit in both
the transcript and the audit record.

| Tool | Destructive | Two-phase |
| --- | --- | --- |
| `rollback_release` | yes | yes |
| `promote_rollout` | yes | yes |
| `abort_rollout` | yes | yes |
| `cancel_pipeline` | yes | yes |
| `skip_step` | yes | yes |
| `sync_application` | no | no |
| `approve_gate` | no | no |
| `reject_gate` | no | no |
| `hold_rollout` | no | no |
| `resume_rollout` | no | no |
| `retry_step` | no | no |

### Exclusions

Exposure is opt-in: the 25 tools cover 27 of the 60 RPCs (two tools each wrap a
pair: `get_resource_tree` covers GetResourceTree + GetResourceTreeDetailed, and
`get_logs` covers GetResourceLogs + GetStepLogs). The remaining 33 sit on the
opt-out list described under Registry Completeness, each with a recorded
reason. Read RPCs are generally excluded for redundancy — they are reachable
through a merged tool (`GetResourceTreeDetailed` via `get_resource_tree`'s
`detailed` parameter) or are too narrow to earn schema budget
(`GetRevisionInfo`, `ListDriftDetails`).

`StreamResourceLogs` is excluded on protocol grounds: it is a server-streaming
RPC and MCP tool calls are request/response. `get_logs` wraps
`GetResourceLogs` and `GetStepLogs` with a required tail limit instead.

Four of the 15 mutating RPCs are deliberately **not** exposed, and these
warrant naming explicitly because omitting a write is a security decision:

| RPC | Reason for exclusion |
| --- | --- |
| `ApplyBundle` | Applies an arbitrary manifest bundle. Effectively unbounded write access to the fleet; no useful scope boundary can be drawn around it. |
| `ApplyResourcePatch` | Arbitrary patch against an arbitrary resource. Same objection. |
| `SyncResources` | Bulk multi-resource sync with a blast radius that is hard to preview, making the two-phase confirmation summary untrustworthy. |
| `IgnoreDriftedField` | Durably suppresses drift detection. A configuration-governance decision that should be made by a human in the console, not inferred by a model from a log line. |

These four remain audited (see Audit Fix) — exclusion from the tool registry
does not exempt them from the audit trail, since the console and CLI still
reach them.

### Pagination and truncation

Every list tool takes a `page_size` defaulting to 50, with server-side
truncation. A fleet-wide `ListApplications` can return thousands of entries and
exhaust the model's context in a single call. Truncated responses carry an
explicit marker so the model never silently reasons over a partial fleet.

### Registry completeness

The registry is hand-maintained, so a newly added RPC does not appear
automatically. A test asserts that every RPC in `api.proto` is either
registered or present on an explicit opt-out list with a stated reason. Adding
an RPC therefore forces a deliberate decision.

## Token and Scope Model

### Claims

`selfSignedClaims` gains `aud`, `iss`, and `scope`:

```go
type selfSignedClaims struct {
    Subject string `json:"sub"`
    Email   string `json:"email"`
    Name    string `json:"name"`
    Issuer  string `json:"iss"`
    Audience string `json:"aud"`
    Scope   string `json:"scope"` // space-delimited, RFC 6749 §3.3
    IAT     int64  `json:"iat"`
    Exp     int64  `json:"exp"`
}
```

### Migration

The existing 24h TTL makes migration a non-event: every live token self-rotates
within a day, so no dual-read window needs maintaining.

- During the first 24h after deploy, the MCP authenticator validates
  `aud == "paprika-mcp"` strictly, rejecting legacy aud-less tokens. The
  console/CLI authenticator continues to accept them.
- After 24h, the console/CLI authenticator is tightened to require
  `aud == "paprika-api"`. This closes the reverse direction: an MCP token
  replayed against the console API.

**This second step cannot be done as written, and has not been done.** The
in-process transport that lets MCP tool calls re-enter the Connect chain
(the whole point of the chosen "embedded in `--mode=api`" topology — see
Process topology above) works by forwarding the caller's own MCP-audience
bearer token into that same chain: `internal/api/mcp/transport.go:77` sets
`req.Header.Set("Authorization", "Bearer "+token)` on the in-process request
using the token `withBearerToken` stashed from the *MCP* request, i.e. a
token with `aud=paprika-mcp`. If the console/CLI authenticator were tightened
to require `aud == "paprika-api"`, every legitimate MCP tool call would be
rejected by its own downstream Connect chain — the fix for the Security
Properties gap above would break the feature outright, because both the
console leg and the in-process MCP leg currently share one authenticator and
one audience space.

Closing the gap therefore needs something this spec does not currently
describe: either a distinct internal credential for the in-process leg (so
the console-facing chain can require `aud=paprika-api` while a separate,
narrower check admits the internal MCP-forwarded call), or scope enforcement
added inside the Connect chain itself (so a `scope=paprika:read` token is
rejected for a mutating RPC regardless of which front door it entered
through, making the audience question moot for this particular attack).
Neither is designed here. This is tracked as follow-up work required before
`--mcp-enabled=true` is safe to turn on — see Follow-up work required before
enabling — not solved by this spec.

### Two independent gates

Both must pass. They answer different questions and must not be collapsed:

- **Token scope** — what this credential may do: `paprika:read` or
  `paprika:write`.
- **The existing `Authorizer`** — what this human may do, per project.
  Unchanged, still enforced inside the interceptor chain.

A write-scoped token held by a user without project rights fails. A read-scoped
token held by an administrator cannot roll back.

### Client registration

Static, configured via `--mcp-oauth-client-id` and an exact-match redirect-URI
allowlist. Registration is per client *application*, not per user: one entry
covers the whole team, while each person still completes their own
authorization-code flow. RFC 7591 dynamic registration is a non-goal — open
registration is a meaningful attack surface with no benefit while the client
set is known.

### Refresh tokens

Access tokens remain 24h by default, with rotating refresh tokens stored in
Redis via `internal/cache` so that sessions survive and credentials are
revocable.

**Accepted limitation, recorded deliberately:** because the access token is a
stateless HS256 JWT, revoking a refresh token does not invalidate an
outstanding access token. A compromised credential remains valid until it
expires — up to 24h. Most of the security value of refresh tokens comes from
shortening the access-token lifetime; at 24h the benefit is session continuity
and rotation rather than prompt revocation. `--mcp-access-token-ttl` exists so
this can be tightened without a code change.

### Discovery

- `/.well-known/oauth-protected-resource` (RFC 9728) on the MCP resource.
- `/.well-known/oauth-authorization-server` (RFC 8414) for Paprika-as-AS.

## Write Path

Read tools feed untrusted content — pod logs, annotations, container output —
directly into the model's context. A crafted log line instructing the model to
roll back production is a realistic attack. Two independent mitigations apply.

### Layer 1: tool annotations (advisory)

Write tools carry `readOnlyHint: false` and, where applicable,
`destructiveHint: true` and `idempotentHint`. Compliant clients use these to
prompt the operator. This is client-side and the server does not rely on it.

### Layer 2: two-phase commit (authoritative)

Tools marked `Destructive` cannot execute on first call. The first call mutates
nothing and returns a human-readable preview — what changes, which application,
which revision — plus a confirmation token that is:

- single-use,
- valid for 60 seconds,
- bound to the principal, and
- bound to a hash of the exact arguments.

Execution requires a second call carrying that token. Argument binding is
essential: without it, the model could obtain confirmation for a benign action
and replay it against a different one.

Non-destructive writes are single-phase — still scope-gated and audited, but
reconciling to declared state or pausing a rollout does not warrant the
friction.

## Audit Fix

`auditVerbs` gains `Cancel`, `Hold`, `Ignore`, `Resume`, `Retry`, and `Skip`, so
that `CancelPipeline`, `HoldRollout`, `IgnoreDriftedField`, `ResumeRollout`,
`RetryStep`, and `SkipStep` are audited. This corrects a pre-existing defect and
is independently valuable; it ships here because this feature depends on
correct write classification.

Prefix matching remains fragile — a future `PauseRollout` would silently fall
through again. The registry-completeness test is the durable guard, since it
forces an explicit scope declaration for every new RPC regardless of its name.

## Error Handling

Connect error codes map to MCP errors, with two cases treated specially:

- `unauthenticated` returns HTTP 401 with a `WWW-Authenticate` header pointing
  at the protected-resource metadata. This lets a client transparently re-run
  the OAuth flow rather than failing the conversation.
- `permission_denied` names the missing scope or project but discloses nothing
  about resources the caller cannot see.

Truncated list responses carry an explicit marker. Confirmation-token failures
distinguish expired, already-used, and argument-mismatch, because they mean
different things operationally.

Audit records cover *attempts*, not only successes: denied-for-scope and
expired-confirmation both produce records. Probing of this surface should be
visible in the audit trail.

## Security Properties

- **Console tokens cannot be replayed against MCP.** The MCP authenticator is
  built with `NewSelfSignedAuthenticatorForAudience(secret, "paprika-mcp",
  "")` (`cmd/main.go:965`), which strictly requires `aud == "paprika-mcp"`.
  A console/CLI token (no `aud`, or the wrong one) is rejected at the MCP
  front door.
- **The reverse does NOT hold, and this spec previously claimed it did — that
  claim was false and is corrected here.** The console/CLI Connect chain is
  built with `NewSelfSignedAuthenticator(cfg.TokenSecret)`
  (`internal/api/auth/middleware.go:112`), the plain constructor with no
  audience argument, so it performs no audience check at all. That chain
  also never reads the `scope` claim — `principalHasScope`/`HasScope` exist
  only in `internal/api/mcp/invoke.go` and are never called from
  `internal/api/auth`. A token minted with `aud=paprika-mcp,
  scope=paprika:read` therefore authenticates successfully against the
  console Connect chain and yields a full `Principal`, gated only by that
  principal's project `Authorizer` rights — exactly the same gate a normal
  console token faces. Such a credential can call
  `/paprika.v1.PaprikaService/RollbackRelease` directly over the console
  API, bypassing the MCP tool registry's scope gate, the destructive-tool
  gate, and two-phase confirmation entirely, none of which exist outside the
  MCP layer. This was verified empirically. See Migration below for why the
  spec's original remedy for this does not fit the chosen topology, and
  Follow-up work required before enabling for tracking.
- Authorization (project rights, via the `Authorizer`) is enforced once, in
  the existing interceptor chain; the MCP layer cannot bypass *that* check
  because it re-enters the same chain. This is a narrower guarantee than
  "cannot be misused" — it says nothing about the scope bypass above, which
  lives one layer up, in which chain a token is allowed to enter at all.
- Scope gating is declared per tool and verified by a test that iterates the
  registry, so it cannot drift as tools are added — but this guarantee holds
  only for calls that go through the MCP tool registry. A caller that
  presents an MCP-audience token directly to the console API skips the
  registry, and with it this gate (see above).
- Destructive operations require human-visible confirmation bound to exact
  arguments — again, only for calls made through the MCP layer; the console
  API has no two-phase confirmation.
- Every mutation is audited with the acting principal, including the six RPCs
  that are unaudited today.
- **The surface is disabled by default. It does NOT listen on a separately
  firewallable address** — this spec previously claimed it did; that claim
  was false and is corrected in Configuration above. MCP is mounted on the
  same shared API mux as the console and CLI and is reachable wherever that
  is reachable.

## Testing and Validation

### Registry-driven tests

Three table-driven tests iterate the tool registry so they cannot drift:

1. **No write tool is reachable with a read-scoped token.** Calls every
   registered tool with a `paprika:read` token and asserts that everything
   declared `ScopeWrite` is refused. This is the direct regression test for the
   `auditVerbs` defect.
2. **Every write tool emits an audit record** carrying the acting principal,
   driven through the real interceptor chain against a fake `Auditor`.
3. **Registry completeness** against `api.proto`, as described above.

### Unit tests

`aud` acceptance and rejection including the legacy aud-less case; scope
parsing; two-phase confirmation covering single-use, 60s expiry,
argument-hash mismatch, and wrong-principal; the 401 + `WWW-Authenticate`
re-auth path; truncation markers.

Convention: testify, matching the 97 existing testify test files. Ginkgo is
reserved for e2e.

### Integration tests

Run against the real `connectHandler` through the in-memory `RoundTripper`, not
a mock, so authorization and audit are exercised as deployed. The
`test/fleetconsole/` fixture is the structural precedent, but it is deliberately
auth-disabled; the MCP fixture runs with auth enabled, since auth is the subject
under test.

### Risk to retire first

The in-memory `RoundTripper` must preserve Connect's error semantics and
trailer handling identically to a network transport. This is verified by
experiment in the first implementation task, not assumed. If it does not hold,
the fallback is a loopback listener on localhost — slightly slower, identical
security properties.

## Non-Goals

- Dynamic client registration (RFC 7591).
- Token exchange (RFC 8693); required only if topology 1 is revisited.
- Streaming tool results; `StreamResourceLogs` stays excluded.
- A local stdio MCP server.
- Exposing MCP from `operator`, `webhook`, `repo-server`, or `agent` modes.
- Ginkgo e2e covering the full OAuth round trip against a deployed instance;
  a follow-on, not part of this spec.

## Follow-up work required before enabling

The three items below are known gaps in the code as merged. None block
merging this branch, because `--mcp-enabled` defaults to `false` and nothing
here is reachable with the flag off. All three block turning it on.

1. **The `/mcp/authorize` circularity.** `/mcp/authorize` authenticates the
   caller with the MCP-audience authenticator, which requires a token whose
   `aud=paprika-mcp` — and the only thing that mints such a token is
   `/mcp/token`, which requires an authorization code that only a completed
   `/mcp/authorize` can issue. There is no way into the loop. Paprika's OIDC
   login (`/auth/login`, `/auth/token`) is client-side: it returns JSON to a
   SPA that holds state in `sessionStorage`/`localStorage`, there is no
   server-side session or cookie to piggyback on, and there is no MCP page in
   `ui/` today. Closing this needs either an MCP-specific page in `ui/` that
   drives the existing client-side OIDC flow to establish identity and then
   exchanges it for an MCP-audience token, or a second IdP client
   registration paired with a server-side session. Until one of these lands,
   `--mcp-enabled=true` produces an OAuth surface that advertises itself via
   discovery metadata but that no MCP client — browser-based or otherwise —
   can actually authenticate against.
2. **Monolith topology support.** The Helm chart wires MCP into the
   `deploymentMode: split` API-server Deployment only. `deploymentMode:
   monolith` (the chart default) has no MCP wiring at all; the template
   fails the `helm template` render loudly when `mcp.enabled=true` is
   combined with monolith rather than silently producing a deployment with
   MCP quietly absent. Supporting the monolith topology needs the
   equivalent wiring added to `manager/manager.yaml`. Out of scope for this
   spec; tracked here so it isn't forgotten.
3. **The console-chain scope/audience bypass** described in Security
   Properties and Migration above: an MCP-audience, read-scoped token
   authenticates successfully against the console Connect chain (which
   checks neither audience nor scope) and, subject only to the caller's
   existing project rights, can call any RPC including destructive ones —
   bypassing the MCP registry's scope gate and two-phase confirmation
   entirely. The spec's original migration remedy (tighten the console
   authenticator to `aud == "paprika-api"`) is incompatible with the
   in-process topology this design chose, because the MCP leg forwards an
   `aud=paprika-mcp` token into that same chain. A real fix needs a distinct
   internal credential for the in-process leg, or scope enforcement inside
   the Connect chain itself; neither is designed yet.
