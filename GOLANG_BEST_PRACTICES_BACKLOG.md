# Go Best-Practices Alignment Backlog

**Repo:** `github.com/benebsworth/paprika`  
**Skill:** `../skunkworq-skills/go-best-practices` (Go Best Practices)  
**Date:** 2026-06-17  
**Audited by:** Kimi Code CLI (deep static review + targeted spot checks)

---

## Executive Summary

The Paprika codebase is already in reasonable shape for a Kubebuilder project: it uses Go 1.26, organizes code under `internal/` by domain, has no `util`/`common` grab-bag packages, uses `go.uber.org/mock`, and `golangci-lint run ./...` is currently green. However, aligning it with the `go-best-practices` skill reveals a meaningful backlog concentrated in four areas:

1. **Concurrency safety** – real data races, goroutine leaks, and a potential deadlock in the workflow engine.
2. **Dependency injection & architecture** – producer-side interfaces, constructors returning interfaces, package-level mutable state, and struct embedding that leaks APIs.
3. **CI / toolchain hygiene** – the release workflow pins Go 1.24 (older than `go.mod`), there is no race-detector gate, and `go.mod` lacks a `toolchain` directive.
4. **Error handling & testing** – bare `return err` at high-level orchestration, error-string style violations, and tests that leak resources or rely on real time.

This backlog is intentionally actionable: each item includes severity, effort, affected files, problem statement, suggested fix, and acceptance criteria. It is ordered by risk, not by file.

---

## How This Audit Was Conducted

1. Read the full skill (`SKILL.md`) and its three reference files:
   - `references/interfaces-and-architecture.md`
   - `references/testing-and-concurrency.md`
   - `references/gomock-mocking.md`
2. Inspected `go.mod`, `.golangci.yml`, `.custom-gcl.yml`, `Makefile`, and all GitHub Actions workflows.
3. Ran `golangci-lint run ./...` (green, 0 issues) and `go vet ./...` (clean).
4. Used read-only subagents to audit:
   - Toolchain / CI / project layout
   - Code anti-patterns (error wrapping, `_ =` discards, globals, deprecated APIs)
   - Interfaces, package boundaries, dependency injection, and mock placement
   - Testing structure, concurrency patterns, and race/leak risks
5. Spot-checked every P0 and most P1 findings against the source files.

> **Note:** `golangci-lint` is green because several relevant checks are disabled or excluded (e.g., `wrapcheck` in controllers, `staticcheck` in rollout controllers, `gocritic.ifElseChain`). Re-enabling those linters after the fixes below is part of the recommended follow-up.

---

## Compliance Snapshot

| Skill requirement | Status | Gap |
|---|---|---|
| `go 1.26.0` in `go.mod` | ✅ | Missing `toolchain go1.26.4` |
| Go 1.24+ `tool` directive for dev tools | ❌ | `mockgen` not tracked as a `tool` |
| `golangci-lint` v2.12+ | ❌ | Using v2.11.4 |
| `modules-download-mode: readonly` | ❌ | Not configured |
| `errcheck.check-blank: true` | ❌ | Not configured |
| `make test-race` / `-race` in CI | ❌ | `make test` omits `-race` |
| `GOTOOLCHAIN=auto` in CI | ❌ | Not exported |
| Testable `run(ctx, args, getenv, stdin, stdout, stderr)` entrypoint | ❌ | `cmd/main.go` uses global `flag.CommandLine` and `os.Exit` directly |
| Consumer-defined interfaces | ❌ | Most interfaces live next to implementations |
| `mockgen -typed` / `_test.go` mocks | ❌ | Mocks live in `mocks/` packages without `-typed` |
| Table-driven tests + `t.Parallel()` | ⚠️ | Some packages still use copy-paste tests and skip `t.Parallel()` |
| No goroutine without a stop path | ❌ | Several leaked goroutines in `cmd/main.go` and `cluster_pool.go` |

---

## Risk Heat Map

| Epic | P0 | P1 | P2 | Primary risk |
|---|---:|---:|---:|---|
| CI / Toolchain | 1 | 5 | 3 | Broken release builds, drift between local and CI |
| Concurrency & Safety | 5 | 4 | 2 | Data races, goroutine leaks, deadlock, runtime panics |
| Error Handling & Observability | 0 | 6 | 3 | Silent failures, poor operator debugging, lint debt |
| Interfaces, Architecture & DI | 0 | 7 | 5 | Brittle abstractions, tight coupling, test pain |
| Testing & Mock Hygiene | 0 | 5 | 6 | Flaky/slow tests, false confidence, resource leaks |

---

## Recommended Sequencing

1. **Sprint 0 — Stop the bleeding (P0 only)**
   - Fix the release workflow Go version.
   - Add `toolchain go1.26.4` and `GOTOOLCHAIN=auto`.
   - Fix `cluster_pool.go` data race and goroutine leak.
   - Fix `engine/workflow.go` deadlock.
   - Initialize `NotificationConfigReconciler.rateLimits` in a constructor.

