# Paprika — Go backend conventions, lint rules, build/test contract

Scope: everything an implementer must obey when adding new proto messages, RPCs, handlers and
supporting Go packages to the control plane.

Repo root: `/Users/benebsworth/projects/paprika`
Module: `github.com/benebsworth/paprika` — `go 1.26.0`, `toolchain go1.26.4` (`go.mod:1-4`)

---

## 1. AGENTS.md — every binding rule

File: `/Users/benebsworth/projects/paprika/AGENTS.md` (312 lines). Summary of every rule that binds
Go work:

### Constraints & preferences (AGENTS.md:8-19)
- **New metrics must use the OTel SDK with the Prometheus exporter**, NOT the direct Prometheus
  client. Existing metrics in `internal/metrics/metrics.go` use the raw Prometheus client; both are
  registered on controller-runtime's `metrics.Registry` and served at `/metrics`.
  New instruments go in `internal/metrics/otel.go`.
- Images push to `ghcr.io/paprikacd/paprika`; local iteration falls back to `ttl.sh/paprika-amd64:<tag>`.
- **Images must be `linux/amd64`** (VKE nodes are x86_64; build host is arm64 → QEMU).
- No ARM VKE.

### Safe Kubernetes operations (AGENTS.md:21-37)
- Confirm `kubectl config current-context` before every cluster mutation.
- Use the VKE context only for VKE; never `kind-deephost` for paprika work.
- **Prefer `Taskfile.yml` tasks and `Makefile` targets over ad-hoc commands.**
- Render Helm changes (`helm template`) before applying.
- After any write, re-read the object + status (writes race with controllers).
- **Never commit** kubeconfigs, Cloudflare/registry credentials, bearer tokens, or rendered
  manifests containing secrets.
- Never use destructive Git commands on another contributor's work.
- Never fix a ClusterRole escalation error with an unrelated cluster-admin binding — extend the
  chart-managed manager role with the exact permissions, render/lint, upgrade, `kubectl auth can-i`.

### Required verification (AGENTS.md:39-95) — MANDATORY for Go changes
```sh
go build ./...
go test ./internal/engine ./internal/controller/pipelines -count=1
go vet ./internal/... ./cmd/...
```
For chart / CRD / controller changes additionally:
```sh
helm lint charts/chart/
helm template paprika charts/chart/
go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.1 \
  crd:allowDangerousTypes=true paths=./api/... \
  output:crd:artifacts:config=config/crd/bases
# then copy CRDs into charts/chart/templates/crd/ (loop given at AGENTS.md:58-61)
```
For image changes: build an **immutable tag**, push, update only the intended Deployment, wait for
rollout, verify the live endpoint. Fast path `make docker-build-fast IMG=...` (~1s cached);
full path `make docker-build` + `make docker-push` (~20 min, includes UI).
Production deploys use `helm upgrade` (so `helm rollback` works), not `kubectl set image`.

### Architecture invariants (AGENTS.md:97-121) — do not break
- `Application`, `Release`, `Stage`, `Template` CRs are the **system of record**. The Application
  controller watches source, creates Releases, evaluates health/drift. The Release controller
  applies manifests and manages promotion.
- `ScalableDiffEngine` compares desired vs live using label selectors
  `app.paprika.io/managed-by=paprika`, `app.paprika.io/name=<app>`, with **apiVersion-qualified
  resource keys** (Knative Service vs core Service must not collide).
- GVR resolution is three-tier: static `knownGVRs` → discovery API with caching → pluralization
  fallback. Resolver is `CachedGVRResolver` in `internal/engine/gvr_resolver.go`.
- Prune is **opt-in** via `SyncOptions.Prune` (default false). `pruneStaleResources` deletes live
  resources that are paprika-labelled, ownerless, and absent from desired. `paprika.io/prune: "false"`
  is never pruned. Only namespaced by default; ClusterRole/ClusterRoleBinding via
  `SyncOptions.PruneClusterScopedKinds`.
- The release controller sets `app.paprika.io/release` on every applied resource so
  `cleanupManagedResources` can find them.
- Failure conditions (`Degraded`, `RolledBack`, `Pending`, `ReleaseRetriesExhausted`) are cleared
  on transition to Healthy.

### Existing key metrics (AGENTS.md:130-140) — naming precedent for new metrics
`paprika_out_of_sync{app,namespace}`, `paprika_prunable{app,namespace}`,
`paprika_prune_total{app,namespace,kind}`, `paprika_application_phase_total{application,namespace,phase}`,
`paprika_reconcile_total{controller,result}`. Metrics served at `:8443/metrics` (HTTP,
`--metrics-secure=false`).

### Relevant files map (AGENTS.md:232-257)
`internal/engine/scalable_diff.go`, `internal/engine/diff.go`, `internal/engine/gvr_resolver.go`,
`internal/controller/pipelines/release_controller.go`,
`internal/controller/pipelines/application_controller.go`, `internal/metrics/metrics.go`,
`internal/metrics/otel.go`, `api/pipelines/v1alpha1/application_types.go`, `Dockerfile.fast`,
`Dockerfile`, `docs/guides/{deephost,operations,drift-and-prune,metrics}.md`.

---

## 2. `.golangci.yml` — full config, and what actually bites

File: `/Users/benebsworth/projects/paprika/.golangci.yml` (202 lines). Schema `version: "2"`
(golangci-lint v2). `run.timeout: 5m`, `run.modules-download-mode: readonly`.

