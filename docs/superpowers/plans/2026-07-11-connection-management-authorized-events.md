# Connection Management and Authorized Events Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver project-safe management of repositories, clusters, observability sources, projects, and policies; replace unauthenticated topic SSE with replayable authorized events; and complete credential, audit, browser, and scale acceptance for the enterprise console.

**Architecture:** Connect RPC handlers authorize every read, mutation, test, and stream against global RBAC plus exact AppProject identity. Narrow connection services reuse the strict cluster resolver and metric source checker from earlier plans, while a lifecycle controller makes immutable credential rotation recoverable. A project-partitioned event broker provides bounded replay through memory epochs or Redis Streams, and the UI consumes it through one cursor-aware Connect client.

**Tech Stack:** Go 1.26.0, Kubernetes CRDs/controller-runtime, Connect RPC/protobuf, Redis Streams, OpenTelemetry, Next.js 16, React 19, TypeScript, TanStack Query, Vitest/Testing Library, Helm, kind, Playwright.

**Approved spec:** `docs/superpowers/specs/2026-07-11-enterprise-operations-console-design.md`

**Prerequisites:** `2026-07-11-enterprise-fleet-console.md`, `2026-07-11-application-workspace-multicluster.md`, and `2026-07-11-observability-sources-golden-signals.md` are complete.

**Integration boundaries:** Plan 1 supplies the composed authorization service, project identities/capabilities, shell, TanStack query keys, and controlled scale harness. Plan 2 supplies `clusteraccess.Resolver`, direct/agent connection testing, and the multi-cluster E2E fixture. Plan 3 supplies `metricprovider.SourceCheckService`, ObservabilitySource types, and the error-returning audited provider contract. This plan extends those seams; it does not create competing resolvers, source clients, capability models, or audit sinks.

**Execution skills:** `@superpowers:test-driven-development`, `@security-best-practices`, `@frontend-development`, and `@superpowers:verification-before-completion`.

---

## Chunk 1: Management, Events, Audit, and Final Acceptance

### File structure

- `internal/api/connection_handler.go` — authorized connection read, mutation, test, and redacted response conversion.
- `internal/api/project_handler.go` — authorized AppProject summaries and capability projection.
- `internal/connections/` — reusable testers, owned-credential transactions, rotation state, and dependency scanning.
- `internal/controller/connections/` — crash-recoverable credential rotation reconciliation.
- `internal/api/events/` — project envelopes, cursor codec, memory replay, Redis Streams replay, and fan-in broker.
- `internal/api/watch_events_handler.go` — authorized Connect server stream with periodic revocation checks.
- `internal/api/audit_middleware.go` — typed audit coverage and failure observability.
- `ui/src/components/admin/` — connection forms/tables, credential controls, dependencies, and project summaries.
- `ui/src/lib/watch-events.ts` — cursor-aware Connect event client and targeted query invalidation.
- `test/e2e/browser/` and `ui/e2e/` — real-image, multi-project management and replay acceptance.

### Task 1: Add management, project, and event-stream contracts

**Files:**
- Modify: `proto/paprika/v1/api.proto`
- Modify: `internal/api/auth/authz.go`
- Modify: `internal/api/auth/middleware.go`
- Modify: `internal/api/auth/project_authorizer.go`
- Modify: `internal/api/auth/auth_test.go`
- Modify: `internal/api/auth/project_authorizer_test.go`
- Generated: `internal/api/paprika/v1/api.pb.go`
- Generated: `internal/api/paprika/v1/v1connect/api.connect.go`
- Generated: `ui/src/gen/paprika/v1/api_pb.js`
- Generated: `ui/src/gen/paprika/v1/api_pb.d.ts`
- Generated: `ui/src/gen/paprika/v1/api_connect.js`
- Generated: `ui/src/gen/paprika/v1/api_connect.d.ts`

- [ ] **Step 1: Write compile-failing authorization tests**