2. **Sprint 1 — Concurrency & entrypoints**
   - Shut down leaked HTTP servers in `cmd/main.go`.
   - Give `NewClusterConnectionPool` a stop path.
   - Refactor `cmd/main.go`, `cmd/paprika/main.go`, and `cmd/paprika-cli/main.go` to testable `run(...)` entrypoints.
   - Add `make test-race` and run it in CI.

3. **Sprint 2 — Error handling & lint config**
   - Bump `golangci-lint` to v2.12.2, add `modules-download-mode: readonly`, `errcheck.check-blank`.
   - Wrap high-level bare `return err` paths.
   - Fix error-string capitalization and `%w` ordering.
   - Clean up `_ =` error discards in production code.

4. **Sprint 3 — Architecture & DI**
   - Move consumer-defined interfaces out of producer packages.
   - Change constructors to return concrete structs.
   - Split kitchen-sink interfaces.
   - Replace package globals (`timeNow`, observability globals) with injected dependencies.

5. **Sprint 4 — Testing & mocks**
   - Regenerate mocks with `-typed` and move test-only mocks into `*_test.go`.
   - Convert copy-paste tests to table-driven tests.
   - Add `t.Parallel()` where safe.
   - Inject clocks in `ratelimit`, `cache`, and `metrics`.

---

## Detailed Backlog

### Epic 1 — CI / Toolchain

#### GBP-001 Release workflow uses Go 1.24 while `go.mod` requires 1.26
- **Severity:** P0
- **Effort:** S
- **Files:** `.github/workflows/release.yml:25`
- **Problem:** The release job pins `go-version: "1.24"`, which is older than `go 1.26.0` in `go.mod`. This will fail releases once the toolchain check triggers.
- **Fix:** Use `go-version-file: go.mod` (consistent with `test.yml` and `lint.yml`).
- **Acceptance:** Release workflow uses the same Go minor as `go.mod`.

#### GBP-002 Missing `toolchain` directive in `go.mod`
- **Severity:** P1
- **Effort:** S
- **Files:** `go.mod:3`
- **Problem:** Only `go 1.26.0` is declared; the skill recommends an explicit `toolchain go1.26.4`.
- **Fix:** Add `toolchain go1.26.4` after the `go` directive.
- **Acceptance:** `go env GOTOOLCHAIN` resolves to `go1.26.4` on a clean clone.

#### GBP-003 Dev tools not tracked via the Go `tool` directive
- **Severity:** P1
- **Effort:** S
- **Files:** `go.mod`
- **Problem:** `go.uber.org/mock` is a runtime dependency solely because `mockgen` is needed at generation time. There is no `tools.go` or `tool` directive.
- **Fix:** Run `go get -tool go.uber.org/mock/mockgen@v0.6.0` (or latest) and document `go tool mockgen` usage.
- **Acceptance:** `go tool mockgen` works without a global install; `go.mod` contains a `tool` line.

#### GBP-004 `golangci-lint` version below skill floor
- **Severity:** P1
- **Effort:** S
- **Files:** `Makefile:247`, `.custom-gcl.yml:6`
- **Problem:** Both pin `v2.11.4`; the skill floor is `v2.12`.
- **Fix:** Bump `GOLANGCI_LINT_VERSION` and `.custom-gcl.yml` to `v2.12.2` (or newer).
- **Acceptance:** `make lint` runs v2.12+ and remains green.

#### GBP-005 `.golangci.yml` missing recommended `run` and `errcheck` settings
- **Severity:** P1
- **Effort:** S
- **Files:** `.golangci.yml`
- **Problem:** Missing `run.modules-download-mode: readonly` and `linters-settings.errcheck.check-blank: true`.
- **Fix:** Add both settings.
- **Acceptance:** `golangci-lint config verify` passes and `_ = fn()` patterns in non-test code are flagged.

#### GBP-006 Race detector is not the default CI invocation
- **Severity:** P1
- **Effort:** M
- **Files:** `Makefile:73-75`, `.github/workflows/test.yml:27-29`
- **Problem:** `make test` runs `go test` without `-race`. The skill expects `go test -race ./...` as the default CI command.
- **Fix:** Add a `test-race` target and switch CI to use it (or add `GOFLAGS=-race` to the existing target). Keep envtest filtering logic.
- **Acceptance:** CI runs every unit test with the race detector and fails on data races.

#### GBP-007 CI does not export `GOTOOLCHAIN=auto`
- **Severity:** P1
- **Effort:** S
- **Files:** `.github/workflows/test.yml`, `.github/workflows/lint.yml`, `.github/workflows/release.yml`, `.github/workflows/test-e2e.yml`
- **Problem:** Official `golang` Docker images bake in `GOTOOLCHAIN=local`. If `go.mod` is bumped ahead of the CI image pin, builds fail cryptically.
- **Fix:** Export `GOTOOLCHAIN=auto` in all Go-related steps.
- **Acceptance:** A toolchain bump ahead of the image pin still succeeds (with a one-time download).