### Enabled linters (`linters.default: none`, then `enable:`) — .golangci.yml:5-41
```
bodyclose, contextcheck, cyclop, dogsled, dupl, durationcheck, errcheck, errorlint,
exhaustive, forcetypeassert, funlen, gocognit, gocritic, gocyclo, goprintffuncname,
gosec, govet, ineffassign, mirror, nestif, noctx, nolintlint, perfsprint, prealloc,
reassign, revive, staticcheck, tagalign, tagliatelle, testableexamples, unused,
usestdlibvars, wastedassign, wrapcheck
```

### NOT enabled (verified by grep — do NOT worry about these)
`exhaustruct`, `depguard`, `varnamelen`, `ireturn`, `testifylint`, `paralleltest`, `godot`, `lll`,
`nlreturn`, `wsl`, `containedctx`, `errname`, `forbidigo`, `thelper`, `goconst`, `misspell`,
`unparam`, `nilerr`, `makezero`, `copyloopvar`, `intrange`. `testpackage` appears only inside an
exclusion rule (`.golangci.yml:110-112`) but is not in the enable list — it is inert.

### Settings (verbatim, .golangci.yml:42-92)
```yaml
  settings:
    errcheck:
      check-blank: true            # `_ = f()` is an ERROR
      check-type-assertions: true  # `x := y.(T)` without ok is an ERROR
    govet:
      enable-all: true
      disable:
        - fieldalignment
    gocyclo:
      min-complexity: 20
    cyclop:
      max-complexity: 10           # <-- the strictest thing in the repo
    funlen:
      lines: 100
      statements: 60
    gocognit:
      min-complexity: 30
    nestif:
      min-complexity: 5
    gocritic:
      enabled-tags:
        - performance
        - style
      disabled-checks:
        - wrapperFunc
        - dupImport
        - ifElseChain
        - assignOp
        - octalLiteral
        - importShadow
    revive:
      rules:
        - name: blank-imports
        - name: context-as-argument
        - name: error-return
        - name: error-strings
        - name: error-naming
        - name: if-return
        - name: increment-decrement
        - name: var-naming
        - name: receiver-naming
        - name: unexported-return
        - name: indent-error-flow
        - name: errorf
        - name: superfluous-else
        - name: unreachable-code
        - name: redefines-builtin-id
    errorlint:
      errorf: true
      asserts: true
      comparison: true
```

### Formatters (.golangci.yml:195-202)
```yaml
formatters:
  enable:
    - gofmt
    - goimports
  settings:
    goimports:
      local-prefixes:
        - github.com/benebsworth/paprika
```
→ **Import grouping is: stdlib / third-party / `github.com/benebsworth/paprika/...` last**, matching
what you see in `internal/api/resource_tree_handler_test.go:3-23`.

### Exclusions (.golangci.yml:93-194) — read these carefully
```yaml
  exclusions:
    paths:
      - ui/node_modules
    rules:
      - path: api/v1alpha1/.*        # NOTE: DEAD RULE — real dirs are api/<group>/v1alpha1
        regex: true
        linters: [wrapcheck, gocyclo, cyclop, funlen, gocognit, nestif]
      - path: internal/api/paprika/.*  # generated protobuf/connect code: ALL linters off
        regex: true
        linters: [all]
      - path: test/
        linters: [testpackage, wrapcheck]
      - path: _test\.go
        regex: true
        linters: [wrapcheck, cyclop, funlen, gocognit, gocritic, errcheck, staticcheck]
      - path: _test\.go
        regex: true
        text: dot-imports
        linters: [revive]           # allows Ginkgo/Gomega dot-imports in tests
      - path: internal/rollout/.*            [gocritic, cyclop]
      - path: internal/controller/rollouts/.* [gocognit, cyclop, exhaustive, wrapcheck, staticcheck, gocritic]
      - path: internal/webhook/rollouts/.*    [gocognit, cyclop, gocritic, gocyclo]
      - path: internal/featureflag/.*         [gocritic, nolintlint]
      - path: internal/rollout/canary/canary.go  [gosec]
      - path: internal/controller/pipelines/release_controller.go [cyclop, exhaustive, nolintlint]
      - text: weak cryptographic primitive   linters: [gosec]
      - text: G114                            linters: [gosec]
      - text: type name will be used as       linters: [revive]
```
**Concrete finding:** the first exclusion targets `api/v1alpha1/.*`, but the real API dirs are
`api/pipelines/v1alpha1`, `api/rollouts/v1alpha1`, `api/clusters/v1alpha1`, `api/core/v1alpha1`,
`api/policy/v1alpha1`, `api/featureflags/v1alpha1`. The regex is unanchored but the literal
substring `api/v1alpha1/` never appears, so **that exclusion never fires**. API type files are fully
linted (they pass today via targeted `//nolint` — see `api/*/v1alpha1/groupversion_info.go:36`).

**Crucially:** `internal/api/*.go` (package `apiserver` — where every RPC handler lives) has **no
exclusion**. All strict linters apply to new handler code.

