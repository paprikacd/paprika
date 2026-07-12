# Enterprise Console Remediation Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the audited local enterprise console into a keyboard-safe, release-complete, responsive operations surface while preserving its existing fleet-query architecture and industrial visual direction.

**Architecture:** Use Base UI's installed modal-dialog primitive for nested troubleshooting drawers; extend the existing authorized `ListReleases` RPC with bounded server-side search and surface it through a dedicated paginated route; retain one semantic/virtualized DOM per fleet presentation while reflowing below `xl`; progressively disclose the dashboard health map instead of rendering 100 full tiles by default. Keep Kubernetes and the existing Connect API authoritative.

**Tech Stack:** Go 1.26, Kubernetes fake client, Protobuf/Buf, Connect RPC, Next.js 16, React 19, TypeScript, Tailwind CSS 4, Base UI Dialog, TanStack Virtual, Vitest/Testing Library, Playwright.

**Approved design context:** `docs/superpowers/specs/2026-07-11-enterprise-operations-console-design.md` and `.impeccable.md`. The user approved continuing the prioritized audit remediation on 2026-07-12.

---

## Shared compiled-fixture protocol

Execute this protocol before the first compiled-browser RED run, and repeat the build steps after any Go fixture or UI export change. It prevents Playwright from silently exercising a stale process.

- [ ] Inspect port ownership with `rtk lsof -nP -iTCP:3100 -sTCP:LISTEN`. If occupied, inspect both `rtk ps -p <pid> -o command=` and `rtk lsof -a -p <pid> -d cwd -Fn`. Stop it with `rtk kill -TERM <pid>` only when the executable and cwd resolve to this worktree's `fleet-console-fixture` (or the explicitly documented `/tmp/paprika-fleetconsole` launched for this worktree); otherwise stop and ask the user rather than killing an identical binary from another worktree or an unrelated process.
- [ ] Build the exact artifacts under test:

  ```bash
  rtk go build -o bin/fleet-console-fixture ./test/fleetconsole
  rtk npm --prefix ui run build
  ```

- [ ] For automated E2E, explicitly run through `rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- ...`; `ui/playwright.config.ts` must start, poll, and clean up the 250-application fixture itself. A valid RED is a behavioral assertion after `/readyz`, never connection refusal.
- [ ] Use external-server mode only for interactive inspection after the automated suite. Task 22 defines the single persistent handoff process.

After every plan chunk is approved and before source implementation, checkpoint this plan so later cleanliness checks have a stable baseline:

```bash
rtk git diff --check
rtk git add docs/superpowers/plans/2026-07-12-enterprise-console-remediation.md
rtk git commit -m "docs: plan enterprise console remediation"
```

---

## Chunk 1: Accessible Troubleshooting

### Chunk 1 browser characterization — execute before Task 1

**Files:**
- Modify: `ui/e2e/fleet-console.spec.ts`

- [ ] Add one concrete Playwright scenario first. Navigate to `/dashboard/application?namespace=team-00&name=checkout-service`; wait for the `checkout-service` level-1 heading and `getByText("Managed Resources", { exact: true })`; then require `getByRole("button", { name: "Open Deployment checkout-service resource details" })`. This is the deterministic first RED assertion because the pre-fix graph has only a custom React Flow node. After it exists, keyboard-activate it with Enter, require dialogs named `Resource details for Deployment/checkout-service` and then `Investigation for Deployment/checkout-service`, verify first Escape returns focus to `Investigate` and second Escape returns focus to the graph button. Activate the existing `List` view toggle, focus the same named details button inside `getByRole("table", { name: "Application resources" })`, and open it with Space.
- [ ] Run the shared compiled-fixture protocol against the unchanged UI, then run `rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- e2e/fleet-console.spec.ts --project=chromium-keyboard-only`.

Expected RED: failure on missing native resource controls, dialog semantics, modal-stack Escape order, or focus return after `/readyz`; never connection refusal.

### Task 1: Convert resource details to a labelled modal dialog

**Files:**
- Modify: `ui/src/components/dashboard/resource-detail-panel.test.tsx`
- Modify: `ui/src/components/dashboard/resource-detail-panel.tsx`

- [ ] **Step 1: Add a failing stateful dialog-lifecycle test**

Render an `Open resource details` button that conditionally mounts `ResourceDetailPanel`. Spy on `console.error` and `console.warn`, restoring both spies in `afterEach`. Assert `[data-testid="resource-detail-backdrop"]` exists while open. Assert the opened surface is `getByRole("dialog", { name: "Resource details for Deployment/demo-deploy" })`, has `aria-modal="true"`, and initially focuses `Close resource details`. Use `userEvent.tab({ shift: true })`, `userEvent.tab()`, and an attempted `.focus()` on the opener to prove focus wraps and is recaptured. Press Escape, assert both dialog and backdrop are removed and the opener regains focus. Reopen, unmount, and again assert both portal nodes are absent; finally assert the warning spies were not called.

- [ ] **Step 2: Run the focused test and record RED**

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/resource-detail-panel.test.tsx
```

Expected: FAIL because the drawer has no labelled dialog role, the close button is unnamed, and Escape/focus restoration are absent.

- [ ] **Step 3: Implement the resource dialog with Base UI**

Use `Dialog.Root open modal onOpenChange`, `Dialog.Portal`, `Dialog.Backdrop`, `Dialog.Popup`, `Dialog.Title`, and `Dialog.Close` from the installed `@base-ui/react/dialog`. Assign `data-testid="resource-detail-backdrop"` to the backdrop. The popup must contain the complete existing header, tabs, live-log region, action bar, and optional investigation child; do not duplicate or omit panel content. Set the accessible title to `Resource details for ${kind}/${name}`, label the close control `Close resource details`, point `initialFocus` at that close control, and let Base UI restore focus to the external trigger on unmount. Keep the backdrop and popup at `z-50`; use only opaque/tinted surfaces and borders from the project tokens, with no blur, gradient, glow, or shadow.

- [ ] **Step 4: Run GREEN and a static check**

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/resource-detail-panel.test.tsx
rtk npm --prefix ui run lint -- src/components/dashboard/resource-detail-panel.tsx src/components/dashboard/resource-detail-panel.test.tsx
```

Expected: the test file passes, ESLint exits 0, and neither command prints React accessibility/portal warnings.

- [ ] **Step 5: Checkpoint the isolated resource-dialog change**

```bash
rtk git diff --check
rtk git add ui/src/components/dashboard/resource-detail-panel.tsx ui/src/components/dashboard/resource-detail-panel.test.tsx
rtk git commit -m "fix(ui): make resource details modal accessible"
```

Expected: one commit containing only the resource-dialog production and test files.

### Task 2: Convert investigation to a nested modal dialog

**Files:**
- Modify: `ui/src/components/dashboard/investigation-panel.test.tsx`
- Modify: `ui/src/components/dashboard/investigation-panel.tsx`
- Modify: `ui/src/components/dashboard/resource-detail-panel.test.tsx`

- [ ] **Step 1: Add failing standalone and nested-stack tests**

In `investigation-panel.test.tsx`, use a trigger harness and restored `console.error`/`console.warn` spies. Require `[data-testid="investigation-backdrop"]` while open; assert a dialog named `Investigation for Deployment/demo-deploy`, `aria-modal="true"`, initial focus on `Close investigation`, Tab wrapping, outside-focus recapture, Escape close, focus restoration, backdrop/portal absence after close and unmount, and zero console warnings. In `resource-detail-panel.test.tsx`, open resource details, activate `Investigate`, require both stable backdrop identifiers, then assert the first Escape removes only Investigation/backdrop and restores focus to `Investigate`; a second Escape removes Resource details/backdrop and restores the original opener.

- [ ] **Step 2: Run both tests and record RED**

```bash
rtk npm --prefix ui test -- --run \
  src/components/dashboard/resource-detail-panel.test.tsx \
  src/components/dashboard/investigation-panel.test.tsx
```

Expected: FAIL because Investigation lacks dialog semantics and the nested Escape/focus order is not managed.