#### GBP-008 No CI gate for `gofmt -l .`
- **Severity:** P2
- **Effort:** S
- **Files:** `.github/workflows/lint.yml`
- **Problem:** `make fmt` exists but CI does not fail on unformatted code.
- **Fix:** Add a step that fails if `gofmt -l .` produces output.
- **Acceptance:** CI fails on unformatted Go files.

#### GBP-009 No pre-commit hook for lint / format
- **Severity:** P2
- **Effort:** S
- **Files:** repo root
- **Problem:** The skill recommends a `.githooks/pre-commit` hook running `golangci-lint` on staged `.go` files.
- **Fix:** Add `.githooks/pre-commit` and document `git config core.hooksPath .githooks` in `CONTRIBUTING.md`.
- **Acceptance:** A commit with lint errors is blocked locally.

#### GBP-010 Missing `.editorconfig`
- **Severity:** P2
- **Effort:** XS
- **Files:** repo root
- **Problem:** No editor-agnostic formatting defaults.
- **Fix:** Add a root `.editorconfig` (tab-width 4 for Go, 2-space YAML, trim trailing whitespace).
- **Acceptance:** File exists and is respected by editors.

---

### Epic 2 — Concurrency & Safety

#### GBP-011 `ClusterConnectionPool.isValid` mutates state under `RLock`
- **Severity:** P0
- **Effort:** M
- **Files:** `internal/controller/pipelines/cluster_pool.go:211-227`, callers at `:79`, `:104`, `:121`
- **Problem:** `isValid` resets `pc.circuitOpen` and `pc.failures` while callers hold only an `RLock`. This is a data race.
- **Fix:** Make `isValid` read-only. Move circuit-breaker reset into the write path (`createAndCacheClient`, `getDefaultClient`, or `runHealthChecks`) under a full `Lock`.
- **Acceptance:** `go test -race ./internal/controller/pipelines/...` reports no race from `cluster_pool.go`.

#### GBP-012 `ClusterConnectionPool` goroutine has no stop path
- **Severity:** P0
- **Effort:** M
- **Files:** `internal/controller/pipelines/cluster_pool.go:52-61`, `:229-237`
- **Problem:** `NewClusterConnectionPool` starts `healthCheckLoop` in a goroutine that loops forever. The goroutine leaks in every test that creates a pool and cannot be shut down on manager stop.
- **Fix:** Accept a `context.Context` and stop the ticker on `ctx.Done()`, or register the pool as a `manager.Runnable` whose `Start` receives a context.
- **Acceptance:** Pool shutdown cancels the health-check loop; leak detector / race tests pass.

#### GBP-013 `ClusterConnectionPool.runHealthChecks` holds the write lock during I/O
- **Severity:** P1
- **Effort:** M
- **Files:** `internal/controller/pipelines/cluster_pool.go:239-279`
- **Problem:** The exclusive lock is held while calling `dynamic.NewForConfig` and `List`, blocking all `GetClient`/`GetRestConfig` callers for the duration of every health probe.
- **Fix:** Snapshot the clients under `RLock`, perform probes outside the lock, then acquire the write lock only to update `healthy`/`failures`/`circuitOpen`.
- **Acceptance:** Health checks no longer block client lookups.

#### GBP-014 Workflow `executeSubBatch` can deadlock on a full `errCh`
- **Severity:** P0
- **Effort:** M
- **Files:** `engine/workflow.go:188-208`, `:210-253`, `:255-269`
- **Problem:** `errCh` is buffered to `len(batch)`, but each step goroutine can send multiple errors (create failure, retries, final failure). Because `wg.Wait()` runs before draining, goroutines can block on a full channel forever.
- **Fix:** Replace the hand-rolled `WaitGroup` + channel with `golang.org/x/sync/errgroup.WithContext(ctx)`, or drain errors concurrently and make sends `select { case errCh <- err: case <-ctx.Done(): }`.
- **Acceptance:** A step that fails and retries does not deadlock; `go test -race ./engine/...` passes.

#### GBP-015 `NotificationConfigReconciler` map field is not initialized in the constructor
- **Severity:** P0
- **Effort:** S
- **Files:** `internal/controller/pipelines/notification_controller.go:47-54`, `:209-229`
- **Problem:** `rateLimits map[rateLimitKey]time.Time` is only initialized inside `Start`. If the reconciler is ever constructed and used without calling `Start`, `rateLimitAllowed` panics on a nil-map write. Tests currently paper over this by initializing manually.
- **Fix:** Add a constructor `NewNotificationConfigReconciler(...)` that initializes `rateLimits`, `Sender`, and `Emailer`, and use it from `cmd/main.go`.
- **Acceptance:** No nil-map panic if `rateLimitAllowed` is called before `Start`; all tests use the constructor.

