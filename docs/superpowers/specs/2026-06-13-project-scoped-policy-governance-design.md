# Project-Scoped Policy & Multi-Tenancy Governance

**Date:** 2026-06-13  
**Status:** Ready for implementation planning  
**Author:** Kimi Code (brainstorming session)

## 1. Overview

This design makes `AppProject` the enforced tenant boundary and `Policy` the enforced rule engine for Paprika. The goal is to answer: *“Who can deploy what, where, under which rules.”*

Today Paprika has:

- `AppProject` CRD with `sourceRepos`, `sourceReposDeny`, `repositories`, `destinations`, `kinds`, `kindsDeny`, `clusterResourceWhitelist`, `clusterResourceBlacklist`, and `roles`.
- `Policy` CRD (cluster-scoped) with CEL-based rules, `severity`, and `defaultAction` (`enforce`/`warn`).
- A validating webhook for `Policy` CRDs.
- Apply-time policy evaluation in `internal/api/apply_bundle.go` and the `paprika apply` CLI.
- A partial `ProjectEnforcer` in `internal/api/auth/project_enforcer.go` used by the `Application` webhook.

This feature closes the gaps by:

- Enforcing `AppProject` boundaries during `Application` admission and controller reconciliation.
- Enforcing `Policy` rules against rendered manifests in the `Application` controller, the `Release` controller, and the `ApplyBundle` API path.
- Surfacing governance results through Kubernetes Conditions and Events.
- Scoping API operations using the existing `internal/api/auth` machinery plus project membership derived from `AppProject.spec.roles`.

## 2. Goals & Non-Goals

### Goals

- Make `spec.project` always present on `Application` by adding a CRD default of `default`, defaulting it in the webhook, and normalizing legacy empty values in the controller.
- Enforce all `AppProject` constraints (sources, repositories, destinations, kinds, cluster resources) in webhooks and controllers.
- Evaluate `Policy` rules against rendered manifests during reconciliation and apply.
- Surface governance results through Conditions (`GovernanceChecked`) and Kubernetes Events.
- Scope API list/get/write operations by project membership.
- Provide a single, testable `internal/governance` package shared by webhooks, controllers, and the API server.

### Non-Goals

- OIDC/JWT authentication in this phase (the existing auth stack remains).
- UI-specific governance pages or policy dashboards in this phase.
- External policy engines such as OPA/Gatekeeper.
- Kubernetes RBAC integration in this phase; project authorization uses `AppProject.spec.roles`.
- Multi-cluster policy distribution to remote agents.

## 3. User Experience

### 3.1 Project boundary example

```yaml
apiVersion: core.paprika.io/v1alpha1
kind: AppProject
metadata:
  name: payments
  namespace: default
spec:
  sourceRepos:
    - https://github.com/acme/payments.git
  sourceReposDeny: []
  repositories:
    - payments-repo
  destinations:
    - server: https://kubernetes.default.svc
      namespace: payments-*
  kinds:
    - Deployment
    - Service
    - ConfigMap
  kindsDeny: []
  clusterResourceWhitelist: []
  clusterResourceBlacklist:
    - ClusterRole
  roles:
    - name: admin
      subjects:
        - serviceaccount:default:payments-cd
      actions:
        - write
        - read
```

An `Application` that references a disallowed repo, an unauthorized `Repository`, or targets a forbidden namespace is rejected at admission time and blocked before sync by the controller.

### 3.2 Policy example

```yaml
apiVersion: policy.paprika.io/v1alpha1
kind: Policy
metadata:
  name: require-labels
spec:
  severity: critical
  defaultAction: enforce
  projects:
    - payments
  match:
    kinds:
      - Deployment
  expression: |
    object.metadata.labels != null &&
    has(object.metadata.labels.app) &&
    has(object.metadata.labels.team)
```

Policies are cluster-scoped. The optional `spec.projects` list scopes a policy to named projects; an empty list means the policy applies to all projects. During reconciliation the controller evaluates every rendered manifest against every matching policy. An `enforce` violation blocks sync; a `warn` violation emits an Event and continues.

