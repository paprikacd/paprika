# Paprika UI — Existing Data Layer Map

Scope: `/Users/benebsworth/projects/paprika/ui`. Everything below was read from the repo; nothing is
invented. Line numbers cite the file that was read.

Stack (from `ui/package.json`):
- `next` **16.2.7** (App Router, `output: "export"`, `trailingSlash: true`, `distDir: "out"`), `react`/`react-dom` **19.2.4**
- `@connectrpc/connect` ^1.7.0 + `@connectrpc/connect-web` ^1.7.0 + `@bufbuild/protobuf` ^1.10.1 (protobuf-es **v1** API — `createPromiseClient`, `MethodKind`, class-based messages)
- `@tanstack/react-query` ^5.101.2, `@tanstack/react-table` ^8.21.3, `@tanstack/react-virtual` ^3.14.5
- `@base-ui/react` ^1.5.0, `@xyflow/react` ^12.11.0, `framer-motion` ^12.40.0, `lucide-react` ^1.17.0, `@dagrejs/dagre`, `d3-hierarchy`
- `tailwindcss` ^4 via `@tailwindcss/postcss`, `class-variance-authority`, `clsx`, `tailwind-merge`, `tw-animate-css`
- dev: `vitest` ^4.1.9, `happy-dom` ^20.10.6, `jsdom` ^27.0.1, `@testing-library/react` ^16.3.2 + `jest-dom` ^6.9.1 + `user-event` ^14.6.1, `@playwright/test` **1.61.1**, `eslint` ^9 + `eslint-config-next` 16.2.7

`ui/AGENTS.md` (and `CLAUDE.md` which just does `@AGENTS.md`) says verbatim:
> # This is NOT the Next.js you know
> This version has breaking changes — APIs, conventions, and file structure may all differ from your
> training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code.
> Heed deprecation notices.

---

## 1. `src/lib/*` — the data layer, file by file

### 1.1 `src/lib/transport.ts` (35 lines)

`"use client"`. Exports exactly one function.

```ts
export function createTransport()  // -> Transport from createConnectTransport
```

- `createConnectTransport({ baseUrl: "", fetch: ... })` — **same-origin, empty baseUrl**. Connect calls go
  to the page's own origin (the Go server serves both the static export and the Connect handler).
- Custom `fetch` reads `localStorage.getItem("paprika_id_token")` and, if present, sets
  `Authorization: Bearer <token>`.
- On HTTP `401` it calls `clearStaleAuth()`: removes `paprika_id_token` + `paprika_auth_user` from
  localStorage and, guarded by a module-level `clearingAuth` flag, sets
  `window.location.href = "/login/"` unless already on `/login/`.
- Constants (lines 5–6): `AUTH_TOKEN_KEY = "paprika_id_token"`, `AUTH_USER_KEY = "paprika_auth_user"`.

### 1.2 `src/lib/fleet-client.ts` (720 lines)

`"use client"`. This is the **protobuf ↔ plain-TS boundary**. Every UI-facing type here is a plain
interface with lowercase snake string unions — the UI never touches proto enums directly.

Exported string-union types (lines 48–73):

```ts
export type FleetHealthStatus   = FleetHealth   | "unspecified"   // healthy|progressing|degraded|failed|unknown|missing|unspecified
export type FleetSyncStatus     = FleetSync     | "unspecified"   // synced|out_of_sync|unknown|unspecified
export type FleetReleaseStatus  = FleetRelease  | "unspecified"
export type FleetRolloutStatus  = FleetRollout  | "unspecified"
export type FleetSourceStatus   = FleetSource   | "unspecified"
export type FleetConnectionStatus = "healthy" | "unhealthy" | "disabled" | "not_configured" | "unspecified"
export type FleetCapability = "application_sync" | "release_rollback" | "gate_approve" | "pipeline_retry" | "unspecified"
export type FleetFacetDimension =
  | "project" | "namespace" | "cluster" | "stage" | "health" | "sync" | "release" | "rollout" | "source_type" | "unspecified"
```

Exported interfaces (lines 75–183) — **these are the shapes every fleet component consumes**:

```ts
export interface FleetStageTarget {          // lines 75-84
  stableId: string
  stage: string
  ring: number
  cluster?: NamespacedKey
  clusterLabel: string
  health: FleetHealthStatus
  clusterConnection: FleetConnectionStatus
  unmanagedInlineCluster: boolean
}

export interface FleetApplicationSummary {   // lines 86-111  ← THE row model
  identity?: NamespacedKey                   // { namespace, name } — OPTIONAL, code must handle undefined
  project?: NamespacedKey
  targets: FleetStageTarget[]
  currentStage: string
  currentCluster?: NamespacedKey
  currentClusterLabel: string
  sourceType: FleetSourceStatus
  sourceRevision: string
  health: FleetHealthStatus
  sync: FleetSyncStatus
  driftCount: number
  missingResourceCount: number
  releaseState: FleetReleaseStatus
  rolloutState: FleetRolloutStatus
  resourceCount: number
  repository?: NamespacedKey
  repositoryConnection: FleetConnectionStatus
  effectiveObservabilitySource?: NamespacedKey
  observabilityConnection: FleetConnectionStatus
  blockedGateCount: number
  lastTransitionUnixMs: bigint               // ← bigint, not number
  capabilities: FleetCapability[]
}

export interface FleetFacetBucket {          // lines 113-119
  dimension: FleetFacetDimension
  object?: NamespacedKey   // set when the proto oneof case === "object"
  value?: string           // set when the proto oneof case === "value"
  label: string
  count: bigint
}

export interface FleetApplicationsPage {     // lines 121-127
  applications: FleetApplicationSummary[]
  total: bigint
  nextCursor: string
  indexGeneration: bigint
  facets: FleetFacetBucket[]
}

export interface FleetHealthBucket { health: FleetHealthStatus; count: bigint }   // 129-132

export interface FleetMapNode {              // lines 134-149  (recursive)
  stableId: string
  kind: "group" | "application" | "unspecified"
  label: string
  application?: NamespacedKey
  groupObject?: NamespacedKey
  groupValue?: string
  applicationCount: bigint
  targetCount: bigint
  health: FleetHealthBucket[]
  resourceWeight: bigint
  requestRateWeight: number
  effectiveWeight: number
  usedResourceFallback: boolean
  children: FleetMapNode[]
}

export interface FleetMapResult { roots: FleetMapNode[]; total: bigint; indexGeneration: bigint; facets: FleetFacetBucket[] }   // 151-156

export interface FleetMatrixHeader { stableId: string; label: string; object?: NamespacedKey; value?: string }   // 158-163

export interface FleetMatrixCell {           // lines 165-174
  rowId: string
  columnId: string
  applicationCount: bigint
  targetCount: bigint
  health: FleetHealthBucket[]
  resourceWeight: bigint
  requestRateWeight: number
  usedResourceFallback: boolean
}

export interface FleetMatrixResult {         // lines 176-183
  rows: FleetMatrixHeader[]; columns: FleetMatrixHeader[]; cells: FleetMatrixCell[]
  total: bigint; indexGeneration: bigint; facets: FleetFacetBucket[]
}

export interface QueryApplicationsOptions { cursor?: string; pageSize?: number; signal?: AbortSignal }  // 185-189
export interface FleetRequestOptions { signal?: AbortSignal }                                          // 191-193
```

Exported functions:

| function | line | signature |
|---|---|---|
| `getFleetClient()` | 197 | `(): PromiseClient<typeof PaprikaService>` — module-level memoised singleton `browserFleetClient ??= createPromiseClient(PaprikaService, createTransport())` |
| `toQueryApplicationsRequest(state, options?)` | 202 | `(FleetQueryState, Pick<QueryApplicationsOptions,"cursor"\|"pageSize">) => QueryApplicationsRequest`. **pageSize defaults to 100**, cursor to `""`. |
| `toQueryFleetMapRequest(state)` | 216 | `(FleetQueryState) => QueryFleetMapRequest` |
| `toQueryFleetMatrixRequest(state)` | 225 | `(FleetQueryState) => QueryFleetMatrixRequest` |
| `queryApplications(state, options={})` | 235 | `async => Promise<FleetApplicationsPage>` |
| `queryFleetMap(state, options={})` | 246 | `async => Promise<FleetMapResult>` |
| `queryFleetMatrix(state, options={})` | 256 | `async => Promise<FleetMatrixResult>` |
| `fromQueryApplicationsResponse(response)` | 266 | `(QueryApplicationsResponse) => FleetApplicationsPage` |
| `fromQueryFleetMapResponse(response)` | ~278 | `(QueryFleetMapResponse) => FleetMapResult` |
| `fromQueryFleetMatrixResponse(response)` | ~287 | `(QueryFleetMatrixResponse) => FleetMatrixResult` |

Only these **three RPCs** are used by the fleet path: `queryApplications`, `queryFleetMap`,
`queryFleetMatrix`. `GetSystemStatus` exists on the service but is **not called anywhere in the UI**
(grepped: only appears inside `src/gen/**`).

Private mappers (all in the same file): `toFleetFilter` (298) builds `FleetFilterMessage` with
`projects/namespaces/clusters/stages/health/sync/releaseStates/rolloutStates/sourceTypes`;
`toObjectKey`/`fromObjectKey`; `toHealth`/`fromHealth`; `toSync`/`fromSync`; `toSource`/`fromSource`;
`toRelease`/`fromRelease`; `toRollout`/`fromRollout`; `toSortField` (409); `toSortDirection` (438 —
`desc` → `DESC`, everything else `ASC`); `toGroupDimension` (442); `toSizeMetric` (455 —
`request_rate` → `REQUEST_RATE`, else `RESOURCE_COUNT`); `fromApplicationSummary` (461);
`fromStageTarget` (488); `fromFacetBucket` (501); `fromHealthBucket` (511); `fromMapNode` (515);
`fromMatrixHeader` (535); `fromMatrixCell` (544); `fromConnection` (656); `fromCapability` (671);
`fromFacetDimension` (686); `fromMapNodeKind` (711).

Every `from*` enum mapper has a `default: return "unspecified"` arm.

### 1.3 `src/lib/fleet-query.ts` (500 lines) — the URL is the state store

**No `"use client"` directive** — pure functions, safe in tests.