#### GBP-016 Inline HTTP servers in `cmd/main.go` leak goroutines and ports
- **Severity:** P1
- **Effort:** M
- **Files:** `cmd/main.go:369-385` (`startInlineWebhook`), `:713-745` (`startOperatorUI`), `:914-926` (`startHealthProbeServer`)
- **Problem:** Servers are started in goroutines with no shutdown path; they outlive the manager context.
- **Fix:** Return `*http.Server` from each helper and shut it down on context cancellation (e.g., via `mgr.Add(&serverRunnable{srv})` or a `defer` in `dispatchMode`).
- **Acceptance:** Manager shutdown closes all three servers cleanly.

#### GBP-017 `events.Broker` goroutine and lock issues
- **Severity:** P1
- **Effort:** M
- **Files:** `internal/api/events/broker.go:43` (`receiveLoop`), `:79-91` (`Subscribe`), `:118-130` (`publishLocal`)
- **Problem:**
  - `NewRedisBroker` starts `receiveLoop` with no stop path.
  - `Subscribe` holds `mu.Lock` while calling `pubsub.Subscribe` (Redis network I/O).
  - `publishLocal` silently drops events when a subscriber channel is full.
- **Fix:**
  - Accept a context and stop `receiveLoop` on `ctx.Done()`.
  - Subscribe to Redis outside the lock, then update the in-memory map under the lock.
  - Document the drop policy or use a brief blocking send with `ctx.Done()`.
- **Acceptance:** Broker shuts down cleanly; `Subscribe` does not serialize publishers behind a lock.

#### GBP-018 `retryStep` / `watchJob` lack cancellation and use a hard-coded 24h timeout
- **Severity:** P1
- **Effort:** M
- **Files:** `engine/workflow.go:255-269`, `:276-302`
- **Problem:** `retryStep` does not accept a `context.Context`; `watchJob` uses `time.After(24 * time.Hour)` instead of deriving the deadline from the caller's context or the Job's `ActiveDeadlineSeconds`.
- **Fix:** Thread `ctx` through `retryStep`; replace `time.After(24 * time.Hour)` with a context deadline or the job's own deadline.
- **Acceptance:** Pipeline reconciliation cancels promptly when its context is cancelled.

#### GBP-019 Workflow job names can collide
- **Severity:** P2
- **Effort:** S
- **Files:** `engine/workflow.go:329` (approx.)
- **Problem:** Job names are based on `time.Now().UnixMilli()`; two steps created in the same millisecond can collide.
- **Fix:** Use `time.Now().UnixNano()` or a UUID for the suffix.
- **Acceptance:** No collision under rapid creation.

---

### Epic 3 — Error Handling & Observability

#### GBP-020 High-level orchestration paths return bare `err`
- **Severity:** P0
- **Effort:** M
- **Files:** `cmd/main.go:294, 297, 660, 697, 700, 752, 757, 805`; `internal/api/apply_bundle.go:389, 393, 409, 424, 439`; `internal/controller/pipelines/release_controller.go:628, 649, 654, 665, 679, 1275, 1306`; `internal/controller/pipelines/application_controller.go:637, 1364, 1373`; `traffic/istio/istio.go:46, 87, 127, 153, 176, 196`; `traffic/gatewayapi/gatewayapi.go:63`
- **Problem:** Errors lose context before reaching the operator / CLI user, making incident debugging hard.
- **Fix:** Wrap each with `fmt.Errorf("<operation>: %w", err)`. `%w` must be at the end.
- **Acceptance:** No bare `return err` in the listed high-level functions.

#### GBP-021 Additional bare `return err` in mid-level code
- **Severity:** P1
- **Effort:** M
- **Files:** `internal/api/auth/middleware.go:33, 91`; `cmd/paprika/apply.go:89`; `engine/workflow.go:77, 98`; `source/resolver.go:46`; `internal/api/apply_bundle.go:197`
- **Problem:** Same as GBP-020, but in smaller functions.
- **Fix:** Wrap each error with the operation name.
- **Acceptance:** `golangci-lint` with `wrapcheck` enabled on these paths is green.

#### GBP-022 Error strings start with capital letters or end with punctuation
- **Severity:** P1
- **Effort:** S
- **Files:** `traffic/istio/istio.go:49, 130`; `traffic/gatewayapi/gatewayapi.go:66`; `internal/api/auth/oidc_auth.go:39, 42`
- **Problem:** Violates Go error-string convention and `revive` / `staticcheck ST1005`.
- **Fix:** Lowercase and remove trailing punctuation.
- **Acceptance:** No capitalized error strings in new code.

#### GBP-023 `%w` is not at the end of formatted errors in auth package
- **Severity:** P2
- **Effort:** S
- **Files:** `internal/api/auth/authz.go:92`; `internal/api/auth/authenticator.go:42`; `internal/api/auth/basic_auth.go:56, 67, 71`; `internal/api/auth/oidc_auth.go:82, 93, 102`
- **Problem:** Sentinel errors are placed first, producing least-specific-cause-last output.
- **Fix:** Reorder to `context: %w` form.
- **Acceptance:** All `%w` verbs appear at the end of the format string.

