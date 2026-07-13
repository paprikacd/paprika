# Fleet Scope, Health Heatmap, and Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fleet scope editable and persistent, render every authorized Application in a complete health heatmap, and provide a Kubernetes-verified pod-local administrative dashboard that can be validated locally and on omega VKE.

**Architecture:** Extend the existing `QueryFleetMap` aggregate with namespace grouping and compact leaf metadata, then make one URL-backed scope provider drive Overview, Applications, and scope-preserving navigation. A deterministic pure heatmap layout renders equal Application cells into a virtualized Canvas. Separately, an opt-in `127.0.0.1:3001` listener exchanges a reviewed Kubernetes credential for a short-lived pod-bound session; the CLI owns the hidden port-forward and a token-injecting local proxy. Local fixtures, Playwright completeness oracles, structural Helm checks, and an isolated VKE harness prove the whole path before rollout.

**Tech Stack:** Go 1.26, controller-runtime/client-go, Connect RPC/protobuf, Cobra, Helm, Next.js 16, React 19, TypeScript, TanStack Query, Canvas, Vitest/Testing Library, Playwright, Kubernetes/VKE.

**Approved spec:** `docs/superpowers/specs/2026-07-13-fleet-scope-health-heatmap-admin-dashboard-design.md`

**Execution skills:** `@superpowers:test-driven-development`, `@frontend-development`, `@vercel-react-best-practices`, `@playwright`, `@security-best-practices`, `@superpowers:verification-before-completion`, and `@superpowers:subagent-driven-development`.

---

## Chunk 1: URL-Backed Fleet Scope and Complete Health Heatmap

### Chunk boundary

This chunk is complete when the normal console can edit Project, Cluster, Stage, and Namespace scope; retain that scope across all fleet routes and detail identities; render every filtered Application in Heatmap, Treemap, Matrix, Table, and Queue presentations; and pass deterministic 250-Application local browser tests. It does not start or expose the administrative listener.

### File structure

- `proto/paprika/v1/api.proto` — additive namespace grouping and compact map-leaf metadata.
- `internal/fleet/map.go` and `matrix.go` — namespace grouping, complete health projection, and metadata population.
- `internal/api/fleet_handler.go` — protobuf conversion for the additive fields.
- `ui/src/lib/fleet-query.ts` — canonical query parsing/serialization only.
- `ui/src/lib/fleet-navigation.ts` — lossless route transitions and detail-identity migration only.
- `ui/src/lib/fleet-scope-context.tsx` — shared URL scope/facet state and one map request owner.
- `ui/src/components/layout/scope-multiselect.tsx` and `scope-bar.tsx` — accessible scope editing.
- `ui/src/components/fleet/heatmap-layout.ts` — deterministic equal-cell geometry and digest.
- `ui/src/components/fleet/fleet-health-heatmap.tsx` — virtualized Canvas, interaction, tooltip, and semantic fallback.
- `test/fleetconsole/` — deterministic Kubernetes-style fleet fixture.
- `ui/e2e/helpers/fleet-map-oracle.ts` — independent response-to-layout completeness oracle.

### Task 1: Extend the fleet-map contract without breaking existing clients

**Files:**
- Modify: `proto/paprika/v1/api.proto`
- Modify: `internal/api/fleet_contract_test.go`
- Modify: `internal/api/fleet_handler_test.go`
- Modify: `internal/fleet/map.go`
- Modify: `internal/fleet/map_test.go`
- Modify: `internal/fleet/matrix.go`
- Modify: `internal/fleet/matrix_test.go`
- Modify: `internal/api/fleet_handler.go`
- Generated: `internal/api/paprika/v1/api.pb.go`
- Generated: `ui/src/gen/paprika/v1/api_pb.{js,d.ts}`
- Modify: `ui/src/lib/fleet-client.ts`
- Modify: `ui/src/lib/fleet-client.test.ts`

- [ ] **Step 1: Freeze the additive protobuf shape in descriptor tests**

Add assertions that `FLEET_GROUP_DIMENSION_NAMESPACE = 5`, `FleetMapApplicationMetadata` owns fields 1–11, and `FleetMapNode.application_metadata = 15`. Retain every existing enum value, field number, and RPC assertion.

```proto
enum FleetGroupDimension {
  // Existing values 0–4 remain unchanged.
  FLEET_GROUP_DIMENSION_NAMESPACE = 5;
}

message FleetMapApplicationMetadata {
  FleetObjectKey project = 1;
  FleetObjectKey current_cluster = 2;
  string current_stage = 3;
  FleetSyncState sync = 4;
  FleetReleaseState release = 5;
  FleetRolloutState rollout = 6;
  uint64 drifted_resources = 7;
  uint64 missing_resources = 8;
  uint64 managed_resources = 9;
  google.protobuf.Timestamp last_transition = 10;
  string issue_summary = 11;
}
```

- [ ] **Step 2: Add failing fleet tests**

In `map_test.go`, prove namespace grouping creates one group per `Application.Identity.Namespace`, every Application stable ID appears exactly once, compact metadata reflects the projected record, and an Application with missing projected resources can produce `FleetHealthMissing`. In `matrix_test.go`, prove Namespace can be either axis. In the handler/client tests, prove the new enum and optional metadata round-trip while a node without metadata still decodes.

- [ ] **Step 3: Run the focused Go tests and capture the red state**

Run: `rtk go test ./internal/fleet ./internal/api -run 'Test.*(FleetMap|FleetMatrix|FleetDescriptor|FleetContract|QueryFleetMap)' -count=1`

Expected: failures for the missing namespace group value, metadata type/field, and Missing projection case.

- [ ] **Step 4: Implement the smallest internal model and conversion**

Add `GroupDimensionNamespace`, a compact internal metadata struct on Application leaves only, and namespace keys in both map and Matrix grouping. Reuse the existing projected `FleetApplication` fields; do not query Kubernetes or the paginated applications API from the mapper. Make Missing an explicit result of the core health projection when a projected Application has missing resources and no stronger state.

- [ ] **Step 5: Generate bindings**

Run: `rtk make generate-proto`

Expected: Go and TypeScript generated bindings change only for the additive enum/message/field.

- [ ] **Step 6: Prove generated bindings still need client mapping**

Run: `rtk npm --prefix ui test -- src/lib/fleet-client.test.ts`

Expected: new namespace-group and optional-metadata mapping assertions fail against the unchanged client adapter.

- [ ] **Step 7: Map the generated metadata into the UI client model**

Keep metadata optional in `FleetMapNode`. Convert timestamps to the existing UI timestamp representation, preserve canonical `namespace/name` object identities, and avoid synthesizing unavailable fields.

- [ ] **Step 8: Run contract and mapper tests green**

Run: `rtk go test ./internal/fleet ./internal/api -run 'Test.*(FleetMap|FleetMatrix|FleetDescriptor|FleetContract|QueryFleetMap)' -count=1`

Run: `rtk npm --prefix ui test -- src/lib/fleet-client.test.ts`

Expected: both commands pass; the map completeness tests compare exact stable-ID multisets.

- [ ] **Step 9: Commit the contract increment**

```text
feat(fleet): add namespace grouping and compact map metadata
```

### Task 2: Extend the canonical fleet query codec

**Files:**
- Modify: `ui/src/lib/fleet-query.ts`
- Modify: `ui/src/lib/fleet-query.test.ts`
- Modify: `ui/src/lib/release-query.ts`
- Modify: `ui/src/lib/release-query.test.ts`

- [ ] **Step 1: Add failing codec matrices**

Cover repeated Project/Cluster/Stage/Namespace values, `group=namespace`, `view=heatmap`, `density=auto|compact|comfortable`, and `labels=auto|all|none`. Assert defaults are omitted, invalid values produce the existing non-blocking notices, and sort/direction/search/status filters round-trip unchanged.

- [ ] **Step 2: Run the codec tests red**

Run: `rtk npm --prefix ui test -- src/lib/fleet-query.test.ts src/lib/release-query.test.ts`

Expected: failures for the new presentation and namespace-group values.

- [ ] **Step 3: Implement the additive state**

Use these closed unions and keep `treemap` as the Applications default:

```ts
export type FleetView = "heatmap" | "treemap" | "matrix" | "table" | "queue"
export type FleetDensity = "auto" | "compact" | "comfortable"
export type FleetLabelMode = "auto" | "all" | "none"
export type FleetGroup = "project" | "cluster" | "stage" | "namespace" | "health"
```

Overview chooses Heatmap in its page defaults; parsing the same URL on Applications must not silently rewrite that route's default.

- [ ] **Step 4: Run the codec tests green**

Run: `rtk npm --prefix ui test -- src/lib/fleet-query.test.ts src/lib/release-query.test.ts`

Expected: all canonicalization, notice, and round-trip cases pass.

- [ ] **Step 5: Commit the codec increment**

```text
feat(ui): extend fleet query presentation state
```

### Task 3: Make navigation lossless and detail identities unambiguous

**Files:**
- Create: `ui/src/lib/fleet-navigation.ts`
- Create: `ui/src/lib/fleet-navigation.test.ts`
- Modify: `ui/src/components/layout/sidebar.tsx`
- Modify: `ui/src/components/dashboard/dashboard-command-center.tsx`
- Modify: `ui/src/components/dashboard/application-card.tsx`
- Modify: `ui/src/components/dashboard/dashboard-health-map.tsx`
- Modify: `ui/src/components/dashboard/pipeline-card.tsx`
- Modify: `ui/src/components/dashboard/release-table.tsx`
- Modify: `ui/src/components/fleet/fleet-overview.tsx`
- Modify: `ui/src/app/dashboard/page.tsx`
- Modify: `ui/src/app/dashboard/application/page.tsx`
- Modify: `ui/src/app/dashboard/rollouts/page.tsx`
- Modify: `ui/src/app/dashboard/rollouts/detail/page.tsx`
- Modify: `ui/src/app/dashboard/pipelines/detail/page.tsx`
- Modify: `ui/src/app/dashboard/releases/page.tsx`
- Modify: `ui/src/app/dashboard/applicationsets/page.tsx`
- Modify: `ui/src/app/dashboard/applicationsets/detail/page.tsx`
- Modify: `ui/src/app/dashboard/application/page.test.tsx`
- Modify: `ui/src/app/dashboard/rollouts/detail/page.test.tsx`
- Modify: `ui/src/app/dashboard/pipelines/detail/__tests__/page.test.tsx`
- Modify: `ui/src/app/dashboard/releases/page.test.tsx`
- Create: `ui/src/app/dashboard/applicationsets/detail/page.test.tsx`
- Create: `ui/src/components/dashboard/application-card.test.tsx`
- Create: `ui/src/components/dashboard/pipeline-card.test.tsx`
- Modify: `ui/src/components/dashboard/dashboard-command-center.test.tsx`
- Modify: `ui/src/components/dashboard/dashboard-health-map.test.tsx`
- Modify: `ui/src/components/dashboard/release-table.test.tsx`
- Modify: `ui/src/components/fleet/fleet-overview.test.tsx`
- Modify: `ui/src/app/dashboard/__tests__/dashboard-refresh.test.tsx`