- [ ] **Step 3: Implement the nested Base UI dialog**

Use the same Base UI primitives with the title `Investigation for ${kind}/${name}`, the close label `Close investigation`, and close-control initial focus. Give its backdrop `data-testid="investigation-backdrop"`. Keep `InvestigationPanel` rendered inside the outer resource `Dialog.Root` so Base UI registers the modal stack. Portal the investigation backdrop and popup at `z-60`; retain every existing investigation step, evidence panel, and action. Its `onOpenChange(false)` must call only the investigation `onClose` callback.

- [ ] **Step 4: Run GREEN, lint, and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/resource-detail-panel.test.tsx src/components/dashboard/investigation-panel.test.tsx
rtk npm --prefix ui run lint -- src/components/dashboard/investigation-panel.tsx src/components/dashboard/investigation-panel.test.tsx
rtk git diff --check
rtk git add ui/src/components/dashboard/investigation-panel.tsx ui/src/components/dashboard/investigation-panel.test.tsx ui/src/components/dashboard/resource-detail-panel.test.tsx
rtk git commit -m "fix(ui): stack investigation dialog accessibly"
```

Expected: both test files pass, lint exits 0, warning spies remain untouched, and the commit contains only the nested-dialog change.

### Task 3: Make resource graph nodes native buttons

**Files:**
- Modify: `ui/src/components/dashboard/resource-graph.test.tsx`
- Modify: `ui/src/components/dashboard/resource-graph.tsx`

- [ ] **Step 1: Write failing native-button activation tests**

Query `getByRole("button", { name: "Open Deployment demo-deploy resource details" })`. Assert it is a native `BUTTON`, receives visible keyboard focus, and Enter and Space each call `onSelectNode` exactly once without scrolling the document. Assert the surrounding React Flow node wrapper has no `tabindex` attribute, so exactly one keyboard stop exists for each resource.

- [ ] **Step 2: Run RED**

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/resource-graph.test.tsx
```

Expected: FAIL because the visual node is a custom role-button rather than a native button.

- [ ] **Step 3: Replace the custom interactive node with a native button**

Preserve the node's absolute layout, status marker, labels, selection state, pointer behavior, and graph-edge geometry, but render the interactive content as `<button type="button">`. Keep React Flow `Handle` elements as siblings outside the button so interactive/port elements are never nested in it. Give the button the tested accessible name and a token-based `focus-visible` outline. Set `nodesFocusable={false}` on `ReactFlow` (or `focusable:false` on every generated node), rely on native Enter/Space activation, and remove the manual keyboard handler and custom `role`/`tabIndex`.

- [ ] **Step 4: Run GREEN and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/resource-graph.test.tsx
rtk npm --prefix ui run lint -- src/components/dashboard/resource-graph.tsx src/components/dashboard/resource-graph.test.tsx
rtk git diff --check
rtk git add ui/src/components/dashboard/resource-graph.tsx ui/src/components/dashboard/resource-graph.test.tsx
rtk git commit -m "fix(ui): use native resource graph controls"
```

Expected: tests pass, lint exits 0, and the isolated graph change is committed.

### Task 4: Add a native resource-details action to each table row

**Files:**
- Modify: `ui/src/components/dashboard/resource-list-table.test.tsx`
- Modify: `ui/src/components/dashboard/resource-list-table.tsx`

- [ ] **Step 1: Write failing name-action tests**

Assert the table is named `Application resources`. Assert each resource row retains its table row semantics and contains `getByRole("button", { name: "Open Deployment demo-deploy resource details" })`. Enter and Space on that button each select once. Enter/Space on the separate tree expander only expands/collapses and never selects the row.

- [ ] **Step 2: Run RED**

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/resource-list-table.test.tsx
```

Expected: FAIL because the row is pointer-clickable but has no native details action.

- [ ] **Step 3: Add the semantic action without changing table roles**

Give the existing `<table>` `aria-label="Application resources"`. Keep `<tr>` non-focusable and preserve its pointer `onClick`. In the Name cell, render the existing kind/name content inside `<button type="button">` with the tested label. Stop propagation only for that button and the existing tree expander so one gesture produces one action. Add a visible token-based `focus-visible` outline to both controls.

- [ ] **Step 4: Run GREEN, lint, and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/resource-list-table.test.tsx
rtk npm --prefix ui run lint -- src/components/dashboard/resource-list-table.tsx src/components/dashboard/resource-list-table.test.tsx
rtk git diff --check
rtk git add ui/src/components/dashboard/resource-list-table.tsx ui/src/components/dashboard/resource-list-table.test.tsx
rtk git commit -m "fix(ui): add keyboard resource row actions"
```

Expected: tests pass, lint exits 0, the table remains semantic, and the isolated list change is committed.

### Task 5: Verify the complete troubleshooting interaction in a compiled browser

**Files:**
- Modify: `ui/e2e/fleet-console.spec.ts`

- [ ] **Step 1: Rebuild and run the previously red scenario GREEN**

```bash
rtk npm --prefix ui run build
rtk go build -o bin/fleet-console-fixture ./test/fleetconsole
rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- e2e/fleet-console.spec.ts --project=chromium-keyboard-only
```

Expected: Playwright owns a ready 250-app fixture, the focused keyboard-only project passes, and Playwright cleans the process up.

- [ ] **Step 2: Checkpoint the troubleshooting E2E regression**

```bash
rtk git diff --check
rtk git add ui/e2e/fleet-console.spec.ts
rtk git commit -m "test(ui): cover keyboard troubleshooting dialogs"
```

---

## Chunk 2: Complete Release Inventory

### Chunk 2 browser characterization — execute before Task 6

**Files:**
- Modify: `ui/e2e/fleet-console.spec.ts`

- [ ] Add the exact late-release and legacy-navigation regression first. Search for fixture release `application-00246-release-v1`, require a scope-preserving dedicated inventory result with no hash, and require `/dashboard/?project=team-06%2Fproject-2&cluster=platform%2Fcluster-1&stage=production&namespace=team-06#releases` to migrate once with all four scope dimensions intact.
- [ ] Run the shared compiled-fixture protocol against the unchanged UI, then run `rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- e2e/fleet-console.spec.ts --project=chromium`.

Expected RED: the release beyond the dashboard's first 100 cannot be found and/or Releases still points at the legacy hash after `/readyz`; never a startup failure.

### Task 6: Add a dedicated release query RPC without changing legacy descriptors

**Files:**
- Modify: `proto/paprika/v1/api.proto`
- Regenerate: `internal/api/paprika/v1/api.pb.go`
- Regenerate: `internal/api/paprika/v1/v1connect/api.connect.go`
- Regenerate: `ui/src/gen/paprika/v1/api_pb.js`
- Regenerate: `ui/src/gen/paprika/v1/api_pb.d.ts`
- Regenerate: `ui/src/gen/paprika/v1/api_connect.js`
- Regenerate: `ui/src/gen/paprika/v1/api_connect.d.ts`
- Modify: `internal/api/fleet_contract_test.go`

- [ ] **Step 1: Add failing new-query descriptor assertions**

Extend the fleet-query contract list to require a fourth appended method, `QueryReleases(QueryReleasesRequest) returns (QueryReleasesResponse)`. Require the new request fields `filter=1`, `search=2`, `page_size=3`, and `page_offset=4`, and response fields `releases=1`, `total_count=2`. Keep the legacy `ListReleasesRequest` descriptor hash and RPC entry byte-for-byte unchanged; also retain an explicit assertion that its fields 1–5 keep their numbers, kinds, and cardinalities.

- [ ] **Step 2: Run the contract test and record RED**

```bash
rtk go test ./internal/api -run 'Test.*Fleet.*Descriptor' -count=1
```

Expected: FAIL because the new messages and RPC do not exist while all legacy descriptor hashes remain green.

- [ ] **Step 3: Add the new messages/RPC and regenerate all clients**