#### GBP-024 `_ =` error discards in production code
- **Severity:** P1
- **Effort:** M
- **Files:** `cmd/cloud-run/main.go:253`; `cmd/main.go:911`; `internal/reposerver/server.go:104, 134`; `internal/webhook/receiver/handler.go:101, 109`; `engine/template.go:168`; `internal/agent/server/server.go:204-205`
- **Problem:** Silent failures from `w.Write`, `fmt.Fprintln`, and file writes.
- **Fix:** Either return/log the error or use `defer func() { _ = resp.Body.Close() }()` with a documented ignore.
- **Acceptance:** No unchecked `_ =` for I/O or HTTP writes in production code.

#### GBP-025 Silently ignored parse / type-assertion errors
- **Severity:** P1
- **Effort:** S
- **Files:** `cmd/paprika-cli/template.go:44` (`sourceType, _ = raw["type"].(string)`); `internal/api/events/broker.go:63` (`db, _ := strconv.Atoi(os.Getenv(...))`)
- **Problem:** Invalid input is ignored, leading to wrong defaults or hidden misconfigurations.
- **Fix:** Check the `ok` value and return an explicit error.
- **Acceptance:** Invalid template types and `PAPRIKA_REDIS_DB` values surface errors.

#### GBP-026 Package-level mutable state in observability
- **Severity:** P0
- **Effort:** M
- **Files:** `internal/observability/observability.go:31-35`
- **Problem:** `tracer`, `provider`, and `enabled` are package globals mutated by `InitTracing`.
- **Fix:** Return a `Telemetry` struct (or `Tracer` + `Shutdown` func) from `InitTracing` and inject it into servers/controllers. Keep `StartSpan` as a method.
- **Acceptance:** No package-level mutable state; tests can create independent telemetry instances.

#### GBP-027 Package-level mutable `timeNow` in webhook receiver
- **Severity:** P0
- **Effort:** S
- **Files:** `internal/webhook/receiver/handler.go:316`, `:313`
- **Problem:** `var timeNow = time.Now` is global mutable state swapped in tests.
- **Fix:** Inject a `func() time.Time` or `Clock` interface through `NewHandler`.
- **Acceptance:** Tests inject the clock; production uses `time.Now` via the constructor default.

#### GBP-028 `cmd/cloud-run/main.go` global health mux and `init()`
- **Severity:** P2
- **Effort:** S
- **Files:** `cmd/cloud-run/main.go:49, 232`
- **Problem:** A package-level `var muxHealth = http.NewServeMux()` is initialized in `init()`.
- **Fix:** Create the mux lazily inside `startHealthProbe` or return it from a constructor.
- **Acceptance:** No mutable globals or non-scheme `init()` functions in `cmd/cloud-run/main.go`.

#### GBP-029 `context.Context` shadowed by `ctx, cancel := context.WithTimeout`
- **Severity:** P2
- **Effort:** XS
- **Files:** `internal/api/auth/oidc_auth.go:97`
- **Problem:** The skill prefers `=` reassignment to avoid shadowing the parameter.
- **Fix:** Use `ctx, cancel = context.WithTimeout(ctx, 10*time.Second)` after declaring `cancel`.
- **Acceptance:** `go vet` / shadow analyzer reports no shadow.

#### GBP-030 Deprecated APIs suppressed with `//nolint:staticcheck`
- **Severity:** P1
- **Effort:** M
- **Files:** `cmd/main.go:471, 493, 537, 571` (`mgr.GetEventRecorderFor`); `internal/controller/pipelines/application_controller.go:483`; `internal/webhook/pipelines/v1alpha1/application_webhook.go:122` (`app.Spec.Source.Image`)
- **Problem:** SA1019 usages are permanently suppressed rather than migrated.
- **Fix:** Migrate to `mgr.GetEventRecorder` and `app.Spec.Source.OCI.URL`; remove the `nolint` comments.
- **Acceptance:** No `SA1019` suppressions remain.

#### GBP-031 `os.Getenv` scattered deep in constructors
- **Severity:** P2
- **Effort:** M
- **Files:** `internal/cache/factory.go:29-31`; `internal/api/events/broker.go:52, 59, 63, 66`; `internal/reposerver/client/client.go:41`; `internal/observability/observability.go:39, 44, 140, 177`; `internal/sharding/sharding.go:28, 38, 119, 121, 123`; `cmd/main.go:942, 975, 1021`; `cmd/cloud-run/main.go:67, 71, 202`
- **Problem:** Configuration is read throughout the call tree, making tests environment-dependent and behavior hard to trace.
- **Fix:** Read all env vars in `main`/`registerFlags` and pass explicit `Config` structs. Keep `NewFromEnv` as a thin wrapper only where necessary.
- **Acceptance:** No `os.Getenv` inside library constructors (only in `main` or `*_test.go`).

---

### Epic 4 — Interfaces, Architecture & DI