### The strict ones that will actually bite new handler/API code
| Linter | Threshold | What it means for you |
|---|---|---|
| `cyclop` | **max-complexity: 10** | Any handler with >10 branch points fails. Existing handlers use `//nolint:cyclop // <reason>` — e.g. `internal/api/fleet_handler.go:26,80,127` "Keep the complete request validation contract visible at the RPC boundary." 74 `nolint:cyclop` across the repo. Prefer extracting helpers; nolint with a reason is accepted precedent. |
| `wrapcheck` | on | Every error returned from another package must be wrapped: `fmt.Errorf("listing artifacts: %w", err)` (`internal/api/server.go:214`). Lowercase, no trailing punctuation (revive `error-strings`). |
| `funlen` | 100 lines / 60 statements | Long `convert*` functions must be split or nolint'd. |
| `gocognit` | 30 | |
| `gocyclo` | 20 | |
| `nestif` | 5 | Deeply nested `if` chains fail — invert and early-return (revive `indent-error-flow`). |
| `errcheck` `check-blank` | on | `_ = f()` is an error. Must handle or `//nolint:errcheck // reason`. |
| `errcheck` `check-type-assertions` + `forcetypeassert` | on | Always `v, ok := x.(T)`. |
| `exhaustive` | default settings → `default-signifies-exhaustive: false` | **A `switch` on a proto enum must list every enum member**; a `default:` clause is not enough. Precedent: `cmd/paprika/status.go:96` `//nolint:exhaustive // Only these codes have status-specific recovery guidance.` |
| `dupl` | default 150 tokens | Repetitive list/convert handlers trip this. `internal/api/server.go:1` carries a **file-level** `//nolint:dupl // repetitive list filtering patterns`. |
| `prealloc` | on | `out := make([]*paprikav1.X, 0, len(list.Items))` before append loops. |
| `perfsprint` | on | No `fmt.Sprintf("%d", n)` → `strconv.Itoa`; no `fmt.Sprintf("%s", s)`. |
| `contextcheck` / `noctx` | on | Always thread `ctx`; no `http.NewRequest` without ctx. |
| `errorlint` (`errorf`/`asserts`/`comparison`) | on | `errors.Is`/`errors.As`, never `==` on errors, never bare type assertions on errors. |
| `tagliatelle` | on | struct tag case rules (7 `nolint:tagliatelle` in repo for k8s-style tags). |
| `tagalign` | on | struct tags must be aligned. |
| `gosec` | on (50 `nolint:gosec` in repo) | G204/G304/G306 suppressions are **per-call-site**, deliberately not globally disabled (see the long comment at `.golangci.yml:163-183`). |
| `nolintlint` | on, default settings | `allow-unused: false` → an unnecessary `//nolint` is itself an error. Repo style always adds an explanation: `//nolint:<linter> // <reason>`. |
| `revive var-naming` | on | Generated proto Go names like `PreviousActiveRs`, `GatewayApi`, `HttpRoute` come from protoc — do not "fix" them. |

Repo-wide `nolint` tally (excluding `ui/` and generated `internal/api/paprika/`):
`cyclop 74, gosec 50, gocritic 40, errcheck 21, noctx 12, staticcheck 10, nestif 10, dupl 10,
gocyclo 8, tagliatelle 7, gocognit 6, unused 5, funlen 5, exhaustive 3, perfsprint 1, contextcheck 1`.

### `.custom-gcl.yml` (11 lines, verbatim)
```yaml
# This file configures golangci-lint with module plugins.
# When you run 'make lint', it will automatically build a custom golangci-lint binary
# with all the plugins listed below.
#
# See: https://golangci-lint.run/plugins/module-plugins/
version: v2.12.2
plugins:
  # logcheck validates structured logging calls and parameters (e.g., balanced key-value pairs)
  - module: "sigs.k8s.io/logtools"
    import: "sigs.k8s.io/logtools/logcheck/gclplugin"
    version: latest
```
**Note:** `logcheck` is compiled into the custom binary but is **not** listed in
`.golangci.yml linters.enable`, so it is currently inert. Because `.custom-gcl.yml` exists,
`make golangci-lint` builds a custom binary (`Makefile:338-347`) — plain `go install golangci-lint`
is not equivalent.

`.golangci.yml.bak` also exists at repo root (stale, ignore).

---

## 3. Makefile — targets that matter

File: `/Users/benebsworth/projects/paprika/Makefile` (547 lines). `SHELL = /usr/bin/env bash -o pipefail`,
`.SHELLFLAGS = -ec`. `IMG ?= ghcr.io/paprikacd/paprika:latest` (exported).
`CONTROLLER_GEN_PATHS` = `go list -f '{{.Dir}}' ./...` minus `/ui/`, `;`-joined (Makefile:17).

### Generation
| Target | Line | Command |
|---|---|---|
| `manifests` | 59-61 | `controller-gen rbac:roleName=manager-role crd:allowDangerousTypes=true webhook paths="$(CONTROLLER_GEN_PATHS)" output:crd:artifacts:config=config/crd/bases` |
| `generate-proto` | 63-73 | `go tool buf generate` — only if `protoc-gen-go`, `protoc-gen-connect-go` and `ui/node_modules/.bin/protoc-gen-es` are all present; otherwise it **silently keeps the committed generated files** and prints install hints |
| `generate` | 75-78 | `controller-gen object:headerFile="hack/boilerplate.go.txt",year=$(YEAR) paths=...` then `PATH="$(LOCALBIN):$(PATH)" go generate ./...` (runs all `//go:generate mockgen`); depends on `controller-gen generate-proto mockgen` |

### Format / vet / lint
| Target | Line | Command |
|---|---|---|
| `fmt` | 80-82 | `go fmt ./...` |
| `vet` | 84-86 | `go vet ./...` |
| `lint` | 131-133 | `$(LOCALBIN)/golangci-lint run` |
| `lint-fix` | 135-137 | `golangci-lint run --fix` |
| `lint-config` | 139-142 | `golangci-lint config verify` (CI runs this before `lint`) |