```proto
message QueryReleasesRequest {
  FleetFilter filter = 1;
  string search = 2;
  uint32 page_size = 3;
  uint32 page_offset = 4;
}

message QueryReleasesResponse {
  repeated Release releases = 1;
  uint64 total_count = 2;
}
```

Append `rpc QueryReleases(QueryReleasesRequest) returns (QueryReleasesResponse);` after the existing fleet-query methods; do not edit `ListReleasesRequest`, `ListReleasesResponse`, or the legacy `ListReleases` method.

Run:

```bash
rtk go tool buf lint
rtk go tool buf generate
rtk go test ./internal/api -run 'Test.*Fleet.*Descriptor' -count=1
rtk git diff --check
```

Expected: Buf lint exits 0, generation changes only the declared Go/Connect/JS/d.ts artifacts plus the new descriptor assertions, every legacy descriptor hash remains unchanged, and the focused contract test passes.

- [ ] **Step 4: Checkpoint the additive contract**

```bash
rtk git add proto/paprika/v1/api.proto internal/api/paprika/v1/api.pb.go internal/api/paprika/v1/v1connect/api.connect.go internal/api/fleet_contract_test.go ui/src/gen/paprika/v1/api_pb.js ui/src/gen/paprika/v1/api_pb.d.ts ui/src/gen/paprika/v1/api_connect.js ui/src/gen/paprika/v1/api_connect.d.ts
rtk git commit -m "feat(api): extend release query contract"
```

Expected: one additive protobuf/generated-code commit with every legacy message/RPC descriptor unchanged.

### Task 7: Extract and implement authorized, bounded release search

**Files:**
- Create: `internal/api/release_handler.go`
- Modify: `internal/api/release_handler_test.go`
- Modify: `internal/api/server.go`
- Modify: `internal/fleet/search.go`
- Modify: `internal/fleet/search_test.go`

- [ ] **Step 1: Move existing release-list code without changing behavior**

Move `ListReleases`, `releaseMatchesListRequest`, `sortReleasesByNewest`, and `paginateReleases` from `server.go` into `release_handler.go`. Keep signatures and logic byte-for-byte equivalent except imports. Run:

```bash
rtk gofmt -w internal/api/release_handler.go internal/api/server.go
rtk go test ./internal/api -run 'TestListReleases' -count=1
```

Expected: existing release tests pass before any search behavior is added.

- [ ] **Step 2: Add table-driven RED tests for validation, ranking, scope, and pagination**

First add a fleet test proving `NormalizeSearchDocument` NFKC/separator-normalizes a stored metadata string longer than 128 runes without rejecting it, while existing `NormalizeSearch` still rejects a query over `MaxSearchRunes`. Then cover all of the following `QueryReleases` cases in `release_handler_test.go`:

- nil request returns `InvalidArgument`, and `page_offset` above the named maximum returns `InvalidArgument`;
- search over 128 Unicode runes returns `InvalidArgument`;
- `page_size=0` defaults to 24 for both empty and nonempty search, and `page_size>100` is rejected;
- the legacy `ListReleases` zero-size unbounded behavior remains unchanged in its existing tests;
- NFKC/separator-normalized exact name ranks before prefix, then substring, then newer metadata-only matches;
- multiple query terms are ANDed across release name, namespace, application, pipeline, target, phase, and current stage;
- unauthorized releases and releases outside the shared `FleetFilter` application candidate set never affect rank, `total_count`, or page boundaries;
- identical rank/timestamps order by namespace then name;
- page offset is applied only after authorization, scope, search, and deterministic sort;
- a canceled context maps to Connect `Canceled` rather than returning partial results.

Build the scope case with a real `fleet.Index` snapshot containing applications in different projects/clusters/stages and releases carrying the corresponding application label.

- [ ] **Step 3: Run RED**

```bash
rtk go test ./internal/fleet -run 'TestNormalizeSearch(Document|Unicode)' -count=1
rtk go test ./internal/api -run 'Test(QueryReleases|ListReleases)' -count=1
```

Expected: the new document-normalizer and QueryReleases cases fail while the legacy ListReleases tests remain green.

- [ ] **Step 4: Implement the minimal query pipeline**

Expose `fleet.NormalizeSearchDocument(raw string) string` as the non-validating form used when indexing trusted stored documents; keep `fleet.NormalizeSearch` as the only caller-query validator. In `release_handler.go`, define named constants `defaultReleaseQueryPageSize=24`, `maxReleaseQueryPageSize=100`, and `maxReleaseQueryOffset=1_000_000`, and reuse `fleet.MaxSearchRunes`. Validate before the Kubernetes list. If `filter` has active dimensions, convert it with `fleetFilterFromProto`, build the caller's authorized fleet scope, load the immutable snapshot, and call `FilterApplications` with an empty application-name search to obtain the exact allowed `(namespace, application)` identities. Then process cached Release objects in this order: cancellation check, per-release authorization, optional application-scope membership, normalized AND-term metadata match, ranking, deterministic sort, total, pagination. Use `fleet.NormalizeSearch` only for the request query and `fleet.NormalizeSearchDocument` for release name/namespace/application/pipeline/target/phase/current-stage documents. `QueryReleases` always defaults/caps its response; `ListReleases` stays byte-for-byte behavior-compatible.

This remains an O(N) scan of controller-runtime's in-memory Release cache. Do not describe it as indexed release search; the bounded response and the benchmark in the next step are the guardrails for this iteration.

- [ ] **Step 5: Run GREEN and the neighboring fleet suites**

```bash
rtk gofmt -w internal/api/release_handler.go internal/api/release_handler_test.go internal/api/server.go internal/fleet/search.go internal/fleet/search_test.go
rtk go test ./internal/api ./internal/fleet -run 'Test(QueryReleases|ListReleases|NormalizeSearch.*|.*Fleet.*)' -count=1
rtk go vet ./internal/api ./internal/fleet
```

Expected: focused API/fleet tests pass and `go vet` exits 0.

- [ ] **Step 6: Add and run a representative 10,000-release cache-scan benchmark**

Add `BenchmarkQueryReleasesSearch10k` using the fake cache-backed client, a fixed exact query, authorized scope, and `page_size=8`. Verify the response is always at most eight and run:

```bash
rtk go test ./internal/api -run '^$' -bench '^BenchmarkQueryReleasesSearch10k$' -benchtime=5x -benchmem
```

Expected: five iterations complete without error or unbounded response allocation. Record the reported ns/op, B/op, and allocs/op in the implementation notes; treat it as evidence for this local cache-scan design, not a hard SLA or an indexed-search claim.

- [ ] **Step 7: Checkpoint the extracted handler**

```bash
rtk git diff --check
rtk git add internal/api/release_handler.go internal/api/release_handler_test.go internal/api/server.go internal/fleet/search.go internal/fleet/search_test.go
rtk git commit -m "feat(api): add scoped release search"
```

Expected: the large server file shrinks and the isolated release handler/tests are committed.

### Task 8: Add one canonical release-query URL codec

**Files:**
- Create: `ui/src/lib/release-query.ts`
- Create: `ui/src/lib/release-query.test.ts`

- [ ] **Step 1: Write failing codec tests**

Define the expected `ReleaseQueryState` as `q`, `page`, and the shared fleet scope dimensions `projects`, `clusters`, `stages`, and `namespaces`. Tests must prove repeated scope parameters are canonicalized with the existing fleet-query helpers; changing `q` resets `page` to 1; unrelated presentation parameters are dropped; valid one-based pages round-trip; and empty, zero, negative, fractional, nonnumeric, or values whose `(page-1)*24` exceed the API's 1,000,000 offset maximum canonicalize to page 1 with a replacement URL. `releaseURL(current, patch)` must preserve all four scope dimensions for sidebar, legacy-hash, command-result, and pagination links. Dedicated `applicationURL(current, identity)` and `rolloutURL(current, identity)` tests must prove those helpers target their correct detail routes, preserve every repeated `namespace` scope value unchanged, and encode destination identity separately as `application_namespace`/`application_name` or `rollout_namespace`/`rollout_name`; identity must never collide with the shared `namespace` filter.

