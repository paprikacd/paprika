# Console redesign — design

Status: approved (scope C)
Date: 2026-09-10

## Problem

The Paprika console is a dark, rounded, Instrument Sans interface built around
seven feature areas that grew independently. A new design — `Paprika
Console.dc.html`, in the "ArgoCD replacement UI uplift" Claude Design project —
reworks it into a dense light operations console: steel blue on paper, square
hairline "blueprint" frames with corner registration marks, Barlow Condensed
over Barlow at a 13px base.

Roughly a third of what that design draws is data the control plane does not
have. We are building all of it: the design in full, and the backend that makes
it real.

## Reference material

Detailed analysis lives in `docs/superpowers/specs/console-redesign/`:

- `00-gap-analysis.md` — view mapping, design-system strategy, data reality
  check, risks, scope options.
- `01-backend-design.md` — feasibility per gap, the full proto extension, the
  backend implementation plan, the degraded-mode contract, sequencing.
- `design-*.md` — the target design, view by view, at exact values.
- `repo-*.md`, `be-*.md` — the existing UI and Go control plane as they stand.

## The governing principle: no invented numbers

The design shows cost, capacity, latency and history unconditionally. Much of
that depends on systems Paprika may not be connected to. The console must never
render a plausible-looking zero for something it cannot measure.

Every data class the console can show carries a `DataState`:

| State | Meaning | Console behaviour |
|---|---|---|
| `OK` | fresh and real | render |
| `NOT_CONFIGURED` | no source configured | hide the board or column entirely |
| `NOT_AVAILABLE` | source configured, capability absent | grey it, show the reason |
| `STALE` | last good sample is past its budget | render with an age badge |
| `ERROR` / `FORBIDDEN` | fetch failed | grey it, generic reason |

`GetDataSources` returns exactly one status per `DataClass`, in enum order,
always. The console calls it once at boot and uses it to decide which surfaces
exist at all — rather than probing each RPC and guessing from empty results.

`ResourceMeter` carries per-component state, because `requested` and
`allocatable` come from the Kubernetes API while `used` needs metrics-server;
one is usually `OK` while the other is often `NOT_AVAILABLE`.

## Architecture

### Design system

The repo's Tailwind v4 token architecture stays; the values are replaced and
the vocabulary the design needs is added. No second token system, no inline hex
in TSX.

`src/app/globals.css` carries: remapped semantic tokens (`--background` paper,
`--primary` steel, `--radius: 0`); a four-weight hairline ladder; neutral and
steel ramps; semantic surfaces (zebra, inset, scope-active, selected); the
inverted "ink" family for the navy sidebar, tooltips and log panes; **21 status
tone tokens** (7 states × text/line/fill); diff colours, deliberately not the
status tones; five shadows, all on genuine overlays; and a named type scale for
the sub-12px sizes Tailwind's ramp does not reach.

`statusPalette: quiet` is a `[data-status-palette="quiet"]` block rewriting the
three healthy tokens — not a second palette.

### Status tones

`src/lib/status-tone.ts` is the single resolver from every backend enum
(`FleetHealth`, `FleetSyncState`, `FleetRolloutState`, `FleetReleaseState`) onto
seven tones. Each tone carries a glyph as well as a colour, so state survives
greyscale and colour blindness. The set is closed; a screen that invents an
eighth tone stops reading as one system.

### Routes

| Design view | Route | Verdict |
|---|---|---|
| Operations overview | `/dashboard/` | rebuild |
| Applications | `/dashboard/applications/` | rebuild (4 presentations) |
| Application detail | `/dashboard/application/` | rebuild |
| Pipeline detail | `/dashboard/pipelines/detail/` | restyle + extend |
| Rollout detail | `/dashboard/rollouts/detail/` | rebuild |
| Sync & diff | `/dashboard/diff/` | net-new |
| Fleet map | `/dashboard/map/` | net-new |
| Repositories / Templates / Clusters | `/dashboard/{repositories,templates,clusters}/` | net-new |