### Test
| Target | Line | Command |
|---|---|---|
| `test` | 88-90 | `KUBEBUILDER_ASSETS="$(ENVTEST use $(ENVTEST_K8S_VERSION) --bin-dir bin -p path)" go test $(go list ./... \| grep -v /e2e) -coverprofile cover.out` — deps: `manifests generate fmt vet setup-envtest` |
| `test-race` | 92-94 | same with `-race`. **This is the CI gate.** |
| `setup-test-e2e` | 104-116 | create Kind cluster `paprika-test-e2e` if absent |
| `test-e2e` | 118-121 | `go test -tags=e2e ./test/e2e/ -v -ginkgo.v -timeout=30m` then `cleanup-test-e2e` |
| `test-e2e-split` | 123-125 | `go test -tags=e2e_split ./test/e2e/ -v -ginkgo.v -timeout=60m` |
| `cleanup-test-e2e` | 127-129 | `kind delete cluster --name paprika-test-e2e` |

`ENVTEST_K8S_VERSION` and `ENVTEST_VERSION` are derived from `go.mod` versions of `k8s.io/api` and
`sigs.k8s.io/controller-runtime` (Makefile:290-300).

### Build (and the fast paths)
| Target | Line | Command |
|---|---|---|
| `build` | 151-153 | `go build -o bin/manager cmd/main.go` (deps `manifests generate fmt vet`) |
| `build-cli` | 155-157 | `go build -o bin/paprika ./cmd/paprika/...` |
| `build-ui` | 145-149 | `cd ui && npm ci && npm run build`, then `rm -rf internal/api/uistatic/*` and copy `ui/out/*` in |
| `build-with-ui` | 159-160 | `build-ui` then `build` |
| `run` | 162-164 | `go run ./cmd/main.go` |
| `docker-build` | 169-175 | `go run ./hack/validate-image-ref.go` then `docker build -t "$IMG" .` (full, ~20 min) |
| **`docker-build-fast`** | 181-184 | `docker buildx build -f Dockerfile.fast --platform linux/amd64 -t "$IMG" --push .` — **Go only, ~1s cached; this is the iteration path** |
| `ko-build-ui` / `ko-push` / `ko-build-full` | 191-222 | native cross-compile via `ko`, no QEMU |

**Fastest inner loop for pure-Go backend work** (skips the `manifests generate fmt vet` chain):
```sh
go build ./...
go test ./internal/api/... -count=1
bin/golangci-lint run ./internal/api/...
```
Then before pushing: `make lint && make test-race`.

### Tool versions (Makefile:283-303)
`LOCALBIN = $(pwd)/bin`. `KUSTOMIZE_VERSION v5.8.1`, `CONTROLLER_TOOLS_VERSION v0.20.1`,
`GOLANGCI_LINT_VERSION v2.12.2`, `MOCKGEN_VERSION` = the `go.uber.org/mock` version from go.mod.
`make tools` installs kustomize, controller-gen, envtest, golangci-lint, mockgen, goreleaser.
`make hooks` (Makefile:36-37) installs the pre-commit hook.

### `Taskfile.yml` (AGENTS.md says prefer this)
`task build`, `build:all`, `install`, `test` (→ `make test`), `test:race`, `test:e2e`,
`lint` (→ `make lint` + `ui:lint`), **`check` (→ generate + test + lint)**, `generate`,
`ui:dev|lint|test|build`, `docker:build`, `clean`.

---

## 4. CODE_REVIEW.md — review standards

File: `/Users/benebsworth/projects/paprika/CODE_REVIEW.md` (150 lines). It is an architecture audit,
not a checklist, but it encodes the standards reviewers apply:

**What it says is working:** interfaces exist for `health.HealthEvaluator`, `engine.DiffEngine`,
`engine.TemplateRenderer`, `traffic.Router`, `controller.ClusterClientManager`; `go.uber.org/mock`
used in `health/`, `engine/`, `source/`, `controller/`; controller-runtime patterns followed.

**Critical issues it flags (i.e. the standards to meet in new code):**
1. *Missing package interfaces* — `gates/` (no `Gate` interface, global `ExecuteGate` dispatcher),
   `analysis/` (concrete `Analyzer`), `engine/workflow.go` (`WorkflowEngine` created inline in
   `PipelineReconciler.Reconcile()`), `metrics/` (package-level globals), `source/`.
2. *Tight coupling in controllers* — dependencies instantiated inline instead of injected.
3. *`main.go` wiring* — 446 lines, wiring not testable; should move to `cmd/wire.go` or
   `internal/wiring/`.
4. *Inconsistent error wrapping* — `%v`/`%s` instead of `%w`: `traffic/traffic.go:33`,
   `gates/gates.go:54`, `engine/template.go:127`.
5. *Missing constructor patterns* — `ApplicationReconciler` (9 fields) and `ReleaseReconciler`
   (7 fields) built by literal init in `main.go` instead of a constructor enforcing invariants.
6. *Magic numbers/strings* — hardcoded timeouts (`30*time.Second`, `300`, `5*time.Second`),
   selectors (`app.kubernetes.io/name=demo-app`), annotation keys scattered across controllers.
   Recommends an `internal/constants/` package.
7. *Test coverage gaps* — `gates/` only integration-style, `analysis/` untested, controller tests are
   all envtest (slow); wants **fast mock-based unit tests**.

**Go best-practice violations it names (CODE_REVIEW.md:130-136):**
`%w` everywhere; contexts must be propagated to HTTP clients; struct tags must be real; the local
`controller` package name collides with `sigs.k8s.io/controller-runtime/pkg/controller`; and
interface/impl naming — interface named descriptively, concrete type plain or `*Impl`.