Value tables (exported `as const` arrays + derived types):

```ts
export interface NamespacedKey { namespace: string; name: string }                   // line 1

FLEET_HEALTH_VALUES    = ["healthy","progressing","degraded","failed","unknown","missing"]        // 6
FLEET_SYNC_VALUES      = ["synced","out_of_sync","unknown"]                                        // 16
FLEET_RELEASE_VALUES   = ["pending","promoting","canarying","verifying","complete","failed",
                          "rolled_back","superseded","awaiting_approval"]                          // 19
FLEET_ROLLOUT_VALUES   = ["pending","progressing","paused","healthy","degraded","failed",
                          "rolled_back","aborted"]                                                 // 32
FLEET_SOURCE_VALUES    = ["git","helm","kustomize","s3","oci","inline"]                            // 44
FLEET_SORT_VALUES      = ["name","project","cluster","stage","health","sync","release","rollout",
                          "resource_count","last_transition","impact","relevance"]                 // 47
FLEET_DIRECTION_VALUES = ["asc","desc"]                                                            // 63
FLEET_VIEW_VALUES      = ["treemap","matrix","table","queue"]                                      // 66
FLEET_GROUP_VALUES     = ["project","cluster","stage","health"]                                    // 69
FLEET_SIZE_VALUES      = ["resource_count","request_rate"]                                         // 72
FLEET_RANGE_VALUES     = ["15m","30m","1h","2h","6h","12h","24h","3d","7d"]                        // 75
```

```ts
export interface FleetQueryState {   // lines 78-100
  projects: NamespacedKey[]; clusters: NamespacedKey[]; stages: string[]; namespaces: string[]
  health: FleetHealth[]; sync: FleetSync[]; release: FleetRelease[]; rollout: FleetRollout[]
  sources: FleetSource[]
  q: string
  sort: FleetSort; direction: FleetDirection
  view: FleetView
  group: FleetGroup; rows: FleetGroup; columns: FleetGroup
  size: FleetSize
  zoom: string
  selected: NamespacedKey | null
  range: FleetRange
}
export type FleetQueryPatch = Partial<FleetQueryState>
export type FleetQueryField = "project"|"cluster"|"stage"|"namespace"|"health"|"sync"|"release"
  |"rollout"|"source"|"sort"|"direction"|"view"|"group"|"rows"|"columns"|"size"|"selected"|"range"  // 103-121
export interface FleetQueryNotice { field: FleetQueryField; value: string; reason: "invalid"|"not_available"; message: string }  // 123
export interface ParsedFleetQuery { state: FleetQueryState; notices: FleetQueryNotice[] }           // 130
export interface FleetFacetAvailability { projects?; clusters?; stages?; namespaces?; health?; sync?; release?; rollout?; sources? }  // 135
```

`DEFAULT_FLEET_QUERY` (lines 147–170) — **memorise these; serialisation omits defaults**:

```ts
{ projects: [], clusters: [], stages: [], namespaces: [], health: [], sync: [], release: [],
  rollout: [], sources: [], q: "", sort: "name", direction: "asc", view: "treemap",
  group: "project", rows: "project", columns: "cluster", size: "resource_count",
  zoom: "", selected: null, range: "2h" }
```

Exported functions:
- `parseFleetQuery(input: string | QueryParameters): ParsedFleetQuery` (line 177). Accepts a raw query
  string or anything with `get`/`getAll` (i.e. `URLSearchParams` from `useSearchParams()`). URL param
  names: `project`, `cluster`, `stage`, `namespace`, `health`, `sync`, `release`, `rollout`, **`source`**
  (note: singular, maps to `state.sources`), `q`, `sort`, `direction`, `view`, `group`, `rows`,
  `columns`, `size`, `zoom`, `selected`, `range`. Namespaced params are `namespace/name` strings
  validated against `const dnsLabel = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/` (line 175). Anything
  invalid becomes a `FleetQueryNotice` with `reason: "invalid"`.
- `serializeFleetQuery(state): URLSearchParams` (line 227). Canonicalises first, appends multi-values,
  and uses `appendNonDefault` for scalars so **default values never appear in the URL**. `selected` is
  written as `namespace/name`.
- `mergeFleetQuery(current, patch): FleetQueryState` (line 253) — `canonicalizeFleetQuery({...current, ...patch})`.
- `reconcileFleetQuery(current, available: FleetFacetAvailability): ParsedFleetQuery` (line 257) — drops
  selections that are not present in the returned facets and emits `reason: "not_available"` notices.

### 1.4 `src/lib/use-fleet-data.ts` (595 lines) — the primary hook

`"use client"`. `const APPLICATION_PAGE_SIZE = 100` (line 32).

```ts
export interface FleetDataClient {                       // lines 34-47
  queryApplications: (state: FleetQueryState, options?: QueryApplicationsOptions) => Promise<FleetApplicationsPage>
  queryFleetMap:     (state: FleetQueryState, options?: FleetRequestOptions) => Promise<FleetMapResult>
  queryFleetMatrix:  (state: FleetQueryState, options?: FleetRequestOptions) => Promise<FleetMatrixResult>
}

export interface FleetApplicationsData {                 // lines 49-57
  kind: "applications"
  view: "table" | "queue"
  pages: readonly FleetApplicationsPage[]
  applications: FleetApplicationSummary[]     // deduped merge of all pages
  facets: FleetFacetBucket[]                  // facets of the FIRST page
  total: bigint                               // total of the LAST page
  indexGeneration: bigint                     // generation of the LAST page
}
export interface FleetMapData    { kind: "map";    view: "treemap"; result: FleetMapResult }     // 59
export interface FleetMatrixData { kind: "matrix"; view: "matrix";  result: FleetMatrixResult }  // 65
export type FleetPresentationData = FleetApplicationsData | FleetMapData | FleetMatrixData        // 71

export type FleetDataStatus =                            // lines 76-84
  | "loading" | "ready" | "empty" | "stale" | "partial" | "unauthorized" | "unavailable" | "error"

export interface UseFleetDataOptions { client?: FleetDataClient }   // 86-88

export interface UseFleetDataResult {                    // lines 90-110  ← EXACT return type
  state: FleetQueryState
  status: FleetDataStatus
  currentData: FleetPresentationData | undefined
  staleData: FleetPresentationData | undefined
  displayData: FleetPresentationData | undefined
  error: unknown
  applicationFacets: readonly FleetFacetBucket[]
  isLoading: boolean
  isReady: boolean
  isEmpty: boolean
  isStale: boolean
  isPartial: boolean
  isUnauthorized: boolean
  isUnavailable: boolean
  isError: boolean            // true for "error" | "unauthorized" | "unavailable"
  hasMore: boolean
  isLoadingMore: boolean
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
}

export function useFleetData(state: FleetQueryState, options: UseFleetDataOptions = {}): UseFleetDataResult  // line 171
```

Behaviour:
- `defaultClient` (line 112) is `{ queryApplications, queryFleetMap, queryFleetMatrix }` from
  `fleet-client`. **Injectable via `options.client` — this is the seam tests use.**
- Query key (lines 116–121, built by `activeRequest`, line 483):
  `["fleet", "applications" | "map" | "matrix", "treemap"|"matrix"|"table"|"queue", <request>.toJsonString()]`.
  For `view === "queue"` the request state is forced to `{ sort: "impact", direction: "desc" }`
  (lines 487–490) — the **queue is server-ranked, never client-sorted**.
- `useQuery` with `placeholderData: (previousData) => previousData`, so switching presentation shows the
  previous frame; `query.isPlaceholderData` splits `staleData` vs `currentData` (lines 318–320).
- `loadMore()` (line 356): single in-flight `AbortController` guarded by `loadMoreOperation` ref;
  cancels the active query, reads the cached page base, calls `applicationLoader.load(cursor, signal)`,
  and appends via `queryClient.setQueryData`. Failure sets `loadMoreError` → status `"partial"` (the
  loaded rows stay visible). `hasMore` = `currentData.pages.at(-1)?.nextCursor` is truthy.
- `dataStatus` (line 549) precedence: `partial` (partialError + currentData) → `stale` (staleData) →
  `loading` (isPending) → `errorStatus(...)` (isError) → `loading` (no data) → `empty` (`total === 0n`)
  → `ready`.
- `errorStatus` (line 567): `ConnectError` with `Code.Unauthenticated` or `Code.PermissionDenied` →
  `"unauthorized"`; `Code.Unavailable` → `"unavailable"`; else `"error"`.
- `refresh()` = `query.refetch({ throwOnError: true })`.

### 1.5 `src/lib/fleet-pages.ts` (74 lines)

No `"use client"`.

```ts
export interface FleetPageLoaderDependencies<TPage> {
  fetchPage: (cursor: string) => Promise<TPage>
  resetFleetPages: () => void | Promise<void>
}
export type FleetPageLoader<TPage> = (cursor?: string) => Promise<TPage>

export function mergeFleetApplicationPages(pages: readonly FleetApplicationsPage[]): FleetApplicationSummary[]  // line 15
export function createFleetPageLoader<TPage>(deps: FleetPageLoaderDependencies<TPage>): FleetPageLoader<TPage>   // line 41
```

- `mergeFleetApplicationPages` dedupes on `JSON.stringify([identity.namespace, identity.name])`;
  applications **without** an `identity` are pushed through unfiltered.
- `createFleetPageLoader` recovers from a **stale cursor**: if `fetchPage(cursor)` throws a
  `ConnectError` with `Code.InvalidArgument` and the cursor is non-empty and not already recovered
  once, it calls `resetFleetPages()` then refetches from `""`. Recovery is attempted at most once per
  cursor (`recoveredCursors` Set).

### 1.6 `src/lib/fleet-refresh.ts` (169 lines)

`"use client"`. Exported constants:

```ts
export const FLEET_REFRESH_INTERVAL_MS   = 60_000    // 60 s
export const FOCUSED_REFRESH_INTERVAL_MS = 15_000    // 15 s
export const MAX_REFRESH_INTERVAL_MS     = 120_000   // 120 s backoff ceiling
```