- [ ] **Step 1: Write failing lossless-patch tests**

Table-test these invariants:

- Scope mutation starts from current `URLSearchParams` and replaces only `project`, `cluster`, `stage`, and `namespace`.
- Scope mutation clears only pagination cursor/page, selected map cell, and semantic zoom.
- Search, filters, group, view, density, labels, sort, direction, time range, tab, hash, unknown parameters, and explicit resource identity survive.
- Detail identities use `application_*`, `rollout_*`, `pipeline_*`, or `applicationset_*` keys.
- A single legacy `namespace` plus `name` migrates once with `replace`; multiple legacy namespaces without explicit identity produce an ambiguity result instead of guessing.

- [ ] **Step 2: Run navigation tests red**

Run: `rtk npm --prefix ui test -- src/lib/fleet-navigation.test.ts`

Expected: module-not-found or missing helper failures.

- [ ] **Step 3: Implement one route-aware helper surface**

```ts
export function patchFleetSearchParams(
  current: URLSearchParams,
  patch: Partial<FleetQueryState>,
  options?: { scopeChanged?: boolean },
): URLSearchParams

export function fleetHref(pathname: string, current: URLSearchParams): string
export function fleetDetailHref(kind: FleetDetailKind, key: ObjectKey, current: URLSearchParams): string
export function readFleetDetailIdentity(kind: FleetDetailKind, params: URLSearchParams): DetailIdentityResult
export function migrateLegacyDetailIdentity(kind: FleetDetailKind, params: URLSearchParams): URLSearchParams | FleetIdentityAmbiguity
```

Centralize the owned/transient key sets. Do not let components reconstruct query strings.

- [ ] **Step 4: Replace direct link construction route by route**

Update every current legacy-link owner listed above, including Application cards, health map, fleet overview, dashboard command center/page, Release table/page breadcrumb, Rollouts page, Pipeline card, and both ApplicationSet pages. Each page/component test must start from a scoped URL containing an unknown parameter and assert the destination retains it plus the dedicated identity pair. Keep the existing query-backed static routes; do not introduce dynamic route segments into the exported Next.js build.

- [ ] **Step 5: Run navigation and page tests green**

Run: `rtk npm --prefix ui test -- src/lib/fleet-navigation.test.ts src/components/layout/app-shell.test.tsx src/components/dashboard/application-card.test.tsx src/components/dashboard/pipeline-card.test.tsx src/components/dashboard/dashboard-command-center.test.tsx src/components/dashboard/dashboard-health-map.test.tsx src/components/dashboard/release-table.test.tsx src/components/fleet/fleet-overview.test.tsx src/app/dashboard/application/page.test.tsx src/app/dashboard/releases/page.test.tsx src/app/dashboard/rollouts/detail/page.test.tsx src/app/dashboard/pipelines/detail/__tests__/page.test.tsx src/app/dashboard/applicationsets/detail/page.test.tsx src/app/dashboard/__tests__/dashboard-refresh.test.tsx`

Expected: lossless navigation, route-aware legacy migration, and all four detail identities pass.

- [ ] **Step 6: Commit the navigation increment**

```text
feat(ui): preserve fleet scope through resource navigation
```

### Task 4: Add one shared fleet-scope and facet provider

**Files:**
- Create: `ui/src/lib/fleet-scope-context.tsx`
- Create: `ui/src/lib/fleet-scope-context.test.tsx`
- Modify: `ui/src/lib/use-fleet-data.ts`
- Modify: `ui/src/lib/use-fleet-data.test.tsx`
- Modify: `ui/src/components/layout/app-shell.tsx`
- Modify: `ui/src/components/layout/app-shell.test.tsx`
- Modify: `ui/src/components/fleet/fleet-filters.tsx`
- Modify: `ui/src/components/fleet/fleet-filters.test.tsx`

- [ ] **Step 1: Write failing provider behavior tests**

Prove the provider parses scope once, exposes `patchScope`, retains selected-but-unavailable facet values, cancels or ignores stale facet responses, leaves URL state intact after failure, and offers Retry. Render shell plus Applications and assert only one TanStack map request exists when group/search/filter inputs match.

- [ ] **Step 2: Run provider tests red**

Run: `rtk npm --prefix ui test -- src/lib/fleet-scope-context.test.tsx src/lib/use-fleet-data.test.tsx src/components/fleet/fleet-filters.test.tsx`

Expected: provider module missing and duplicate ownership assertions failing.

- [ ] **Step 3: Implement shared state and stable query keys**

Build the map query key from the serialized RPC request only; never include presentation names such as `heatmap` or `treemap` because both consume the same response. Keep the provider route-local and cancellable. Remove Project/Cluster/Stage/Namespace editing from `FleetFilters`; it may display a read-only scope summary.

- [ ] **Step 4: Mount the provider once in `AppShell`**

Loading keeps selected values removable. Failure shows retry and never replaces authorized facets with an authoritative empty array. Unavailable selected values remain marked until the user removes them.

- [ ] **Step 5: Run provider and shell tests green**

Run: `rtk npm --prefix ui test -- src/lib/fleet-scope-context.test.tsx src/lib/use-fleet-data.test.tsx src/components/fleet/fleet-filters.test.tsx src/components/layout/app-shell.test.tsx`

Expected: one map cache entry for identical semantic requests and no duplicate global scope controls.

- [ ] **Step 6: Commit the provider increment**

```text
feat(ui): centralize fleet scope and facet state
```

### Task 5: Replace the static scope bar with accessible controls

**Files:**
- Create: `ui/src/components/layout/scope-multiselect.tsx`
- Create: `ui/src/components/layout/scope-multiselect.test.tsx`
- Modify: `ui/src/components/layout/scope-bar.tsx`
- Modify: `ui/src/components/layout/app-shell.test.tsx`

- [ ] **Step 1: Write interaction and accessibility tests**

Cover trigger summaries (`All`, one value, `first +N`), canonical identity collision labels, type-ahead, facet counts, checkbox state, Select all visible, Clear, Clear scope, selected-unavailable rows, loading/failure/retry, Escape, arrows, Enter/Space, focus return, and narrow horizontal scrolling. Assert accessible names include dimension, selection, and result count.

- [ ] **Step 2: Run the component tests red**

Run: `rtk npm --prefix ui test -- src/components/layout/scope-multiselect.test.tsx src/components/layout/app-shell.test.tsx`

Expected: missing interactive control failures.

- [ ] **Step 3: Implement Project, Cluster, Stage, and Namespace controls**

Use canonical `namespace/name` values for Project and Cluster, scalar values for Stage and Namespace, the shared provider for all changes, and `patchFleetSearchParams(..., { scopeChanged: true })` for URL mutation. Do not reconcile URL selections merely because facets are loading or failed.

- [ ] **Step 4: Run component tests green**

Run: `rtk npm --prefix ui test -- src/components/layout/scope-multiselect.test.tsx src/components/layout/app-shell.test.tsx`

Expected: keyboard, focus, counts, unavailable selections, and mobile behavior pass.

- [ ] **Step 5: Commit the scope UI increment**

```text
feat(ui): make fleet scope interactive
```

### Task 6: Apply shared scope to Releases, Rollouts, and Pipelines

**Files:**
- Modify: `proto/paprika/v1/api.proto`
- Modify: `internal/api/fleet_contract_test.go`
- Modify: `internal/api/pipeline_handler_test.go`
- Modify: `internal/api/server.go`
- Generated: `internal/api/paprika/v1/api.pb.go`
- Generated: `ui/src/gen/paprika/v1/api_pb.{js,d.ts}`
- Create: `ui/src/lib/fleet-resource-scope.ts`
- Create: `ui/src/lib/fleet-resource-scope.test.ts`
- Modify: `ui/src/app/dashboard/page.tsx`
- Modify: `ui/src/app/dashboard/__tests__/dashboard-refresh.test.tsx`
- Modify: `ui/src/app/dashboard/releases/page.tsx`
- Modify: `ui/src/app/dashboard/releases/page.test.tsx`
- Modify: `ui/src/app/dashboard/rollouts/page.tsx`
- Create: `ui/src/app/dashboard/rollouts/page.test.tsx`

- [ ] **Step 1: Write failing Pipeline contract and server tests**

Add the additive `Pipeline.project = 9` descriptor assertion. In `pipeline_handler_test.go`, seed Pipelines in multiple namespaces with different `app.paprika.io/project` labels. Prove `ListPipelinesRequest.namespace` and `.project` intersect, unauthorized projects remain absent, unlabeled Pipelines do not match a selected project, and the response carries the exact label value.

- [ ] **Step 2: Run Pipeline API tests red**

Run: `rtk go test ./internal/api -run 'Test(FleetDescriptor|ListPipelines.*Project)' -count=1`

Expected: missing field and currently ignored `request.project` assertions fail.

- [ ] **Step 3: Add the minimal Pipeline project path**

Append `string project = 9` to `Pipeline`, filter `ListPipelines` by `app.paprika.io/project` when `request.project` is non-empty, and populate the response from the same authorized label. Do not expose arbitrary labels.

- [ ] **Step 4: Regenerate and run Pipeline API tests green**

Run: `rtk make generate-proto`

Run: `rtk go test ./internal/api -run 'Test(FleetDescriptor|ListPipelines.*Project)' -count=1`

Expected: namespace/project intersection, authorization, and additive wire tests pass.

- [ ] **Step 5: Write failing association/filter UI tests**

Prove Releases pass all four dimensions to `QueryReleases`. For Rollouts, flatten Application identities plus compact metadata from the complete shared `QueryFleetMap` result, build a Release join keyed by exact `namespace/rollout_ref`, then join `Release.application` to the exact namespaced map leaf; Namespace matches directly and Project/Cluster/Stage match through that Application. Zero or multiple Release matches are treated as unassociated, and an unassociated Rollout is omitted whenever a non-empty unsupported dimension is selected. Assert the association input count equals the complete map leaf count so a paginated `QueryApplications` page can never become the join source. For Pipelines, selected canonical projects become `{ namespace: project.namespace, project: project.name }` List requests, multiple selected projects/namespaces merge and de-duplicate stable identities, and Cluster/Stage remain only in navigation state.