**Action plan priorities:** P0 create `gates.GateExecutor` / `analysis.Analyzer` / `engine`
interfaces + generate mocks; P1 controllers take interfaces + mock-based unit tests; P2 refactor
`main.go` wiring, fix error wrapping; P3 extract constants.

`GOLANG_BEST_PRACTICES_BACKLOG.md` (36 KB) is the fuller audit: epics are
CI/Toolchain, Concurrency & Safety, Error Handling & Observability, Interfaces/Architecture/DI,
Testing & Mock Hygiene. Standing asks relevant to new code: **table-driven tests + `t.Parallel()`**,
**`mockgen -typed`**, **no goroutine without a stop path**, **inject a clock rather than calling
`time.Now()`**, **`t.TempDir()` not manual temp dirs**, **consumer-defined interfaces**.

---

## 5. CONTRIBUTING.md — the binding contributor rules

File: `/Users/benebsworth/projects/paprika/CONTRIBUTING.md` (123 lines).

**Prereqs:** Go 1.26+, Docker, kubectl, a k8s cluster v1.29+ (Kind for local), golangci-lint v2.x
(`make lint` installs it automatically).

**Code style (verbatim, CONTRIBUTING.md:60-66):**
- Follow Go standard formatting (`go fmt ./...`)
- **Run `make lint` before committing — all linters must pass**
- **Use structured logging via `log.FromContext(ctx)`** (Kubernetes logging conventions)
- **All exported types and functions must have Go doc comments**
- **New features must include tests (unit tests for logic, envtest for controllers)**

**Branching:** branch off `main` (`feature/my-feature`), one feature/fix per branch, rebase before PR.
(NB: the default branch in this checkout is actually `master`.)

**Commit messages (CONTRIBUTING.md:74-87):**
```
<area>: <short description>

<optional longer explanation>
```
Examples given: `engine: add release-name param to HelmSDKRenderer`,
`traffic/istio: handle missing VirtualService gracefully`,
`controller/application: skip pipeline creation when no build steps`.

**Actual practice in `git log` is Conventional Commits with a scope** — e.g.
`feat(controller): cluster-scoped prune with kind allowlist`,
`fix(engine): distinguish same-kind resources across API groups`,
`chore(lint): clear the backlog blocking every publish and deploy`,
`docs:`, `test(cli):`, `ci(release):`, `build:`. **Match the git log, not the doc.**

**PR process:** update docs if API/user-facing behaviour changes; add/update tests; all CI checks
must pass (lint, test, e2e); request maintainer review; ≥1 maintainer review required;
squash on merge.

**Project conventions (CONTRIBUTING.md:104-114) — verbatim:**
- **Multi-group layout**: API types in `api/<group>/<version>/`, controllers in `internal/controller/<group>/`
- **Auto-generated files**: Do not edit `config/crd/bases/*.yaml`, `config/rbac/role.yaml`,
  `**/zz_generated.*.go` — regenerate with `make manifests generate`
- **Kubebuilder markers**: Never remove `// +kubebuilder:scaffold:*` comments
- **Mocking**: `go.uber.org/mock` with `//go:generate mockgen` directives at package boundaries
- **Interface boundaries**: `*Impl` suffix for concrete types, `interfaces.go` files per package
- **Testing**: Ginkgo + Gomega for envtest controllers, standard `testing` package for unit tests
- **Finalizer pattern**: `controllerutil.AddFinalizer`/`RemoveFinalizer` with deferred cleanup
- **Webhooks**: validate + defaulting per CRD; cert-manager for certs
- **HA patterns**: rate limiting at `QPS=50, Burst=100`; leader election for single-active replica

**Pre-commit hooks:** `git config core.hooksPath .githooks` (or `make hooks`).

---

## 6. Test conventions

### Layout & gating
| Kind | Location | Framework | Gate |
|---|---|---|---|
| Unit / handler tests | alongside source, `*_test.go`, **same package** (e.g. `package apiserver` in `internal/api/*_test.go`) | stdlib `testing` + `github.com/stretchr/testify/require` | `make test` / `make test-race` |
| Controller integration | `internal/controller/<group>/suite_test.go` + `*_controller_test.go` | **Ginkgo v2 + Gomega + envtest** | `make test` (needs `KUBEBUILDER_ASSETS`; `make setup-envtest`) |
| Webhook | `internal/webhook/<group>/v1alpha1/webhook_suite_test.go` | Ginkgo + envtest | `make test` |
| E2E | `test/e2e/` | Ginkgo | **build tags**: `//go:build e2e`, `e2e_core`, `e2e_split` — excluded from `make test` by both the tag and `grep -v /e2e` |
| Browser smoke | `ui/` Playwright + `test/fleetconsole` Go fixture | Playwright | CI job `fleet-ui-smoke` |

envtest suites: 5 of them — `internal/controller/{core,clusters,pipelines,rollouts,policy}/suite_test.go`.
They set `CRDDirectoryPaths: config/crd/bases`, `ErrorIfCRDPathMissing: true`, call
`getFirstFoundEnvTestBinaryDir()` so IDE runs work, and use `t.Setenv("ENABLE_WEBHOOKS", "false")`
(`internal/controller/pipelines/suite_test.go:44-114`).

### Counts (facts)
173 `*_test.go` files outside `ui/`; 144 contain `func Test`; 70 files call `t.Parallel()`;
57 files use the `tests := []struct{...}` / `testCases :=` / `cases :=` table idiom;
82 files import testify.