- [ ] **Step 2: Run RED**

```bash
rtk npm --prefix ui test -- --run src/lib/release-query.test.ts
```

Expected: FAIL because the release query module does not exist.

- [ ] **Step 3: Implement the pure codec**

Reuse `parseFleetQuery`/canonical fleet key helpers rather than creating a second identity grammar. Export `parseReleaseQuery`, `serializeReleaseQuery`, `mergeReleaseQuery`, `releaseURL`, `applicationURL`, and `rolloutURL`, backed by one internal scope-parameter copier. Keep parsing and serialization pure; expose `needsCanonicalReplace` so the page can call `router.replace` once without a render loop.

- [ ] **Step 4: Run GREEN and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/lib/release-query.test.ts src/lib/fleet-query.test.ts
rtk npm --prefix ui run lint -- src/lib/release-query.ts src/lib/release-query.test.ts
rtk git diff --check
rtk git add ui/src/lib/release-query.ts ui/src/lib/release-query.test.ts
rtk git commit -m "feat(ui): add canonical release query state"
```

Expected: both codec suites pass, lint exits 0, and the pure URL-state change is committed.

### Task 9: Build `/dashboard/releases` with race-safe server pagination

**Files:**
- Create: `ui/src/app/dashboard/releases/page.tsx`
- Create: `ui/src/app/dashboard/releases/page.test.tsx`
- Modify: `ui/src/components/dashboard/release-table.tsx`
- Modify: `ui/src/components/dashboard/release-table.test.tsx`
- Modify: `ui/src/app/dashboard/application/page.tsx`
- Modify: `ui/src/app/dashboard/application/page.test.tsx`
- Modify: `ui/src/app/dashboard/rollouts/detail/page.tsx`
- Create: `ui/src/app/dashboard/rollouts/detail/page.test.tsx`

- [ ] **Step 1: Write failing flat inventory-component tests**

Refine `ReleaseGrid` expectations first: semantic heading/list structure, namespace-qualified React keys, keyboard-accessible application/rollout links only when those references exist, no unconditional rollback action, text-plus-color status, and no fixed minimum width below `xl`. Assert loading skeleton, no-releases, no-search-matches, and error/retry states are distinct and announced through one polite live region. Add detail-page tests proving the new explicit identity keys win while all shared `namespace` values remain available, and that legacy `?namespace=...&name=...` links still work as a fallback.

- [ ] **Step 2: Run component RED**

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/release-table.test.tsx src/app/dashboard/application/page.test.tsx src/app/dashboard/rollouts/detail/page.test.tsx
```

Expected: FAIL on the flat visual/semantic inventory contract.

- [ ] **Step 3: Refactor `ReleaseGrid` and run component GREEN**

Use the project's flat border/surface hierarchy, monospaced operational metadata, restrained paprika accents, and responsive definition rows. Keep all existing release facts. Key releases by `${namespace}/${name}`; use `applicationURL` for application drill-down and `rolloutURL` for rollout drill-down so destination identity and shared scope both survive. Update Application detail to resolve `application_namespace`/`application_name` first and Rollout detail to resolve `rollout_namespace`/`rollout_name` first, each falling back to legacy `namespace`/`name` only when the explicit pair is absent.

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/release-table.test.tsx src/app/dashboard/application/page.test.tsx src/app/dashboard/rollouts/detail/page.test.tsx
rtk npm --prefix ui run lint -- src/components/dashboard/release-table.tsx src/components/dashboard/release-table.test.tsx src/app/dashboard/application/page.tsx src/app/dashboard/application/page.test.tsx src/app/dashboard/rollouts/detail/page.tsx src/app/dashboard/rollouts/detail/page.test.tsx
```

Expected: ReleaseGrid tests pass and lint exits 0.

- [ ] **Step 4: Write failing page-state tests**

Mock the generated Connect client and Next router. Assert `queryReleases` receives initial `q`/scope/page parsing, `pageSize:24`, page 2 `pageOffset:24`, and the full `FleetFilter` generated from project/cluster/stage/namespace scope. Assert Previous/Next links preserve scope and search, invalid-page replacement, page reset after a debounced query change, and exact-result rendering. Use deferred promises to prove an older request resolving last cannot overwrite the newest query. Abort on unmount/query replacement. When total shrinks below the requested offset, replace with the new last page and refetch once; when total is zero, canonicalize to page 1 without looping.

- [ ] **Step 5: Run page RED**

```bash
rtk npm --prefix ui test -- --run src/app/dashboard/releases/page.test.tsx
```

Expected: FAIL because `/dashboard/releases` does not exist.

- [ ] **Step 6: Implement the page with latest-request-wins semantics**

Use a controlled search input with a 250 ms debounce, an effect-owned `AbortController`, and a monotonically increasing request generation. Call `queryReleases` with `search`, `filter`, `pageSize:24`, and `(page-1)*24`. Commit URL changes through `router.replace` for query/canonicalization and render Previous/Next as real links. Disable pagination while loading but keep the prior page visible with an `Updating releases…` live status. On error retain the prior page and offer a retry button. Render results through `ReleaseGrid`.

- [ ] **Step 7: Run GREEN, build, and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/app/dashboard/releases/page.test.tsx src/components/dashboard/release-table.test.tsx src/lib/release-query.test.ts src/app/dashboard/application/page.test.tsx src/app/dashboard/rollouts/detail/page.test.tsx
rtk npm --prefix ui run lint -- src/app/dashboard/releases/page.tsx src/app/dashboard/releases/page.test.tsx src/components/dashboard/release-table.tsx src/components/dashboard/release-table.test.tsx src/app/dashboard/application/page.tsx src/app/dashboard/application/page.test.tsx src/app/dashboard/rollouts/detail/page.tsx src/app/dashboard/rollouts/detail/page.test.tsx
rtk npm --prefix ui run build
rtk git diff --check
rtk git add ui/src/app/dashboard/releases/page.tsx ui/src/app/dashboard/releases/page.test.tsx ui/src/components/dashboard/release-table.tsx ui/src/components/dashboard/release-table.test.tsx ui/src/app/dashboard/application/page.tsx ui/src/app/dashboard/application/page.test.tsx ui/src/app/dashboard/rollouts/detail/page.tsx ui/src/app/dashboard/rollouts/detail/page.test.tsx
rtk git commit -m "feat(ui): add complete release inventory"
```

Expected: focused tests pass, static export contains `/dashboard/releases/index.html`, lint/build exit 0, and the inventory change is committed.

### Task 10: Move navigation and make dashboard release search complete on demand

**Files:**
- Modify: `ui/src/components/layout/sidebar.tsx`
- Modify: `ui/src/components/layout/app-shell.test.tsx`
- Modify: `ui/src/components/dashboard/dashboard-command-center.tsx`
- Modify: `ui/src/components/dashboard/dashboard-command-center.test.tsx`
- Modify: `ui/src/app/dashboard/page.tsx`
- Modify: `ui/src/app/dashboard/__tests__/dashboard-refresh.test.tsx`

- [ ] **Step 1: Write failing scope-preserving navigation tests**

Assert Releases points to `/dashboard/releases`, is active on that route, and retains repeated project/cluster/stage/namespace query parameters from the current URL. Assert legacy `/dashboard#releases` and `/dashboard/#releases` replace once to the dedicated route, preserve the same scope, and remove the hash. Unrelated view/group/selected parameters must not leak into release URLs.

- [ ] **Step 2: Run navigation RED**

```bash
rtk npm --prefix ui test -- --run src/components/layout/app-shell.test.tsx
```

Expected: FAIL because Releases still targets the dashboard hash and no migration exists.

- [ ] **Step 3: Implement navigation/migration and run GREEN**

Use `releaseURL` from both Sidebar and the dashboard legacy-hash effect. Guard the effect so one hash produces one `router.replace`, even under Strict Mode.

```bash
rtk npm --prefix ui test -- --run src/components/layout/app-shell.test.tsx
```

Expected: the scoped navigation and one-shot migration cases pass.