```ts
export interface RefreshOptions {
  enabled?: boolean                                  // default true
  onRequestOutcome?: (succeeded: boolean) => void
  refreshOnMount?: boolean                           // default true
}
export interface BoundedRefreshOptions extends RefreshOptions { intervalMs: number; maxIntervalMs?: number }

export function useBoundedRefresh(refresh, opts: BoundedRefreshOptions): void      // line 24
export function useFleetRefresh(refresh, opts: RefreshOptions = {}): void          // line 120 -> 60s
export function useFocusedRefresh(refresh, opts: RefreshOptions = {}): void        // line 130 -> 15s
export function useSingleFlightRefresh(refresh): () => Promise<void>               // line 145
```

`useBoundedRefresh` semantics: exponential backoff `min(maxIntervalMs, intervalMs * 2 ** failureCount)`;
never schedules or runs while `document.visibilityState === "hidden"`; re-schedules on
`visibilitychange`; on `window focus` it clears the timer and refreshes immediately; calls
`onRequestOutcome(succeeded)` after every attempt; cleans up both listeners on unmount.

`useSingleFlightRefresh` returns a stable callback that shares one in-flight promise so scheduled,
focus and operator-triggered refreshes cannot race.

### 1.7 `src/lib/pipeline-refresh.ts` (15 lines)

`"use client"`. Thin wrapper:

```ts
export function usePipelineRefresh(namespace: string, name: string, refresh, options: RefreshOptions = {}): void
```
Delegates to `useFocusedRefresh` (15 s) with `enabled: options.enabled !== false && Boolean(namespace && name)`.

### 1.8 `src/lib/connection-context.tsx` (67 lines)

`"use client"`.

```ts
interface ConnectionState {          // NOT exported
  connected: boolean                 // === online && lastRequestSucceeded === true
  online: boolean                    // navigator.onLine, kept live via "online"/"offline" listeners
  lastRequestSucceeded: boolean | null
  reportRequestOutcome: (succeeded: boolean) => void
  /** @deprecated Use reportRequestOutcome. */
  setConnected: (succeeded: boolean) => void
  /** @deprecated Push events are disabled until an authorized watch API exists. */
  events: readonly MessageEvent["data"][]     // always the frozen EMPTY_EVENTS array
}
export function ConnectionProvider({ children }): JSX.Element
export function useConnection(): ConnectionState
```

**There is no SSE / EventSource / streaming.** `events` is permanently `[]`. The e2e suite asserts the
app never hits `/events` (see §4.4) and the Go fixture serves `404` on that route.

### 1.9 `src/lib/auth-context.tsx` (154 lines)

`"use client"`.

```ts
export interface AuthUser { sub: string; email: string; name: string; picture?: string }
interface AuthContextValue { user: AuthUser | null; idToken: string | null; isLoading: boolean; login: () => Promise<void>; logout: () => void }

export const AUTH_TOKEN_KEY = "paprika_id_token"
export const AUTH_USER_KEY  = "paprika_auth_user"
// private: const AUTH_RETURN_TO_KEY = "paprika_return_to"

export function AuthProvider({ children }): JSX.Element
export function useAuth(): AuthContextValue
export function persistAuth(idToken: string): void
export function consumeReturnTo(): string | null
```

- On mount (once, guarded by a `restored` ref + `queueMicrotask`) it restores the token from
  localStorage, decodes the JWT payload, and drops it if `exp * 1000 <= Date.now()`. `isLoading`
  starts `true` and flips `false` after that microtask.
- `login()` GETs `/auth/login?redirect_uri=<origin>/auth/callback`, expects
  `{ url, codeVerifier, state }`, stashes `paprika_code_verifier` / `paprika_expected_state` /
  `paprika_redirect_uri` in **sessionStorage** and `paprika_return_to` in localStorage, then redirects.
- `logout()` clears everything and `safeRedirect("/login/")`.

### 1.10 `src/lib/query-provider.tsx` (42 lines)

`"use client"`.

```ts
export function createEnterpriseQueryClient(): QueryClient
export function getBrowserQueryClient(): QueryClient     // SSR-safe singleton
export function QueryProvider({ children }: { children: ReactNode }): JSX.Element
```

Defaults (lines 12–21) — **asserted verbatim in `fleet-client.test.ts`**:
```
queries:   staleTime: 30_000, gcTime: 600_000, retry: 2,
           refetchOnWindowFocus: false, refetchOnReconnect: true
mutations: retry: false
```

### 1.11 `src/lib/fleet-focus.ts` (212 lines) — accessibility focus coordinator

No `"use client"` (plain class, unit-testable).

```ts
export type FleetApplicationIdentity = Readonly<NamespacedKey>
export interface FleetFocusTarget { focus(): void }
export interface FleetFocusAdapter {
  resolveApplicationTarget(identity: FleetApplicationIdentity, signal: AbortSignal): MaybePromise<FleetFocusTarget | null>
  resolveResultsHeadingTarget(signal: AbortSignal): MaybePromise<FleetFocusTarget | null>
}
export interface FleetFocusCoordinatorOptions { announce(message: string): void }
export interface FleetFocusCoordinator {
  registerAdapter(presentation: string, adapter: FleetFocusAdapter): () => void
  activatePresentation(presentation: string | null): Promise<void>
  trackFocusedApplication(identity: FleetApplicationIdentity | null): void
  focusedApplication(): FleetApplicationIdentity | null
  updateResults(identities: readonly FleetApplicationIdentity[]): Promise<void>
  settled(): Promise<void>
}
export function createFleetFocusCoordinator(options: FleetFocusCoordinatorOptions): FleetFocusCoordinator  // line 180
```

When the focused application disappears from the results, focus moves to the results heading and it
announces the exact string (line 148):
`Application ${identity.namespace}/${identity.name} was removed from the results.`

### 1.12 Other `src/lib` files

- `src/lib/use-step-artifacts.ts` (17 lines): `useStepArtifacts(artifacts: ArtifactRef[], stepName: string): ArtifactRef[]` — memoised `artifacts.filter(a => a.producingStep === stepName)`. Empty step name selects pipeline-level artifacts.
- `src/lib/clipboard.ts` (28 lines): `copyToClipboard(text): Promise<void>` — `navigator.clipboard.writeText` with a hidden-textarea + `document.execCommand("copy")` fallback. Exists specifically so component tests can `vi.mock("@/lib/clipboard", ...)`.
- `src/lib/utils.ts` (6 lines): `cn(...inputs: ClassValue[])` = `twMerge(clsx(inputs))`.

---

## 2. `src/gen/**` — generated ConnectRPC / protobuf

Files (only one proto package):
```
src/gen/paprika/v1/api_connect.d.ts   386 lines
src/gen/paprika/v1/api_connect.js     386
src/gen/paprika/v1/api_pb.d.ts       6202
src/gen/paprika/v1/api_pb.js         2060
```
Regenerated with `npm run generate` → `cd .. && buf generate`. protobuf-es **v1** style (class-based
messages, `MethodKind`, `createPromiseClient`).

### 2.1 Service: `paprika.v1.PaprikaService` (api_connect.d.ts line 13)

**42 RPCs, all `MethodKind.Unary` except `StreamResourceLogs` (`MethodKind.ServerStreaming`).**
Client method names are camelCase (`client.listPipelines(...)`, `client.queryApplications(...)`).

| # | RPC | Request | Response | line |
|---|---|---|---|---|
| 1 | `ListPipelines` | `ListPipelinesRequest` | `ListPipelinesResponse` | 19 |
| 2 | `ListReleases` | `ListReleasesRequest` | `ListReleasesResponse` | 28 |
| 3 | `ListStages` | `ListStagesRequest` | `ListStagesResponse` | 37 |
| 4 | `ListApplications` | `ListApplicationsRequest` | `ListApplicationsResponse` | 46 |
| 5 | `ListPolicies` | `ListPoliciesRequest` | `ListPoliciesResponse` | 55 |
| 6 | `ListApplicationSets` | `ListApplicationSetsRequest` | `ListApplicationSetsResponse` | 64 |
| 7 | `GetApplicationSet` | `GetApplicationSetRequest` | `GetApplicationSetResponse` | 73 |
| 8 | `ListNotificationConfigs` | … | … | 82 |
| 9 | `GetApplication` | `GetApplicationRequest` | `GetApplicationResponse` | 91 |
| 10 | `SyncApplication` | `SyncApplicationRequest` | `SyncApplicationResponse` | 100 |
| 11 | `ApproveGate` | `ApproveGateRequest` | `ApproveGateResponse` | 109 |
| 12 | `ListGateStatus` | … | … | 118 |
| 13 | `RejectGate` | `RejectGateRequest` | `RejectGateResponse` | 127 |
| 14 | `ResolveSource` | … | … | 136 |
| 15 | `Render` | `RenderRequest` | `RenderResponse` | 145 |
| 16 | `ApplyBundle` | … | … | 154 |
| 17 | `RollbackRelease` | … | … | 163 |
| 18 | `ListRollouts` | `ListRolloutsRequest` | `ListRolloutsResponse` | 172 |
| 19 | `GetRollout` | … | … | 181 |
| 20 | `PromoteRollout` | … | … | 190 |
| 21 | `AbortRollout` | … | … | 199 |
| 22 | `ListAnalysisRuns` | … | … | 208 |
| 23 | `GetAnalysisRun` | … | … | 217 |
| 24 | `GetPipeline` | `GetPipelineRequest` | `GetPipelineResponse` | 226 |
| 25 | `GetArtifact` | … | … | 235 |
| 26 | `ListArtifacts` | … | … | 244 |
| 27 | `RetryStep` | … | … | 253 |
| 28 | `SkipStep` | … | … | 262 |
| 29 | `CancelPipeline` | … | … | 271 |
| 30 | `GetStepLogs` | … | … | 280 |
| 31 | `GetResource` | `GetResourceRequest` | `GetResourceResponse` | 289 |
| 32 | `GetResourceTree` | … | … | 298 |
| 33 | `GetResourceLogs` | … | … | 307 |
| 34 | `GetResourceTreeDetailed` | … | … | 316 |
| 35 | `StreamResourceLogs` | `StreamResourceLogsRequest` | `LogChunk` **(ServerStreaming)** | 325 |
| 36 | `Investigate` | `InvestigateRequest` | `InvestigateResponse` | 334 |
| 37 | `ListInvestigatorPlugins` | … | … | 343 |
| 38 | `QueryApplications` | `QueryApplicationsRequest` | `QueryApplicationsResponse` | 352 |
| 39 | `QueryFleetMap` | `QueryFleetMapRequest` | `QueryFleetMapResponse` | 361 |
| 40 | `QueryFleetMatrix` | `QueryFleetMatrixRequest` | `QueryFleetMatrixResponse` | 370 |
| 41 | `GetSystemStatus` | `GetSystemStatusRequest` | `GetSystemStatusResponse` | 379 |