### Mocking
`go.uber.org/mock` (mockgen), version pinned to the go.mod entry. It is a `tool` directive in
`go.mod:299-302` alongside `github.com/bufbuild/buf/cmd/buf`. All 12 directives use
`-destination=mocks/<x>.go -package=mocks` and mostly `-typed`:
```
internal/traffic/traffic.go:65                       WeightRouter,HeaderRouter,MirrorRouter,Provider
internal/cache/interfaces.go:59                      Getter,Setter,Deleter,Pinger,Closer,PrefixDeleter
internal/controller/pipelines/workflow.go:13         WorkflowEngine
internal/controller/pipelines/cluster_client_manager.go:11  ClusterClientManager
internal/api/evaluator.go:9                          Evaluator          (no -typed)
internal/controller/pipelines/diff_engine.go:12      DiffEngine
internal/controller/pipelines/agent_client.go:10     AgentClient
internal/controller/pipelines/source_resolver.go:10,17,24,31  SourceResolver, Git/S3/OCI resolvers
internal/controller/pipelines/renderer.go:11         TemplateRenderer
```
Mock packages: `internal/{traffic,cache,api,controller/pipelines}/mocks`.
New interfaces get an `interfaces.go` + a `//go:generate mockgen ... -typed` line; `make generate`
regenerates.

### Fakes used instead of mocks in `internal/api`
- controller-runtime `sigs.k8s.io/controller-runtime/pkg/client/fake` — `fake.NewClientBuilder().
  WithScheme(scheme).WithObjects(...).WithStatusSubresource(&pipelinesv1alpha1.Application{}).Build()`
- `k8s.io/client-go/dynamic/fake` (`dynamicfake.NewSimpleDynamicClient`) for live/unstructured reads
- `k8s.io/client-go/kubernetes/fake` for typed core reads
- A fresh `runtime.NewScheme()` per test with `clientgoscheme.AddToScheme` + the CRD group's `AddToScheme`
- Server built with functional options: `NewPaprikaServer(c, nil, WithDynamicClient(dynClient))`

### Representative good test #1 — pure conversion (copy this shape)
`/Users/benebsworth/projects/paprika/internal/api/rollout_handler_test.go:13-105`
`TestConvertRollout_ExposesStrategyTrafficAndDebugState` — builds a fully-populated CR literal,
calls the single `convertRollout(ro)` conversion function, then asserts each proto field with
`require.EqualValues` / `require.Equal` / `require.Len`. Name pattern:
`Test<Func>_<BehaviourAsserted>`. No mocks needed. This is the right shape for every new
`convert*` function you add for Cluster/Capacity/Cost/RolloutHistory messages.

### Representative good test #2 — handler with fakes
`/Users/benebsworth/projects/paprika/internal/api/resource_tree_handler_test.go:25-95`
`setupResourceTreeTest(t) *PaprikaServer` helper (`t.Helper()`), scheme + fake client + dynamic fake
seeded with a Deployment/ReplicaSet/Pod owner chain, then
`srv.GetResourceTree(ctx, connect.NewRequest(&paprikav1.GetResourceTreeRequest{...}))`.
Handlers are always called through `connect.NewRequest(...)`.

### Representative good test #3 — **the proto contract test (READ THIS BEFORE TOUCHING api.proto)**
`/Users/benebsworth/projects/paprika/internal/api/fleet_contract_test.go`
- `TestFleetDescriptor` (line 16) pins every value of 13 fleet enums, then calls:
- `assertLegacyFleetDescriptors` (line 514): asserts `legacyFleetMessageDescriptorHashes` has
  **exactly 120 entries** and that each pre-existing top-level message's
  `protodesc.ToDescriptorProto` deterministic-marshal **SHA-256 is unchanged**.
- It also asserts RPC **ordering by index**: `require.Len(legacyFleetServiceMethods, 37)`,
  `require.Len(fleetQueryServiceMethods, 3)`, `require.GreaterOrEqual(methods.Len(), 40)`, and then
  checks `methods.Get(i)` for i=0..36 are the 37 legacy RPCs and i=37..39 are
  `QueryApplications`, `QueryFleetMap`, `QueryFleetMatrix`.
- `assertFleetMessageDescriptors` (line 482) requires `fleetMessageDescriptorContracts` to hold
  exactly 15 messages, each with an exact field count, number, kind, cardinality, referenced type
  and oneof.
- `TestSystemStatusContract` (line 117) is the **template for adding a new RPC**: it declares an
  inline `assertMessage` closure and pins the new request/response messages' fields
  (`GetSystemStatusRequest`, `GetSystemStatusResponse`, `FleetSyncBucket`), asserts
  `HasPresence()` for `optional` fields, and asserts the method descriptor by name.

**Practical consequences for this project's work:**
1. **New RPCs must be appended at the END of `service PaprikaService`** in
   `proto/paprika/v1/api.proto`. Today it has 41 RPCs (lines 1175-1186); `GetSystemStatus` at the
   end is the precedent for appending. Inserting anywhere earlier shifts indices and breaks
   `assertLegacyFleetDescriptors`.
2. **New top-level messages are fine** — the 120-hash map is a literal, not a count of the file.
3. **Adding a field to any of the 120 legacy messages breaks its SHA-256** — you must recompute and
   update the hash in `legacyFleetMessageDescriptorHashes`. Adding a field to any of the 15
   `fleetMessageDescriptorContracts` messages breaks the exact field-count assertion.
4. Every new RPC should get a `Test<Rpc>Contract` in the style of `TestSystemStatusContract`.