- [ ] **Step 4: Write failing async command-search tests**

Add an injected contract:

```ts
searchReleases?: (query: string, signal: AbortSignal) => Promise<Release[]>
```

Assert a release absent from initial dashboard data appears after 250 ms; the result links to `/dashboard/releases?namespace=team-06&q=application-00246-release-v1`; rapid query replacement aborts/ignores the stale result; failure is visible without removing working non-release results; periodic dashboard refresh no longer calls legacy `listReleases` or the new `queryReleases`.

Also assert the injected dashboard callback sends at most eight results and carries the current shared FleetFilter, result deduplication uses namespace/name, and the link preserves project/cluster/stage/namespace scope through `releaseURL`.

- [ ] **Step 5: Run command-search RED**

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/dashboard-command-center.test.tsx src/app/dashboard/__tests__/dashboard-refresh.test.tsx
```

Expected: FAIL because the command center only sees the dashboard's first 100 periodically fetched releases.

- [ ] **Step 6: Implement abortable on-demand release search**

The dashboard injection calls `queryReleases` with the current FleetFilter, `pageSize:8`, and the AbortSignal. Remove the old periodic 100-release bundle; the new RPC runs only after a nonempty debounced command query. While searching, announce `Searching releases…`; on failure show `Release search unavailable`; merge/dedupe results by namespace/name before ranking all command items.

- [ ] **Step 7: Run GREEN, lint, and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/components/layout/app-shell.test.tsx src/components/dashboard/dashboard-command-center.test.tsx src/app/dashboard/__tests__/dashboard-refresh.test.tsx
rtk npm --prefix ui run lint -- src/components/layout/sidebar.tsx src/components/dashboard/dashboard-command-center.tsx src/app/dashboard/page.tsx
rtk git diff --check
rtk git add ui/src/components/layout/sidebar.tsx ui/src/components/layout/app-shell.test.tsx ui/src/components/dashboard/dashboard-command-center.tsx ui/src/components/dashboard/dashboard-command-center.test.tsx ui/src/app/dashboard/page.tsx ui/src/app/dashboard/__tests__/dashboard-refresh.test.tsx
rtk git commit -m "feat(ui): complete release navigation and search"
```

Expected: all focused suites pass, lint exits 0, and the navigation/search integration is committed.

### Task 11: Prove complete release discovery in the compiled 250-app fixture

**Files:**
- Modify: `ui/e2e/fleet-console.spec.ts`

- [ ] **Step 1: Rebuild and run the previously red release story GREEN**

```bash
rtk npm --prefix ui run build
rtk go build -o bin/fleet-console-fixture ./test/fleetconsole
rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- e2e/fleet-console.spec.ts --project=chromium
```

Expected: the exact release and legacy migration scenarios pass against the freshly rebuilt 250-app fixture.

- [ ] **Step 2: Checkpoint the release E2E regression**

```bash
rtk git diff --check
rtk git add ui/e2e/fleet-console.spec.ts
rtk git commit -m "test(ui): cover complete release discovery"
```

---

## Chunk 3: Responsive Density and Treemap Legibility

Below `xl`, the operational views deliberately reflow the same semantic rows so every fact remains available without mandatory horizontal panning. At `xl` and above, the existing wide table/matrix presentation and column relationships remain intact. This is a responsive presentation change, not a data reduction or a duplicate mobile DOM.

### Chunk 3 browser characterization — execute before Task 12

**Files:**
- Modify: `ui/e2e/fleet-responsive.spec.ts`

- [ ] Add the complete viewport/virtualization test first: 390×844 and 768×1024 require exactly eight ranked dashboard tiles, no page/surface horizontal overflow, complete facts/actions, text-plus-glyph treemap legend, and nonoverlapping Table/Queue virtual rows after index 75 with keyboard activation; 1440×900 retains wide table/matrix columns.
- [ ] Run the shared compiled-fixture protocol against the unchanged UI, then run `rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- e2e/fleet-responsive.spec.ts --project=chromium`.

Expected RED: old all-tile density, narrow overflow, missing legend, or late-row layout fails after `/readyz`; never fixture startup.

### Task 12: Bound the dashboard health map with server-order progressive disclosure

**Files:**
- Create: `ui/src/components/dashboard/dashboard-health-map.tsx`
- Create: `ui/src/components/dashboard/dashboard-health-map.test.tsx`
- Modify: `ui/src/components/dashboard/dashboard-command-center.test.tsx`
- Modify: `ui/src/components/dashboard/dashboard-command-center.tsx`

- [ ] **Step 1: Write failing extracted health-map tests**

Pass 20 deliberately nonalphabetical applications in known server-rank order. Assert only the first eight identities render initially in exactly that order while all 20 contribute to status counts. Assert `Show all 20 loaded applications` carries `aria-expanded=false`, expands to all 20 without re-sorting, changes to `Show compact preview`, and changing health filter resets the compact preview to the first eight matching items in original server order. Assert the footer says `8 of 20 loaded · 250 indexed` and links to `/dashboard/applications?view=treemap`.

- [ ] **Step 2: Run RED**

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/dashboard-health-map.test.tsx src/components/dashboard/dashboard-command-center.test.tsx
```

Expected: FAIL because the extracted component does not exist and the current map re-sorts/groups all loaded applications.

- [ ] **Step 3: Extract and implement the bounded map**

Move only health-map presentation/filter logic out of the command center. Preserve the input sequence; do not sort by namespace or health. Flatten namespace groups because every tile already prints namespace. Derive status counts from the complete filtered input before slicing, use a constant preview limit of eight, and reset `expanded=false` when the active health filter changes. Keep the expansion control a native button with `aria-expanded` and `aria-controls`.

- [ ] **Step 4: Run GREEN, lint, and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/components/dashboard/dashboard-health-map.test.tsx src/components/dashboard/dashboard-command-center.test.tsx
rtk npm --prefix ui run lint -- src/components/dashboard/dashboard-health-map.tsx src/components/dashboard/dashboard-health-map.test.tsx src/components/dashboard/dashboard-command-center.tsx
rtk git diff --check
rtk git add ui/src/components/dashboard/dashboard-health-map.tsx ui/src/components/dashboard/dashboard-health-map.test.tsx ui/src/components/dashboard/dashboard-command-center.tsx ui/src/components/dashboard/dashboard-command-center.test.tsx
rtk git commit -m "fix(ui): bound dashboard health map density"
```

Expected: focused tests pass, the first-eight ranking assertion passes, lint exits 0, and the extraction is committed.

### Task 13: Reflow the virtualized application table below `xl`

**Files:**
- Modify: `ui/src/components/fleet/fleet-view.test.tsx`
- Modify: `ui/src/components/fleet/application-table.tsx`

- [ ] **Step 1: Add failing single-DOM compact-row tests**

Add stable `data-testid="application-table-scroll"` and `data-testid="application-row-${namespace}-${name}"` contracts. Assert one and only one row exists per application, with identity, target/stage, named health/sync/resource facts, and authorized actions all inside that row. Assert the same row exposes a native keyboard drill-down control; no separate `mobile`/`desktop` subtree is allowed.

- [ ] **Step 2: Run RED**

```bash
rtk npm --prefix ui test -- --run src/components/fleet/fleet-view.test.tsx
```

Expected: FAIL on the new scroll/row contract and compact grouping.

- [ ] **Step 3: Implement the table reflow**

Remove the unconditional `min-w-[58rem]`; below `xl`, visually hide the repeated column header and lay each existing row out as identity, target/stage, fact strip, and action strip. At `xl`, restore the existing six-column grid. Keep one virtualizer, its measurement ref, semantic labels, row identity, focus behavior, and all authorized actions.