### 2.2 Enums — VERBATIM members (`api_pb.d.ts`)

TS member names are stripped of the proto prefix; the proto wire name is in the JSDoc.

```ts
// line 12 — paprika.v1.Severity  (NOTE: no prefix stripping here)
enum Severity { SEVERITY_UNSPECIFIED = 0, CRITICAL = 1, WARNING = 2, INFO = 3 }

// line 37 — paprika.v1.FleetHealth
enum FleetHealth {
  UNSPECIFIED = 0,   // FLEET_HEALTH_UNSPECIFIED
  HEALTHY = 1,       // FLEET_HEALTH_HEALTHY
  PROGRESSING = 2,   // FLEET_HEALTH_PROGRESSING
  DEGRADED = 3,      // FLEET_HEALTH_DEGRADED
  FAILED = 4,        // FLEET_HEALTH_FAILED
  UNKNOWN = 5,       // FLEET_HEALTH_UNKNOWN
  MISSING = 6,       // FLEET_HEALTH_MISSING
}

// line 77 — paprika.v1.FleetSyncState
enum FleetSyncState { UNSPECIFIED = 0, SYNCED = 1, OUT_OF_SYNC = 2, UNKNOWN = 3 }

// line 102 — paprika.v1.FleetSourceType
enum FleetSourceType { UNSPECIFIED = 0, GIT = 1, HELM = 2, KUSTOMIZE = 3, S3 = 4, OCI = 5, INLINE = 6 }

// line 142 — paprika.v1.FleetReleaseState
enum FleetReleaseState {
  UNSPECIFIED = 0, PENDING = 1, PROMOTING = 2, CANARYING = 3, VERIFYING = 4,
  COMPLETE = 5, FAILED = 6, ROLLED_BACK = 7, SUPERSEDED = 8, AWAITING_APPROVAL = 9,
}

// line 197 — paprika.v1.FleetRolloutState
enum FleetRolloutState {
  UNSPECIFIED = 0, PENDING = 1, PROGRESSING = 2, PAUSED = 3, HEALTHY = 4,
  DEGRADED = 5, FAILED = 6, ROLLED_BACK = 7, ABORTED = 8,
}

// line 247 — paprika.v1.FleetSortField
enum FleetSortField {
  UNSPECIFIED = 0, NAME = 1, PROJECT = 2, CLUSTER = 3, STAGE = 4, HEALTH = 5, SYNC = 6,
  RELEASE = 7, ROLLOUT = 8, RESOURCE_COUNT = 9, LAST_TRANSITION = 10, IMPACT = 11, RELEVANCE = 12,
}

// line 317 — paprika.v1.FleetSortDirection
enum FleetSortDirection { UNSPECIFIED = 0, ASC = 1, DESC = 2 }

// line 337 — paprika.v1.FleetGroupDimension
enum FleetGroupDimension { UNSPECIFIED = 0, PROJECT = 1, CLUSTER = 2, STAGE = 3, HEALTH = 4 }

// line 367 — paprika.v1.FleetSizeMetric
enum FleetSizeMetric { UNSPECIFIED = 0, RESOURCE_COUNT = 1, REQUEST_RATE = 2 }

// line 387 — paprika.v1.FleetFacetDimension
enum FleetFacetDimension {
  UNSPECIFIED = 0, PROJECT = 1, NAMESPACE = 2, CLUSTER = 3, STAGE = 4,
  HEALTH = 5, SYNC = 6, RELEASE = 7, ROLLOUT = 8, SOURCE_TYPE = 9,
}

// line 442 — paprika.v1.FleetCapability
enum FleetCapability { UNSPECIFIED = 0, APPLICATION_SYNC = 1, RELEASE_ROLLBACK = 2, GATE_APPROVE = 3, PIPELINE_RETRY = 4 }

// line 472 — paprika.v1.FleetConnectionState
enum FleetConnectionState { UNSPECIFIED = 0, HEALTHY = 1, UNHEALTHY = 2, DISABLED = 3, NOT_CONFIGURED = 4 }

// line 502 — paprika.v1.FleetMapNodeKind
enum FleetMapNodeKind { UNSPECIFIED = 0, GROUP = 1, APPLICATION = 2 }
```

**There are only 14 enums in the whole proto.** Everything else (`Application.phase`,
`Application.health`, `Pipeline.phase`, `StepStatus.phase`, `Release.phase`, `Rollout.phase`,
`ResourceNode.health`, `GateStatus.status`, `Policy.severity`, …) is a **free-form `string`** on the
wire. Only the *fleet* surface is enum-typed.

### 2.3 Key message shapes (`api_pb.d.ts`)

#### Fleet query surface

```ts
class FleetObjectKey     { namespace: string; name: string }                                        // 5268

class FleetFilter {                                                                                  // 5297
  projects: FleetObjectKey[]; namespaces: string[]; clusters: FleetObjectKey[]; stages: string[]
  health: FleetHealth[]; sync: FleetSyncState[]
  releaseStates: FleetReleaseState[]; rolloutStates: FleetRolloutState[]; sourceTypes: FleetSourceType[]
}

class StageTargetSummary {                                                                           // 5361
  stableId: string; stage: string; ring: number
  cluster?: FleetObjectKey; clusterLabel: string
  health: FleetHealth; clusterConnection: FleetConnectionState; unmanagedInlineCluster: boolean
}

class ApplicationSummary {                                                                           // 5420
  identity?: FleetObjectKey; project?: FleetObjectKey
  targets: StageTargetSummary[]
  currentStage: string; currentCluster?: FleetObjectKey; currentClusterLabel: string
  sourceType: FleetSourceType; sourceRevision: string
  health: FleetHealth; sync: FleetSyncState
  driftCount: number; missingResourceCount: number
  releaseState: FleetReleaseState; rolloutState: FleetRolloutState
  resourceCount: number
  repository?: FleetObjectKey; repositoryConnection: FleetConnectionState
  effectiveObservabilitySource?: FleetObjectKey; observabilityConnection: FleetConnectionState
  blockedGateCount: number
  lastTransitionUnixMs: bigint
  capabilities: FleetCapability[]
}

class FleetFacetBucket {                                                                             // 5549
  dimension: FleetFacetDimension
  key: { value: FleetObjectKey; case: "object" } | { value: string; case: "value" } | { case: undefined }
  label: string; count: bigint
}
class FleetHealthBucket { health: FleetHealth; count: bigint }                                        // 5600
class FleetSyncBucket   { sync: FleetSyncState; count: bigint }                                       // 5629

class GetSystemStatusRequest  { namespace?: string; attentionLimit: number }                          // 5658
class GetSystemStatusResponse {                                                                       // 5687
  indexGeneration: bigint; total: bigint
  health: FleetHealthBucket[]; sync: FleetSyncBucket[]
  attentionTotal: bigint; attention: ApplicationSummary[]; hasMoreAttention: boolean
}

class QueryApplicationsRequest  { filter?: FleetFilter; search: string; sort: FleetSortField; direction: FleetSortDirection; pageSize: number; cursor: string }  // 5741
class QueryApplicationsResponse { applications: ApplicationSummary[]; total: bigint; nextCursor: string; indexGeneration: bigint; facets: FleetFacetBucket[] }   // 5790

class FleetMapNode {                                                                                  // 5834
  stableId: string; kind: FleetMapNodeKind; label: string
  application?: FleetObjectKey
  groupKey: { value: FleetObjectKey; case: "groupObject" } | { value: string; case: "groupValue" } | { case: undefined }
  applicationCount: bigint; targetCount: bigint
  health: FleetHealthBucket[]
  resourceWeight: bigint; requestRateWeight: number; effectiveWeight: number
  usedResourceFallback: boolean
  children: FleetMapNode[]
}
class QueryFleetMapRequest  { filter?: FleetFilter; search: string; group: FleetGroupDimension; sizeMetric: FleetSizeMetric }   // 5930
class QueryFleetMapResponse { roots: FleetMapNode[]; total: bigint; indexGeneration: bigint; facets: FleetFacetBucket[] }       // 5969

class FleetMatrixHeader { stableId: string; label: string; key: {object|value oneof} }                 // 6008
class FleetMatrixCell   { rowId: string; columnId: string; applicationCount: bigint; targetCount: bigint; health: FleetHealthBucket[]; resourceWeight: bigint; requestRateWeight: number; usedResourceFallback: boolean }  // 6054
class QueryFleetMatrixRequest  { filter?: FleetFilter; search: string; rowGroup: FleetGroupDimension; columnGroup: FleetGroupDimension; sizeMetric: FleetSizeMetric }  // 6113
class QueryFleetMatrixResponse { rows: FleetMatrixHeader[]; columns: FleetMatrixHeader[]; cells: FleetMatrixCell[]; total: bigint; indexGeneration: bigint; facets: FleetFacetBucket[] }  // 6157
```

#### Legacy / detail surface (used by the dashboard + detail pages)