---

## 7. Proto & generated-code rules

- Single proto file: `/Users/benebsworth/projects/paprika/proto/paprika/v1/api.proto` (1187 lines,
  41 RPCs). `syntax = "proto3"; package paprika.v1;`
  `option go_package = "github.com/benebsworth/paprika/internal/api/paprika/v1";`
- `buf.yaml`: `version: v2`, module path `proto`, `lint.use: [DEFAULT]`, `breaking.use: [FILE]`.
  DEFAULT lint means: enum values must be `SCREAMING_SNAKE` **prefixed with the enum name**, with a
  `..._UNSPECIFIED = 0` first value; fields `lower_snake_case`; messages `PascalCase`; RPC
  request/response named `<Rpc>Request` / `<Rpc>Response`. See `enum FleetHealth` for the pattern.
- Timestamps are modelled as `optional int64` "Seconds since Unix epoch" (see `StepStatus`
  fields 3/4) — **not** `google.protobuf.Timestamp`. Follow that.
- `optional` is used to get explicit presence (asserted in the contract test).
- `buf.gen.yaml` (v2) emits: Go → `internal/api` (`paths=source_relative`), connect-go → same,
  ES → `ui/src/gen` (`target=js+dts`), connect-es → same.
- Generated Go lands in `internal/api/paprika/v1/api.pb.go` and
  `internal/api/paprika/v1/v1connect/`. **Generated output is committed** and is excluded from all
  linters. CI job `generated` deletes `internal/api/paprika` and `ui/src/gen`, runs
  `make generate-proto`, and fails on any diff or untracked file.
- `make generate-proto` **silently no-ops** if the plugins are missing. Install:
  `go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11`,
  `go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.20.0`, and `cd ui && npm ci`.

### Handler wiring rules (package `apiserver`, `internal/api/`)
- Compile-time assertion `var _ v1connect.PaprikaServiceHandler = (*PaprikaServer)(nil)`
  (`internal/api/server.go:201`) — adding an RPC to the proto **forces** a method on `PaprikaServer`
  or the package will not compile.
- Constructor + functional options: `type ServerOption func(*PaprikaServer)` (`server.go:47`);
  `NewPaprikaServer(c client.Client, broker *events.Broker, opts ...ServerOption)` (`server.go:115`);
  existing options `WithRenderer`, `WithAuthorizer`, `WithFleetIndex(fleet.Reader)`, `WithClock`,
  `WithDynamicClient`, `WithRESTMapper`, `WithAuditor` (`server.go:50-92`).
  **New dependencies (metrics provider, cost provider, cluster reader) must be added as a
  `With...` option, not a new constructor parameter.**
- **Clock is injected**, never `time.Now()` directly: `s.now()` (`server.go:145-150`),
  `clock.Real{}` default, `internal/clock` package.
- Error mapping: return `connect.NewError(connect.Code..., errors.New("..."))` at the RPC boundary,
  never a raw internal error. See `internal/api/fleet_handler.go:181-215` — a single
  `func ...Error(err error) error` maps sentinel errors to
  `CodeUnavailable/CodeInvalidArgument/CodePermissionDenied/CodeCanceled/CodeDeadlineExceeded/CodeInternal`
  with **generic, non-leaking messages**. Internal errors get wrapped with `%w` instead
  (`server.go:214` `fmt.Errorf("listing artifacts: %w", err)`).
- Authorization: `s.authorizeProject(ctx, auth.ActionRead, resource, namespace, project)`
  (`server.go:187-199`) — nil authorizer means "allowed" (test mode); otherwise pulls
  `auth.PrincipalFromContext(ctx)` and returns `auth.ErrUnauthorized`-wrapped errors.
  **Every new read RPC must authorize per project.**
- Metrics on handlers: `started := time.Now()` … `recordAPIList(ctx, "artifacts", started, n, err)`.

### Package placement
`internal/` domain packages (no `util`/`common` grab-bags): `agent, agentclient, analysis, api,
audit, cache, cicontract, clock, conftest, controller, coordinator, engine, featureflag, fleet,
gates, governance, health, investigator, metrics, mtls, observability, oci, policy, ratelimit,
reposerver, reposerverclient, repository, rollout, sharding, source, syncwindow, traffic, webhook`.
API groups: `api/{clusters,core,featureflags,pipelines,policy,rollouts}/v1alpha1`.
The fleet read model / index lives in `internal/fleet` (`Reader` interface at
`internal/fleet/reader.go:14-21`: `ProjectKeys`, `QueryApplications`, `QueryMap`, `QueryMatrix`,
`LoadSnapshot`, `CheckReady`) with `model.go, projection.go, filter.go, facets.go, cursor.go,
pagination.go, search.go, snapshot.go, status.go, store.go, store_cache.go, rebuild.go,
telemetry.go`, each with a paired `_test.go`. **New read-model data (cluster capacity, cost,
rollout history) belongs here, projected into `internal/fleet/model.go`, not computed in handlers.**

### License headers
`hack/boilerplate.go.txt` (Apache 2.0, `Copyright YEAR.`) is applied by `controller-gen object` to
`api/**` files. Files under `internal/` (including `internal/api/*.go`) carry **no** license header —
`internal/api/fleet_handler.go:1` is just `package apiserver`. Match the neighbouring files.

---

## 8. Commit / PR / CI conventions

### `.githooks/pre-commit` (installed via `git config core.hooksPath .githooks` or `make hooks`)
1. Collects staged `.go` files (`ACM` filter); exits 0 if none.
2. Resolves `./bin/golangci-lint`, falling back to `$PATH`; errors with
   "Install with: make golangci-lint" if absent.