### 3.3 CLI/API experience

- `paprika apply -f ... --project payments` prints policy results and exits non-zero on blocking violations.
- `kubectl describe application/my-app` shows a `GovernanceChecked` condition.
- Kubernetes Events include the policy name, severity, and action.

## 4. Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         API / CLI                                   │
│  paprika apply ──► ApplyBundle ──► governance.Evaluate              │
│                                    governance.ValidateProject       │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Admission Webhooks                                │
│  Application validator calls governance.ProjectValidator.Validate     │
│  AppProject validator checks allow/deny overlaps                      │
│  Policy validator checks CEL and project list                         │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Controllers                                       │
│  Application controller calls governance.Validate + Evaluate          │
│  Release controller calls governance.Validate + Evaluate before apply │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│              internal/governance package                              │
│  - ProjectResolver                                                    │
│  - ProjectValidator (uses AppProject fields)                          │
│  - PolicyEvaluator (wraps policy.Evaluator, selects by project)       │
│  - Violation                                                          │
└─────────────────────────────────────────────────────────────────────┘
```

## 5. Components

### 5.1 `internal/governance`

A new package that consolidates project-boundary and policy-evaluation logic. It depends on Paprika API types and the existing `policy` package, not on webhook or controller internals.

#### `ProjectResolver`

```go
type ProjectResolver struct {
    client client.Reader
}

func (r *ProjectResolver) Resolve(ctx context.Context, obj client.Object) (*corev1alpha1.AppProject, error)
```

- For `Application`: read `spec.project` from the **Application's namespace**. AppProjects are namespace-scoped and live alongside the Applications they govern (matching the existing `ProjectEnforcer` behavior).
- For `Template`/`Stage` inside a controller: resolve via the owner `Application`.
- Returns an error if the referenced project does not exist.

#### `ProjectValidator`

```go
type ProjectValidator struct {
    resolver       *ProjectResolver
    clusterResolver ClusterResolver
    restMapper     meta.RESTMapper
}

func (v *ProjectValidator) ResolveProject(ctx context.Context, namespace, name string) (*corev1alpha1.AppProject, error)
func (v *ProjectValidator) Validate(ctx context.Context, app *pipelinesv1alpha1.Application, manifests []*unstructured.Unstructured, project *corev1alpha1.AppProject) (Violations, error)
```

Validates:

- `sourceRepos` / `sourceReposDeny`: the application source URL.
- `repositories`: the optional `Repository` name referenced by `spec.source.repoRef`.
- `destinations`: target cluster/server and namespace for every stage and every manifest namespace. Stage `ClusterRef` names are resolved to server URLs by `ClusterResolver`; if a destination specifies `name`, the cluster name is compared directly.
- `kinds` / `kindsDeny`: kinds used in rendered manifests (skipped when no manifests are provided).
- `clusterResourceWhitelist` / `clusterResourceBlacklist`: cluster-scoped resources in the bundle (skipped when no manifests are provided). Scope is determined by `restMapper.RESTMapping`; if the mapper cannot decide, a manifest with an empty namespace is treated as cluster-scoped.

Matching semantics:

- All list fields (`sourceRepos`, `sourceReposDeny`, `kinds`, `kindsDeny`, `clusterResourceWhitelist`, `clusterResourceBlacklist`) support glob-style matching where `*` matches any sequence of characters. An empty allow list means "allow all."
- Deny lists take precedence over allow lists: a value matching any deny entry is rejected even if it also matches an allow entry.
- For `destinations`, an entry matches if all non-empty fields (`server`, `namespace`, `name`) match the corresponding target value using glob matching. An empty `destinations` list means any destination is allowed.

All callers normalize an empty project to `default` before invoking `ProjectValidator`, so the validator never sees an empty project.

For the `ApplyBundle` path, where an `Application` CR does not yet exist, `ProjectValidator` also exposes:

```go
func (v *ProjectValidator) ValidateBundle(ctx context.Context, project *corev1alpha1.AppProject, source pipelinesv1alpha1.ApplicationSource, stages []pipelinesv1alpha1.ApplicationPromotionStage, defaultNs, server string, manifests []*unstructured.Unstructured) (Violations, error)
```

For the `ApplyBundle` path, callers pass a synthetic `ApplicationSource{Type: SourceTypeInline, Inline: &InlineSourceSpec{}}` because the manifests are already materialized. This skips repository-level source constraints while still allowing `allowed_sources` type checks and namespace/cluster boundary rules to run.

#### `ClusterResolver`

```go
type ClusterResolver interface {
    ResolveServer(ctx context.Context, defaultNs string, ref pipelinesv1alpha1.ClusterRef) (string, error)
}
```

- Resolves a `ClusterRef` to the cluster's API server URL by reading the `Cluster` CR.
- Used by `ProjectValidator` to compare stage destinations against `AppProject.spec.destinations`.

#### `PolicyEvaluator`

```go
type PolicyEvaluator struct {
    client client.Reader
}