```ts
class Application {                                                                                   // 1404
  name: string; namespace: string
  phase: string                    // free-form, e.g. "Healthy" | "Degraded" | "Promoting"
  currentStage: string; revision: string; synced: boolean
  templateRef: string; pipelineRef: string; releaseRef: string
  stages: ApplicationStage[]
  source?: ApplicationSource
  strategy: string; syncPolicy: string
  parameters: { [key: string]: string }
  sourceHash: string; sourceRevision: string
  health: string                   // free-form string, NOT the FleetHealth enum
  healthChecks: HealthCheckResult[]
  resources: ResourceSync[]
  resourceHealth: ResourceHealth[]
  outOfSync: number; prunedResources: number
  gates: GateStatus[]
  project: string
  conditions: Condition[]
  analysisResults: AnalysisResult[]
}
class ApplicationStage  { name: string; ring: number; phase: string; release: string; revision: string }   // 865
class ApplicationSource {                                                                                   // 775
  type: string; repoUrl: string; revision: string; path: string; chart?: ChartRef
  bucket: string; key: string; region: string; endpoint: string; secretRef: string
  pollInterval: string; inline?: InlineSource; oci?: OCISource
}

class Pipeline { name: string; namespace: string; createdAt: bigint; steps: Step[]; maxParallel: number; phase: string; stepStatuses: StepStatus[]; artifacts: ArtifactRef[] }   // 1561
class Step        { name: string; image: string; script: string; depends: string[] }                       // 522
class StepStatus  { name: string; phase: string; startedAt?: bigint; completedAt?: bigint }                // 561
class ArtifactRef { name: string; path: string; kind: string; reference: string; resolvedReference: string; digest: string; phase: string; producingStep: string; createdAt: bigint; failedReason: string }  // 604

class Release {                                                                                            // 1690
  name: string; namespace: string; createdAt: bigint
  pipeline: string; target: string; phase: string; currentStage: string
  promotionHistory: Promotion[]
  manifestSource?: ManifestSource
  policyResults: PolicyResult[]
  application: string; rolledBackTo: string; observedGeneration: bigint
  conditions: Condition[]; renderedManifestSnapshot: string
  canaryWeight: number; canaryStepIndex: number; canaryStepStartedAt: bigint
  rolloutRef: string; hookStatuses: HookStatus[]
}
class Promotion { stage: string; result: string; timestamp: bigint; manifestSnapshot: string }              // 1811
class Stage     { name: string; namespace: string; createdAt: bigint; ring: number; phase: string; stageName: string }  // 1911

class Rollout {                                                                                            // 3485
  name: string; namespace: string
  strategyType: string; phase: string
  currentStep: number; currentWeight: number
  stableRs: string; canaryRs: string; activeService: string; previewService: string
  observedGeneration: bigint; conditions: Condition[]; message: string
  targetKind: string; targetName: string; replicas: number
  paused: boolean; abort: boolean
  stableReadyReplicas: number; canaryReadyReplicas: number
  currentStepStartedAt: bigint; promotedAt: bigint; previewHealthyAt: bigint
  currentPodHash: string; previousActiveRs: string
  trafficRouter?: TrafficRouter
  canarySteps: RolloutStep[]           // { setWeight: number; duration: string }
  analysisChecks: RolloutAnalysisCheck[]
  abRoutes: RolloutABRoute[]
  mirrorPercent: number; autoPromotionSeconds: number; scaleDownDelaySeconds: number
}

class GateStatus   { name: string; stage: string; status: string; approvedBy: string; type: string; message: string }   // 1131
class Condition    { type: string; status: string; observedGeneration: bigint; lastTransitionTime: string; reason: string; message: string }   // 1180
class ResourceSync   { kind: string; name: string; namespace: string; status: string }                     // 1048
class ResourceHealth { kind: string; name: string; namespace: string; health: string; message: string }     // 1087
class HealthCheckResult { name: string; status: string; message: string; checkedAt?: bigint; httpStatusCode: number; httpBody: string }  // 997
class Policy       { name: string; severity: string; defaultAction: string; description: string }          // 2486
class ApplicationSet { name: string; namespace: string; applications: number; phase: string }              // 2578

class ResourceNode     { kind; name; namespace; syncStatus; health; healthMessage; parentKind; parentName; uid: string; managed: boolean }  // 4599
class ResourceTreeNode { …ResourceNode fields… + phase: string; ready: number; total: number; message: string; containers: string[] }        // 4814
class GetResourceResponse {                                                                                // 4466
  kind: string; name: string; namespace: string; syncStatus: string
  healthStatus: string; healthMessage: string
  liveManifest: string; desiredManifest: string; diff: string
  events: KubernetesEvent[]
  apiVersion: string; group: string; version: string; resource: string; uid: string
  labels: { [key: string]: string }; annotations: { [key: string]: string }
}
class KubernetesEvent { type; reason; message; lastTimestamp: string; count: number; involvedObjectKind; involvedObjectName: string }  // 4412

class AnalysisRun       { name; namespace; templateRef; applicationRef; phase: string; cyclesExecuted: number; startedAt: bigint; completedAt: bigint; observedGeneration: bigint; args: {[k:string]:string}; results: AnalysisRunResult[]; conditions: Condition[] }  // 1325
class AnalysisRunResult { name: string; passed: boolean; message: string; detail: string; checkedAt: string }  // 1279

class InvestigationFinding { id: string; severity: Severity; title: string; description: string; evidence: FindingEvidence[]; playbook: string[]; narrator: string }  // 5010
class FindingEvidence      { source: string; timestamp: string; summary: string }                          // 4976
class InvestigateResponse  { findings: InvestigationFinding[]; summary: string; narrator: string; generatedAtMs: bigint }  // 5064
class LogChunk             { podName: string; containerName: string; line: string; timestampMs: bigint }    // 5229
```

#### List request/response shapes used by the dashboard

```ts
ListPipelinesRequest        { namespace?: string; project: string }                     // 2206
ListPipelinesResponse       { pipelines: Pipeline[] }                                   // 2235
ListReleasesRequest         { namespace?: string; project: string; applicationName: string; pageSize: number; pageOffset: number }  // 2259
ListReleasesResponse        { releases: Release[]; totalCount: number }                 // 2303
ListApplicationsRequest     { namespace?: string; project: string }                     // 2385
ListApplicationsResponse    { applications: Application[] }                             // 2414
ListPoliciesResponse        { policies: Policy[] }                                      // 2462
ListApplicationSetsResponse { applicationsets: ApplicationSet[] }   // NOTE lowercase "applicationsets"  // 2641
ListRolloutsRequest         { namespace?: string; project: string }                     // 3664
ListRolloutsResponse        { rollouts: Rollout[] }                                     // 3693
GetApplicationRequest       { name: string; namespace: string }                         // 2525
GetApplicationResponse      { application?: Application }                               // 2554
GetPipelineRequest          { name: string; namespace: string }                         // 3987
GetPipelineResponse         { pipeline?: Pipeline }                                     // 4016
```

**`ListPipelines` / `ListApplications` / `ListRollouts` / `ListPolicies` / `ListApplicationSets` are
NOT paginated.** Only `ListReleases` has `pageSize`/`pageOffset`.

---

## 3. Domain concepts — what the backend actually provides

### 3.1 Application (fleet row) — `ApplicationSummary`

Real, populated fields for a fleet row: `identity {namespace,name}`, `project {namespace,name}`,
`targets[]` (per-stage: `stage`, `ring`, `cluster`, `clusterLabel`, `health`, `clusterConnection`,
`unmanagedInlineCluster`), `currentStage`, `currentCluster`, `currentClusterLabel`, `sourceType`,
`sourceRevision`, `health`, `sync`, `driftCount`, `missingResourceCount`, `releaseState`,
`rolloutState`, `resourceCount`, `repository`, `repositoryConnection`,
`effectiveObservabilitySource`, `observabilityConnection`, `blockedGateCount`,
`lastTransitionUnixMs` (bigint epoch ms), `capabilities[]`.

**There is NO** per-application: description, owner/team string, git commit message, deploy duration,
error rate / latency / request-rate number, cost, replica count, image tag, last-deployed-by,
environment colour, uptime, or SLO. The only "load" signal on an application is `resourceCount`;
request rate exists **only aggregated on treemap/matrix nodes** (`requestRateWeight`), never per row.

`capabilities` are authorization-derived per project (Go `internal/fleet/pagination.go:90`,
`internal/fleet/status.go:99` → `scope.SortedCapabilities(summary.Project)`), not per application
state. `internal/fleet/model.go:143` comments that capabilities are deliberately absent from the
shared index.

### 3.2 Cluster

There is **no Cluster message**. A cluster is only ever a `FleetObjectKey` (`namespace` + `name`) plus
a display `clusterLabel: string` and a `clusterConnection: FleetConnectionState`. Cluster-level
aggregates only exist as treemap/matrix group nodes (via `FleetGroupDimension.CLUSTER`) and as
`FleetFacetDimension.CLUSTER` facet buckets with a `count`.

### 3.3 Rollout

`Rollout` (line 3485) is rich: `strategyType`, `phase`, `currentStep`, `currentWeight`, `stableRs`,
`canaryRs`, `activeService`, `previewService`, `paused`, `abort`, `stableReadyReplicas`,
`canaryReadyReplicas`, `replicas`, `currentStepStartedAt`, `promotedAt`, `previewHealthyAt`,
`trafficRouter` (Istio / Gateway API config), `canarySteps[] {setWeight, duration}`,
`analysisChecks[]`, `abRoutes[]`, `mirrorPercent`, `autoPromotionSeconds`, `scaleDownDelaySeconds`,
`conditions[]`, `message`. `phase` is a **free-form string** here (only the *fleet* `rolloutState` is
the `FleetRolloutState` enum).

Mutations available: `PromoteRollout`, `AbortRollout`.

### 3.4 Pipeline

`Pipeline` = `name`, `namespace`, `createdAt: bigint`, `steps: Step[]` (`name`, `image`, `script`,
`depends[]` — this is the DAG edge list), `maxParallel`, `phase: string`, `stepStatuses: StepStatus[]`
(`name`, `phase`, `startedAt?`, `completedAt?` — all bigint), `artifacts: ArtifactRef[]`.

No per-step logs inline — use `GetStepLogs` / `StreamResourceLogs`. Mutations: `RetryStep`,
`SkipStep`, `CancelPipeline`.

### 3.5 Resource

Three shapes: `ResourceSync` (kind/name/namespace/status), `ResourceHealth`
(kind/name/namespace/health/message), `ResourceNode` (adds `syncStatus`, `healthMessage`,
`parentKind`, `parentName`, `uid`, `managed`), and `ResourceTreeNode` (adds `phase`, `ready`, `total`,
`message`, `containers[]`). Full detail via `GetResource` → live/desired manifest, unified `diff`,
`events: KubernetesEvent[]`, `labels`, `annotations`.

### 3.6 Health / sync status enums