- [ ] **Step 6: Run resource-scope tests red**

Run: `rtk npm --prefix ui test -- src/lib/fleet-resource-scope.test.ts src/app/dashboard/releases/page.test.tsx src/app/dashboard/rollouts/page.test.tsx src/app/dashboard/__tests__/dashboard-refresh.test.tsx`

Expected: current unscoped `listPipelines({})`/`listRollouts({})`, missing Release join, and unsupported association behavior fail.

- [ ] **Step 7: Implement pure Pipeline request planning and Rollout association matching**

```ts
export function planPipelineScopeRequests(scope: FleetScope): readonly ListPipelinesRequest[]
export function mergeScopedPipelines(responses: readonly Pipeline[][]): readonly Pipeline[]

export function flattenMapApplicationAssociations(
  roots: readonly FleetMapNode[],
): readonly FleetMapApplicationAssociation[]

export function buildRolloutApplicationAssociations(
  rollouts: readonly Rollout[],
  releases: readonly Release[],
  applications: readonly FleetMapApplicationAssociation[],
): ReadonlyMap<string, FleetMapApplicationAssociation>

export function rolloutMatchesFleetScope(
  rollout: Rollout,
  associatedApplication: FleetMapApplicationAssociation | undefined,
  scope: FleetScope,
): boolean
```

Use canonical Project identities and exact namespaced joins. Never guess across duplicate rollout refs or show an unassociated resource as a match for a selected dimension it cannot prove. Keep the existing ListPipelines RPC; do not add a new Pipeline fleet-query API in this increment.

- [ ] **Step 8: Wire each page to the same parsed scope**

Pass all four dimensions to `QueryReleases`; fetch the Release fields needed for the explicit Rollout join; flatten associations from the complete shared map response rather than `QueryApplications`; and execute the planned Pipeline Namespace/Project requests. Preserve all four dimensions in every link regardless of which subset that resource model can consume.

- [ ] **Step 9: Run resource-scope tests green**

Run: `rtk npm --prefix ui test -- src/lib/fleet-resource-scope.test.ts src/app/dashboard/releases/page.test.tsx src/app/dashboard/rollouts/page.test.tsx src/app/dashboard/__tests__/dashboard-refresh.test.tsx`

Expected: association rules, unsupported-scope omission, and Pipeline limitations match the approved spec.

- [ ] **Step 10: Commit the resource-scope increment**

```text
feat(ui): apply fleet scope across operational resources
```

### Task 7: Build deterministic complete heatmap geometry

**Files:**
- Create: `ui/src/components/fleet/heatmap-layout.ts`
- Create: `ui/src/components/fleet/heatmap-layout.test.ts`

- [ ] **Step 1: Write property-oriented failing tests**

For empty, 1, 250, and 10,000-leaf forests, compare the exact sorted input/output stable-ID multisets. Assert no duplicate rectangles, deterministic ordering/digest, equal cell size, stable group bands, density thresholds, complete virtual height, visible-band clipping, and edge/corner hit testing. Include shuffled input and resized viewport cases.

- [ ] **Step 2: Run layout tests red**

Run: `rtk npm --prefix ui test -- src/components/fleet/heatmap-layout.test.ts`

Expected: module-not-found failure.

- [ ] **Step 3: Implement one pure layout function**

```ts
export interface HeatmapLayoutInput {
  roots: readonly FleetMapNode[]
  width: number
  viewportHeight: number
  scrollTop: number
  density: FleetDensity
  labels: FleetLabelMode
  sort: FleetSortField
  direction: FleetSortDirection
}

export interface HeatmapLayoutResult {
  cells: readonly HeatmapCellRect[]       // one per Application leaf
  visibleCells: readonly HeatmapCellRect[]
  groups: readonly HeatmapGroupBand[]
  virtualHeight: number
  inputCount: number
  layoutCount: number
  digest: string                          // sorted stable-ID multiset
}
```

Auto chooses the largest complete cell size down to 6 px; all densities return complete geometry and use virtual scrolling when needed. Sort by severity then namespace/name for the default sort, and prove every explicit sort/direction changes spatial order deterministically.

- [ ] **Step 4: Run layout tests green and repeat for determinism**

Run: `rtk npm --prefix ui test -- src/components/fleet/heatmap-layout.test.ts`

Run: `rtk npm --prefix ui test -- src/components/fleet/heatmap-layout.test.ts`

Run: `rtk npm --prefix ui test -- src/components/fleet/heatmap-layout.test.ts`

Expected: exact-multiset and digest cases pass identically across repeats.

- [ ] **Step 5: Commit the layout increment**

```text
feat(ui): add deterministic complete heatmap layout
```

### Task 8: Render and interact with the virtualized Canvas heatmap

**Files:**
- Create: `ui/src/components/fleet/fleet-health-heatmap.tsx`
- Create: `ui/src/components/fleet/fleet-health-heatmap.test.tsx`
- Reuse: `ui/src/components/fleet/treemap-navigation.ts`
- Reuse: `ui/src/components/fleet/treemap-presentation.ts`

- [ ] **Step 1: Write failing renderer tests**

Mock Canvas and ResizeObserver. Assert viewport-only painting, health color plus glyph/pattern, group counts/distributions, bounded tooltip metadata, hover/focus synchronization, spatial arrows, Escape, Enter detail navigation, label modes, and Table fallback after Canvas failure. Assert the host exposes exactly these non-identity oracles:

```tsx
data-heatmap-input-count={layout.inputCount}
data-heatmap-layout-count={layout.layoutCount}
data-heatmap-layout-digest={layout.digest}
```

For 10,000 Applications, assert the component does not create one interactive DOM node per Application.

- [ ] **Step 2: Run renderer tests red**

Run: `rtk npm --prefix ui test -- src/components/fleet/fleet-health-heatmap.test.tsx`

Expected: component-not-found failure.

- [ ] **Step 3: Implement Canvas, semantic focus, and fallback**

Reuse the existing palette, hit-test conventions, legend, and detail-link helper. Keep only the active cell and group summaries in the semantic layer; provide a route to the complete Table view. Repaint visible bands on resize/scroll and never allocate a bitmap at virtual-content height.

- [ ] **Step 4: Run renderer and navigation tests green**

Run: `rtk npm --prefix ui test -- src/components/fleet/fleet-health-heatmap.test.tsx src/components/fleet/treemap-navigation.test.ts`

Expected: interaction, accessibility, fallback, and bounded-DOM assertions pass.

- [ ] **Step 5: Commit the renderer increment**

```text
feat(ui): render complete fleet health heatmap
```

### Task 9: Integrate Heatmap without sampling or duplicate fetches

**Files:**
- Modify: `ui/src/lib/use-fleet-data.ts`
- Modify: `ui/src/lib/use-fleet-data.test.tsx`
- Modify: `ui/src/components/fleet/fleet-view.tsx`
- Modify: `ui/src/components/fleet/fleet-view.test.tsx`
- Modify: `ui/src/components/fleet/fleet-filters.tsx`
- Modify: `ui/src/components/dashboard/dashboard-health-map.tsx`
- Modify: `ui/src/components/dashboard/dashboard-health-map.test.tsx`
- Modify: `ui/src/components/dashboard/dashboard-command-center.tsx`
- Modify: `ui/src/components/dashboard/dashboard-command-center.test.tsx`
- Modify: `ui/src/components/fleet/fleet-overview.tsx`
- Modify: `ui/src/components/fleet/fleet-overview.test.tsx`
- Modify: `ui/src/app/dashboard/page.tsx`

- [ ] **Step 1: Write failing integration tests**

Assert Overview defaults to a complete Health-grouped heatmap, Applications defaults remain Project-grouped Treemap, presentation switches retain all query state, Heatmap and Treemap share the identical `QueryFleetMap` cache key, and the attention queue alone uses `QueryApplications`. Remove every eight-card/preview expectation. Cover empty scoped fleet, failed map with Retry plus Table fallback, and other dashboard panels remaining usable.

- [ ] **Step 2: Run integration tests red**

Run: `rtk npm --prefix ui test -- src/lib/use-fleet-data.test.tsx src/components/fleet/fleet-view.test.tsx src/components/fleet/fleet-overview.test.tsx src/components/dashboard/dashboard-health-map.test.tsx src/components/dashboard/dashboard-command-center.test.tsx`

Expected: current sampled dashboard and presentation-key assertions fail.

- [ ] **Step 3: Wire both visualizations to the same complete map result**

Remove presentation names from map request/cache state. Replace the dashboard's paginated card input with `FleetHealthHeatmap`; keep the impact-ranked list as the separate attention queue. Add Heatmap/Density/Labels/Namespace options without hiding Treemap size metric or Matrix axes.

- [ ] **Step 4: Run integration tests green**

Run: `rtk npm --prefix ui test -- src/lib/use-fleet-data.test.tsx src/components/fleet/fleet-view.test.tsx src/components/fleet/fleet-overview.test.tsx src/components/dashboard/dashboard-health-map.test.tsx src/components/dashboard/dashboard-command-center.test.tsx`

Expected: Overview and Applications both prove complete map ownership with no preview cap.

- [ ] **Step 5: Commit the integration increment**

```text
feat(ui): use complete heatmap across fleet dashboard
```

### Task 10: Expand the deterministic 250-Application fixture

**Files:**
- Modify: `test/fleetconsole/seed.go`
- Modify: `test/fleetconsole/seed_test.go`
- Modify: `test/fleetconsole/server_test.go`

- [ ] **Step 1: Write failing fixture invariants**

Assert exact totals and repeatability across two builds: 250 Applications; 12 namespaces; at least four AppProjects; multiple actual clusters and stages; Healthy, Progressing, Degraded, Failed, Unknown, and Missing; complete, active, failed, and gated Releases/Rollouts; deterministic Pipelines carrying the exact `app.paprika.io/project` label consumed by `ListPipelines`; stable UIDs/timestamps/order; no duplicate stable IDs; and exactly one map Application leaf per Application.

- [ ] **Step 2: Run fixture tests red**

Run: `rtk go test ./test/fleetconsole -count=1`

Expected: absent Pipeline/multi-stage/six-health-state assertions fail.

- [ ] **Step 3: Seed associated Kubernetes-style objects**