#### GBP-032 Producer-side interfaces in `engine`, `source`, `analysis`, `health`, `policy`, `gates`, `internal/governance`, `internal/syncwindow`
- **Severity:** P0
- **Effort:** L
- **Files:** `engine/interfaces.go`; `source/interfaces.go`; `analysis/interfaces.go`; `health/interfaces.go`; `policy/interfaces.go`; `gates/interfaces.go`; `internal/governance/cluster_resolver.go`; `internal/syncwindow/evaluator.go`
- **Problem:** Interfaces are defined next to their only implementation, forcing consumers to import the producer package just for the interface. This is the Java-style anti-pattern the skill calls out as the highest-leverage design mistake.
- **Fix:** Move each interface to the package that **consumes** it (controllers / `internal/api`). Have the producer export concrete structs. Adapters satisfy interfaces implicitly.
- **Acceptance:** No interface in a producer package that is only consumed elsewhere.

#### GBP-033 Constructors return interfaces instead of concrete structs
- **Severity:** P0
- **Effort:** M
- **Files:** `policy/evaluator.go:22`; `internal/governance/cluster_resolver.go:19`; `internal/syncwindow/evaluator.go:26`; `internal/cache/factory.go:23, 44`
- **Problem:** Returning interfaces prevents callers from using new methods and hides the concrete type.
- **Fix:** Return `*evaluator`, `*clusterResolver`, `*MemoryCache`, `*RedisCache`. Callers can still store them through the interface if needed.
- **Acceptance:** Constructors listed above return structs.

#### GBP-034 Kitchen-sink interfaces
- **Severity:** P1
- **Effort:** M
- **Files:** `traffic/traffic.go:21` (`Router`, 7 methods); `internal/featureflag/provider.go:5` (`Provider`, 5 methods); `internal/cache/interfaces.go:12` (`Cache`, 5 methods); `engine/interfaces.go:20` (`TemplateRenderer`, 4 methods)
- **Problem:** Large interfaces weaken abstraction and force implementers to stub unused methods.
- **Fix:** Split into role interfaces (`WeightRouter`, `HeaderRouter`, `MirrorRouter`, `Getter`, `Setter`, `Renderer`, `Resolver`) and compose only the combinations callers need.
- **Acceptance:** No interface >3 methods unless it is a genuine stdlib-style composition (`io.ReadWriter`).

#### GBP-035 Speculative / single-implementation abstractions
- **Severity:** P2
- **Effort:** M
- **Files:** `analysis/interfaces.go:13`; `health/interfaces.go:14, 20`; `policy/interfaces.go:34`; `engine/interfaces.go:41`; `source/interfaces.go:6-8`; `gates/gates.go:19`
- **Problem:** Interfaces exist with no second implementation, mainly to support mocks. The skill says interfaces earn their place at the second implementation or a real seam.
- **Fix:** Either introduce a second implementation, move the interface to the consumer, or delete it and test the real code.
- **Acceptance:** Every exported interface has ≥2 implementations or a documented seam.

#### GBP-036 Struct embedding leaks `client.Client` API through exported types
- **Severity:** P1
- **Effort:** M
- **Files:** `internal/api/server.go:32-40`; `internal/controller/pipelines/cluster.go:17-20`; `internal/controller/pipelines/cluster_pool.go:43-47`; `internal/controller/pipelines/notification_controller.go:47-48`; `internal/controller/pipelines/application_controller.go:73`; `internal/controller/pipelines/release_controller.go:87`; `internal/controller/pipelines/pipeline_controller.go:30`; `internal/controller/rollouts/rollout_controller.go:58`; plus other reconcilers
- **Problem:** Embedding promotes the full controller-runtime client API on exported types, leaking implementation details and making future evolution harder.
- **Fix:** Replace embedding with an unexported `client client.Client` field and delegate only the methods you intend to expose. For Kubebuilder reconcilers, the standard pattern is an unexported field.
- **Acceptance:** No exported struct embeds `client.Client`.

#### GBP-037 Side effects in constructors
- **Severity:** P2
- **Effort:** M
- **Files:** `internal/controller/pipelines/cluster_pool.go:59` (starts goroutine); `internal/api/events/broker.go:43` (starts goroutine); `analysis/analysis.go:37-50` (builds `*http.Client` with `InsecureSkipVerify`); `gates/gates.go:36-40` (builds `*http.Client`); `internal/agent/client/client.go:26-31` (builds `*http.Client`)
- **Problem:** Constructors should not start goroutines or build hidden HTTP clients with insecure settings.
- **Fix:**
  - Provide `Start(ctx)` or register as a `manager.Runnable`.
  - Accept `*http.Client` as a parameter; default to `http.DefaultClient` only in a `NewFromEnv` wrapper.
- **Acceptance:** Constructors are pure; lifecycle methods handle goroutines.

#### GBP-038 Package naming smells
- **Severity:** P1
- **Effort:** M
- **Files:** `internal/api/server.go:1` (package `api`); `internal/controller/pipelines/cluster.go:1`, `cluster_pool.go:1` (package `controller` despite path `pipelines`); `internal/reposerver/client/client.go:1`; `internal/agent/client/client.go:1`
- **Problem:** `api` and `controller` are generic grab-bag names; two different packages are both named `client`.
- **Fix:** Rename `internal/api` package to `apiserver`; rename `internal/controller/pipelines` files to `package pipelines`; rename `internal/reposerver/client` to `reposerverclient` and `internal/agent/client` to `agentclient`.
- **Acceptance:** Package names describe the domain and do not collide with controller-runtime imports.