- [ ] **Step 4: Run GREEN and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/components/fleet/fleet-view.test.tsx
rtk npm --prefix ui run lint -- src/components/fleet/application-table.tsx src/components/fleet/fleet-view.test.tsx
rtk git diff --check
rtk git add ui/src/components/fleet/application-table.tsx ui/src/components/fleet/fleet-view.test.tsx
rtk git commit -m "fix(ui): reflow fleet table on narrow screens"
```

Expected: the table tests pass, lint exits 0, and the table-only change is committed.

### Task 14: Reflow the virtualized attention queue below `xl`

**Files:**
- Modify: `ui/src/components/fleet/fleet-view.test.tsx`
- Modify: `ui/src/components/fleet/attention-queue.tsx`

- [ ] **Step 1: Add a failing single-DOM queue contract**

Require `data-testid="attention-queue-scroll"` and one `attention-row-${namespace}-${name}` per record. Assert rank/identity, severity reason, target/stage, health/sync/resource facts, and actions are all in the same row, with one keyboard selection target.

- [ ] **Step 2: Run RED**

```bash
rtk npm --prefix ui test -- --run src/components/fleet/fleet-view.test.tsx
```

Expected: FAIL on the queue scroll/row contract.

- [ ] **Step 3: Implement the queue reflow**

Remove the unconditional `min-w-[42rem]`; below `xl`, arrange rank/identity, fact strip, and actions on separate lines. Restore the existing wide layout at `xl`. Preserve the current virtual row measurement callback, roving/keyboard selection behavior, and complete data/action set.

- [ ] **Step 4: Run GREEN and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/components/fleet/fleet-view.test.tsx
rtk npm --prefix ui run lint -- src/components/fleet/attention-queue.tsx src/components/fleet/fleet-view.test.tsx
rtk git diff --check
rtk git add ui/src/components/fleet/attention-queue.tsx ui/src/components/fleet/fleet-view.test.tsx
rtk git commit -m "fix(ui): reflow attention queue on narrow screens"
```

Expected: the queue tests pass, lint exits 0, and the queue-only change is committed.

### Task 15: Reflow the fleet matrix below `xl`

**Files:**
- Modify: `ui/src/components/fleet/fleet-matrix.test.tsx`
- Modify: `ui/src/components/fleet/fleet-matrix.tsx`

- [ ] **Step 1: Add a failing single-table matrix contract**

Require `data-testid="fleet-matrix-scroll"`, one populated semantic table row per matrix cell, textual health in addition to the marker, and all identity/count/health facts in that row. Assert no second mobile table/list exists.

- [ ] **Step 2: Run RED**

```bash
rtk npm --prefix ui test -- --run src/components/fleet/fleet-matrix.test.tsx
```

Expected: FAIL on the matrix scroll/compact semantics.

- [ ] **Step 3: Implement the matrix reflow**

Remove the unconditional `min-w-[48rem]`; below `xl`, visually reflow each existing table row into identity, count facts, and text-plus-color health while retaining the table DOM. Restore the native matrix column layout at `xl`. Preserve drill-down and keyboard semantics.

- [ ] **Step 4: Run GREEN and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/components/fleet/fleet-matrix.test.tsx
rtk npm --prefix ui run lint -- src/components/fleet/fleet-matrix.tsx src/components/fleet/fleet-matrix.test.tsx
rtk git diff --check
rtk git add ui/src/components/fleet/fleet-matrix.tsx ui/src/components/fleet/fleet-matrix.test.tsx
rtk git commit -m "fix(ui): reflow fleet matrix on narrow screens"
```

Expected: matrix tests pass, lint exits 0, and the matrix-only change is committed.

### Task 16: Add a semantic treemap legend and measured label fitting

**Files:**
- Create: `ui/src/components/fleet/treemap-presentation.ts`
- Create: `ui/src/components/fleet/treemap-presentation.test.ts`
- Modify: `ui/src/components/fleet/fleet-treemap.test.tsx`
- Modify: `ui/src/components/fleet/fleet-treemap.tsx`

- [ ] **Step 1: Write failing pure presentation-helper tests**

Assert recursive health collection in stable severity order `failed, degraded, progressing, missing, unknown, healthy`; legend entries expose both a text label and non-color glyph; binary-search label fitting returns the full label when it fits, the longest prefix plus exactly one ellipsis when constrained, and an empty string when even the measured ellipsis plus padding cannot fit.

- [ ] **Step 2: Run helper RED**

```bash
rtk npm --prefix ui test -- --run src/components/fleet/treemap-presentation.test.ts
```

Expected: FAIL because the pure helper does not exist.

- [ ] **Step 3: Implement the pure helper and run GREEN**

Accept a `measureText(label): number` callback and available pixel width so the helper remains deterministic under Vitest. Keep collection iterative/recursive over every visible node and dedupe health values before severity sorting.

```bash
rtk npm --prefix ui test -- --run src/components/fleet/treemap-presentation.test.ts
```

Expected: all stable-order and measured-fitting cases pass.

- [ ] **Step 4: Write failing Canvas/legend integration tests**

Mock canvas measurement and assert `Treemap health legend` renders text plus glyph for every health present, tiny cells receive no canvas label, constrained cells receive one ellipsis, and full names remain available through tooltip, selected detail, and the semantic table alternative. Assert the instruction text names tap/click and keyboard navigation.

- [ ] **Step 5: Run integration RED**

```bash
rtk npm --prefix ui test -- --run src/components/fleet/fleet-treemap.test.tsx
```

Expected: FAIL because the legend and measured fitting are not wired.

- [ ] **Step 6: Wire the helper into the Canvas**

Render a compact `Treemap health legend`; use `measureText` for group/application labels; preserve full names in tooltip, selected detail, and the semantic table alternative. Update instructions to mention tap/click plus keyboard navigation.

- [ ] **Step 7: Run GREEN, lint, and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/components/fleet/treemap-presentation.test.ts src/components/fleet/fleet-treemap.test.tsx
rtk npm --prefix ui run lint -- src/components/fleet/treemap-presentation.ts src/components/fleet/treemap-presentation.test.ts src/components/fleet/fleet-treemap.tsx src/components/fleet/fleet-treemap.test.tsx
rtk git diff --check
rtk git add ui/src/components/fleet/treemap-presentation.ts ui/src/components/fleet/treemap-presentation.test.ts ui/src/components/fleet/fleet-treemap.tsx ui/src/components/fleet/fleet-treemap.test.tsx
rtk git commit -m "fix(ui): make treemap status and labels legible"
```

Expected: both suites pass, the semantic alternative remains bounded to the existing visible/selected contract, lint exits 0, and the treemap change is committed.

### Task 17: Add real responsive/virtualization browser coverage

**Files:**
- Create: `ui/e2e/fleet-responsive.spec.ts`

- [ ] **Step 1: Rebuild the native fixture/UI and run the previously red test GREEN**

```bash
rtk npm --prefix ui run build
rtk go build -o bin/fleet-console-fixture ./test/fleetconsole
rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- \
  e2e/fleet-responsive.spec.ts --project=chromium
```

Expected: both narrow viewports and the wide control pass, including the late virtualized rows and keyboard navigation.

- [ ] **Step 2: Checkpoint responsive browser coverage**

```bash
rtk git diff --check
rtk git add ui/e2e/fleet-responsive.spec.ts
rtk git commit -m "test(ui): cover responsive fleet presentations"
```

---

## Chunk 4: Visual and Fixture Resilience

### Task 18: Raise semantic text and effective focus-ring contrast

**Files:**
- Create: `ui/src/app/color-tokens.test.ts`
- Modify: `ui/src/app/globals.css`
- Modify: `ui/src/components/ui/button.tsx`
- Modify: `ui/src/components/ui/badge.tsx`
- Modify: `ui/src/components/dashboard/dashboard-command-center.tsx`
- Modify: `ui/src/app/login/page.tsx`

- [ ] **Step 1: Write a failing mathematical contrast test**

Read only the `:root.dark` declaration block from `globals.css`; parse `oklch(L C H / alpha)` tokens. For rendered CSS accuracy, convert OKLCH → OKLab → linear sRGB, gamut-map/clip channels, gamma-encode to sRGB, source-over composite translucent foreground/surface colors in encoded sRGB, then decode the composite back to linear sRGB for WCAG 2 relative luminance and contrast. Include a black/white sanity assertion of 21:1 plus a known translucent sRGB fixture so a bad converter or wrong compositing order cannot make the suite pass.