func (e *PolicyEvaluator) Evaluate(ctx context.Context, project string, manifests []unstructured.Unstructured, opts policy.EvaluateOptions) ([]Violation, error)
```

- Lists cluster-scoped `Policy` objects.
- Filters to policies whose `spec.projects` is empty, contains `*`, or contains the requested project. This filtering happens before delegation so the existing `policy.Evaluator` does not need to understand projects.
- Reuses the existing `policy.NewEvaluator` for CEL evaluation.
- `policy.EvaluateOptions` is the existing type from the `policy` package (`Namespace`, `ApplicationName`, `SkipPolicies`, `PolicyOverrides`).
- Returns typed `Violation` results.

#### `Violation`

```go
type Violation struct {
    Rule     string       // policy name or "project"
    Severity string
    Message  string
    Action   PolicyAction // enforce or warn
}

func (v Violation) Blocking() bool { return v.Action == PolicyActionEnforce }
```

### 5.2 CRD changes

- `Policy` CRD: add optional `spec.projects []string` field. An empty list means the policy applies to all projects; `["*"]` is also accepted and means the same. The string `*` is reserved and may not be used as an actual project name.
- `Application` CRD: keep `spec.project` optional but add `+kubebuilder:default="default"`. The defaulting webhook sets empty values to `default`, the validating webhook rejects any empty value that slips through, and the controller treats pre-webhook Applications with an empty project as `default`.
- `ApplyBundleRequest` (proto): add optional `project` field. The CLI defaults it to `default` unless overridden.
- Request protos with project field: `ApplyBundleRequest.project`, `ListApplicationsRequest.project`, `ListReleasesRequest.project`, `ListStagesRequest.project`, `ListPipelinesRequest.project`. There is no `ListTemplates` RPC in the current proto; add the field if that RPC is introduced later. For single-resource get/update/delete requests without a project field (`GetApplication`, `GetRelease`, etc.), the server fetches the target resource and reads the owning `Application.spec.project` for authorization.

### 5.3 Webhook changes

- `Application` validating webhook: resolve project and call `ProjectValidator`. Return clear HTTP errors.
- `Application` defaulting webhook: if `spec.project` is empty, set it to `default`.
- `AppProject` validating webhook (existing): keep overlap checks; add validation that `destinations` entries have at least one of `server`, `namespace`, or `name`, and that `kinds`/`clusterResourceWhitelist`/`clusterResourceBlacklist` entries look like valid kind names.
- `Policy` validating webhook: validate `spec.projects` values are non-empty strings and reject duplicates; validate `defaultAction` (already done).
- `Template`/`Stage` webhooks: no project-boundary validation in this phase. Structural validation only. Template and Stage controllers also do not run governance checks; enforcement happens through their owner `Application` controller.

The operator startup helper (not the webhook) creates the permissive `default` `AppProject` if it is missing.

### 5.4 Controller changes

- `Application` controller:
  - If `spec.project` is empty, treat it as `default`.
  - After source/stages are reconciled, call `ProjectValidator.Validate` with **no manifests** to check structural project boundaries (source repos, repositories, destinations). This is a lightweight gate that does not require rendering.
  - On blocking structural violation: set `GovernanceChecked=False` with reason `ProjectViolation`, set `Phase=Failed` with reason `GovernanceViolation`, emit Event, and stop before `reconcileReleaseFlow`.
- `Release` controller:
  - After rendering manifests (or loading the inline snapshot) and before applying, resolve the owning `Application`.
  - Call `ProjectValidator.ValidateBundle` with the application's project/source/stages and the rendered manifests, and call `PolicyEvaluator.Evaluate` with the same project and manifests.
  - Block apply on enforce violations and record `GovernanceChecked` in `Release` status.

### 5.5 API authorization

- Extend the existing `internal/api/auth` `RBACRule` with an optional `Projects []string` field. This is used for coarse-grained API access control (e.g., a CI robot may only access the `payments` project). A rule with no projects applies globally.
- Add a `ProjectAuthorizer` that holds a `client.Reader` and checks whether the principal matches a subject in `AppProject.spec.roles` for the requested project and action. `AppProjectRole.Subjects` are treated as opaque strings; the API server compares them to `Principal.Subject` or group memberships. A subject value of `*` matches any principal. The authorizer reads `AppProject` from the same namespace as the target resource.
- Action vocabulary is the same as the existing `internal/api/auth` actions: `read` maps to `get`/`list` RPCs, `write` maps to `create`/`update`/`delete`, and `admin` allows everything.
- The `Principal` type is the existing `internal/api/auth.Principal` populated by the configured authenticators (BasicAuth, OIDC, etc.).
- The `auth.Interceptor` constructor/factory is updated to accept the API server's `client.Reader` so it can build the `ProjectAuthorizer` and return a `connect.UnaryInterceptorFunc`. The interceptor still extracts action/resource/namespace, and now also extracts `project` from request messages where the field exists (`ApplyBundleRequest.project`, list request `project`, etc.). For single-resource get/update/delete requests without a project field, the server fetches the target resource and reads the owning `Application.spec.project` before authorizing. `ApplyBundle` has no target resource, so it is authorized solely via its explicit `project` field.
- Authorization runs both `RBACAuthorizer` and `ProjectAuthorizer`; both must allow the request.
- `PaprikaServer` accepts an `auth.Authorizer` so it can perform server-side project checks for list filtering and for RPCs without a project field.
- For `list` operations, the API handler fetches all items and filters the response to projects the principal is authorized to read. `Application` objects are filtered by `spec.project`. Child resources (`Release`, `Stage`, `Pipeline`, `Template`) are created with an `app.paprika.io/project` label by their parent controllers; the API server registers a field indexer on that label so filtering does not require owner-reference lookups.

### 5.6 Conditions and Events

- New condition type `GovernanceChecked` on `Application` and `Release`, independent of the existing phase conditions.
  - `Status: True`, `Reason: Passed` when no blocking violations.
  - `Status: False`, `Reason: ProjectViolation` or `Reason: PolicyViolation` when blocked.
- When a blocking violation is found:
  - Set `GovernanceChecked=False` with the violation reason and message.
  - Set `Phase=Failed` with reason `GovernanceViolation` so existing phase-based logic stops the rollout.
  - Do not create or update the `Release`.
- When only warnings are found:
  - Set `GovernanceChecked=True` with a message listing warnings.
  - Leave the phase unchanged and continue the rollout.
- Events:
  - `Normal` `GovernanceCheckPassed` on success.
  - `Warning` `PolicyViolation` for each `warn` or `enforce` violation.

## 6. Data Flow

1. User creates `Application` with `spec.project: payments`.
2. Defaulting webhook sets `spec.project` to `default` if empty.
3. Startup helper has already ensured the permissive `default` `AppProject` exists.
4. Validating webhook resolves `AppProject/payments` and validates boundaries; rejects if invalid.
5. Application controller validates structural project boundaries (source/repos/destinations) and continues to create Template/Release resources.
6. Release controller renders manifests (or loads inline snapshot) and runs full project-boundary + policy evaluation.
7. If blocking violations exist, the Release controller records `GovernanceChecked=False` and stops before applying. The Application controller reflects the failure in its own status.
8. If only warnings, the Release controller records `GovernanceChecked=True` and continues applying.
9. `paprika apply` sends `ApplyBundleRequest.project`; the API server normalizes empty values to `default`, uses the project for boundary validation and policy evaluation, and stores it on the inline-created `Application.spec.project` so subsequent controller reconciles use the same project.

## 7. Error Handling

- Webhooks return clear, actionable HTTP errors (e.g., `repo "foo" not allowed in project "payments"`).
- Controllers distinguish transient errors (fetch failure, CEL compile error) from terminal violations.
- Transient errors are requeued with backoff.
- Terminal violations are recorded in status and not requeued until the resource changes.
- Unknown evaluation errors are logged and requeued.

## 8. Testing Strategy

### Unit tests

- `ProjectResolver`: resolve by application; missing project.
- `ProjectValidator`: allowed/disallowed repos, repositories, destinations, kinds, cluster resources; wildcard patterns.
- `PolicyEvaluator`: project selection; enforce/warn actions; CEL compilation errors; empty policy list.

### Webhook integration tests (envtest)

- Create an `AppProject` and attempt to create an `Application` that violates it; expect rejection.
- Create a compliant `Application`; expect admission.
- Create a `Policy` with `spec.projects`; ensure invalid project names are rejected.

### Controller tests (envtest)

- Reconcile an `Application` whose rendered manifests violate an enforce policy; assert `GovernanceChecked=False` and no sync.
- Reconcile an `Application` with only warn policies; assert `GovernanceChecked=True` and sync proceeds.

### API authorization tests

- Unit tests for `RBACRule` matching with `Projects`.
- Unit tests for `ProjectAuthorizer` against mocked `AppProject` roles.
- Integration tests for the interceptor rejecting unauthorized requests and allowing authorized ones.
- Tests for list-response filtering by project for Applications and child resources.

### E2E tests (Kind)

- Apply an `AppProject`, a `Policy`, and an `Application` in one script.
- Assert the `Application` is blocked and Events are emitted.

## 9. Migration & Compatibility

- Existing `Application` resources without `spec.project` receive `default` via the defaulting webhook.
- On startup the operator ensures a `default` `AppProject` exists in **each namespace that already contains Applications** (and in the operator namespace for new Applications created there) with permissive defaults and a catch-all role (`subjects: ["*"], actions: ["read","write"]`) so existing users are not locked out. For simplicity, the bootstrap creates the project in the operator namespace; Applications in other namespaces must reference an AppProject in their own namespace, and the bootstrap can be extended to create per-namespace default projects later.
- Existing `Policy` resources continue to apply globally because `spec.projects` is empty by default.
- CRD changes: add `spec.projects` to `Policy`; regenerate manifests (`make manifests generate`).
- Proto changes: add `project` to `ApplyBundleRequest`; regenerate Go/TypeScript stubs.

## 10. Out of Scope / Future Work

- OIDC/JWT authentication and group mapping.
- UI governance dashboard, policy violation history, and approval workflows.
- External policy engines (OPA, Gatekeeper).
- Kubernetes RBAC integration for API authorization.
- Multi-cluster policy distribution to remote agents.
- Audit log persistence beyond Kubernetes Events.
- This spec assumes the related `paprika apply` spec is updated in tandem so that `ApplyBundleRequest.project` and any `--project` CLI flag remain aligned.

## 11. Cross-Spec Alignment

Because `ApplyBundleRequest` is shared with the `paprika apply -f` feature, the following changes must be coordinated with the `paprika apply` design spec:

- Add `string project = N;` to `ApplyBundleRequest` in `proto/paprika/v1/api.proto`.
- Add a `--project` flag to the `paprika apply` CLI that defaults to `default`.
- Ensure the CLI prints project-boundary violations as well as policy results.