3. `gofmt -l` on the staged files — **fails on any unformatted file**.
4. `golangci-lint run --timeout=10m <dirs of staged files>/...` — only the touched packages.

### `.editorconfig`
LF, UTF-8, final newline, trim trailing whitespace. Go → tabs. yml/yaml/json/md → 2 spaces.
Makefile → tabs.

### Commit message format
Conventional Commits with a scope, per the actual history:
`feat(<scope>): …`, `fix(<scope>): …`, `chore(<scope>): …`, `docs: …`, `test(<scope>): …`,
`ci(<scope>): …`, `build: …`. Scopes seen: `controller, engine, chart, selfheal, terraform,
pipelines, metrics, metrics+status, cli, release, landing, docs, build, lint`.

### `.github/PULL_REQUEST_TEMPLATE.md` — the PR checklist you must be able to tick
Description + `Fixes # (issue)`; Type of Change; **How Has This Been Tested?**:
`make test` passes / `make lint` passes / `go build ./...` and `go vet ./...` pass / E2E if
applicable; Checklist: code style, docs updated, tests added, tests pass locally, dependent
changes merged.

### CI — `.github/workflows/ci.yml`, triggers: push to `master`, all pull_request
Jobs (all must pass; `publish` `needs:` every one of them):
| Job | What it runs |
|---|---|
| `go-test` "Go race tests" | `make test-race` (20 min cap) + `hack/test-check-vke-pod-conditions.sh`, `hack/test-github-actions-oidc-token.sh`, `hack/test-github-actions-vke-token.sh` |
| `go-lint` "Go lint" | `make lint-config` (`golangci-lint config verify`) then `make lint` |
| `ui` | `npm ci`, `npm test`, `npm run lint`, `npm run build` in `ui/` |
| `generated` "Generated code drift" | installs `protoc-gen-go@v1.36.11`, `protoc-gen-connect-go@v1.20.0`, `ui npm ci`; `rm -rf internal/api/paprika ui/src/gen`; `make generate-proto`; `git diff --exit-code` + no untracked files |
| `chart` | `hack/test-oidc-secret-rendering.sh`, `hack/test-oidc-deployment-migration.sh`, `hack/compare-helm-chart.sh --self-test`, `helm lint`, `helm template` (plain + `deploy/test-values.yaml`) |
| `release-contract` | goreleaser snapshot build of the CLI, exercises `paprika version/login/status` |
| `distribution-contracts` | `hack/test-cli-install.sh`, `hack/test-taskfile-contract.sh`, `hack/test-landing-install.sh` |
| `fleet-ui-smoke` | builds UI, builds `./test/fleetconsole` fixture, Playwright `fleet-console.spec.ts` against the **real** Go fleet server |
| `fleet-scale` | `hack/test-fleet-scale.sh` (90 min cap) |
| `cluster-integration` | Kind + `hack/test-split-metrics.sh` + `make helm-deploy` + `make helm-status` + wait for deployment |
| `publish` → `deploy-vke` | only on push to `master`; builds `linux/amd64`, pushes `ghcr.io/paprikacd/paprika:latest` and `:sha-<sha>`, then deploys the digest to VKE |

Note `fleet-ui-smoke` runs the **real Go server** against the console — adding backend data that the
console reads means that job exercises your new RPCs end to end. Go version everywhere comes from
`go-version-file: go.mod` with `GOTOOLCHAIN: auto`.

---

## 9. Checklist for the console-backend work

1. Append new messages / enums to `proto/paprika/v1/api.proto`; **append new RPCs after
   `GetSystemStatus` at the end of `service PaprikaService`**. Enum values prefixed with the enum
   name, `_UNSPECIFIED = 0` first. Timestamps as `optional int64` seconds-since-epoch.
2. `make generate-proto` (needs `protoc-gen-go`, `protoc-gen-connect-go`, `ui npm ci`) and **commit**
   `internal/api/paprika/**` and `ui/src/gen/**`.
3. Implement the method on `*PaprikaServer` in a new `internal/api/<area>_handler.go`
   (package `apiserver`, no license header). Keep each handler under cyclop 10 / funlen 100 or add
   `//nolint:cyclop // <reason>`.
4. New dependencies enter through a `With…(…) ServerOption`, and time through the injected clock.
5. Authorize per project via `s.authorizeProject`; map failures with `connect.NewError`; wrap
   internal errors with `%w`.
6. Read-model projections (cluster capacity, cost, rollout history) belong in `internal/fleet`,
   with a paired `_test.go`.
7. New metrics → OTel instruments in `internal/metrics/otel.go`, named `paprika_*`.
8. Tests: a `Test<Rpc>Contract` descriptor test in the `TestSystemStatusContract` style; a
   `TestConvert<X>_<Behaviour>` conversion test; a fake-client handler test. Table-driven with
   `t.Parallel()` where independent. testify `require`.
9. CRD/API type changes → `make manifests generate`, copy CRDs into `charts/chart/templates/crd/`,
   `helm lint` + `helm template`. Never hand-edit `zz_generated.*.go`, `config/crd/bases/*.yaml`,
   `config/rbac/role.yaml`.
10. Before pushing: `make lint-config && make lint && make test-race`, plus the AGENTS.md trio
    (`go build ./...`, `go test ./internal/engine ./internal/controller/pipelines -count=1`,
    `go vet ./internal/... ./cmd/...`). Commit as `feat(api): …`.