Generate one stable Pipeline → Application → Stage → Release → Rollout association per fixture record, with the Pipeline and every downstream project-aware object carrying the canonical project label. Exercise the real projection and `PaprikaServer`; do not inject browser-only map JSON or special-case the handler.

- [ ] **Step 4: Run fixture tests and build green**

Run: `rtk go test ./test/fleetconsole -count=1`

Run: `rtk go build -o bin/fleet-console-fixture ./test/fleetconsole`

Expected: deterministic invariants pass and the fixture binary builds.

- [ ] **Step 5: Commit the fixture increment**

```text
test(fixture): seed complete deterministic fleet data
```

### Task 11: Prove local completeness and responsive behavior in a real browser

**Files:**
- Create: `ui/e2e/helpers/fleet-map-oracle.ts`
- Create: `ui/e2e/helpers/runtime-audit.ts`
- Create: `hack/test-fleet-console.sh`
- Modify: `ui/playwright.config.ts`
- Modify: `ui/package.json`
- Modify: `ui/e2e/fleet-console.spec.ts`
- Modify: `ui/e2e/fleet-responsive.spec.ts`
- Modify: `ui/e2e/fleet-scale.spec.ts`
- Modify: `.github/workflows/test.yml`

- [ ] **Step 1: Write an independent response oracle**

Intercept successful `/paprika.v1.PaprikaService/QueryFleetMap` responses, recursively flatten Application leaves, and assert:

1. `response.total` equals raw Application-leaf count.
2. Raw count equals unique stable-ID count.
3. Host input count equals intercepted count.
4. Host layout count equals intercepted count.
5. Host digest equals the digest of the sorted intercepted stable-ID multiset.

- [ ] **Step 2: Make Playwright configuration externally addressable**

Support `PAPRIKA_E2E_BASE_URL`, `PLAYWRIGHT_NO_WEBSERVER=1`, `PAPRIKA_E2E_TRACE=on`, and optional fixture port/output directory. The shell harness must refuse to kill or reuse an independently owned listener and clean only the PID it starts.

- [ ] **Step 3: Replace obsolete preview tests with end-to-end acceptance coverage**

Cover scope changes and metadata membership, scope persistence through Overview/Applications/Releases/Rollouts/Pipelines/all four details/back navigation, all 250 cells, five presentations, grouping/density/labels/sort/direction, pointer and keyboard interaction, empty/loading/map failure/retry/Table fallback, and no console/page/request/Connect errors or `/events` requests.

- [ ] **Step 4: Add the responsive and scale matrix**

Run Overview, all Applications views, Releases, Rollouts, Pipelines, and Application detail at 1440×900, 768×1024, and 390×844. Assert no document horizontal overflow and focused controls remain visible. At 10,000 Applications, assert exact oracle count/digest and bounded DOM nodes.

- [ ] **Step 5: Run the local browser gate**

Run: `rtk bash hack/test-fleet-console.sh`

Expected: the harness builds UI/fixture, uses a free loopback port, runs Chromium console and responsive suites, and tears down only its own process.

- [ ] **Step 6: Run explicit multi-mode Playwright coverage**

Run: `rtk proxy env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- e2e/fleet-console.spec.ts e2e/fleet-responsive.spec.ts --project=chromium --project=chromium-reduced-motion --project=chromium-keyboard-only`

Expected: all projects pass with zero uncaught runtime failures.

- [ ] **Step 7: Add both fleet suites and artifacts to CI**

Update `.github/workflows/test.yml` to run console plus responsive specs and upload `ui/test-results` and `ui/playwright-report` under `if: always()`.

- [ ] **Step 8: Run the chunk verification set**

Run: `rtk go test ./internal/fleet ./internal/api ./test/fleetconsole -count=1`

Run: `rtk npm --prefix ui test`

Run: `rtk npm --prefix ui run lint`

Run: `rtk npm --prefix ui run build`

Run: `rtk bash hack/test-fleet-scale.sh`

Expected: all commands pass; the scale gate reports complete 10,000-leaf Canvas geometry.

- [ ] **Step 9: Commit the browser and CI gate**

```text
test(ui): validate scoped complete fleet heatmap
```

---

## Chunk 2: Kubernetes-Verified Pod-Local Admin Dashboard

### Chunk boundary

This chunk is complete when API-capable Paprika pods can optionally run a fixed `127.0.0.1:3001` listener, a reviewed Kubernetes identity can exchange for a short-lived pod-bound session, `paprika admin dashboard` can own the port-forward and token-injecting local proxy, the UI visibly marks that session, and structural chart tests prove port 3001 is not publicly exposed. It does not deploy the image to omega VKE. Chunk 3 is a mandatory continuation before the feature can be called complete: it builds linux/amd64, deploys immutable images, applies isolated labelled live fixtures, runs the real CLI with JSON readiness, proves public auth versus admin success with the same Connect call, executes live Playwright, captures evidence, and rolls back on any post-upgrade gate failure.

### File structure

- `internal/api/admin/session.go` — in-memory opaque-session lifecycle only.
- `internal/api/admin/kubernetes.go` — TokenReview, Pod read, and exact SubjectAccessReview only.
- `internal/api/admin/security.go` — loopback Host and mutation Origin policy only.
- `internal/api/admin/context.go` — private context marker, principal installation, and authorizer wrapper.
- `internal/api/admin/http.go` — exchange/session endpoints and admin-only handler composition.
- `internal/api/admin/listener.go` — literal loopback bind validation and server lifecycle.
- `cmd/main_admin.go` — server-mode assembly for API/operator processes only.
- `cmd/paprika/admin_kubernetes.go` — kubeconfig, discovery, access review, and client-go forwarding.
- `cmd/paprika/admin_session.go` — exchange, description, rotation, and revocation client.
- `cmd/paprika/admin_proxy.go` — browser-facing loopback reverse proxy only.
- `cmd/paprika/admin_dashboard.go` — Cobra orchestration/output/lifecycle only.
- `charts/chart/templates/rbac/admin-dashboard.yaml` — dedicated eligible ServiceAccount and review-only RBAC.
- `ui/src/lib/admin-session-context.tsx` — fail-safe session-status probe.
- `ui/src/components/layout/admin-session-banner.tsx` — persistent marked/unknown presentation.

### Task 12: Implement the in-memory admin session state machine

**Files:**
- Create: `internal/api/admin/session.go`
- Create: `internal/api/admin/session_test.go`

- [ ] **Step 1: Write failing table and concurrency tests**

Inject `Clock` and `TokenSource`. Cover a 32-byte cryptographically random token, create/validate, real reviewed subject/groups/extras, pod UID binding, 10-minute idle expiry, 30-minute absolute expiry, access-mode description, validation extending idle but never absolute lifetime, wrong pod/token, atomic rotation, old-token invalidation, authenticated revocation, already-expired revocation, and concurrent validate/rotate/revoke under `go test -race`. Assert token values never appear in `SessionDescription`, errors, or formatted values.

- [ ] **Step 2: Run the store tests red**

Run: `rtk go test ./internal/api/admin -run TestStore -count=1`

Expected: package or symbols do not exist.

- [ ] **Step 3: Implement a lock-protected store**

```go
const AccessMode = "kubernetes-port-forward-admin"

type ReviewedIdentity struct {
    Username string
    Groups   []string
    Extra    map[string][]string
}

type SessionDescription struct {
    Subject      string    `json:"subject"`
    AccessMode   string    `json:"accessMode"`
    IdleExpires  time.Time `json:"idleExpiresAt"`
    AbsoluteEnds time.Time `json:"absoluteExpiresAt"`
    PodUID       types.UID `json:"-"`
}
```

Return the raw base64url token only from create/rotate. Store a one-way SHA-256 lookup key rather than the raw token, compare fixed-size hashes, clone slices/maps defensively, prune expired records under the same lock, and make rotation create-and-invalidate one atomic operation.

- [ ] **Step 4: Run deterministic and race tests green**

Run: `rtk go test ./internal/api/admin -run TestStore -count=1`

Run: `rtk go test -race ./internal/api/admin -run TestStore -count=1`

Expected: lifetime, concurrency, secrecy, and rotation invariants pass.

- [ ] **Step 5: Commit the session core**

```text
feat(admin): add short-lived pod-bound session store
```

### Task 13: Verify Kubernetes identity and exact pod port-forward authority

**Files:**
- Create: `internal/api/admin/kubernetes.go`
- Create: `internal/api/admin/kubernetes_test.go`
- Create: `internal/api/admin/security.go`
- Create: `internal/api/admin/security_test.go`

- [ ] **Step 1: Write fail-closed verifier tests**

Use narrow fake interfaces for TokenReview, SubjectAccessReview, and Pod Get. Cover this exact order and outcome:

1. Required Downward API identity is complete.
2. The live Pod UID and ServiceAccount exactly match environment identity.
3. Regular containers are exactly the configured eligible allowlist; an injected sidecar, missing expected container, duplicate, or terminating Pod disables exchange.
4. TokenReview is authenticated and returns a non-empty username.
5. Paprika's own `system:serviceaccount:<namespace>:<service-account>` identity is rejected.
6. SubjectAccessReview receives the reviewed username/groups/extras and exact attributes `verb=create`, core group, `resource=pods`, `subresource=portforward`, selected namespace/name.
7. API error, denied, or indeterminate review fails closed.

Assert the presented bearer never appears in errors/log output.

- [ ] **Step 2: Write Host and Origin tests**

Accept only a canonical `127.0.0.1:<port>` Host. Reject `localhost`, IPv6, wildcard, missing/invalid ports, user-info, forwarded host headers, and non-loopback IPs. For mutation requests, require the local browser proxy's same-origin check and rewrite contract; reject foreign/malformed Origin before exchange, rotation, revocation, or mutating Connect calls.

- [ ] **Step 3: Run verifier/security tests red**

Run: `rtk go test ./internal/api/admin -run 'Test(KubernetesReview|PodIdentity|Host|Origin)' -count=1`

Expected: missing verifier and policy failures.

- [ ] **Step 4: Implement the narrow Kubernetes verifier**

Use `authentication.k8s.io/v1.TokenReview`, `authorization.k8s.io/v1.SubjectAccessReview`, and `CoreV1().Pods(namespace).Get`. Do not trust loopback, client-supplied usernames, pod labels, or an SSAR result supplied by the CLI. Preserve TokenReview extras in the SAR and session record.

- [ ] **Step 5: Run verifier/security tests green**

Run: `rtk go test ./internal/api/admin -run 'Test(KubernetesReview|PodIdentity|Host|Origin)' -count=1`