The table-driven assertions must cover:

- every destructive/success tint percentage discovered by recursively scanning production `ui/src` classes for `bg-destructive/<n>` and `bg-success/<n>`, composited over background/card with the matching semantic text token;
- the *effective winning* Button and Badge focus indicators for every variant plus `aria-invalid` and dark-state overrides, derived from `buttonVariants()`/`badgeVariants()` class output rather than assuming the base `ring-ring/50` wins;
- the command-center search input (`ring-primary/10` plus `border-primary/60`), every command-center `focus-visible:ring-primary/50` control, and both login inputs' `focus:ring-primary/15`, derived from their production classes;
- every effective ring/border indicator over background, card, and sidebar-accent;
- every text pair at least 4.5:1 and every effective focus indicator at least 3:1.

- [ ] **Step 2: Run RED**

```bash
rtk npm --prefix ui test -- --run src/app/color-tokens.test.ts
```

Expected: FAIL because current semantic text is around the low-3:1 range on stronger tints; base `/50`, destructive `/20`/dark `/40`, command `/10`/`/50`, invalid-state, and login `/15` indicators include combinations below 3:1.

- [ ] **Step 3: Implement accessible semantic/focus tokens**

Raise dark `--destructive` and `--success` lightness while preserving their hue/chroma family. Make `--ring` and `--sidebar-ring` opaque high-contrast warm-orange tokens. In Button and Badge, replace base, destructive-variant, dark, and `aria-invalid` translucent focus rings with an opaque tested ring token (or opaque tested destructive ring where state meaning is needed). Replace command-center `/10`/`/50` focus rings and both login `/15` focus rings with the same tested opaque indicator and a compatible border. The test must rediscover tint percentages after implementation; keep or reduce production destructive/success tints only when every discovered state passes.

- [ ] **Step 4: Run GREEN, lint, and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/app/color-tokens.test.ts
rtk npm --prefix ui run lint -- src/app/color-tokens.test.ts src/app/login/page.tsx src/components/ui/button.tsx src/components/ui/badge.tsx src/components/dashboard/dashboard-command-center.tsx
rtk git diff --check
rtk git add ui/src/app/color-tokens.test.ts ui/src/app/globals.css ui/src/app/login/page.tsx ui/src/components/ui/button.tsx ui/src/components/ui/badge.tsx ui/src/components/dashboard/dashboard-command-center.tsx
rtk git commit -m "fix(ui): meet semantic and focus contrast"
```

Expected: all mathematical ratios pass with the sanity check, lint exits 0, and the contrast change is committed.

### Task 19: Make the skip link visibly operable in compiled CSS

**Files:**
- Modify: `ui/src/app/globals.css`
- Modify: `ui/src/components/layout/app-shell.tsx`
- Modify: `ui/src/components/layout/app-shell.test.tsx`
- Modify: `ui/e2e/fleet-console.spec.ts`

- [ ] **Step 1: Write the failing unit class contract**

Assert the link retains `href="#dashboard-main"`, uses exactly one `dashboard-skip-link` class hook plus its color/type utilities, and no longer uses `sr-only` or `focus:not-sr-only`. Read `globals.css` and require `.dashboard-skip-link` plus `.dashboard-skip-link:focus-visible` rules containing fixed positioning, clipping while hidden, restored width/height/overflow/clip on focus, and `min-height:44px`.

- [ ] **Step 2: Run unit RED**

```bash
rtk npm --prefix ui test -- --run src/components/layout/app-shell.test.tsx
```

Expected: FAIL because the link relies on conflicting `sr-only`/`focus:not-sr-only` utilities.

- [ ] **Step 3: Add a compiled-browser RED test**

In a test titled `keeps the focused skip link fixed and operable`, press Tab from a fresh dashboard load, require the skip link to be focused and visible, then inspect computed style and bounding box: `position === "fixed"`, height at least 44 px, and every edge within the viewport. Activate it and assert `#dashboard-main` receives focus.

Run the shared compiled-fixture protocol against the unchanged compiled UI, then execute:

```bash
rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- e2e/fleet-console.spec.ts --project=chromium-keyboard-only --grep 'keeps the focused skip link fixed and operable'
```

Expected: FAIL because the compiled focused link collapses to roughly text height and/or loses fixed placement; a connection failure is not acceptable RED evidence.

- [ ] **Step 4: Implement the explicit skip-link rules**

Replace the utility conflict with the class hook. The hidden rule must keep `position:fixed; left:1rem; top:1rem; z-index:100; width:1px; height:1px; overflow:hidden; white-space:nowrap; clip-path:inset(50%)`. The focus-visible rule must set `display:flex; align-items:center; width:auto; height:auto; min-height:44px; overflow:visible; white-space:normal; clip-path:inset(0)` and preserve the existing accessible color/type/padding styling.

- [ ] **Step 5: Rebuild, run GREEN, and checkpoint**

```bash
rtk npm --prefix ui test -- --run src/components/layout/app-shell.test.tsx
rtk npm --prefix ui run build
rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- e2e/fleet-console.spec.ts --project=chromium-keyboard-only
rtk git diff --check
rtk git add ui/src/app/globals.css ui/src/components/layout/app-shell.tsx ui/src/components/layout/app-shell.test.tsx ui/e2e/fleet-console.spec.ts
rtk git commit -m "fix(ui): keep skip navigation visible and fixed"
```

Expected: unit and compiled keyboard tests pass; the computed skip-link box is at least 44 px tall and activation focuses main content.

### Task 20: Register Policy types through the complete local fixture path

**Files:**
- Modify: `test/fleetconsole/seed_test.go`
- Modify: `test/fleetconsole/seed.go`
- Modify: `test/fleetconsole/server_test.go`
- Modify: `ui/e2e/fleet-console.spec.ts`

- [ ] **Step 1: Write failing scheme and real-Connect tests**

In `seed_test.go`, call `newFixtureScheme()`, then:

```go
object, err := scheme.New(policyv1alpha1.SchemeGroupVersion.WithKind("PolicyList"))
require.NoError(t, err)
require.IsType(t, &policyv1alpha1.PolicyList{}, object)
```

In `server_test.go`'s real fixture server, call the generated client's `ListPolicies(ctx, connect.NewRequest(&paprikav1.ListPoliciesRequest{}))`; require no error and an empty `Policies` slice.

- [ ] **Step 2: Run Go RED**

```bash
rtk go test ./test/fleetconsole -run 'Test(FixtureSchemeRegistersPolicyList|FixtureServerServesCompiledUIAndRealFleetConnectQueries)' -count=1
```

Expected: FAIL with `PolicyList is not registered for policy.paprika.io/v1alpha1`; the real Connect call currently surfaces the same fixture 500.

- [ ] **Step 3: Add the browser/network RED assertion**

In a test titled `loads empty policies through the real fixture`, observe the response for `/paprika.v1.PaprikaService/ListPolicies`, assert status 200 and parsed JSON `{}`, and assert no policy-load error is rendered. Run the shared compiled-fixture protocol against the unchanged native fixture, then execute:

```bash
rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- e2e/fleet-console.spec.ts --project=chromium --grep 'loads empty policies through the real fixture'
```

Expected: FAIL on the existing 500 after Playwright's `/readyz` poll; stale-process or connection failures are invalid evidence.

- [ ] **Step 4: Register `policyv1alpha1.AddToScheme`**

Add the policy import and a named `policy` registration beside pipelines/core/rollouts/clusters.

- [ ] **Step 5: Run Go GREEN, rebuild the fixture, then run browser GREEN**

```bash
rtk gofmt -w test/fleetconsole/seed.go test/fleetconsole/seed_test.go test/fleetconsole/server_test.go
rtk go test ./test/fleetconsole -run 'Test(FixtureSchemeRegistersPolicyList|FixtureServerServesCompiledUIAndRealFleetConnectQueries)' -count=1
rtk go build -o bin/fleet-console-fixture ./test/fleetconsole
rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- e2e/fleet-console.spec.ts --project=chromium
```