#### GBP-039 Setter injection makes dependencies optional
- **Severity:** P2
- **Effort:** M
- **Files:** `internal/api/server.go:62-69` (`SetRenderer`, `SetAuthorizer`, `SetPolicyEvaluator`, etc.)
- **Problem:** Setters imply optional dependencies and allow partially initialized objects.
- **Fix:** Inject dependencies through `NewPaprikaServer` (or functional options with defaults) and remove the setters.
- **Acceptance:** Server construction requires all dependencies explicitly.

#### GBP-040 `if-else` chain that should be a `switch`
- **Severity:** P2
- **Effort:** XS
- **Files:** `engine/scalable_diff.go:87-108`
- **Problem:** `gocritic.ifElseChain` is disabled in `.golangci.yml`; the code is clearer as a `switch`.
- **Fix:** Refactor to `switch { case !exists: ...; case resourceEqual(...): ...; default: ... }` and consider re-enabling `ifElseChain`.
- **Acceptance:** Chain is converted; linter option is re-evaluated.

---

### Epic 5 — Testing & Mock Hygiene

#### GBP-041 Regenerate mocks with `-typed` and move test-only mocks into `*_test.go`
- **Severity:** P1
- **Effort:** M
- **Files:** `engine/mocks/*`, `internal/controller/pipelines/mocks/*`, `health/mocks/*`, `source/mocks/*`, `analysis/mocks/*`, `gates/mocks/*`, `traffic/mocks/*`, `internal/cache/mocks/*`; all `//go:generate mockgen` directives
- **Problem:** Mocks are not generated with `-typed`, so `Return`/`DoAndReturn` take `any` and fail at runtime. They also live in non-test `mocks` packages, leaking into the module surface.
- **Fix:** Add `-typed` to every directive. Generate mocks next to the source as `mock_<file>_test.go` where possible; keep shared mocks in `internal/<domain>/mocks` if they are reused.
- **Acceptance:** All mocks compile with type-safe recorders; no mock package is imported by production code.

#### GBP-042 Remove redundant `defer ctrl.Finish()`
- **Severity:** P2
- **Effort:** XS
- **Files:** `engine/engine_gomock_test.go`; `engine/cached_renderer_test.go`; `health/cel_gomock_test.go`; `internal/controller/pipelines/pipeline_controller_unit_test.go`; `internal/controller/pipelines/release_controller_unit_test.go`
- **Problem:** `gomock.NewController(t)` already registers `t.Cleanup` to call `Finish`.
- **Fix:** Delete the explicit `defer ctrl.Finish()` lines.
- **Acceptance:** No redundant `Finish()` in test files.

#### GBP-043 Delete or replace mock-only / placeholder tests
- **Severity:** P1
- **Effort:** M
- **Files:** `engine/engine_gomock_test.go`; `health/cel_gomock_test.go`; `internal/controller/pipelines/pipeline_controller_unit_test.go:12-58, 60-97`
- **Problem:** These tests only exercise generated mocks or contain empty subtests; they provide no behavioral coverage.
- **Fix:** Replace with tests of the real implementation or meaningful fakes; delete placeholder tests.
- **Acceptance:** No test file exists solely to exercise mocks.

#### GBP-044 Convert copy-paste tests to table-driven tests
- **Severity:** P1
- **Effort:** M
- **Files:** `engine/workflow_test.go` (`TestLinearDAG`, `TestFanOutDAG`, `TestNoDepsDAG`, `TestCycleDetection`, `TestMissingDependency`, `TestDiamondDAG`); `gates/gates_test.go`; `internal/controller/pipelines/self_heal_test.go`; `policy/evaluator_test.go`; `cmd/paprika/apply_test.go`; `cmd/paprika/watch_test.go`
- **Problem:** Multiple near-identical functions are harder to extend and review than a single table-driven test.
- **Fix:** Collapse into one test with a `[]struct{...}` table and `t.Run` subtests.
- **Acceptance:** Each listed package has a single table-driven test per behavior area.

#### GBP-045 Add `t.Parallel()` to safe table-driven tests
- **Severity:** P2
- **Effort:** S
- **Files:** `engine/template_test.go`; `source/resolver_test.go`; `health/cel_test.go`; `internal/controller/pipelines/sync_options_test.go`; `internal/controller/pipelines/sync_window_test.go`; `internal/syncwindow/evaluator_test.go`; `cmd/paprika/apply_test.go`; `cmd/paprika/watch_test.go`; `internal/controller/pipelines/release_controller_unit_test.go`
- **Problem:** Tests do not take advantage of Go 1.22 per-iteration loop scope.
- **Fix:** Add `t.Parallel()` to the outer test and each subtest after confirming they do not share mutable state.
- **Acceptance:** `go test -count=1` runtime improves; no race failures.