Expected: exact resource-name review and every fail-closed case pass.

- [ ] **Step 6: Commit the verifier**

```text
feat(admin): verify kubernetes identity and pod forwarding access
```

### Task 14: Install an unforgeable admin context and audited real principal

**Files:**
- Create: `internal/api/admin/context.go`
- Create: `internal/api/admin/context_test.go`
- Modify: `internal/audit/audit.go`
- Modify: `internal/audit/audit_test.go`
- Modify: `internal/api/audit_middleware.go`
- Modify: `internal/api/audit_middleware_test.go`

- [ ] **Step 1: Write failing context/authorizer tests**

Prove no header, cookie, query parameter, protobuf field, or caller-created `auth.Principal` can activate admin authorization. Only `WithValidatedSession` inside the package installs the private marker and principal `Subject: kubernetes:<reviewed-username>`. `AdminAwareAuthorizer.Authorize` and `.AuthorizedProjects` allow all candidates only with that marker and otherwise delegate exactly once to the ordinary authorizer.

- [ ] **Step 2: Write failing audit tests**

For a mutating RPC under a validated session, require `Principal=kubernetes:<username>` and `Extra["access_mode"]="kubernetes-port-forward-admin"`; ordinary audit records retain current behavior. Assert no session or Kubernetes bearer token reaches the event or broker payload.

- [ ] **Step 3: Run context/audit tests red**

Run: `rtk go test ./internal/api/admin ./internal/api -run 'Test(AdminContext|AdminAwareAuthorizer|Audit.*AccessMode)' -count=1`

Expected: private marker, wrapper, and audit attribute are absent.

- [ ] **Step 4: Implement context, wrapper, and audit attribute**

Keep the context key and marker type unexported. Expose only validation-derived helpers. Extend `audit.Event.Extra`; do not add the access mode to browser-controlled request metadata.

- [ ] **Step 5: Run context/audit tests green**

Run: `rtk go test ./internal/api/admin ./internal/api ./internal/audit -run 'Test(AdminContext|AdminAwareAuthorizer|Audit.*AccessMode)' -count=1`

Expected: both authorizer methods and real-subject audit semantics pass.

- [ ] **Step 6: Commit the context boundary**

```text
feat(admin): install audited verified-session authorization
```

### Task 15: Compose the isolated admin HTTP surface and listener lifecycle

**Files:**
- Create: `internal/api/admin/http.go`
- Create: `internal/api/admin/http_test.go`
- Create: `internal/api/admin/listener.go`
- Create: `internal/api/admin/listener_test.go`
- Create: `cmd/main_admin.go`
- Create: `cmd/main_admin_test.go`
- Modify: `cmd/main.go`
- Modify: `cmd/main_operator.go`
- Modify: `cmd/main_test.go`

- [ ] **Step 1: Write endpoint-matrix tests**

Assert these exact results:

| Listener/path | No session | Valid session |
| --- | --- | --- |
| Admin `/healthz`, `/readyz` | 200 when checker is ready | 200 |
| Admin `POST /admin/session/exchange` | reviewed exchange or 401/403 | atomic rotation |
| Admin `GET /admin/session` | 401 | non-secret description |
| Admin `DELETE /admin/session` | 401 | 204 and immediate revocation |
| Admin UI asset / Connect RPC | 401 | served/called with verified context |
| Admin `/events` | 404 | 404 |
| Normal `/admin/session*` | 404 | 404 even with admin header |
| Normal unauthenticated Connect | current 401 | current Paprika auth only |

Also cover expired/wrong-pod/old-rotation tokens, content types, body limits, no-store headers on session responses, and Host/Origin enforcement.

- [ ] **Step 2: Write listener and mode tests**

Prove the only remote address is literal `127.0.0.1:3001`, binding happens synchronously so address-in-use fails startup, context cancellation closes both listeners, an unexpected admin exit fails the process lifecycle, and `--admin-dashboard-enabled` is rejected for webhook, repo-server, and agent modes. There is no host/port flag.

- [ ] **Step 3: Run HTTP/lifecycle tests red**

Run: `rtk go test ./internal/api/admin ./cmd -run 'Test(AdminHTTP|AdminDashboard|NormalListener|AdminListener)' -count=1`

Expected: endpoint and second-listener symbols are absent.

- [ ] **Step 4: Build a separate admin PaprikaServer**

Reuse Kubernetes clients, renderer/evaluator dependencies, fleet reader, broker, readiness checker, static UI, OTel interceptor, and auditor, but create a distinct `PaprikaServer` with `AdminAwareAuthorizer`. Install session validation before both Connect and static handlers. Never mutate or reuse the normal server's authorizer/interceptor chain.

- [ ] **Step 5: Add the fixed listener to API and operator lifecycle groups**

Parse only `--admin-dashboard-enabled`. Load required `POD_NAMESPACE`, `POD_NAME`, `POD_UID`, `POD_SERVICE_ACCOUNT`, and `PAPRIKA_ADMIN_EXPECTED_CONTAINER`; missing identity fails the admin listener without weakening the normal listener. Bind before announcing readiness and join the existing cancellation/error lifecycle.

- [ ] **Step 6: Make the normal path explicitly fail closed**

Register `/admin/session` and `/admin/session/` as Not Found before the normal SPA fallback. Keep `/events` explicitly Not Found on both surfaces.

- [ ] **Step 7: Run HTTP/lifecycle and auth regression tests green**

Run: `rtk go test ./internal/api/admin ./internal/api/auth ./internal/api ./cmd -run 'Test(AdminHTTP|AdminDashboard|NormalListener|AdminListener|Auth)' -count=1`

Expected: endpoint matrix passes and ordinary authentication behavior is unchanged.

- [ ] **Step 8: Commit the listener**

```text
feat(admin): add isolated verified-session dashboard listener
```

### Task 16: Discover an eligible pod and establish a client-go port-forward

**Files:**
- Create: `cmd/paprika/admin_kubernetes.go`
- Create: `cmd/paprika/admin_kubernetes_test.go`
- Create: `cmd/paprika/admin_dashboard.go`
- Create: `cmd/paprika/admin_dashboard_test.go`
- Modify: `cmd/paprika/main.go`

- [ ] **Step 1: Write command/flag/output validation tests**

Add `paprika admin dashboard` with `--kubeconfig`, `--context`, `--namespace`, `--release`, `--port`, `--no-open`, and `--timeout`. Default local port is 0 and timeout is 30s. Reject YAML before Kubernetes access; JSON emits exactly one readiness object to stdout while progress/warnings use stderr.

- [ ] **Step 2: Write kubeconfig credential tests**

Support static bearer and exec/OIDC bearer credentials. Prove a client-certificate-only or request-signing-only context fails before pod discovery/browser launch with actionable guidance. Build the exchange request through client-go's bearer/exec auth wrappers over a supplied loopback RoundTripper; never print or persist the resulting Authorization value.

- [ ] **Step 3: Write discovery and SSAR tests**

List standard chart labels, exclude terminating/unready pods, prefer ready `app.kubernetes.io/component=api-server`, fall back to ready `control-plane=controller-manager`, choose newest creation timestamp then pod name, and fail with valid release names when multiple `app.kubernetes.io/instance` values are present without `--release`. Require successful SelfSubjectAccessReview for exact `create pods/portforward` on the selected pod name/namespace; denied/error/indeterminate is fatal.

- [ ] **Step 4: Write port-forward lifecycle tests with injected transport**

Prove `spdy.RoundTripperFor`, `spdy.NewDialer`, and `portforward.NewOnAddresses` bind only `127.0.0.1`, map an ephemeral hidden local port to fixed remote 3001, expose the chosen port only after the ready channel, and stop every goroutine on context cancellation/error.

- [ ] **Step 5: Run CLI Kubernetes tests red**

Run: `rtk go test ./cmd/paprika -run 'TestAdmin(DashboardFlags|Kubeconfig|Discovery|AccessReview|PortForward)' -count=1`

Expected: command and injected Kubernetes workflow are absent.

- [ ] **Step 6: Implement discovery and forwarding behind narrow dependencies**

Inject kubeconfig loader, Pod lister, SSAR client, credential RoundTripper factory, forwarder, clock, and outputs. The command must not invoke `kubectl`, create a Kubernetes object, or select an ambiguous installation.

- [ ] **Step 7: Run CLI Kubernetes tests green**

Run: `rtk go test ./cmd/paprika -run 'TestAdmin(DashboardFlags|Kubeconfig|Discovery|AccessReview|PortForward)' -count=1`

Expected: bearer-capable contexts, deterministic discovery, exact SSAR, and cancellation pass.

- [ ] **Step 8: Commit pod discovery and forwarding**

```text
feat(cli): discover and forward the admin dashboard pod
```

### Task 17: Own exchange, proxy injection, rotation, and shutdown

**Files:**
- Create: `cmd/paprika/admin_session.go`
- Create: `cmd/paprika/admin_session_test.go`
- Create: `cmd/paprika/admin_proxy.go`
- Create: `cmd/paprika/admin_proxy_test.go`
- Modify: `cmd/paprika/admin_dashboard.go`
- Modify: `cmd/paprika/admin_dashboard_test.go`
- Modify: `go.mod`
- Modify: `go.sum`

- [ ] **Step 1: Write session-client tests**

Through the hidden forward, poll unauthenticated `/readyz`, exchange the kubeconfig bearer, then require authenticated `/admin/session` to echo expected subject/access mode/pod session before readiness. Cover disabled listener, TokenReview/SAR denial, malformed response, wrong subject/mode, timeout, rotation with the current session header, and best-effort revoke.

- [ ] **Step 2: Write reverse-proxy security tests**

Bind only `127.0.0.1`; `--port=0` chooses an ephemeral browser port. Strip any caller `X-Paprika-Admin-Session`, inject the in-memory token upstream, set upstream Host to `127.0.0.1:3001`, reject non-loopback browser Host, enforce same-origin mutations against the browser proxy origin, and rewrite the accepted Origin to the fixed upstream origin. Never forward hop-by-hop or spoofed forwarding headers.

- [ ] **Step 3: Write rotation/shutdown tests with fake clock and browser**

Every five minutes pause new proxy requests, repeat exchange validation, atomically swap the token, and resume. A failed refresh closes the proxy. SIGINT/SIGTERM, context cancellation, tunnel failure, and refresh failure attempt DELETE while the tunnel is alive, zero the local token, close listeners/goroutines, and report revoke failure. Browser-launch failure remains non-fatal and leaves the printed URL usable.