The **only** typed status vocabularies are the fleet enums in §2.2. Everything on the legacy
`Application`/`Release`/`Rollout`/`Pipeline` messages is a raw string. Do not assume a closed set for
those — the fleet fixture emits `"Healthy"`, `"Degraded"`, `"Progressing"`, `"Pending"` for stage
phases and `"Running"`, `"Succeeded"`, `"Failed"` for pipeline phases (see the dashboard counters at
`src/app/dashboard/page.tsx:231-233`).

### 3.7 Impact ranking (`sort=impact`)

Server-side only. `internal/fleet/cursor.go:281`:

```go
type ImpactKey struct {
  UnhealthySeverity    uint8
  BlockedGates         uint32
  ActiveChange         bool
  ResourceCount        uint32
  LastTransitionUnixMS int64
}
```
Compared lexicographically (`internal/fleet/pagination.go:301 compareImpact`). The UI never
re-sorts — `AttentionQueue` explicitly states "The fleet service orders this queue."

### 3.8 Where the data is consumed today

- **Root layout** `src/app/layout.tsx`: `<AuthProvider><ConnectionProvider><QueryProvider><Nav/>…`.
  Fonts: `Instrument_Sans` → `--font-sans` (weights 400/500/600/700), `JetBrains_Mono` → `--font-mono`
  (400/500). `<html className="… dark" style={{ colorScheme: "dark" }}>` — **dark-only**.
- **Dashboard layout** `src/app/dashboard/layout.tsx` → `<AppShell>` = skip link + `<Sidebar/>` +
  `<ScopeBar/>` + `<main id="dashboard-main" tabIndex={-1}>`; content wrapper is `lg:pl-64`.
- **`/dashboard`** `src/app/dashboard/page.tsx` (478 lines): `useFleetData(mergeFleetQuery(shared, { view: "queue", sort: "impact", direction: "desc" }))`
  for the overview, PLUS a module-level `createPromiseClient(PaprikaService, createTransport())`
  driving `Promise.allSettled([listPipelines({}), listReleases({pageSize: 100}), listApplicationSets({}), listPolicies({}), listRollouts({})])`
  into `useState` (lines 165–215). Errors are per-section strings. Refresh via
  `useSingleFlightRefresh` + `useFleetRefresh(refreshDashboard, { onRequestOutcome: reportRequestOutcome })` (60 s).
  `DASHBOARD_RELEASE_SEARCH_LIMIT = 100`.
- **`/dashboard/applications`** `src/app/dashboard/applications/page.tsx` (32 lines): `<Suspense>` +
  `<FleetView/>`. Fallback copy verbatim: eyebrow `Fleet inventory`, h1 `Applications`, status
  `Loading fleet query controls…`.
- Other pages each construct their own module-scope `createPromiseClient`:
  `dashboard/application/page.tsx` (786), `dashboard/pipelines/detail/page.tsx`,
  `dashboard/rollouts/page.tsx` (293), `dashboard/rollouts/detail/page.tsx`,
  `dashboard/applicationsets/page.tsx` (178), `dashboard/applicationsets/detail/page.tsx`,
  plus components `resource-detail-panel.tsx`, `investigation-panel.tsx`, `application-card.tsx`.
  **`getFleetClient()` from `fleet-client.ts` is used only inside `fleet-client.ts` itself.**

#### Current fleet UI label text (verbatim, for before/after comparison)

`src/components/fleet/fleet-view.tsx` (391 lines):
- eyebrow `Fleet inventory`; `<h1 id="applications-title" tabIndex={-1}>Applications</h1>`;
  subtitle `Filter, compare, and troubleshoot every authorized deployment from one indexed snapshot.`
- `<section aria-labelledby="applications-title" aria-busy={loading||stale} data-fleet-ready={fleetReadyTotal}>`
  — `data-fleet-ready` is what the scale e2e waits on.
- Notice bar `role="status" aria-label="Fleet query notice"`, dismiss button `aria-label="Dismiss fleet query notice"`.
- SR-only live region `role="status" aria-label="Fleet focus updates" aria-live="assertive"`.
- Presentation dispatch: `applications` + `view==="queue"` → `<AttentionQueue>`, else `<ApplicationTable>`;
  `map` → `<FleetTreemap>`; `matrix` → `<FleetMatrix>`.

`src/components/fleet/fleet-filters.tsx` (786 lines):
- `<section aria-label="Fleet query controls">`; label `Search fleet`; input
  `aria-label="Search applications"` `type="search"` placeholder `Application, project, cluster, revision…`
- fieldset legend `Presentation`, 4 buttons `aria-label={`Show ${label} view`}` `aria-pressed`:
  `{ treemap, "Treemap", "Relative fleet footprint" }`, `{ matrix, "Matrix", "Cross-scope comparison" }`,
  `{ table, "Table", "Sortable inventory" }`, `{ queue, "Queue", "Highest impact first" }` (line 54).
- `<div aria-label="Active filters">` chips; `<details>` with `<summary>Filter dimensions</summary>` + `+` glyph.
- 9 filter groups in this order: `Project`, `Cluster`, `Stage`, `Namespace`, `Health`, `Sync`,
  `Release`, `Rollout`, `Source`.
- Canvas controls (`aria-label="{Treemap|Matrix} layout controls"`): `Group treemap by` (treemap) OR
  `Matrix rows` + `Matrix columns` (matrix), plus `Size applications by`.

`src/components/fleet/application-table.tsx` (372 lines) — **column order & sizes**:
- `role="table" aria-label="Applications" aria-rowcount={Number(total)+1} aria-colcount={6}`
- grid: `grid-cols-[minmax(15rem,1.5fr)_minmax(9rem,1fr)_8rem_8rem_7rem_minmax(10rem,1fr)]`, `gap-3`,
  `px-4 sm:px-6`, min row height 11 (header) / `py-3`, `min-w-[58rem]`
- headers, in order: **`Application`, `Target`, `Health`, `Sync`, `Resources`, `Authorized actions`**
  (`font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground`)
- cell 1 = `identity.name` (fallback `Unnamed application`) + `namespace/name` mono
  (fallback `Identity unavailable`); cell 2 = `currentClusterLabel` (fallback `No target`) +
  `currentStage` (fallback `Stage unknown`); cell 5 = `resourceCount.toLocaleString()`
- virtualised with `@tanstack/react-virtual`, `estimateSize: () => 76`, `overscan: 8`,
  `initialRect: { width: 1120, height: 560 }`; scroll box `h-[min(62vh,42rem)] min-h-80`
- `ApplicationCapabilityActions` buttons (all `disabled`, title
  `Open the application detail to perform this authorized action`):
  `application_sync`→`Sync` (`aria-label="Sync ns/name"`), `release_rollback`→`Rollback`,
  `gate_approve`→`Approve`, `pipeline_retry`→`Retry`
- `FleetLoadMore` — `data-testid="fleet-load-more-sentinel"`, text
  `` `${loaded.toLocaleString()} loaded / ${total.toString()} indexed` ``, button
  `aria-label="Load 100 more applications"`, label `Load next 100` / `Loading next 100…`

`src/components/fleet/attention-queue.tsx` (156 lines): `<section aria-label="Attention queue">`,
eyebrow `Server-ranked impact`, copy `The fleet service orders this queue. Every page remains in
authoritative server order.`, `<ol aria-label="Applications requiring attention">`, `estimateSize: () => 116`, `overscan: 6`.

`src/components/fleet/fleet-states.tsx` (91 lines) — the 7 non-`ready` status notices, verbatim:

| status | title | detail | role | icon |
|---|---|---|---|---|
| loading | `Loading fleet data` | `Reading the current application index.` | status | `LoaderCircle` (spins, `motion-reduce:animate-none`) |
| empty | `No applications match this scope` | `Adjust a filter or search term to widen the operational view.` | status | `ArchiveX` |
| unauthorized | `You do not have access to this fleet scope` | `The index excludes applications outside your authorized projects.` | alert | `ShieldX` |
| unavailable | `Fleet index unavailable` | `The deployment index is not ready. Existing application routes remain available.` | alert | `Unplug` |
| stale | `Showing previous fleet data` | `The requested presentation is loading; this snapshot may be out of date.` | status | `Clock3` |
| partial | `Some applications could not be loaded` | `Loaded rows remain available. Retry the next page when the service recovers.` | status | `AlertTriangle` |
| error | `Fleet query failed` | `Paprika could not complete this query. Your URL scope has been preserved.` | alert | `AlertTriangle` |

`stale`/`partial` render compact (`border-b … bg-muted/50 px-4 py-3`); the rest render as a
`min-h-44` card (`mx-4 my-8 … border border-border bg-card px-5 py-6`).

`src/components/fleet/fleet-overview.tsx` (344 lines) — dashboard overview, all derived **client-side**
from the loaded attention window + facets:
- eyebrow `Authorized fleet`, `<h2>Operations overview</h2>`, link `Open application inventory` → `/dashboard/applications`
- `Fleet health posture` card, `{total} applications`, a 6-cell grid in `healthOrder` =
  `["healthy","progressing","degraded","failed","missing","unknown"]`
- `Change surface` / `Active delivery changes`: counts `Active releases`, `Active rollouts`, `Blocked gates`;
  footnote `{n} highest-impact applications loaded; blocked-gate count reflects this window.`
  - `activeReleaseStates` = `pending, promoting, canarying, verifying, awaiting_approval`
  - `activeRolloutStates` = `pending, progressing, paused`
- `Dependency posture` / `Connection failures`: `Repository failures`, `Cluster failures`, `Observability failures`;
  footnote `… connection counts reflect this window. Observability sources that are not configured are absent, not failed.`
- `Server-ranked impact` / `Highest impact attention` + link `Open full queue` →
  `/dashboard/applications?sort=impact&direction=desc&view=queue`; list rows link to
  `/dashboard/application?namespace=…&name=…`; index badge `String(i+1).padStart(2,"0")`;
  empty state `No applications currently require attention.`
  - `attentionReleaseStates` = `failed, awaiting_approval`; `attentionRolloutStates` = `paused, degraded, failed, aborted`