#### GBP-046 Use `t.TempDir()` and `t.Setenv()` instead of manual cleanup
- **Severity:** P2
- **Effort:** S
- **Files:** `internal/controller/pipelines/applicationset_controller_test.go:155-159`; `cmd/paprika/apply_test.go:292-301`; `test/e2e/e2e_suite_test.go:123`; `internal/controller/pipelines/suite_test.go:62`; `engine/cached_renderer_test.go:26, 65`
- **Problem:** Manual `os.MkdirTemp` + `defer os.RemoveAll`, manual env save/restore, and hard-coded `/tmp/test` are brittle and leak between tests.
- **Fix:** Use `t.TempDir()`, `t.Setenv()`, and `t.Cleanup()`.
- **Acceptance:** No manual temp-dir or env cleanup in tests.

#### GBP-047 Stop leaking real servers in tests
- **Severity:** P1
- **Effort:** M
- **Files:** `cmd/main_test.go:14-61, 83-95`; `internal/api/sse_test.go:24-30`
- **Problem:** Tests start real HTTP servers in goroutines and never shut them down; `sse_test.go` also calls `require.NoError` inside a non-test goroutine.
- **Fix:** Use `httptest.Server` where possible, or capture `*http.Server` and call `Shutdown` in `t.Cleanup`. Move assertions out of helper goroutines.
- **Acceptance:** Tests run without port/goroutine leaks.

#### GBP-048 Handle errors in `httptest` handlers
- **Severity:** P2
- **Effort:** XS
- **Files:** `internal/controller/pipelines/notification_controller_test.go:115`
- **Problem:** `io.ReadAll(r.Body)` error is ignored.
- **Fix:** Check the error and use `require.NoError(t, err)` or `http.Error`.
- **Acceptance:** No ignored handler errors in tests.

#### GBP-049 Inject clocks to remove real time from unit tests
- **Severity:** P2
- **Effort:** M
- **Files:** `internal/ratelimit/ratelimit.go:29, 79`; `internal/cache/memory.go:37, 50`; `metrics/metrics.go:155, 160`
- **Problem:** Tests must sleep to observe TTL refill / expiry behavior.
- **Fix:** Inject a `Clock` interface (`Now() time.Time`) with real and fake implementations.
- **Acceptance:** TTL/rate-limit tests run deterministically without `time.Sleep`.

#### GBP-050 Add `go generate ./...` to `make generate`
- **Severity:** P1
- **Effort:** S
- **Files:** `Makefile:61-63`
- **Problem:** `make generate` regenerates controller-gen and protobuf output but does not refresh gomock mocks.
- **Fix:** Add `go generate ./...` to the `generate` target (or add a separate `generate-mocks` target).
- **Acceptance:** `make generate` updates mocks.

---

## Quick Wins (can be done in one PR each)

1. **GBP-001** — Release workflow Go version (P0, 5 min).
2. **GBP-002** — Add `toolchain go1.26.4` (P1, 5 min).
3. **GBP-005** — Add `.golangci.yml` `modules-download-mode` and `errcheck.check-blank` (P1, 10 min).
4. **GBP-027** — Inject clock in webhook receiver (P0, 30 min).
5. **GBP-042** — Remove redundant `defer ctrl.Finish()` (P2, 15 min).
6. **GBP-046** — Replace manual temp dirs with `t.TempDir()` (P2, 30 min).
7. **GBP-040** — Convert `scalable_diff.go` if-else chain to switch (P2, 15 min).
8. **GBP-022** — Lowercase error strings in traffic/auth packages (P1, 20 min).

---

## Notable Positives

- Go version is current (`go 1.26.0`) and the module uses modern dependencies.
- Project layout follows domain-driven packages under `internal/`: `agent`, `cache`, `controller`, `featureflag`, `governance`, `observability`, `ratelimit`, `repository`, `rollout`, etc.
- No `util`, `common`, `helpers`, `misc`, or `models` grab-bag packages were found.
- Mock framework is the live fork `go.uber.org/mock v0.6.0`, not the archived Google version.
- `//go:generate mockgen` directives are placed next to the interfaces they mock.
- `golangci-lint` v2 config is in place and currently green.
- Uses `metav1.Condition` and standard Kubernetes API conventions (per `AGENTS.md`).

---

## Appendix — Verification Commands to Run After Each Sprint

```bash
# Toolchain / CI
go version                         # should report 1.26.x
gofmt -l .                         # should be empty
go vet ./...                       # should be clean
golangci-lint run ./...            # should be clean
golangci-lint config verify        # should pass

# Concurrency
go test -race ./internal/controller/pipelines/... -run ClusterPool
go test -race ./engine/... -run Workflow
go test -race ./...                # default CI target after fixes

# Architecture (manual)
grep -R "type .* interface" --include="*.go" api/ engine/ source/ analysis/ health/ policy/ gates/ internal/governance/ internal/syncwindow/
grep -R "func New.*(.*) .*interface" --include="*.go" .
grep -R "client.Client" --include="*.go" internal/controller/ internal/api/ | grep -v "unexported"
```