- [ ] **Step 4: Run session/proxy tests red**

Run: `rtk go test ./cmd/paprika -run 'TestAdmin(Session|Proxy|Rotation|Shutdown|Output)' -count=1`

Expected: proxy and lifecycle behavior are absent.

- [ ] **Step 5: Implement the orchestrated workflow**

Use an RW-locked token holder and bounded request pause during rotation. Make `github.com/cli/browser` a direct dependency and inject its opener in tests. The JSON readiness object contains context, namespace, pod, proxy URL, reviewed subject, session expiry, and access mode—never either token.

- [ ] **Step 6: Run session/proxy and race tests green**

Run: `rtk go test ./cmd/paprika -run 'TestAdmin(Session|Proxy|Rotation|Shutdown|Output)' -count=1`

Run: `rtk go test -race ./cmd/paprika -run 'TestAdmin(Session|Proxy|Rotation|Shutdown)' -count=1`

Expected: injection, refresh, cleanup, output, and token-race tests pass.

- [ ] **Step 7: Commit the CLI workflow**

```text
feat(cli): proxy verified admin dashboard sessions
```

### Task 18: Add opt-in chart identity and prove port 3001 is private

**Files:**
- Modify: `charts/chart/values.yaml`
- Modify: `charts/chart/templates/_helpers.tpl`
- Modify: `charts/chart/templates/manager/manager.yaml`
- Modify: `charts/chart/templates/manager/statefulset.yaml`
- Modify: `charts/chart/templates/api-server/deployment.yaml`
- Modify: `charts/chart/templates/rbac/manager-rolebinding.yaml`
- Modify: `charts/chart/templates/rbac/leader-election-rolebinding.yaml`
- Modify: `charts/chart/templates/rbac/metrics-auth-rolebinding.yaml`
- Create: `charts/chart/templates/rbac/admin-dashboard.yaml`
- Create: `charts/chart/tests/admin_dashboard_test.go`
- Create: `hack/test-admin-dashboard-helm.sh`
- Modify: `deploy/test-values.yaml`

- [ ] **Step 1: Write four-mode structural render tests**

Render monolith/split with `adminDashboard.enabled=false/true`. When enabled, require only eligible manager/API containers to receive `--admin-dashboard-enabled`, Downward API namespace/name/UID/ServiceAccount, exact expected-container env, and the dedicated admin-eligible ServiceAccount. Require that ServiceAccount to receive existing operational bindings plus only `create tokenreviews` and `create subjectaccessreviews` review authority.

- [ ] **Step 2: Add global no-exposure assertions**

Across every rendered object, reject 3001 in container ports, Service port/targetPort, Ingress backends, HTTPRoute/Gateway backends, NetworkPolicy ingress, probes, and webhook/repo-server/agent arguments. Inventory regular containers on eligible pods so sidecars cannot be introduced by the chart unnoticed. Assert the review ClusterRole grants no `pods`, `pods/portforward`, secrets, impersonation, or wildcard permissions.

- [ ] **Step 3: Run chart tests red**

Run: `rtk go test ./charts/chart/tests -count=1 -v`

Expected: missing value, identity, RBAC, and eligible arguments fail.

- [ ] **Step 4: Implement opt-in chart wiring**

Add only:

```yaml
adminDashboard:
  enabled: false
```

When enabled, switch eligible manager/API pods to a dedicated ServiceAccount and bind every operational Role/ClusterRole they already require; leave webhook, repo-server, and agent on the existing ServiceAccount. Add the review-only ClusterRole/Binding. Do not declare the port. Set `deploy/test-values.yaml` to enabled for the eventual e2e release.

- [ ] **Step 5: Run structural and lint tests green**

Run: `rtk go test ./charts/chart/tests -count=1 -v`

Run: `rtk bash hack/test-admin-dashboard-helm.sh`

Run: `rtk helm lint charts/chart`

Expected: all four renders pass and every public-exposure scan is clean.

- [ ] **Step 6: Commit the chart isolation**

```text
feat(chart): opt in verified pod-local admin dashboard
```

### Task 19: Mark admin sessions persistently and fail safe on uncertainty

**Files:**
- Create: `ui/src/lib/admin-session-context.tsx`
- Create: `ui/src/lib/admin-session-context.test.tsx`
- Create: `ui/src/components/layout/admin-session-banner.tsx`
- Create: `ui/src/components/layout/admin-session-banner.test.tsx`
- Modify: `ui/src/components/layout/app-shell.tsx`
- Modify: `ui/src/components/layout/app-shell.test.tsx`

- [ ] **Step 1: Write probe-state tests**

At shell startup, 404 means ordinary session and no banner; valid 200 JSON means marked admin; transport timeout/error, malformed 200, or 5xx means unknown. Unknown retries with bounded exponential backoff and remains visibly marked until a valid 200 or explicit 404. Do not infer mode from hostname, auth failure, or URL flags.

- [ ] **Step 2: Write banner accessibility/responsiveness tests**

Admin text is exactly `Kubernetes port-forward admin session · unrestricted Paprika access`, includes reviewed subject and stop-the-CLI reminder, is high contrast, persistent, non-dismissible, keyboard/screen-reader visible, and does not obscure shell controls on mobile. Unknown text is `Session security status unknown` with an immediate Retry action.

- [ ] **Step 3: Run UI session tests red**

Run: `rtk npm --prefix ui test -- src/lib/admin-session-context.test.tsx src/components/layout/admin-session-banner.test.tsx src/components/layout/app-shell.test.tsx`

Expected: probe/context/banner modules are absent.

- [ ] **Step 4: Implement the fail-safe provider and banner**

Use same-origin `fetch("/admin/session", { credentials: "same-origin", cache: "no-store" })`, strict response validation, abortable timeouts, and fake-timer-testable retry scheduling. The UI never receives or stores the opaque session token.

- [ ] **Step 5: Run UI session tests green**

Run: `rtk npm --prefix ui test -- src/lib/admin-session-context.test.tsx src/components/layout/admin-session-banner.test.tsx src/components/layout/app-shell.test.tsx`

Expected: ordinary, marked, uncertain, retry, and responsive states pass.

- [ ] **Step 6: Commit the session marker**

```text
feat(ui): mark kubernetes port-forward admin sessions
```

### Task 20: Run the admin chunk security and build gate

**Files:**
- Modify only files required by failures found in this verification task.

- [ ] **Step 1: Run all focused race/security tests**

Run: `rtk go test -race ./internal/api/admin ./internal/api/auth ./internal/api ./internal/audit ./cmd ./cmd/paprika`

Expected: zero failures or races.

- [ ] **Step 2: Run repository-wide Go tests and lint**

Run: `rtk make test`

Run: `rtk make lint`

Expected: all packages compile/test and static analysis passes; do not rely only on the focused package set.

- [ ] **Step 3: Run chart isolation and UI tests**

Run: `rtk bash hack/test-admin-dashboard-helm.sh`

Run: `rtk helm lint charts/chart`

Run: `rtk npm --prefix ui test`

Run: `rtk npm --prefix ui run lint`

Run: `rtk npm --prefix ui run build`

Expected: chart, unit, lint, and exported UI build pass.

- [ ] **Step 4: Exercise the CLI against a local fake forward**

Add an integration test fixture that owns an httptest admin listener with fake TokenReview/SAR and a fake client-go forwarder. Run the real Cobra command through exchange → description → proxy request → rotation → revoke, assert the normal mock listener remains 401/404, and capture no secrets in stdout/stderr.

Run: `rtk go test ./cmd/paprika -run TestAdminDashboardEndToEnd -count=1 -v`

Expected: the complete CLI-owned lifecycle passes without a Kubernetes cluster.

- [ ] **Step 5: Commit any verification-only corrections**

```text
test(admin): validate verified dashboard isolation
```

---

## Chunk 3: Isolated Live Validation, AMD64 Rollout, and Rollback

### Chunk boundary

This chunk completes the feature only after local mocked browser validation and a real omega VKE rollout both pass. The live gate must use the shipped `paprika admin dashboard` command, not a hand-written `kubectl port-forward`; prove the same unauthenticated Connect call fails on the normal/public listener and succeeds through the admin proxy; validate every accepted fleet presentation and detail route; record image digests and runtime evidence; and automatically restore the previous Helm revision if any post-upgrade security/browser gate fails.

### File structure

- `config/e2e/fleet-admin/base/` — deterministic, run-labelable Paprika CR fixtures only.
- `test/fleetadmin/fixtures_test.go` — fixture identity/association/status invariants.
- `hack/lib/fleet-admin-harness.sh` — process ownership, readiness, evidence, and cleanup primitives.
- `hack/test-fleet-admin-harness.sh` — fake-command lifecycle regression tests.
- `hack/test-fleet-admin-dashboard.sh` — real cluster orchestration only.
- `ui/e2e/fleet-admin-live.spec.ts` — real admin proxy acceptance tests.
- `.github/workflows/build-push.yml` — immutable linux/amd64 image production.
- `.github/workflows/deploy-vke.yml` — atomic upgrade, live gate, evidence, and rollback.
- `artifacts/fleet-admin-live/<run-id>/` — generated evidence; never commit credentials or tokens.

### Task 21: Create deterministic isolated live fixtures

**Files:**
- Create: `config/e2e/fleet-admin/base/kustomization.yaml`
- Create: `config/e2e/fleet-admin/base/projects.yaml`
- Create: `config/e2e/fleet-admin/base/clusters.yaml`
- Create: `config/e2e/fleet-admin/base/applications.yaml`
- Create: `config/e2e/fleet-admin/base/stages.yaml`
- Create: `config/e2e/fleet-admin/base/releases.yaml`
- Create: `config/e2e/fleet-admin/base/rollouts.yaml`
- Create: `config/e2e/fleet-admin/base/pipelines.yaml`
- Create: `test/fleetadmin/fixtures_test.go`
- Create: `test/fleetadmin/guard/main.go`
- Create: `test/fleetadmin/guard/main_test.go`
- Modify: `terraform/github-actions-deployer-rbac.yaml`

- [ ] **Step 1: Write failing rendered-fixture tests**

Render the base and assert unique stable identities, exact namespace-local associations, at least two Projects/Clusters/Stages, all six Application health states, active/complete/failed/gated Releases and Rollouts, and project-labelled Pipelines. Every object must carry `paprika.io/e2e-suite=fleet-admin-dashboard`; no object may use `paprika-e2e` as its fixture namespace. Status documents must be separable so the harness can apply objects first and patch status subresources second.

- [ ] **Step 2: Run fixture tests red**