`src/components/layout/sidebar.tsx` — `<nav aria-label="Fleet sections">`, width `w-64`, sections:
- **Fleet**: `Overview` → `/dashboard` (LayoutDashboard), `Applications` → `/dashboard/applications` (Rocket)
- **Delivery**: `Pipelines` → `/dashboard#pipelines` (GitBranch), `Releases` → `/dashboard#releases` (Package), `Rollouts` → `/dashboard/rollouts` (Boxes)
- **System**: `Activity` (Activity, **disabled**), `Admin` (Settings, **disabled**) — rendered as
  `<button disabled aria-disabled="true" aria-label="{label}. Available in a later plan" title="Available in a later plan">`
- Brand: `P` mark, `Paprika` / `Control plane`; footer shows user + `Authenticated` + `aria-label="Sign out"`, or `Operations console`.
- `/dashboard#applications` is client-redirected to `/dashboard/applications`.

`src/components/layout/scope-bar.tsx` — `<section aria-label="Current fleet scope">` sticky
`top-14 lg:top-0`, eyebrow `Fleet scope`, three **static, non-interactive** segments:
`Projects: All projects` (Layers), `Clusters: All clusters` (Boxes), `Stages: All stages` (Rocket).

Design tokens live in `src/app/globals.css` (206 lines) as Tailwind v4 `@theme` vars in **oklch**:
`--background: oklch(0.115 0.01 50)` etc., with `--color-*` aliases for background/foreground/card/
popover/primary/secondary/muted/accent/destructive/**success**/**warning**/border/input/ring and a
full `--color-sidebar-*` family, plus `--radius-sm|md|lg|xl` and `--ease-out-quart|quint|expo`.

---

## 4. Testing

### 4.1 `ui/vitest.config.mts` (17 lines, verbatim)

```ts
import { defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    environment: "happy-dom",
    setupFiles: ["./src/test-setup.ts"],
    globals: true,
    css: false,
  },
})
```

Note: `include` is `src/**` only, so `e2e/*.spec.ts` is never picked up by vitest. `css: false` means
Tailwind classes are never evaluated — assert on roles/text, not computed styles.

### 4.2 `src/test-setup.ts` (1 line, verbatim)

```ts
import "@testing-library/jest-dom/vitest"
```

### 4.3 How existing tests mock the data layer

**35 test files** under `src/`. Three distinct mocking strategies:

**(a) Inject `FleetDataClient` into `useFleetData` (no `vi.mock` at all).**
`src/lib/use-fleet-data.test.tsx` (776 lines) builds a fake client and passes it as
`options.client`. Representative setup, verbatim (lines 125–170):

```tsx
interface TestCalls {
  applications: Array<{ state: FleetQueryState; options: QueryApplicationsOptions }>
  map: Array<{ state: FleetQueryState; options: FleetRequestOptions }>
  matrix: Array<{ state: FleetQueryState; options: FleetRequestOptions }>
}

function testClient(overrides: Partial<FleetDataClient> = {}): { client: FleetDataClient; calls: TestCalls } {
  const calls: TestCalls = { applications: [], map: [], matrix: [] }
  const client: FleetDataClient = {
    queryApplications: async (state, options = {}) => {
      calls.applications.push({ state, options })
      return applicationsPage([application("initial", { namespace: "apps", name: "api" })])
    },
    queryFleetMap: async (state, options = {}) => {
      calls.map.push({ state, options })
      return mapResult()
    },
    queryFleetMatrix: async (state, options = {}) => {
      calls.matrix.push({ state, options })
      return matrixResult()
    },
    ...overrides,
  }
  return { client, calls }
}

function queryWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } },
  })
}
```

Its `application()` factory (lines 35–60) shows the **minimum viable `FleetApplicationSummary`**:

```tsx
function application(sourceRevision: string, identity?: NamespacedKey): FleetApplicationSummary {
  return {
    identity, targets: [], currentStage: "", currentClusterLabel: "",
    sourceType: "git", sourceRevision, health: "healthy", sync: "synced",
    driftCount: 0, missingResourceCount: 0, releaseState: "complete", rolloutState: "healthy",
    resourceCount: 1, repositoryConnection: "healthy", observabilityConnection: "healthy",
    blockedGateCount: 0, lastTransitionUnixMs: BigInt(0), capabilities: [],
  }
}
```

**(b) `vi.mock` the hook module itself (component tests).**
`src/components/fleet/fleet-view.test.tsx` (680 lines), lines 14–46:

```tsx
const navigation = vi.hoisted(() => ({
  params: new URLSearchParams(),
  pathname: "/dashboard/applications",
  replace: vi.fn(),
}))
const mockUseFleetData = vi.hoisted(() => vi.fn())

vi.mock("next/navigation", () => ({
  usePathname: () => navigation.pathname,
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => navigation.params,
}))

vi.mock("@/lib/use-fleet-data", async () => {
  const actual = await vi.importActual<typeof import("@/lib/use-fleet-data")>("@/lib/use-fleet-data")
  return { ...actual, useFleetData: mockUseFleetData }
})

import { FleetView } from "@/components/fleet/fleet-view"   // ← import AFTER the mocks

beforeEach(() => {
  navigation.params = new URLSearchParams()
  navigation.pathname = "/dashboard/applications"
  navigation.replace.mockReset()
  mockUseFleetData.mockReset()
  mockUseFleetData.mockImplementation((state: FleetQueryState) => fleetResult(state, { status: "loading" }))
})
afterEach(() => { vi.restoreAllMocks() })
```

plus a full `UseFleetDataResult` factory (lines 547–574) that derives every `is*` flag from `status`:

```tsx
function fleetResult(state: FleetQueryState, overrides: Partial<UseFleetDataResult>): UseFleetDataResult {
  const status = overrides.status ?? "ready"
  return {
    state, status,
    currentData: undefined, staleData: undefined, displayData: undefined,
    error: undefined, applicationFacets: [],
    isLoading: status === "loading", isReady: status === "ready", isEmpty: status === "empty",
    isStale: status === "stale", isPartial: status === "partial",
    isUnauthorized: status === "unauthorized", isUnavailable: status === "unavailable",
    isError: ["unauthorized", "unavailable", "error"].includes(status),
    hasMore: false, isLoadingMore: false,
    loadMore: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}
```

**(c) `vi.mock` the whole Connect stack (page tests).**
`src/app/dashboard/__tests__/dashboard-refresh.test.tsx`, lines 5–58 — the canonical recipe for any
page that constructs its own `createPromiseClient` at module scope:

```tsx
const mockClient = vi.hoisted(() => ({
  listPipelines: vi.fn().mockResolvedValue({ pipelines: [] }),
  listReleases: vi.fn().mockResolvedValue({ releases: [] }),
  listApplications: vi.fn().mockResolvedValue({ applications: [] }),
  listApplicationSets: vi.fn().mockResolvedValue({ applicationsets: [] }),
  listPolicies: vi.fn().mockResolvedValue({ policies: [] }),
  listRollouts: vi.fn().mockResolvedValue({ rollouts: [] }),
}))
const mockReportRequestOutcome = vi.hoisted(() => vi.fn())
const fleetMocks = vi.hoisted(() => { /* displayData + refresh + useFleetData vi.fn */ })
const navigation = vi.hoisted(() => ({ query: "" }))

vi.mock("@connectrpc/connect-web", () => ({ createConnectTransport: vi.fn(() => ({})) }))
vi.mock("@connectrpc/connect",     () => ({ createPromiseClient: vi.fn(() => mockClient) }))
vi.mock("@/gen/paprika/v1/api_connect", () => ({ PaprikaService: {} }))
vi.mock("@/lib/connection-context", () => ({ useConnection: () => ({ reportRequestOutcome: mockReportRequestOutcome }) }))
vi.mock("@/lib/use-fleet-data",    () => ({ useFleetData: fleetMocks.useFleetData }))
vi.mock("next/navigation",         () => ({ useSearchParams: () => new URLSearchParams(navigation.query) }))
vi.mock("@/components/dashboard/pipeline-card",   () => ({ PipelineCard: () => <div /> }))
vi.mock("@/components/dashboard/application-card",() => ({ ApplicationCard: () => <div /> }))
vi.mock("@/components/notifications/toast-stack", () => ({ ToastStack: () => null }))

import DashboardPage from "@/app/dashboard/page"

function renderDashboard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><DashboardPage /></QueryClientProvider>)
}
```

Other patterns seen: `vi.mock("@/lib/transport", …)` (`dashboard/application/page.test.tsx`),
`vi.mock("@/lib/clipboard", …)` (`artifact-card.test.tsx`), `vi.mock("@/lib/auth-context", …)`
(`app-shell.test.tsx`), `vi.mock("@xyflow/react", …)` (`pipeline-dag.test.tsx`, `resource-graph.test.tsx`),
`vi.mock("lucide-react", …)` (several component tests).

`src/lib/fleet-client.test.ts` (197 lines) is a **real-protobuf** test: it constructs actual
`QueryApplicationsResponse`/`FleetObjectKey`/`ApplicationSummary` instances from `@/gen/...` and
round-trips them through `toQuery*Request` / `fromQuery*Response` — no mocking at all. It also
asserts the `query-provider` defaults verbatim (see §1.10).

### 4.4 Playwright

**`ui/playwright.config.ts` (61 lines)**
- `const baseURL = "http://127.0.0.1:3100"`; `desktopViewport = { width: 1920, height: 1080 }`
- `useExternalServer = process.env.PLAYWRIGHT_NO_WEBSERVER === "1"`
- `testDir: "./e2e"`, `timeout: 45_000`, `expect.timeout: 10_000`
- `forbidOnly: Boolean(process.env.CI)`, `retries: CI ? 1 : 0`,
  `reporter: CI ? [["line"],["html",{open:"never"}]] : "line"`
- `use: { baseURL, viewport: desktopViewport, trace: "retain-on-failure", screenshot: "only-on-failure" }`
- `webServer` (skipped when `PLAYWRIGHT_NO_WEBSERVER=1`):
  ```
  command: "./bin/fleet-console-fixture --listen 127.0.0.1:3100 --assets ui/out --applications 250"
  cwd: "..", url: `${baseURL}/readyz`, reuseExistingServer: false, timeout: 120_000,
  stdout: "pipe", stderr: "pipe"
  ```
  ⇒ it serves the **static export in `ui/out`**, so you must `npm run build` first.