Add cases for global `connection.admin`, project `connection.write`, `connection.test`, and global `project.admin`. Prove every Repository/Cluster create/update/delete/**test** requires global `connection.admin`; `connection.test` applies only to an exact-project ObservabilitySource and never shared infrastructure. ObservabilitySource uses exact `(namespace, projectRef)`, global `connection.admin` explicitly bypasses the AppProject-role branch for source administration, and every non-global request intersects a permitting global RBAC rule with its exact AppProject role. Preserve auth-disabled mode as explicit allow-all/global capability; auth enabled with no matching global rule denies. Prove a streaming request receives an authenticated principal and unknown procedures fail closed.

```go
func TestStreamingInterceptorAuthenticatesPrincipal(t *testing.T) {
    interceptor := newTestInterceptor(t)
    next := connect.StreamingHandlerFunc(func(ctx context.Context, _ connect.StreamingHandlerConn) error {
        require.NotEmpty(t, auth.PrincipalFromContext(ctx).Subject)
        return nil
    })
    require.NoError(t, invokeStreaming(t, interceptor.WrapStreamingHandler(next)))
}
```

- [ ] **Step 2: Run the targeted tests and confirm the missing vocabulary/stream wrapper failures**

Run: `rtk go test ./internal/api/auth -run 'Test(ManagementAuthorization|StreamingInterceptor)' -count=1`

Expected: compile failures for the new resource/actions or a test failure because `WrapStreamingHandler` does not authenticate.

- [ ] **Step 3: Define additive protobuf contracts**

Add list/get/create/update/delete/test RPCs for Repository, Cluster, and ObservabilitySource; list/get RPCs for AppProject; and server-streaming `WatchEvents`. Preserve all existing field numbers and RPCs.

Define typed connection specs rather than accepting arbitrary Kubernetes objects. Number every new message from one in the order below:

- `ConnectionIdentity{namespace,name,resource_version}`; reuse Plan 1's `FleetObjectKey` for every namespace/name project or cluster identity rather than defining another key.
- `CredentialPurpose` with `AUTH=1` and `TLS_CA=2`; `ExistingCredentialRef{secret_name,key}`; typed Git HTTPS, private-key, username/password, OCI docker-config, bearer, mTLS, TLS-CA, and kubeconfig messages; `ManagedCredentialInput` as a oneof; and `CredentialSlotInput{purpose, oneof existing/managed}`. Reject duplicate purposes and incompatible shapes. Repository/Cluster accept AUTH only. ObservabilitySource accepts independent AUTH and TLS_CA slots matching Plan 3's separately versioned auth and `tls.caSecretRef` Secrets.
- `CredentialSummary{purpose,secret_name,auth_kind,owned}`; `CredentialRotationSummary{operation_id,purpose,phase,candidate_secret_name,observed_generation,message}` with no credential bytes or old-secret identity; `ConnectionHealth{phase,message,observed_generation,checked_at,response_time_ms}`; `DependentResource{type,namespace,name}`; and typed `DependencyViolation{repeated readable_dependents}` for Connect `FailedPrecondition` error details. Append capability values 5–8 to Plan 1's existing enum exactly as listed.
- `RepositoryConnection{identity,type,url,insecure,enable_lfs,github_app_id,github_app_installation_id,github_app_enterprise_url,force_http_basic_auth,no_proxy,repeated credentials,repeated rotations,health,capabilities,dependencies}`.
- `ClusterConnection{identity,display_name,mode,server,service_account,labels,health_interval,health_timeout,disabled,connection_timeout,agent_address,repeated credentials,repeated rotations,health,capabilities,dependencies}`.
- `ObservabilitySourceConnection{identity,project_ref,provider,endpoint,auth,tls,query,scope,correlation,golden_signals,repeated credentials,repeated rotations,health,capabilities,dependencies}`. Its typed nested fields mirror Plan 3 exactly; no `Struct`, JSON, YAML, or arbitrary map is accepted except Cluster labels.

Create/update/test requests carry repeated purpose-keyed write-only slots. Update carries `identity.resource_version` and rotates only supplied purposes, so AUTH and TLS_CA rotate independently. Delete carries only `ConnectionIdentity`; test builds a complete one-call override by combining supplied slots with authorized existing refs without status mutation or caching. Lists accept namespace, exact project where applicable, page size (default 100/max 500), and opaque cursor. Responses never echo credential inputs.

AppProject summaries include destinations, repository names, constraints, quotas, conditions, role names, caller-effective actions, and redacted subject summaries. Event requests use repeated project `FleetObjectKey` values, resource filters, and an opaque versioned resume cursor. `WatchEvent` has a top-level refreshed cursor on **every** delivery, heartbeat, and reset frame; its oneof carries typed delivery, heartbeat, or reset payload. Reset payload contains only affected project identities, while its top-level cursor preserves unaffected positions and advances reset streams to the live baseline.

- [ ] **Step 4: Regenerate clients**

Run: `rtk make generate-proto`

Expected: Go and TypeScript clients compile with the additive RPCs and `git diff --check` is clean.

- [ ] **Step 5: Implement full unary and streaming authentication hooks**

Replace substring classification with an explicit procedure→action/resource table covering every existing and new RPC. Add literal dotted actions while preserving the current read/write/admin hierarchy: `connection.admin` implies connection.write/test/read; `connection.write` implies connection.test/read but not admin; `connection.test` implies read only; `project.admin` is global-only. Unknown procedures deny when auth is enabled.

Refactor `auth.Interceptor` into a concrete `connect.Interceptor`, including `WrapStreamingHandler`. Authentication populates the principal for the stream and checks the global Event-read rule; `WatchEvents` calls the composed authorizer for each exact project before subscribing. Add `HasGlobalCapability` without redefining Plan 1's project method. Every caller uses `AuthorizedProjects(ctx, principal, action, resource, candidates)` and computes candidate `ProjectRef`s first.

- [ ] **Step 6: Run auth and protobuf verification**

Run: `rtk go test ./internal/api/auth -count=1`

Expected: all unary, streaming, global, project, and redaction authorization tests pass.

- [ ] **Step 7: Commit the contract boundary**

```bash
rtk git add proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go internal/api/paprika/v1/v1connect/api.connect.go ui/src/gen/paprika/v1/api_pb.js ui/src/gen/paprika/v1/api_pb.d.ts ui/src/gen/paprika/v1/api_connect.js ui/src/gen/paprika/v1/api_connect.d.ts internal/api/auth/authz.go internal/api/auth/middleware.go internal/api/auth/project_authorizer.go internal/api/auth/auth_test.go internal/api/auth/project_authorizer_test.go
rtk git commit -m "feat: define connection and event contracts"
```

### Task 2: Implement authorized reads and redacted project summaries

**Files:**
- Create: `internal/api/project_handler.go`
- Create: `internal/api/project_handler_test.go`
- Create: `internal/api/connection_handler.go`
- Create: `internal/api/connection_handler_test.go`
- Modify: `internal/api/server.go`
- Modify: `internal/api/auth/project_authorizer.go`
- Create: `internal/api/policy_handler_test.go`

- [ ] **Step 1: Write failing visibility and leakage tests**

Seed two AppProjects in one namespace with disjoint repositories, destinations, policies, sources, and role subjects. Assert a caller authorized for only one project cannot observe the other project through results, counts, capabilities, dependencies, policy lists, connection status, or role subjects. Build two servers from the same objects in different insertion order and prove list cursors return the same stable `(namespace,name)` pages; a changed filter or cursor schema is `InvalidArgument`.

- [ ] **Step 2: Run and confirm unimplemented RPC/policy leakage failures**

Run: `rtk go test ./internal/api ./internal/api/auth -run 'Test(ListAppProjects|GetAppProject|ListPolicies|ConnectionRead|Redact)' -count=1`

Expected: new RPCs are unimplemented and the existing policy list exposes unauthorized policies.

- [ ] **Step 3: Implement the project summary handlers**

Call `Reader.ProjectKeys(namespaceFilter)` first, then Plan 1's `AuthorizedProjects(ctx, principal, auth.ActionRead, auth.ResourceProject, candidates)` exactly once. Return only that intersection. Show role names and caller-effective actions; redact other subjects unless the principal has global `project.admin`.

- [ ] **Step 4: Implement connection read visibility**

Apply the exact tenancy rules:

- Repository visibility is the union of `spec.repositories` across authorized AppProjects.
- Cluster visibility is the union of named AppProject destinations.
- ObservabilitySource visibility requires access to its exact `(namespace, spec.projectRef)`.
- `ListPolicies` includes only policies whose project set intersects authorized projects; project-empty policies require at least one readable project in scope.

Calculate facets, totals, and capabilities after filtering. Sort by namespace/name and encode cursor version, canonical request hash, namespace, and name—never process generation—using the Plan 1 cursor conventions. Never fetch Secret contents for a read response.

- [ ] **Step 5: Run handler and authorization tests**

Run: `rtk go test ./internal/api ./internal/api/auth -run 'Test(ListAppProjects|GetAppProject|ListPolicies|ConnectionRead|Redact)' -count=1`

Expected: all project-isolation, capability, and redaction cases pass.

- [ ] **Step 6: Commit authorized reads**

```bash
rtk git add internal/api/project_handler.go internal/api/project_handler_test.go internal/api/connection_handler.go internal/api/connection_handler_test.go internal/api/server.go internal/api/auth/project_authorizer.go internal/api/policy_handler_test.go
rtk git commit -m "feat: add authorized connection inventory"
```

### Task 3: Add bounded connection mutation and live tests

**Files:**
- Create: `internal/connections/types.go`
- Create: `internal/connections/repository_tester.go`
- Create: `internal/connections/cluster_tester.go`
- Create: `internal/connections/tester_test.go`
- Modify: `internal/api/connection_handler.go`
- Modify: `internal/api/connection_handler_test.go`
- Modify: `internal/api/server.go`
- Modify: `internal/controller/core/repository_controller.go`

- [ ] **Step 1: Write failing CRUD, precondition, and no-secret tests**

Cover create/update/delete/test authorization, same-namespace credential references, typed credential shapes, immutable identity fields, and `resourceVersion` mismatch mapping to `connect.CodeAborted`. Assert a live test does not mutate status and no response/error/log contains credential bytes.

- [ ] **Step 2: Run and confirm unimplemented mutation failures**

Run: `rtk go test ./internal/connections ./internal/api -run 'Test(Connection|Repository|Cluster|ObservabilitySource)' -count=1`

Expected: missing package or unimplemented mutation failures.

- [ ] **Step 3: Extract narrow tester interfaces**

Define `RepositoryTester`, `ClusterTester`, and use Plan 3's `metricprovider.SourceCheckService` directly. Build the complete purpose-keyed `Credentials` override (auth plus optional TLS CA), set `SourceCheckRequest.GlobalConnectionAdmin` only from `HasGlobalCapability`, and rely on the checker to avoid cache/status writes. Extract Git/Helm logic from the Repository controller and add a bounded OCI registry check. For a saved or unsaved Cluster draft, call Plan 2's shared connection validator, construct a candidate `clusteraccess.ResolvedCluster`, then call `DirectPool` or the mTLS agent health boundary; never call runtime `Resolver.Resolve`, which reads a Cluster CR and requires Healthy status.

- [ ] **Step 4: Implement API mutations with optimistic concurrency**

Add `WithRepositoryTester`, `WithClusterTester`, and `WithSourceCheckService` server options. Global `connection.admin` is required for every shared Repository/Cluster create/update/delete/test. Exact-project `connection.write` manages ObservabilitySource and exact-project `connection.test` may test it; dedicated scope still requires global `connection.admin`. `connection.test` cannot imply write. Update/delete use Kubernetes preconditions and map conflicts to `Aborted`; test never writes status.

- [ ] **Step 5: Run focused and race tests**

Run: `rtk go test ./internal/connections ./internal/api -run 'Test(Connection|Repository|Cluster|ObservabilitySource)' -count=1`

Run: `rtk go test -race ./internal/connections ./internal/api -run 'Test(Connection|Repository|Cluster|ObservabilitySource)' -count=1`

Expected: CRUD, authorization, timeout, conflict, and redaction suites pass without races.

- [ ] **Step 6: Commit mutation services**

```bash
rtk git add internal/connections/types.go internal/connections/repository_tester.go internal/connections/cluster_tester.go internal/connections/tester_test.go internal/api/connection_handler.go internal/api/connection_handler_test.go internal/api/server.go internal/controller/core/repository_controller.go
rtk git commit -m "feat: manage and test deployment connections"
```

### Task 4: Add compensating transactions for UI-owned credentials

**Files:**
- Create: `internal/connections/credentials.go`
- Create: `internal/connections/credentials_test.go`
- Create: `internal/api/connection_envtest_test.go`
- Modify: `internal/api/connection_handler.go`
- Modify: `internal/api/connection_handler_test.go`

- [ ] **Step 1: Write failure-injection tests for each create boundary**

Inject failures before/after each purpose-keyed Secret creation, connection creation, and owner-reference patch. Cover ObservabilitySource AUTH-only, TLS_CA-only, and independent AUTH+TLS_CA slots. Assert compensation removes every newly owned resource, pre-existing external Secrets survive, and no response/error includes credential bytes. Use envtest to prove same-namespace owner references and immutable Secret behavior.

- [ ] **Step 2: Run and confirm the transaction service is missing**

Run: `rtk go test ./internal/connections ./internal/api -run 'TestCredentialCreate' -count=1`

Expected: compile failures for the credential transaction types.

- [ ] **Step 3: Implement fixed credential shapes and compensation**

Accept only: Git HTTPS `username`/`password` or `token`; Git SSH/GitHub App `privateKey`; Helm `username`/`password`; OCI `username`/`password` or `.dockerconfigjson`; Prometheus AUTH bearer/basic/mTLS fixed keys; Prometheus TLS_CA `ca.crt`; and Cluster kubeconfig under its selected key. Use `kubernetes.io/dockerconfigjson` only for that OCI shape and `Opaque` otherwise. Create one immutable same-namespace Secret per supplied purpose, labeled with connection/project/purpose. The sequence is all unowned purpose Secrets, connection, then owner patches; compensate the connection and every created Secret after any intermediate failure. Never modify/delete an external Secret.

Project writers may bind only a source-owned/labeled Secret or one named in `AppProject.spec.allowedCredentialSecrets`; global administrators may bind other same-namespace Secrets.

- [ ] **Step 4: Run unit/envtest and commit**

Run: `rtk go test ./internal/connections ./internal/api -run 'TestCredentialCreate' -count=1`

Expected: every injected failure compensates correctly and managed/external ownership rules pass.

```bash
rtk git add internal/connections/credentials.go internal/connections/credentials_test.go internal/api/connection_handler.go internal/api/connection_handler_test.go internal/api/connection_envtest_test.go
rtk git commit -m "feat: transact owned connection credentials"
```

### Task 5: Make immutable credential rotation crash-recoverable

**Files:**
- Create: `internal/connections/rotation.go`
- Create: `internal/connections/rotation_test.go`
- Create: `internal/controller/connections/credential_rotation_controller.go`
- Create: `internal/controller/connections/credential_rotation_controller_test.go`
- Modify: `internal/api/connection_handler.go`
- Modify: `internal/api/connection_handler_test.go`
- Modify: `internal/api/connection_envtest_test.go`
- Modify: `cmd/main_controllers.go`

- [ ] **Step 1: Write the failing lifecycle state table**

For AUTH and TLS_CA independently, cover interruption before/after intent persistence, deterministic candidate creation, candidate test, connection switch, and health observation; plus conflicts, Unhealthy rollback, cleanup, and external old-Secret preservation. Recreate the controller between every phase and prove annotation intent plus labeled Secret discovery—not process memory—drives recovery.

- [ ] **Step 2: Run and confirm missing rotation behavior**

Run: `rtk go test ./internal/connections ./internal/controller/connections ./internal/api -run 'TestCredentialRotation' -count=1`

Expected: missing rotation state/controller failures.

- [ ] **Step 3: Implement persistent rotation phases**

Generate an operation ID and deterministic candidate name, then persist `{operationID,purpose,oldRef,candidateName,phase=WaitingForCandidate}` on the connection with a resourceVersion precondition **before** creating any Secret; annotations contain names/state only, never bytes. Create the immutable candidate with connection UID, operation ID, and purpose labels. Reconciliation lists those labels and adopts exactly the deterministic candidate after restart; missing candidates remain visibly waiting and expire to a retryable terminal state instead of becoming invisible orphans.

The controller combines the candidate purpose with the current other purpose, live-tests through the shared tester/`SourceCheckService`, then switches only that Secret ref with a precondition. Delete the old owned Secret only after the new generation reports Healthy. On failed/unhealthy transition, restore only that purpose's old ref and delete only its candidate. Project response conversion maps annotations to `CredentialRotationSummary`; old refs and credential values remain redacted.

- [ ] **Step 4: Register, run restart/envtest coverage, and commit**

Run: `rtk go test ./internal/connections ./internal/controller/connections ./internal/api -run 'TestCredentialRotation' -count=1`

Expected: rotation converges correctly from every persisted phase after controller restart.

```bash
rtk git add internal/connections/rotation.go internal/connections/rotation_test.go internal/controller/connections/credential_rotation_controller.go internal/controller/connections/credential_rotation_controller_test.go internal/api/connection_handler.go internal/api/connection_handler_test.go internal/api/connection_envtest_test.go cmd/main_controllers.go
rtk git commit -m "feat: recover connection credential rotation"
```

### Task 6: Block connection deletion on readable dependencies

**Files:**
- Create: `internal/connections/dependencies.go`
- Create: `internal/connections/dependencies_test.go`
- Modify: `internal/api/connection_handler.go`
- Modify: `internal/api/connection_handler_test.go`
- Modify: `internal/api/connection_envtest_test.go`

- [ ] **Step 1: Write failing dependency and redaction tests**

Seed readable and unreadable dependents for every reference kind. Assert deletion is blocked even when every identity is redacted, `connect.CodeFailedPrecondition` carries a typed `DependencyViolation` containing only caller-readable identities, no force flag exists, and deleting an unreferenced connection removes only its owned purpose Secrets.

- [ ] **Step 2: Run and confirm dependency scanning is absent**

Run: `rtk go test ./internal/connections ./internal/api -run 'TestConnectionDependencies' -count=1`

Expected: delete currently succeeds or dependency types are missing.

- [ ] **Step 3: Implement the exact scanners**

- Repository: `Application.spec.source.repoRef`, `Template.spec.repoRef`, `AppProject.spec.repositories`.
- Cluster: strict named `Stage.spec.cluster` and named AppProject destinations, using `clusteraccess.IsStrictNamedRef`.
- ObservabilitySource: `Application.spec.observability.sourceRef`; every promotion-stage source and embedded canary/rollout metric check; generated/standalone Stage source plus canary/rollout checks; `AppProject.spec.defaultObservabilitySource`; `AnalysisTemplate.spec.checks[].metric.sourceRef`; and every top-level/strategy/step `RolloutAnalysis.checks[].metric.sourceRef`.

Authorize each dependent identity before including it. Return a typed `DependencyViolation` detail with the readable list; when empty, retain the detail with zero entries and a generic blocked message without hidden counts. V1 has no force delete.

- [ ] **Step 4: Run dependency/envtest and commit**

Run: `rtk go test ./internal/connections ./internal/api -run 'TestConnectionDependencies' -count=1`

Run: `rtk make test`

Expected: all dependency, redaction, ownership, and repository regression tests pass.

```bash
rtk git add internal/connections/dependencies.go internal/connections/dependencies_test.go internal/api/connection_handler.go internal/api/connection_handler_test.go internal/api/connection_envtest_test.go
rtk git commit -m "feat: protect referenced deployment connections"
```

### Task 7: Replace shared pub/sub with project-partitioned replay

**Files:**
- Modify: `internal/api/events/eventtypes.go`
- Modify: `internal/api/events/broker.go`
- Create: `internal/api/events/memory.go`
- Create: `internal/api/events/redis_streams.go`
- Create: `internal/api/events/cursor.go`
- Modify: `internal/api/events/broker_test.go`
- Create: `internal/api/events/redis_streams_test.go`
- Create: `internal/api/events/cursor_test.go`
- Modify: `internal/controller/pipelines/application_controller.go`
- Modify: `internal/controller/pipelines/release_controller.go`
- Modify: `internal/controller/pipelines/pipeline_controller.go`
- Modify: `internal/controller/rollouts/rollout_controller.go`
- Modify: `internal/controller/pipelines/notification_controller.go`
- Modify: `internal/api/pipeline_handler.go`
- Modify: `internal/api/audit_middleware.go`

- [ ] **Step 1: Write failing broker conformance tests**

Create one suite used by memory and Redis backends. Prove logical key `project/<namespace>/<project>`, per-project order, no claimed cross-project order, atomic replay-to-live handoff, 1,000-event/five-minute bounds, 64-KiB payload rejection, sensitive/untyped payload rejection, cursor version validation, partial reset, memory epoch mismatch, and Redis multi-writer ordering. Use `github.com/alicebob/miniredis/v2` for deterministic Redis tests.

- [ ] **Step 2: Run and confirm the existing pub/sub contract fails replay tests**

Run: `rtk go test ./internal/api/events -run 'Test(BrokerConformance|Cursor|RedisStreams)' -count=1`

Expected: missing replay/cursor types or ordering/reset failures.

- [ ] **Step 3: Implement authorization envelopes and versioned cursor maps**

Every event contains exact project identity and resource type/namespace/name plus an allowlisted typed change kind/summary; do not persist arbitrary request bodies, credentials, audit records, Kubernetes objects, or log text. Validate and redact the summary before publication and enforce a 64-KiB serialized event bound before memory/Redis insertion. Memory positions are broker epoch plus sequence; Redis positions are that project's Redis Stream ID. Encode the per-project position map in an opaque, versioned, size-bounded cursor and reject malformed or oversized inputs.

- [ ] **Step 4: Implement bounded memory and Redis Streams backends**

Use `XADD`/`XREAD` and trimming for Redis; do not use pub/sub. Fan-in subscribes to at most 200 public project streams, preserves order inside each, and reports `reset_required` only for unavailable positions. Advance the cursor for every consumed stream, including filtered events; the Watch handler sends that refreshed map on its next delivery, heartbeat, or reset. Internal notification consumption uses a separate uncapped project-discovery subscription and never weakens public limits.

- [ ] **Step 5: Migrate Application and Release publishers red-green**

Add publisher tests first, derive exact project identity from reconciled objects, publish typed envelopes, and remove their dashboard publications. Missing identity records a bounded failure and publishes nothing.

- [ ] **Step 6: Migrate Pipeline and Rollout publishers red-green**

Add their envelope/order tests first, replace pipeline-specific/dashboard topics with project envelopes, and retain resource identity so Pipeline UI filtering remains exact.

- [ ] **Step 7: Migrate API publishers and notification consumption red-green**

Test `pipeline_handler` and audit invalidations before migration. Audit emits only a typed resource-invalidation summary; actor/request/outcome stays in the audit sink. Change notifications to the internal project-discovery subscription, including projects added after startup; never use the public RPC.

- [ ] **Step 8: Run conformance, controller, and race suites**

Run: `rtk go test ./internal/api/events ./internal/controller/pipelines ./internal/controller/rollouts -count=1`

Run: `rtk go test -race ./internal/api/events -count=1`

Expected: both backends pass identical replay/order/reset behavior and all publishers include project identity.

- [ ] **Step 9: Commit replayable events**

```bash
rtk git add internal/api/events/eventtypes.go internal/api/events/broker.go internal/api/events/memory.go internal/api/events/redis_streams.go internal/api/events/cursor.go internal/api/events/broker_test.go internal/api/events/redis_streams_test.go internal/api/events/cursor_test.go internal/controller/pipelines/application_controller.go internal/controller/pipelines/release_controller.go internal/controller/pipelines/pipeline_controller.go internal/controller/pipelines/notification_controller.go internal/controller/rollouts/rollout_controller.go internal/api/pipeline_handler.go internal/api/audit_middleware.go
rtk git commit -m "feat: partition and replay project events"
```

### Task 8: Add authorized WatchEvents and migrate every client

**Files:**
- Create: `internal/api/watch_events_handler.go`
- Create: `internal/api/watch_events_handler_test.go`
- Create: `internal/metrics/events.go`
- Create: `internal/metrics/events_test.go`
- Modify: `internal/api/server.go`
- Modify: `cmd/main.go`
- Modify: `cmd/main_operator.go`
- Modify: `cmd/cloud-run/main.go`
- Create: `ui/src/lib/watch-events.ts`
- Create: `ui/src/lib/watch-events.test.ts`
- Create: `ui/src/lib/pipeline-events.ts`
- Create: `ui/src/lib/pipeline-events.test.ts`
- Modify: `ui/src/lib/connection-context.tsx`
- Delete: `ui/src/lib/pipeline-sse.ts`
- Modify: `ui/src/app/dashboard/page.tsx`
- Modify: `ui/src/app/dashboard/application/page.tsx`
- Delete: `ui/src/app/dashboard/__tests__/pipeline-sse.test.tsx`
- Modify: `ui/src/app/dashboard/__tests__/dashboard-sse.test.tsx`
- Modify: `ui/src/app/dashboard/pipelines/detail/page.tsx`
- Modify: `ui/src/app/dashboard/pipelines/detail/__tests__/page.test.tsx`
- Delete: `internal/api/sse.go`
- Delete: `internal/api/sse_test.go`

- [ ] **Step 1: Write failing stream authorization and replay tests**

Cover structured filters, authorization before broker subscription, cross-project isolation, the 200-stream limit, cursor advancement across filtered events, selective reset, Redis replay, reconnect, and malformed cursors. Assert delivery, heartbeat, and reset all carry the refreshed cursor and reconnecting immediately after a filtered/reset frame does not replay it. An omitted project filter expands to the authorized set; over 200 returns `ResourceExhausted` before subscription. Prove authorization on subscribe, every 30-second heartbeat, and before delivery after cache expiry; revocation terminates with `PermissionDenied`.

- [ ] **Step 2: Run and confirm the handler is missing**

Run: `rtk go test ./internal/api -run 'TestWatchEvents' -count=1`

Expected: missing handler or unimplemented RPC failures.

- [ ] **Step 3: Implement the server stream and bounded telemetry**

Authorize explicit projects before subscribing. Filter after replay retrieval, reauthorize at the specified boundaries, and put the broker's latest cursor on every frame. Reset establishes a live baseline for affected streams while preserving unaffected positions. Record only bounded OTel attributes: backend, outcome, reset reason, and stream-count bucket.

- [ ] **Step 4: Enforce a shared backend for split processes**

Add construction tests for all-in-one operator, standalone API, split controller, and Cloud Run. Operator may use the memory backend. Standalone API/Cloud Run and their separate controller publisher fail startup/readiness with a clear configuration error unless Redis Streams is configured; independent in-memory brokers are never presented as working cross-process events. Inject the same Redis/backend/retention settings into every process.

- [ ] **Step 5: Implement the base reconnecting client red-green**

Test `watchEvents()` cursor persistence, exponential reconnect, all three cursor-bearing frames, heartbeat handling, principal/scope-keyed session storage, and project-selective reset callbacks. Implement only the base client and typed identity→smallest-query-key mapping.

- [ ] **Step 6: Migrate shell, fleet, and Application consumers red-green**

Add invalidation tests for each consumer, replace polling triggers where appropriate with `watchEvents`, retain bounded polling as reconnect-gap backstop, then rerun each test before moving on.

- [ ] **Step 7: Migrate Pipeline consumers red-green**

Test `pipeline-events.ts` as a narrow wrapper, migrate Pipeline detail, and delete `pipeline-sse.ts` plus its obsolete test only after the replacement passes.

- [ ] **Step 8: Remove the raw route only after all consumers compile**

Remove Plan 1's explicit `/events` `NotFoundHandler` tombstone from operator, split API, and cloud-run muxes without restoring an HTTP/SSE route; `WatchEvents` is reachable only through the generated Connect service path. Then delete `sse.go`. Assert source search finds no runtime EventSource or raw topic subscription.

Run: `rtk rg -n 'EventSource|/events\?|topic=dashboard|Subscribe\("dashboard"' ui/src internal cmd`

Expected: no matches except explicit migration tests/documentation.

- [ ] **Step 9: Run backend and UI tests**

Run: `rtk go test ./internal/api ./internal/api/events ./internal/metrics -count=1`

Run: `cd ui && rtk npm test`

Expected: authorization, replay, reconnection, reset, and targeted invalidation tests pass.

- [ ] **Step 10: Commit the authorized stream migration**

```bash
rtk git add internal/api/watch_events_handler.go internal/api/watch_events_handler_test.go internal/api/server.go internal/api/sse.go internal/api/sse_test.go internal/api/events/broker.go internal/api/events/broker_test.go internal/metrics/events.go internal/metrics/events_test.go cmd/main.go cmd/main_operator.go cmd/cloud-run/main.go ui/src/lib/watch-events.ts ui/src/lib/watch-events.test.ts ui/src/lib/pipeline-events.ts ui/src/lib/pipeline-events.test.ts ui/src/lib/connection-context.tsx ui/src/lib/pipeline-sse.ts ui/src/app/dashboard/page.tsx ui/src/app/dashboard/application/page.tsx ui/src/app/dashboard/__tests__/pipeline-sse.test.tsx ui/src/app/dashboard/__tests__/dashboard-sse.test.tsx ui/src/app/dashboard/pipelines/detail/page.tsx ui/src/app/dashboard/pipelines/detail/__tests__/page.test.tsx
rtk git commit -m "feat: replace dashboard sse with authorized events"
```

### Task 9: Complete typed audit coverage and sink failure visibility

**Files:**
- Modify: `internal/audit/audit.go`
- Modify: `internal/audit/audit_test.go`
- Modify: `internal/api/audit_middleware.go`
- Modify: `internal/api/audit_middleware_test.go`
- Modify: `internal/api/signals_handler.go`
- Modify: `internal/metricprovider/manager.go`
- Modify: `internal/analysis/metric.go`
- Modify: `internal/controller/pipelines/analysisrun_controller.go`
- Modify: `internal/controller/pipelines/release_controller.go`
- Modify: `internal/controller/rollouts/rollout_controller.go`
- Modify: `internal/metrics/otel.go`
- Create: `internal/metrics/audit_test.go`

- [ ] **Step 1: Write failing coverage, redaction, and sink-error tests**

Build on Plan 3's error-returning `Auditor.Record` contract and sink-failure counter. Assert create/update/delete/test/rotate, operational actions, every analysis decision, and Plan 3 metric queries produce actor, exact project, resource, action, outcome, and correlation ID. Assert serialization rejects credentials, authorization headers, raw filters, endpoint URLs, application names in metric attributes, query text, and expanded PromQL. Inject a failing sink and prove a completed RPC result is unchanged while fallback logging and the shared OTel failure counter fire exactly once.

- [ ] **Step 2: Run and confirm current audit gaps**

Run: `rtk go test ./internal/audit ./internal/api ./internal/metrics -run 'TestAudit' -count=1`

Expected: missing management/operational/analysis coverage and typed-detail assertions fail.

- [ ] **Step 3: Make audit records typed and allowlisted**

Replace free-form details with per-action allowlisted detail structs or a converter that rejects unknown/sensitive keys. Audit after authorization and with the final outcome; never include request bodies or provider-expanded queries. Preserve Plan 3's provider/source audit records and fallible sink interface.

- [ ] **Step 4: Observe delivery failures without changing completed operations**

On sink error, use Plan 3's shared failure path: increment the OTel counter using only record-type/error-class attributes and log a redacted record through the process logger. Do not roll back an already completed mutation or replace its RPC response.

- [ ] **Step 5: Run audit and telemetry tests**

Run: `rtk go test ./internal/audit ./internal/api ./internal/metrics -run 'TestAudit' -count=1`

Expected: full coverage, failure observability, and sensitive/high-cardinality rejection pass.

- [ ] **Step 6: Commit audit hardening**

```bash
rtk git add internal/audit/audit.go internal/audit/audit_test.go internal/api/audit_middleware.go internal/api/audit_middleware_test.go internal/api/signals_handler.go internal/metricprovider/manager.go internal/analysis/metric.go internal/controller/pipelines/analysisrun_controller.go internal/controller/pipelines/release_controller.go internal/controller/rollouts/rollout_controller.go internal/metrics/otel.go internal/metrics/audit_test.go
rtk git commit -m "feat: harden enterprise audit delivery"
```

### Task 10: Build the capability-gated management UI

**Files:**
- Create: `ui/src/app/dashboard/admin/connections/page.tsx`
- Create: `ui/src/app/dashboard/admin/clusters/page.tsx`
- Create: `ui/src/app/dashboard/admin/projects/page.tsx`
- Create: `ui/src/app/dashboard/admin/policies/page.tsx`
- Create: `ui/src/components/admin/connection-table.tsx`
- Create: `ui/src/components/admin/connection-table.test.tsx`
- Create: `ui/src/components/admin/connection-form.tsx`
- Create: `ui/src/components/admin/connection-form.test.tsx`
- Create: `ui/src/components/admin/credential-fields.tsx`
- Create: `ui/src/components/admin/credential-fields.test.tsx`
- Create: `ui/src/components/admin/dependency-dialog.tsx`
- Create: `ui/src/components/admin/dependency-dialog.test.tsx`
- Create: `ui/src/components/admin/project-summary.tsx`
- Create: `ui/src/components/admin/project-summary.test.tsx`
- Create: `ui/src/lib/connections.ts`
- Create: `ui/src/lib/connections.test.ts`
- Modify: `ui/src/components/layout/app-shell.tsx`
- Modify: `ui/src/components/layout/app-shell.test.tsx`

- [ ] **Step 1: Write failing accessibility and authority tests**

Test read-only versus create/edit/delete/test/rotate capabilities, Repository/Registry labeling, exact project scoping, redacted role subjects, write-only purpose-keyed credentials, independent AUTH/TLS_CA rotation summaries after refresh, optimistic-conflict recovery, typed dependency error details, and destructive confirmation. Include keyboard navigation, accessible names, focus restoration, and narrow-screen layout. Replace Plan 1's disabled Admin affordance only after the route renders.

- [ ] **Step 2: Run and confirm missing routes/components**

Run: `cd ui && rtk npm test -- admin`

Expected: missing module or route failures.

- [ ] **Step 3: Implement shared inventory and forms**

Use the existing shell and TanStack client. Keep server capability flags authoritative; hiding a control is not authorization. Clear credential inputs immediately after submit and never hydrate them from a response. Display auth kind and Secret name only. Label OCI repositories as Registries while preserving the Repository API type. Projects and Policies are read-only summaries: do not add role, global-RBAC, policy, notification, template, or arbitrary-Secret editors.

- [ ] **Step 4: Implement lifecycle and dependency UX**

Show live test results separately from controller health. Render each purpose's `CredentialRotationSummary` independently as waiting/test/switch/healthy/rollback and survive refresh without client-only state. For deletion, require typed resource-name confirmation and decode only readable dependents from `DependencyViolation`. Treat `Aborted` as a stale-version refresh prompt.

- [ ] **Step 5: Run UI verification**

Run: `cd ui && rtk npm test`

Run: `cd ui && rtk npm run lint`

Run: `cd ui && rtk npm run build`

Expected: all component tests pass, no accessibility regressions are reported, lint is clean, and static export succeeds.

- [ ] **Step 6: Commit management UI**

```bash
rtk git add ui/src/app/dashboard/admin/connections/page.tsx ui/src/app/dashboard/admin/clusters/page.tsx ui/src/app/dashboard/admin/projects/page.tsx ui/src/app/dashboard/admin/policies/page.tsx ui/src/components/admin/connection-table.tsx ui/src/components/admin/connection-table.test.tsx ui/src/components/admin/connection-form.tsx ui/src/components/admin/connection-form.test.tsx ui/src/components/admin/credential-fields.tsx ui/src/components/admin/credential-fields.test.tsx ui/src/components/admin/dependency-dialog.tsx ui/src/components/admin/dependency-dialog.test.tsx ui/src/components/admin/project-summary.tsx ui/src/components/admin/project-summary.test.tsx ui/src/lib/connections.ts ui/src/lib/connections.test.ts ui/src/components/layout/app-shell.tsx ui/src/components/layout/app-shell.test.tsx
rtk git commit -m "feat: add enterprise connection management ui"
```

### Task 11: Ship RBAC, Redis, and real browser acceptance

**Files:**
- Create: `internal/api/connection_rbac.go`
- Modify: `config/rbac/role.yaml`
- Modify: `charts/chart/templates/rbac/manager-role.yaml`
- Modify: `charts/chart/values.yaml`
- Modify: `charts/chart/templates/_helpers.tpl`
- Modify: `charts/chart/templates/manager/manager.yaml`
- Modify: `charts/chart/templates/manager/statefulset.yaml`
- Modify: `charts/chart/templates/api-server/deployment.yaml`
- Modify: `charts/chart/templates/extras/redis-config.yaml`
- Modify: `charts/chart/templates/networkpolicy/api-server.yaml`
- Modify: `charts/chart/templates/networkpolicy/controller-manager.yaml`
- Modify: `deploy/test-values.yaml`
- Create: `internal/charttest/enterprise_test.go`
- Create: `internal/api/events/scale_test.go`
- Create: `internal/metrics/enterprise_attribute_test.go`
- Create: `ui/e2e/fixtures/auth.ts`
- Create: `ui/e2e/connections.spec.ts`
- Create: `ui/e2e/watch-events.spec.ts`
- Create: `ui/e2e/outage-isolation.spec.ts`
- Create: `test/e2e/browser/kind.yaml`
- Create: `test/e2e/browser/values.yaml`
- Create: `test/e2e/browser/seed.yaml`
- Create: `test/e2e/browser/connection-fixtures.yaml`
- Create: `hack/browser-e2e.sh`
- Modify: `ui/playwright.config.ts`
- Modify: `Makefile`
- Modify: `.github/workflows/test-e2e.yml`

- [ ] **Step 1: Write chart and RBAC tests before widening permissions**

Assert operator and split processes receive identical backend/retention/auth-TTL settings; operator memory is valid, while split API/controller without Redis is rejected. Assert generated and chart RBAC grant only required Secret and connection-CR verbs. Assert NetworkPolicies permit configured Prometheus/Redis egress without unrestricted egress.

- [ ] **Step 2: Run chart tests and confirm missing settings/verbs**

Run: `rtk helm lint charts/chart`

Run: `rtk go test ./internal/charttest -run 'Test(ConnectionRBAC|EventConfiguration|NetworkPolicy)' -count=1`

Expected: new assertions fail until chart and generated RBAC are synchronized.

- [ ] **Step 3: Add bounded production configuration**

Add kubebuilder markers in `internal/api/connection_rbac.go` for Repository/Cluster/ObservabilitySource CRUD, AppProject/policy/dependency reads, and Secret lifecycle verbs; regenerate `config/rbac/role.yaml`, then synchronize the chart copy. Expose event backend, five-minute/1,000-item retention, 30-second heartbeat, auth TTL no greater than heartbeat, Redis Streams, and test timeouts. Reject split mode without Redis. Add port 6379 egress only when enabled.

- [ ] **Step 4: Build the actual-image browser harness**

`hack/browser-e2e.sh` must build the UI into the Paprika Docker image with `docker build --platform linux/amd64`, load that image into kind, deploy via Helm with Redis and Plan 3 Prometheus fixtures, and seed two projects with distinct principals. Do not serve a mocked UI or bypass Connect authorization. Trap cleanup and redact kubeconfig, bearer/basic credentials, and Playwright form values from command output/artifacts.

- [ ] **Step 5: Add Repository, Registry, and Cluster journeys red-green**

Write the failing Playwright cases first, then cover create/test, shared-admin enforcement, project visibility, role redaction, optimistic conflicts, and response credential redaction.

- [ ] **Step 6: Add Prometheus credential lifecycle journeys red-green**

Cover independent AUTH/TLS_CA creation and rotation, refresh-visible phases, successful switch, failed-candidate rollback, external Secret preservation, and typed dependency-blocked deletion.

- [ ] **Step 7: Add event replay and revocation journeys red-green**

Cover cursor reconnect/replay, filtered-event heartbeat cursor advancement, selective reset, and revoked project access terminating the stream. Capture traces/screenshots only on failure and redact submitted credentials.

- [ ] **Step 8: Add outage, broker-scale, and telemetry gates red-green**

Add `BrokerScale200Projects` with bounded goroutine/memory assertions, and `EnterpriseAttributeAllowlist` by collecting every management/event/audit metric and span and rejecting names, filters, endpoints, credentials, cursors, and PromQL. In real-browser `outage-isolation.spec.ts`, stop Prometheus, then prove fleet inventory, selected-cluster resource inspection, and a non-metric operational action still work before provider recovery.

- [ ] **Step 9: Run browser and chart acceptance**

Run: `rtk helm lint charts/chart`

Run: `rtk go test ./internal/api/events -run TestBrokerScale200Projects -count=1`

Run: `rtk go test ./internal/metrics -run TestEnterpriseAttributeAllowlist -count=1`

Run: `rtk make test-e2e-browser`

Expected: bounded Go gates pass and the packaged UI completes management, replay, revocation, and Prometheus-outage isolation against deployed API/Redis.

- [ ] **Step 10: Commit deployment and acceptance assets**

```bash
rtk git add internal/api/connection_rbac.go config/rbac/role.yaml charts/chart/templates/rbac/manager-role.yaml charts/chart/values.yaml charts/chart/templates/_helpers.tpl charts/chart/templates/manager/manager.yaml charts/chart/templates/manager/statefulset.yaml charts/chart/templates/api-server/deployment.yaml charts/chart/templates/extras/redis-config.yaml charts/chart/templates/networkpolicy/api-server.yaml charts/chart/templates/networkpolicy/controller-manager.yaml deploy/test-values.yaml internal/charttest/enterprise_test.go internal/api/events/scale_test.go internal/metrics/enterprise_attribute_test.go ui/e2e/fixtures/auth.ts ui/e2e/connections.spec.ts ui/e2e/watch-events.spec.ts ui/e2e/outage-isolation.spec.ts ui/playwright.config.ts test/e2e/browser/kind.yaml test/e2e/browser/values.yaml test/e2e/browser/seed.yaml test/e2e/browser/connection-fixtures.yaml hack/browser-e2e.sh Makefile .github/workflows/test-e2e.yml
rtk git commit -m "test: validate enterprise management end to end"
```

### Task 12: Run the cross-plan release gate

**Files:**
- Create: `docs/guides/operations-console.md`
- Modify: `docs/guides/multi-cluster.md`
- Modify: `docs/guides/observability-sources.md`
- Create: `internal/api/enterprise_outage_test.go`

- [ ] **Step 1: Document the final operator contract**

Document connection tenancy, credential ownership/rotation recovery, dependency-safe deletion, authorized replay, memory availability only for all-in-one operator mode, mandatory Redis for split API/controller transport, activity-versus-audit distinction, strict ClusterRef migration, legacy analysis migration, Prometheus allowlists, and rollback signals. Include declarative examples without real endpoints or credentials.

- [ ] **Step 2: Run generation and repository tests from a clean working tree**

Run: `rtk make generate-proto`

Run: `rtk make generate manifests`

Run: `rtk make test`

Run: `rtk make lint`

Expected: generated artifacts are current; all Go tests and linters pass.

- [ ] **Step 3: Run UI, chart, multi-cluster, and browser gates**

Run: `cd ui && rtk npm test && rtk npm run lint && rtk npm run build`

Run: `rtk helm lint charts/chart`

Run: `rtk make test-e2e-multicluster`

Run: `rtk make test-e2e-browser`

Expected: static export, chart validation, direct/agent target-cluster flows, connection management, and authorized replay pass against real deployments.

- [ ] **Step 4: Write the final cross-plan outage test**

`enterprise_outage_test.go` injects a blocked metric provider and proves authorized fleet inventory, selected-stage resource inspection, sync/rollback/gate actions, and connection reads still succeed while signal/metric-analysis calls return typed unavailable/error states. Task 11's `scale_test.go` and singular `enterprise_attribute_test.go` already provide the broker and telemetry gates.

- [ ] **Step 5: Run scale, outage, and telemetry-cardinality gates**

Run: `rtk bash hack/test-fleet-scale.sh`

Run: `rtk go test ./internal/api -run TestPrometheusOutageIsolation -count=1`

Run: `rtk go test ./internal/api/events -run TestBrokerScale200Projects -count=1`

Run: `rtk go test ./internal/metrics -run TestEnterpriseAttributeAllowlist -count=1`

Expected: Plan 1's controlled linux/amd64 10,000-Application API/browser/memory acceptance remains within budget; a Prometheus outage does not block inventory, resource inspection, or non-metric actions; 200-project event fan-in stays bounded; telemetry contains no names, filters, endpoints, credentials, or PromQL.

- [ ] **Step 6: Inspect the final diff and commit closure**

Run: `rtk git diff --check`

Run: `rtk git status --short`

Expected: no whitespace errors, unexpected generated drift, credentials, kubeconfigs, traces, or screenshots are staged.

```bash
rtk git add docs/guides/operations-console.md docs/guides/multi-cluster.md docs/guides/observability-sources.md internal/api/enterprise_outage_test.go
rtk git commit -m "test: close enterprise operations release gate"
```