Run: `rtk go test ./test/fleetadmin -count=1`

Expected: fixture package/manifests do not exist.

- [ ] **Step 3: Implement a small complete live topology**

Use names that the harness can prefix or transform per run. Preserve the same exact association keys used by production: `app.paprika.io/project`, Application identity, Release `application` plus `rollout_ref`, and Pipeline/Stage references. Include valid apiVersions/kinds from the checked-in CRDs. Do not include cluster credentials, external secrets, or a mutable shared namespace.

- [ ] **Step 4: Add a run-specific overlay and namespace-ownership contract**

The harness creates a temporary Kustomize overlay with namespace `paprika-fleet-e2e-<run-id>` and label `paprika.io/e2e-run=<run-id>` using `includeSelectors: false`. It must reject an invalid run ID before invoking Kubernetes. The namespace guard requires the generated name to be NotFound before creation, refuses to adopt any pre-existing namespace, records the UID returned by Create, and deletes only after re-reading the exact UID plus both suite/run labels. Delete uses `DeleteOptions.Preconditions.UID` so a replacement namespace cannot be removed after the check. The committed base remains deterministic; no run-specific generated YAML is committed.

- [ ] **Step 5: Grant only the CI fixture operations it needs**

Extend the existing deployer ClusterRole for create/get/list/watch/patch/delete and `/status` updates on the exact Paprika resources used by this suite, plus create/get/delete on Namespaces. Kubernetes RBAC cannot constrain those verbs by label, so do not claim it can: safety comes from the create-only namespace guard, recorded UID, exact label verification, and UID-preconditioned delete. Retain the existing `create pods/portforward` permission. Do not add secrets, serviceaccounts, roles/bindings, impersonation, or wildcard resources/verbs.

- [ ] **Step 6: Run fixture and RBAC assertions green**

Run: `rtk go test ./test/fleetadmin -count=1`

Run: `rtk go test ./test/fleetadmin/guard -count=1`

Run: `rtk kubectl kustomize config/e2e/fleet-admin/base`

Expected: deterministic manifests render, relationships resolve, and RBAC tests reject broader authority.

- [ ] **Step 7: Commit isolated fixtures**

```text
test(e2e): add isolated fleet admin fixtures
```

### Task 22: Build a CLI-owned live harness with safe cleanup

**Files:**
- Create: `hack/lib/fleet-admin-harness.sh`
- Create: `hack/test-fleet-admin-harness.sh`
- Create: `hack/test-fleet-admin-dashboard.sh`
- Modify: `Makefile`

- [ ] **Step 1: Write failing fake-command lifecycle tests**

With temporary fake `kubectl`, `helm`, `paprika`, `curl`, and `npm` executables, prove the harness:

- Accepts one readiness JSON object and rejects partial/multiple/malformed objects.
- Tracks only PIDs it created and never kills an independently owned listener.
- Captures diagnostics before cleanup.
- Sends SIGINT to its CLI, waits for authenticated revocation, then TERM only after a bounded timeout.
- Deletes only objects matching the run label.
- Deletes the namespace only through the recorded UID/label guard and UID precondition.
- Preserves artifacts and returns the original failing exit code.

- [ ] **Step 2: Run harness lifecycle tests red**

Run: `rtk bash hack/test-fleet-admin-harness.sh`

Expected: scripts do not exist.

- [ ] **Step 3: Implement preflight and isolated apply**

The real harness requires a kubeconfig/context, target namespace/release, public URL, and artifact root. Run and record:

```bash
rtk kubectl --kubeconfig terraform/omega-oidc.kubeconfig auth can-i create pods/portforward -n paprika-e2e
rtk helm status paprika-e2e -n paprika-e2e
rtk kubectl --kubeconfig terraform/omega-oidc.kubeconfig get nodes
```

Build the UID-preconditioned namespace guard, create and record the owned run namespace, apply the temporary overlay, and patch status subresources. Do not query Paprika yet because the normal listener intentionally requires credentials. If any apply/status operation fails, capture Kubernetes diagnostics and clean up through the recorded ownership guard.

- [ ] **Step 4: Start the real CLI and parse its automation contract**

Build `bin/paprika`, start this owned long-running process, and keep stdout/stderr separate:

```bash
rtk make build-cli
rtk proxy ./bin/paprika --output=json admin dashboard --kubeconfig terraform/omega-oidc.kubeconfig --namespace paprika-e2e --release paprika-e2e --port 0 --no-open --timeout 60s
```

Poll stdout for the single readiness JSON object and extract `proxyUrl`, context, namespace, pod, reviewed subject, expiry, and access mode. Never print or grep process environments, kubeconfig credentials, Authorization headers, or the opaque admin header. Only after this authenticated proxy exists, poll fleet-map/release/rollout/pipeline APIs through `$PROXY_URL` until the exact run-labelled set and expected index generation are queryable. If controllers overwrite deterministic status before that snapshot is observed, fail and capture the conflicting object rather than weakening assertions.

- [ ] **Step 5: Prove normal/public auth and admin success with the same request**

Send the same empty `QueryFleetMap` Connect JSON request to `https://paprika.benebsworth.com/paprika.v1.PaprikaService/QueryFleetMap` and `$PROXY_URL/paprika.v1.PaprikaService/QueryFleetMap`. The public response must be HTTP 401/Connect `unauthenticated`; the admin response must be HTTP 200 and contain the selected run namespace. Also create an owned normal pod forward to port 3000 and prove raw port-forwarding alone remains unauthenticated. Store sanitized headers, bodies, and status codes.

- [ ] **Step 6: Implement bounded diagnostics and cleanup**

On success or failure, collect current/previous API and manager logs, namespace events, fixture YAML/status, CLI outputs, and process results before cleanup. Revoke/stop the CLI while its hidden tunnel is alive, stop only the owned normal forward, delete run-labelled objects, then ask the guard to revalidate and UID-delete the owned namespace. Never remove pre-existing fixtures, pods, releases, namespaces, or processes.

- [ ] **Step 7: Run harness unit tests green**

Run: `rtk bash hack/test-fleet-admin-harness.sh`

Expected: readiness, ownership, failure, cleanup, and secret-redaction cases pass.

- [ ] **Step 8: Add a discoverable make target**

Add `make test-fleet-admin-dashboard` as a thin call to the real harness with documented environment inputs; do not duplicate lifecycle logic in Make.

- [ ] **Step 9: Commit the harness**

```text
test(e2e): add safe admin dashboard cluster harness
```

### Task 23: Validate every live view through the admin proxy

**Files:**
- Create: `ui/e2e/fleet-admin-live.spec.ts`
- Modify: `ui/e2e/helpers/fleet-map-oracle.ts`
- Modify: `ui/e2e/helpers/runtime-audit.ts`
- Modify: `ui/playwright.config.ts`
- Modify: `hack/test-fleet-console.sh`
- Modify: `hack/test-fleet-admin-dashboard.sh`

- [ ] **Step 1: Write the live acceptance spec against route stubs first**

Use Playwright routing only to develop deterministic expectations, then run the same spec unmodified against the live proxy. Require the persistent admin banner with reviewed subject/access mode, selected run namespace, exact live fixture leaf count/digest, Project/Cluster/Stage/Namespace scope, Overview, Heatmap/Treemap/Matrix/Table/Queue, Releases, Rollouts, Pipelines, and Application detail.

- [ ] **Step 2: Add desktop/mobile and interaction coverage**

At 1440×900 and 390×844, assert no document-level overflow, scope controls remain operable, cells/tooltips stay within viewport, keyboard focus/Enter/Escape work, detail/back links retain run scope, and the session banner never disappears or covers critical controls.

- [ ] **Step 3: Add live runtime auditing**

Fail on uncaught page/console errors, failed resources, non-2xx Connect responses (except the intentional normal-auth probe outside Playwright), `/events` requests, map count/digest mismatch, sampled preview behavior, or any fixture object outside the selected run namespace appearing in accepted results.

- [ ] **Step 4: Run the spec against an owned local deterministic fixture**

Teach `hack/test-fleet-console.sh` to accept `PAPRIKA_E2E_EXTRA_SPECS` and pass them to Playwright while retaining its free-port/PID ownership rules.

Run: `rtk proxy env PAPRIKA_E2E_EXTRA_SPECS=e2e/fleet-admin-live.spec.ts PAPRIKA_E2E_ADMIN_SESSION_STUB=1 bash hack/test-fleet-console.sh`

Expected: route-stubbed admin marker plus real local fleet APIs pass before cluster deployment. The harness owns a fresh free-port fixture and never stops or replaces an independently running fixture.

- [ ] **Step 5: Wire the real harness Playwright invocation**

```bash
rtk proxy env PLAYWRIGHT_NO_WEBSERVER=1 PAPRIKA_E2E_BASE_URL="$PROXY_URL" PAPRIKA_E2E_RUN_ID="$RUN_ID" PAPRIKA_E2E_TRACE=on npm --prefix ui run test:e2e -- e2e/fleet-admin-live.spec.ts --project=chromium
```

The harness owns the CLI/proxy for the whole browser run and captures screenshots/traces/report even on failure.

- [ ] **Step 6: Commit live browser coverage**

```text
test(e2e): validate all fleet views through admin proxy
```

### Task 24: Make CI produce and verify immutable linux/amd64 images

**Files:**
- Modify: `.github/workflows/build-push.yml`
- Modify: `.github/workflows/test-chart.yml`
- Modify: `.github/workflows/test.yml`
- Create: `test/workflows/workflows_test.go`

- [ ] **Step 1: Write workflow contract tests**

Extend the workflow-validation tests to require `platforms: linux/amd64`, a discovery tag `sha-${{ github.sha }}`, a content digest, an `image-metadata-<sha>` artifact, manifest inspection, both local fleet browser specs, and the admin Helm isolation script. The metadata must contain repository, exact commit SHA, `sha256:` digest, and platform. Reject any Helm deployment by tag, including a `sha-*` tag; deployment must use `repository@sha256:<digest>`.

- [ ] **Step 2: Run workflow tests red**

Run: `rtk go test ./test/workflows -count=1`

Expected: package may need creation; current build workflow lacks explicit linux/amd64 and deployment digest gates.

- [ ] **Step 3: Update build and test workflows**