Expected: both focused Go tests pass; the browser observes HTTP 200 with `{}` and no policy error.

- [ ] **Step 6: Checkpoint the fixture policy fix**

```bash
rtk git diff --check
rtk git add test/fleetconsole/seed.go test/fleetconsole/seed_test.go test/fleetconsole/server_test.go ui/e2e/fleet-console.spec.ts
rtk git commit -m "fix(fixture): register policy API types"
```

---

## Chunk 5: Full Verification

### Task 21: Run fresh, complete automated verification

- [ ] **Step 1: Regenerate contracts and prove there is no generated drift**

```bash
rtk go tool buf lint
rtk go tool buf generate
rtk git diff --check
rtk git diff --exit-code
rtk git status --short
```

Expected: Buf lint exits 0, regeneration creates no diff, `git diff --exit-code` exits 0, and status is empty.

- [ ] **Step 2: Run uncached Go verification**

```bash
rtk go test ./... -count=1
rtk go vet ./...
rtk make lint
rtk go test ./internal/api -run '^$' -bench '^BenchmarkQueryReleasesSearch10k$' -benchtime=5x -benchmem
```

Expected: every Go package passes fresh, vet exits 0, golangci-lint reports zero issues, and fresh release benchmark ns/op, B/op, and allocs/op are recorded with the O(N) cache-scan qualification.

- [ ] **Step 3: Run complete UI unit/static verification**

```bash
rtk npm --prefix ui run lint
rtk npm --prefix ui test
rtk npm --prefix ui run build
rtk go build -o bin/fleet-console-fixture ./test/fleetconsole
```

Expected: ESLint reports zero errors, all Vitest files pass, Next static export succeeds including `/dashboard/releases`, and the native fixture binary builds.

- [ ] **Step 4: Run the compiled story across all three browser projects**

First use the shared protocol to ensure port 3100 is free. Then let Playwright own the exact binary/UI export:

```bash
rtk env -u PLAYWRIGHT_NO_WEBSERVER npm --prefix ui run test:e2e -- e2e/fleet-console.spec.ts e2e/fleet-responsive.spec.ts --project=chromium --project=chromium-reduced-motion --project=chromium-keyboard-only
```

Expected: `/readyz` becomes ready and Playwright reports zero failures across normal motion, reduced motion, and keyboard-only projects. The run must include exact late-release discovery, legacy-hash migration, skip-link geometry, policy 200, nested dialog focus order, both responsive viewports, and late virtualized rows.

- [ ] **Step 5: Verify final source/checkpoint state**

```bash
rtk git diff --check
rtk git status --short
```

Expected: no unstaged source diff remains after the planned commits; only ignored runtime evidence may exist. If an intended verification-only source change remains, review it, stage it explicitly, and commit it as `test(ui): complete enterprise console regressions` before proceeding.

### Task 22: Inspect the UI visually and leave one fresh local fixture running

- [ ] **Step 1: Evaluate—but do not overstate—the optional application scale gate**

First check Docker availability and daemon state:

```bash
rtk docker version --format '{{.Server.Os}}/{{.Server.Arch}}'
rtk docker info --format '{{.MemTotal}}'
```

If Docker is not installed, the server/daemon is unavailable, either output is invalid, or the memory is below 8,589,934,592 bytes, record the exact skip reason and do not run the gate. Normalize server `linux/x86_64` to `linux/amd64`, matching `hack/test-fleet-scale.sh`; only normalized `linux/amd64` with at least 8 GiB may run `rtk bash hack/test-fleet-scale.sh`. Record pass/fail/skip and its reason. A pass validates the 10,000-application fleet API/presentation gate only; it does not validate Release search. Report Release search separately using the fresh `BenchmarkQueryReleasesSearch10k` numbers and retain the O(N) cache-scan limitation.

- [ ] **Step 2: Rebuild native handoff artifacts after the optional scale script**

The scale script may overwrite the fixture binary with linux/amd64 output, so always run:

```bash
rtk go build -o bin/fleet-console-fixture ./test/fleetconsole
rtk npm --prefix ui run build
rtk mkdir -p artifacts/fleet-console-local artifacts/ui-validation
```

- [ ] **Step 3: Start exactly one persistent 250-application fixture**

Repeat the shared protocol's port ownership check and stop only a verified old fixture. In a managed PTY, start:

```bash
rtk script -q artifacts/fleet-console-local/server.log ./bin/fleet-console-fixture --listen 127.0.0.1:3100 --assets ui/out --applications 250
```

From a second terminal use a bounded readiness poll:

```bash
rtk bash -c 'for attempt in $(seq 1 60); do curl -fsS http://127.0.0.1:3100/readyz && exit 0; sleep 1; done; exit 1'
rtk lsof -nP -iTCP:3100 -sTCP:LISTEN
rtk ps -p <pid> -o command=
rtk lsof -a -p <pid> -d cwd -Fn
```

Expected: readiness succeeds within 60 seconds, exactly one listener exists, and both executable and cwd identify the newly built native fixture in this worktree. Keep that PTY/process alive through handoff.

- [ ] **Step 4: Perform and capture the exact visual/browser checklist**

Use the in-app Browser at `http://127.0.0.1:3100/dashboard/`. Through its `tab.playwright` API, set each viewport/state, complete the stated visibility/layout assertions, and call `page.screenshot({ path: <absolute artifact path>, fullPage: true })` at original resolution. Produce exactly:

- `desktop-dashboard.png`: eight ranked tiles, readable status counts, command search, and balanced density;
- `desktop-release-application-00246.png`: exact query `application-00246-release-v1` in the dedicated inventory;
- `mobile-390-treemap.png`, `mobile-390-matrix.png`, `mobile-390-table.png`, `mobile-390-queue.png`;
- `tablet-768-treemap.png`, `tablet-768-matrix.png`, `tablet-768-table.png`, `tablet-768-queue.png`;
- `desktop-1440-wide-table.png`: preserved wide column presentation;
- `virtual-row-76-table.png` and `virtual-row-76-queue.png`: late rows with measured nonoverlapping spacing;
- `resource-dialog.png` and `nested-investigation.png`: named modal surfaces with visible focus indicators;
- `skip-link-focused.png`: focused, fixed, fully in-viewport, at least 44 px high.

Screenshots prove visual state only. In the same automation, separately assert the legacy hash becomes a hash-free scoped Release URL, the late virtual rows keyboard-navigate correctly, focus cannot leave the top modal, first/second Escape close in stack order, and final focus returns to the exact opener.

Inspect each screenshot at original resolution. If any issue is visible, return to the relevant TDD task rather than documenting it as acceptable.

- [ ] **Step 5: Assert the local runtime is clean**

Before the first navigation, attach Browser/Playwright listeners for console messages of type `error`, `pageerror`, `requestfailed`, every response whose pathname starts `/paprika.v1.PaprikaService/` and status is at least 400, the exact `ListPolicies` response, and requests whose pathname is exactly `/events`. Navigate through the checklist, reload once, and repeat. Require empty console/page/request-failure/failed-Connect/event arrays plus `ListPolicies` status 200 and JSON `{}`. Persist the collected arrays, policy status/body, final URLs, focus assertions, and reload result to `artifacts/ui-validation/runtime-audit.json` using `apply_patch` so the clean result is inspectable.

- [ ] **Step 6: Record the handoff evidence**

Run `rtk git diff --check` and `rtk git status --short` one final time; expected source status is empty because artifacts are ignored. Report the local URL, verified listener PID/cwd, `artifacts/fleet-console-local/server.log`, screenshot filenames, `runtime-audit.json`, exact automated test totals, 10k application gate status, fresh 10k release benchmark numbers, and the known Release cache-scan limitation. Leave the browser on the validated dashboard and leave the single fixture process running. If visual inspection caused any source rework, rerun all of Task 21 before repeating this handoff step.