- three projects, all `devices["Desktop Chrome"]` @ 1920×1080:
  `chromium` (`reducedMotion: "no-preference"`), `chromium-reduced-motion` (`reducedMotion: "reduce"`),
  `chromium-keyboard-only` (`no-preference`; the specs branch on `testInfo.project.name` to drive
  everything with Tab/Enter/Space instead of clicks).

**The fixture server** — `test/fleetconsole/{main,server,seed,static}.go`, built with
`go build -o bin/fleet-console-fixture ./test/fleetconsole`. Flags: `--listen` (default `127.0.0.1:3100`),
`--assets` (default `ui/out`), `--applications` (default 250, max 100 000). It mounts the **real**
`apiserver.NewPaprikaServer` with a fake k8s client + fleet index, serves `/healthz` + `/readyz`, and
deliberately serves **404 on `/events`** (`server.go`) so a legacy EventSource fallback can never look
like a success. Auth is disabled (same-origin, no interceptor) — see the comment at `server.go:32`.

Seed data (`test/fleetconsole/seed.go`): namespaces `team-00`…`team-NN` (`fmt.Sprintf("team-%02d", index%fixtureNamespaceCount)`);
app 0 is named **`checkout-service`**, the rest `application-%05d`. Five repeating states by `index % 5`:

| i%5 | project | source | app phase | health | synced | drift | stage | release | rollout | repository | cluster | gate |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0 | payments | Git | Healthy | Healthy | true | 0 | Healthy | Complete | Healthy | source-primary | delivery-primary | — |
| 1 | commerce | Helm | Degraded | Degraded | false | 0 | Degraded | Failed | Degraded | source-unhealthy | delivery-unhealthy | — |
| 2 | fulfillment | Kustomize | Healthy | Healthy | false | 3 | Healthy | Complete | Healthy | source-primary | delivery-primary | — |
| 3 | platform | OCI | Promoting | Progressing | true | 0 | Progressing | Promoting | Progressing | source-primary | delivery-primary | — |
| 4 | payments | S3 | Promoting | Progressing | true | 0 | Pending | AwaitingApproval | Paused | source-primary | delivery-primary | **blocked** |

**`e2e/fleet-console.spec.ts` (244 lines)** — 6 tests. Constants: `projectKey = "team-00/payments"`,
`fuzzyApplication = "team-00/checkout-service"`, `keyboardProject = "chromium-keyboard-only"`.
An **auto fixture `eventAudit`** (lines 19–40) records every request whose pathname is `/events` and
asserts at teardown:
`expect(eventRequests, "the compiled console must never request the unauthorised legacy event stream").toEqual([])`.

1. `serves the compiled shell with exact links and disabled placeholders` — `/dashboard/applications`;
   `heading level 1 "Applications"`; `navigation "Fleet sections"` must contain exactly
   `["Overview","/dashboard/"], ["Applications","/dashboard/applications/"], ["Pipelines","/dashboard/#pipelines"], ["Releases","/dashboard/#releases"], ["Rollouts","/dashboard/rollouts/"]`
   (note the **trailing slashes** — `trailingSlash: true`); `Activity`/`Admin` must be disabled buttons
   with `aria-disabled="true"` + `title="Available in a later plan"` and **no** link of that name.
2. `applies a namespaced project facet and typo-tolerant application search` — opens
   `summary` "Filter dimensions", checks `checkbox "Project team-00/payments"`, types
   `"checkout servce"` (deliberate typo) into `searchbox "Search applications"`, expects the row
   `team-00/checkout-service` and sentinel `1 loaded / 1 indexed`.
3. `preserves URL state through Treemap, Matrix, and Table with keyboard selection` — asserts
   `role="application"` `Fleet treemap` has `data-motion` = `"reduced"` in the reduced-motion project
   else `"enabled"`; `Home` key selects; state (`project`, `health`, `q`, `selected`, `view`) survives
   `Show Matrix view` → `Show Table view`.
4. `loads the next cursor page without replacing existing applications` — sentinel
   `100 loaded / 250 indexed` → click `Load 100 more applications` → `200 loaded / 250 indexed`.
5. `opens a real Application deep link from highest-impact attention` — from `/dashboard`,
   `region "Highest impact attention"` → first `listitem` link → asserts `?name=`/`?namespace=` present,
   navigates, expects `heading level 1 {applicationName}`, text `Current Phase`, and **zero**
   `Application not found.`
6. `redirects the legacy applications hash to the dedicated inventory` — `/dashboard#applications`
   ends at `${baseURL}/dashboard/applications/`.

Helpers: `activate(page, locator, testInfo, key="Enter")` clicks normally but Tab-walks + presses the
key in `chromium-keyboard-only`; `tabTo` presses Tab up to 250 times; `queryValue`/`queryValues`/`expectQueryState`
read `new URL(page.url()).searchParams`.

**`e2e/fleet-scale.spec.ts` (433 lines)** — single test
`10,000-application fleet stays within Canvas presentation budgets`, `test.setTimeout(180_000)`,
skipped unless `browserName === "chromium" && testInfo.project.name === "chromium"`.
Budgets: `APPLICATION_COUNT = 10_000`, `INITIAL_SAMPLE_COUNT = 20`, `SWITCH_SAMPLE_COUNT = 30`,
`INITIAL_P95_LIMIT_MS = 2_000`, `SWITCH_P95_LIMIT_MS = 250`, `MAX_TREEMAP_DOM_ELEMENTS = 200`,
`INITIAL_READY_MARK = "fleet-scale:initial-canvas-ready"`, ready selector
`[data-fleet-ready="10000"]`.
Hard assertions: sentinel `100 loaded / 10000 indexed`; table `aria-rowcount="10001"`;
`treemapDOM.canvasCount === 1`; `presentationControllerCount === 1`; `applicationNodeCount === 0`;
`descendantElementCount < 200` ("the Canvas presentation must keep its DOM bounded independently of
fleet size"); initial p95 < 2000 ms; switch p95 < 250 ms.
Writes `<repoRoot>/artifacts/fleet-scale/ui-scale.json` and prints
`FLEET_UI_INITIAL_P95_MS=…` / `FLEET_UI_SWITCH_P95_MS=…`.
**Implication for any redesign: the treemap must stay canvas-based with a bounded DOM.**

**`ui/screenshot.mjs` (24 lines)** — a standalone one-off, **not** wired into any npm script and not
part of Playwright. Uses `playwright` directly (`chromium.launch({ headless: true, args: ['--no-sandbox'] })`),
viewport `1440×900`, `snap(url, file)` = goto `domcontentloaded` (20 s) → `networkidle` (10 s, swallowed)
→ `setTimeout 3000` → `page.screenshot({ fullPage: true })`. It targets **`http://localhost:3333`**
(`/`, `/login`, `/dashboard`) and writes to `/Users/benebsworth/projects/paprika/docs/design/{landing,login,dashboard}-before.png`
(hardcoded absolute paths, `mkdirSync` recursive). Note bugs already in the file: only the first
`snap` is awaited, and `browser.close()` is not awaited.

### 4.5 CI (`.github/workflows/ci.yml`)

`fleet-ui` job: Node 22 → `npm ci` (cwd `ui`) → `npm run build` (cwd `ui`) →
`go build -o bin/fleet-console-fixture ./test/fleetconsole` (repo root) →
`npx playwright install --with-deps chromium` (cwd `ui`) →
`npm run test:e2e -- fleet-console.spec.ts` (cwd `ui`) → uploads `ui/playwright-report` + `ui/test-results`.
A separate `fleet-scale` job (90 min) runs `hack/test-fleet-scale.sh` in pinned
`golang:1.26.0-bookworm` + `mcr.microsoft.com/playwright:v1.61.1-noble` containers.

---

## 5. How to run

All commands from `/Users/benebsworth/projects/paprika/ui` (`node_modules` is already installed).

| Task | Command | Notes |
|---|---|---|
| Dev server | `npm run dev` | `next dev`, **no port flag** → default **http://localhost:3000**. Add `-- -p 3333` if you want the port `screenshot.mjs` expects. |
| Static build | `npm run build` | `next build`; `output: "export"`, `distDir: "out"` → produces `ui/out`. Required before Playwright. |
| GH-Pages build | `npm run build:gh-pages` | `PAPRIKA_BASE_PATH=/paprika next build` |
| Serve built export | `npm run start` | `next start` |
| Unit tests (once) | `npm test` | `vitest run` — 35 files under `src/` |
| Unit tests (watch) | `npm run test:watch` | `vitest` |
| Single unit file | `npx vitest run src/components/fleet/fleet-view.test.tsx` | |
| E2E | `npm run test:e2e` | `playwright test`. Needs `ui/out` built **and** `../bin/fleet-console-fixture` present (`cd .. && go build -o bin/fleet-console-fixture ./test/fleetconsole`). |
| E2E, one spec | `npm run test:e2e -- fleet-console.spec.ts` | what CI runs |
| E2E, one project | `npm run test:e2e -- --project=chromium` | others: `chromium-reduced-motion`, `chromium-keyboard-only` |
| E2E vs. an already-running server | `PLAYWRIGHT_NO_WEBSERVER=1 npm run test:e2e` | disables the managed `webServer` |
| Lint | `npm run lint` | `eslint` (flat config `eslint.config.mjs`: `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`; ignores `.next/**`, `out/**`, `build/**`, `next-env.d.ts`) |
| Typecheck | `npx tsc --noEmit` | `tsconfig.json` is `strict: true`, `noEmit: true`, path alias `@/* → ./src/*` |
| Regenerate protos | `npm run generate` | `cd .. && buf generate` |
| Install browsers | `npx playwright install --with-deps chromium` | |

Gotchas:
- The dev server (`:3000`) has **no backend** — every Connect call will fail and land the fleet UI in
  `unavailable`/`error` states. For a realistic UI, build and run the Go fixture:
  `cd /Users/benebsworth/projects/paprika && go build -o bin/fleet-console-fixture ./test/fleetconsole && npm --prefix ui run build && ./bin/fleet-console-fixture --listen 127.0.0.1:3100 --assets ui/out --applications 250`
  then open `http://127.0.0.1:3100/dashboard/applications`.
- `output: "export"` — **no server components with data fetching, no route handlers, no middleware**.
  Every data-touching component is `"use client"`.
- `trailingSlash: true` — internal hrefs resolve with a trailing slash (`/dashboard/applications/`).