Build/push `ghcr.io/paprikacd/paprika:{latest,sha-<sha>}` with explicit `linux/amd64`, read the digest emitted by `docker/build-push-action`, and inspect `ghcr.io/paprikacd/paprika@<digest>` to require linux/amd64. Write sanitized `image-metadata.json` containing repository, `${{ github.sha }}`, digest, and platform; upload it as `image-metadata-${{ github.sha }}` so a later `workflow_run` can retrieve it by triggering run ID. Keep the GHA `GITHUB_TOKEN` packages-write path. Make chart CI run `hack/test-admin-dashboard-helm.sh`; make UI CI upload Playwright report/results under `if: always()`.

- [ ] **Step 4: Run workflow and repository checks green**

Run: `rtk go test ./test/workflows -count=1`

Run: `rtk bash hack/test-admin-dashboard-helm.sh`

Run: `rtk bash hack/test-fleet-console.sh`

Expected: workflow contract, chart isolation, and local mocked UI gates pass.

- [ ] **Step 5: Commit the image/CI contract**

```text
ci: build amd64 and gate fleet admin artifacts
```

### Task 25: Add an atomic VKE deployment and post-upgrade rollback gate

**Files:**
- Modify: `.github/workflows/deploy-vke.yml`
- Modify: `deploy/test-values.yaml`
- Create: `docs/testing/fleet-admin-dashboard.md`

- [ ] **Step 1: Write failing deployment workflow assertions**

Require `workflow_run` deployment to verify the successful triggering repository/branch, check out `github.event.workflow_run.head_sha`, download `image-metadata-<head_sha>` from `github.event.workflow_run.id`, verify the artifact SHA matches the checked-out commit, re-inspect the digest/platform, and construct one `ghcr.io/paprikacd/paprika@sha256:<digest>` reference. Manual dispatch must require an explicit commit SHA and digest and perform the same verification. Capture a previous Helm revision, use `--atomic --wait`, override every enabled component repository with the same digest reference, verify pod `imageID`s, run the real live harness, upload evidence under `if: always()`, and rollback on a post-upgrade gate failure. Reject every tag-based Helm deployment.

- [ ] **Step 2: Run workflow tests red**

Run: `rtk go test ./test/workflows -run TestDeployVKEFleetAdminGate -count=1`

Expected: current workflow lacks the browser/admin-session gate and post-test rollback.

- [ ] **Step 3: Capture pre-upgrade evidence and revision safely**

Before mutation, save Helm status/history/values/manifest, workload and pod YAML, current image/imageID values, readiness, and events. Record whether a previous deployed revision exists; do not invent revision 0.

- [ ] **Step 4: Upgrade every enabled component atomically**

Use only the validated digest reference. Because chart templates omit `:<tag>` when a repository contains `@`, set each enabled component repository to the same `$IMAGE_REF` and do not set image tags. The equivalent command is:

```bash
rtk helm upgrade --install paprika-e2e charts/chart --namespace paprika-e2e --values deploy/test-values.yaml --set adminDashboard.enabled=true --set-string manager.image.repository="$IMAGE_REF" --set-string apiServer.image.repository="$IMAGE_REF" --set-string repoServer.image.repository="$IMAGE_REF" --set-string webhookReceiver.image.repository="$IMAGE_REF" --atomic --wait --timeout 5m
```

Retain existing secret/OIDC inputs from the workflow. Do not commit credentials or replace `deploy/test-values.yaml` with an ephemeral `ttl.sh` reference.

- [ ] **Step 5: Verify runtime image, readiness, and isolation**

Require all workloads ready; `/readyz` healthy; every enabled pod `imageID` matches the pushed digest; all nodes/pods are amd64-compatible; no Service, EndpointSlice, Ingress, HTTPRoute, Gateway backend, NetworkPolicy ingress, or declared container port references 3001; and only eligible pods contain the admin argument/identity env.

- [ ] **Step 6: Run the live harness as the release gate**

Invoke `hack/test-fleet-admin-dashboard.sh` with omega kubeconfig, release `paprika-e2e`, public URL `https://paprika.benebsworth.com`, and an artifact run directory. A green Helm rollout without a green public-auth/admin-proxy/browser gate is a failed deployment.

- [ ] **Step 7: Roll back any post-upgrade gate failure**

If Helm itself fails, rely on `--atomic` and verify the restored workloads. If the post-upgrade security/browser gate fails and a previous revision exists:

```bash
rtk helm rollback paprika-e2e "$PREVIOUS_REVISION" --namespace paprika-e2e --wait --timeout 5m
```

Then rerun workload readiness and the normal/public unauthenticated smoke. If no prior revision existed, uninstall only the newly created release. Preserve the failing evidence and rollback result.

- [ ] **Step 8: Run workflow tests green**

Run: `rtk go test ./test/workflows -run TestDeployVKEFleetAdminGate -count=1`

Expected: immutable upgrade, post-gate rollback, no-prior-revision behavior, and evidence upload assertions pass.

- [ ] **Step 9: Document the operator workflow**

Document local mocked validation, the exact CLI command/warning, required pod port-forward permission, JSON automation contract, how to stop/revoke, live harness inputs, evidence location, and rollback procedure. State plainly that port-forward permission grants unrestricted Paprika administration for the reviewed session.

- [ ] **Step 10: Commit deployment automation**

```text
ci: gate and roll back VKE admin dashboard rollout
```

### Task 26: Execute and validate the omega rollout

**Files:**
- Generated only: `artifacts/fleet-admin-live/<run-id>/`
- Modify source only for defects discovered by this execution; use a new red/green commit for each correction.

- [ ] **Step 1: Verify cluster and credential preconditions**

Run: `rtk kubectl --kubeconfig=terraform/omega-oidc.kubeconfig get nodes -o wide`

Run: `rtk kubectl --kubeconfig=terraform/omega-oidc.kubeconfig auth can-i create pods/portforward -n paprika-e2e`

Run: `rtk helm status paprika-e2e -n paprika-e2e`

Expected: amd64 nodes reachable, exact port-forward permission allowed, and current release state captured.

- [ ] **Step 2: Run the full local mocked gate once more**

Run: `rtk bash hack/test-fleet-console.sh`

Run: `rtk bash hack/test-admin-dashboard-helm.sh`

Run: `rtk make test`

Run: `rtk make lint`

Expected: no deployment begins if local/browser/chart/repository checks fail.

- [ ] **Step 3: Build an immediate fallback image when GHCR SHA is unavailable**

On the Apple Silicon host, use buildx and an ephemeral anonymous registry only as the documented fallback:

```bash
rtk git rev-parse --short HEAD
rtk docker buildx build --platform linux/amd64 -t "ttl.sh/paprika-amd64-<short-sha>:4h" --metadata-file "artifacts/fleet-admin-live/<run-id>/build-metadata.json" --push .
rtk proxy jq -er '."containerimage.digest" | select(test("^sha256:[0-9a-f]{64}$"))' "artifacts/fleet-admin-live/<run-id>/build-metadata.json"
rtk docker buildx imagetools inspect "ttl.sh/paprika-amd64-<short-sha>@<sha256-digest>"
```

Require the manifest to include linux/amd64, extract the `sha256:` digest from the inspection output, and form `ttl.sh/paprika-amd64-<short-sha>@sha256:<digest>`. Record discovery tag plus deployed digest reference in the evidence directory. Prefer the validated GHCR digest artifact whenever available; never pass the TTL or GHCR tag to Helm.

- [ ] **Step 4: Perform the atomic upgrade with one immutable image**

Capture `PREVIOUS_REVISION`, apply the command from Task 25 using the single validated `repository@sha256:<digest>` reference for manager, API, repo-server, and webhook receiver, and wait for readiness. Do not mix image digests across components.

- [ ] **Step 5: Run the real CLI-owned live gate**

Run: `rtk proxy env PAPRIKA_KUBECONFIG=terraform/omega-oidc.kubeconfig PAPRIKA_RELEASE_NAMESPACE=paprika-e2e PAPRIKA_RELEASE=paprika-e2e PAPRIKA_PUBLIC_URL=https://paprika.benebsworth.com PAPRIKA_E2E_TRACE=on bash hack/test-fleet-admin-dashboard.sh`

Expected: readiness JSON identifies the reviewed Kubernetes subject and selected pod; public and normal-forward calls are unauthenticated; admin call is 200; banner and all views pass desktop/mobile; cleanup removes only the run namespace.

- [ ] **Step 6: Inspect evidence before declaring success**

Require these sanitized artifacts:

- `admin-ready.json` plus CLI stdout/stderr and reviewed subject/pod/context.
- Normal/public/admin headers, bodies, and HTTP statuses.
- Rendered fixture YAML and exact indexed-readiness report.
- Desktop/mobile screenshots for every accepted view.
- Playwright traces, report, and test results.
- Helm values/manifest/status/history before and after.
- Workload/pod YAML and image tags/IDs/digests.
- Current/previous API and manager logs plus namespace events.
- Cleanup and rollback result.

- [ ] **Step 7: Roll back immediately on any failed invariant**

Use Task 25's previous-revision/no-previous-revision logic, then verify normal auth and workload readiness. Do not leave a failed admin-enabled revision serving while debugging.

- [ ] **Step 8: Record the successful rollout**

Add the run ID, commit SHA, image digest, Helm revision, reviewed context/subject (no credentials), test summary, and cleanup result to `docs/testing/fleet-admin-dashboard.md`.

```text
docs: record fleet admin dashboard rollout evidence
```

### Task 27: Final verification and handoff

**Files:**
- Modify only source/docs required by final failures.

- [ ] **Step 1: Run the full repository verification**

Run: `rtk make test`

Run: `rtk make lint`

Run: `rtk helm lint charts/chart`

Run: `rtk bash hack/test-admin-dashboard-helm.sh`

Run: `rtk bash hack/test-fleet-console.sh`

Run: `rtk npm --prefix ui run build`

Expected: every command passes from a clean worktree.

- [ ] **Step 2: Run focused race and scale gates**

Run: `rtk go test -race ./internal/api/admin ./internal/api/auth ./internal/api ./cmd ./cmd/paprika`

Run: `rtk bash hack/test-fleet-scale.sh`

Expected: no races and exact 10,000-Application heatmap completeness.

- [ ] **Step 3: Verify generated and committed state**

Run: `rtk git diff --check`

Run: `rtk git status --short`

Expected: no whitespace errors, no generated drift, no tokens/kubeconfigs/artifact secrets staged, and only intentional source/docs/evidence-summary files remain.

- [ ] **Step 4: Request final code review**

Use `@superpowers:requesting-code-review` against the approved spec and this plan. Resolve actionable findings with red/green tests and rerun the affected gates.

- [ ] **Step 5: Commit final verification corrections**

```text
test: complete fleet admin rollout verification
```