All routes are static-exported (`output: "export"`, `trailingSlash: true`), so
detail routes take `?namespace=&name=` and wrap their client body in
`<Suspense>`.

### Backend

Eleven gaps, from `01-backend-design.md`:

| Gap | Verdict |
|---|---|
| Lifecycle vector, 3 of 4 mutations | buildable now — derivation only |
| Cluster inventory, drift detail, commit metadata, ownership, source events, rollout history, pipeline runs | buildable with collection |
| Capacity `used`, per-app RED signals, real cost | needs external (metrics-server, Prometheus, billing) |

Ownership is the cheapest item; cost and signals land last and degrade honestly
until they do.

## Sequencing

**Phase 0 — the contract.** Add every message, enum and RPC to
`proto/paprika/v1/api.proto`; regenerate Go and TypeScript; implement every new
RPC as a stub returning `NOT_CONFIGURED`; teach the fixture server the same.
This unblocks all UI work at once and concentrates proto churn into one
reviewable change.

**Phase 1 — CRD-only, five parallel tracks.** Ownership; lifecycle vector;
drift detail; commit metadata; cluster inventory.

**Phase 2 — history records.** A shared `internal/history` write/prune/list
helper, then `SourceEvent`, then `RolloutRecord` and `PipelineRun`.

**Phase 3 — remaining mutations.** `IgnoreDriftedField`, `SyncResources`,
`ApplyResourcePatch`.

**Phase 4 — external integrations.** `ObservabilitySource` and a metric
provider; cost rate-card estimates, then a billing adapter; metrics-server for
`used`. Phase 4a is the most security-sensitive work in the plan (SSRF,
credential handling, cardinality, DoS) and is staffed separately.

UI work proceeds against the Phase 0 contract and lights up as each backend
track lands.

## Deliberate departures from the design

Three places where the design is not followed literally, because following it
would ship a regression:

1. **Focus rings stay.** The design sets `:focus { outline: none }`, which
   leaves the header search with no keyboard-visible focus state.
2. **Sign-out stays.** The design drops it. Removing the only way to end a
   session is a functional regression, not a style choice. It is quieter, but
   reachable.
3. **Touch targets stay at 44px on touch surfaces.** The dense 29px rows are
   right for the desktop rail; the mobile drawer keeps `min-h-11`.

And one honesty correction: the design's header reads `live · 12s`. The console
polls (60s fleet, 15s focused) and has no push channel, so the indicator shows
the real poll cadence and last-refresh age.

## Risks

- **Proto contract tests.** `internal/api/fleet_contract_test.go` asserts exact
  field counts and an exact `FleetCapability` value map. Three edits are
  expected and are all in Phase 0.
- **`e2e/fleet-scale.spec.ts`** asserts `applicationNodeCount === 0` and
  `descendantElementCount < 200` at 10,000 applications. The treemap stays on
  canvas and the row model stays one-row-per-application; the heatmap and fleet
  map take the same bounded-DOM discipline.
- **`e2e/fleet-console.spec.ts`** runs in CI on every PR and asserts the current
  five-link nav, the disabled Activity/Admin buttons, the checkbox facet panel
  and two region names. All five change; the spec is updated with them.
- **~5,600 lines across 11 components** are rewritten. `css: false` in the
  vitest config means pure restyling is test-safe; the data layer is untouched.

## Testing

- Unit: vitest, colocated `*.test.tsx`. New primitives and the tone resolver get
  direct tests; view tests assert behaviour and accessible names, not markup.
- Contract: `fleet_contract_test.go` extended for the new messages.
- Go: `go build ./...`, `go test ./internal/engine ./internal/controller/pipelines`,
  `go vet ./internal/... ./cmd/...` per `AGENTS.md`.
- E2E: both Playwright specs updated; `fleet-scale.spec.ts` thresholds unchanged.
- Visual: the design is rendered locally and screenshotted per view; the built
  console is screenshotted against the same viewport for comparison.
