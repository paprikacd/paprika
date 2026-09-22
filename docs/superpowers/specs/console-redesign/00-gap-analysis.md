# Gap analysis & integration proposal — `console.dc.html` → `/Users/benebsworth/projects/paprika/ui`

Synthesised from the nine reader notes in this directory plus direct verification against the repo.
Everything below is grounded; where the design implies data that does not exist it is marked **MISSING**.

Two facts frame the whole exercise:

1. The design is a **full theme inversion** — dark oklch / Instrument Sans / 14px / radius 12–21px →
   light literal-hex / Barlow + Barlow Condensed / 13px / radius 0. Nothing about the current
   `globals.css` palette survives as a value; the *token names* can survive.
2. The design is a **fixture**, not a data contract. `APPS` is 16 hand-written rows and roughly half the
   numbers on screen (57 applications, $14.2k/mo, 88 cores allocatable, `cache hit 74%`, `run #418`)
   have no representation in `paprika.v1` at all. Section 3 is the load-bearing part of this document.

---

## 1. VIEW MAPPING

### 1.1 Chrome

| Design element | Existing host | Verdict | Notes |
|---|---|---|---|
| 206px navy sidebar `#1d2d3d`, 29px uppercase rows, mono count badges, pinned identity footer | `src/components/layout/sidebar.tsx` (442) | **Rebuild** | Keep the mobile drawer + `makeElementsInert()` focus trap (the design has no mobile story). Drop the `P` logo tile, the avatar and the sign-out button per design — **sign-out removal needs product sign-off**. Active state changes from `inset 2px 0 0` rail to a solid steel fill. |
| 42px white header: 3 scope dropdowns + clear + inline search + live pip + `gen` | `src/components/layout/scope-bar.tsx` (34, hard-coded stub) | **Rebuild (net-new behaviour)** | The current file is a placeholder with zero wiring. This is the single highest-value chrome change: it becomes the global `FleetQueryState` editor. |
| `<main>` with no padding / no max-width | `src/components/layout/app-shell.tsx` (29) | **Restyle** | Replace `lg:pl-64` offset with a real flex row (design sidebar is in normal flow, not `fixed`). Keep the skip link and `data-dashboard-*` contracts. |
| Nothing after `</main>` — no portal root | — | **No change** | Confirms no global overlay layer is needed. The inspector drawer is `position:fixed` inline. |

### 1.2 Screens

| # | Design view | Existing route / components | Verdict |
|---|---|---|---|
| 1 | Operations overview (6 numbered boards, customise mode) | `/dashboard/` → `src/app/dashboard/page.tsx` (478) + `fleet-overview.tsx` (344) + `dashboard-command-center.tsx` (668) + 7 StatCards + Pipelines/AppSets/Policies grids | **Rebuild** — near-total content replacement. `dashboard-command-center.tsx` has **no home in the design**; it either becomes the ⌘K palette or is deleted. |
| 2 | Applications shell (header, GROUP BY / VIEW segs, facet toolbar, footer) | `/dashboard/applications/` → `fleet-view.tsx` (391) + `fleet-filters.tsx` (786) | **Rebuild** — `fleet-filters.tsx`'s `<details>` + 9 checkbox fieldsets collapse to 6 chips + header scopes. |
| 2a | └ Table (9 cols, group headers, lifecycle strip, zebra) | `application-table.tsx` (372) | **Rebuild** — 6 cols → 9, and virtualisation must be re-plumbed under group headers. |
| 2b | └ Treemap (DOM flex tiles, `flex:{res}`) | `fleet-treemap.tsx` (454, **canvas**) + `treemap-layout.ts` (165) | **Restyle only — do NOT port the design's DOM tiles** (see Risk 1). Repaint the canvas with the new tone table. |
| 2c | └ Matrix (grid, count + `N apps` + per-health pills, shaded empties) | `fleet-matrix.tsx` (129, flat row/col table) | **Rebuild** — maps 1:1 onto `QueryFleetMatrix`. |
| 2d | └ Queue (rank, 3px tone rail, derived WHY) | `attention-queue.tsx` (156) | **Rebuild** — same data source (server impact sort), new layout. |
| 3 | Application detail | `/dashboard/application/` (786) + `investigation-triage.tsx` (361) + `sync-diff-workbench.tsx` (237) + `application-release-history.tsx` (193) + `resource-list-table.tsx` (272) + `resource-graph.tsx` (180) | **Rebuild** — largest single file in the repo; the design reorganises it into a header slab + timeline + 2-col body + rail + promotion. |
| 3a | └ Resource inspector slide-over (Diff/Live/Desired/Events/Logs) | `resource-detail-panel.tsx` (553) | **Restyle** — the 5 tabs, the default-to-Diff behaviour and the log reconnect logic already match the design exactly. Best-aligned component in the repo. |
| 4 | Pipeline detail (step graph, stats strip, step card, artifacts) | `/dashboard/pipelines/detail/` (231) + `pipeline-dag.tsx` (96, xyflow+dagre) + `pipeline-dag-node.tsx` + `step-detail-panel.tsx` (111) + `artifact-card.tsx` (122) | **Restyle + partial rebuild** — node styling and the new stats strip / artifacts list are additive; keep dagre. |
| 5 | Rollout detail (traffic ladder, analysis table, rollout log) | `/dashboard/rollouts/detail/` (314) + `rollout-debug-panel.tsx` (142) | **Rebuild** — the before/after note calls this "essentially a different screen". |
| 6 | Sync & diff workbench | **No route.** Parser + renderer exist in `sync-diff-view.tsx` (269) and a card in `sync-diff-workbench.tsx` (237) | **Net-new route** `/dashboard/diff/`, reusing `parseUnifiedDiff` / `summarizeUnifiedDiff` / `DiffLineRow`. |
| 7 | Cluster & fleet map | **No route, no component** | **Net-new route** `/dashboard/map/` on `QueryFleetMatrix`. |

### 1.3 Existing surfaces with no design home (decide explicitly)

| Surface | Lines | Recommendation |
|---|---|---|
| `/dashboard/rollouts/` list (3 stat cards + table) | 293 | Keep, restyle. Design's `Rollouts` nav item points at a detail screen only. |
| `/dashboard/applicationsets/` + `/detail/` | 178 + 176 | Keep, restyle. Design's `SOURCES → Templates` stub is the natural nav home. |
| `dashboard-command-center.tsx` | 668 | Delete or convert to the ⌘K palette the header promises. |
| `investigation-triage.tsx` + `investigation-panel.tsx` | 361 + 313 | Design drops triage entirely but keeps one `Investigate` button. Keep the panel, fold triage into the app-detail rail. |
| `application-release-history.tsx` | 193 | Design has no Releases surface at all. Keep behind the (currently inert) `Releases` tab. |
| `notification-center.tsx` (169), `toast-stack.tsx` (53) | | Already inert (`events` is permanently `[]`). Delete `notification-center`. |
| `components/landing/*` (6 files, 720 lines), `application-card.tsx` (567), `release-table.tsx` (157) | | **Dead code — delete regardless of scope.** |
| `/login/`, `/auth/callback/` | 146 + 96 | Not in the design. Restyle to the new palette so the product is internally consistent. |
| `card.tsx`, `status-badge.tsx` | 103 + 89 | Superseded by `Blueprint` / `StatusPill`. Keep during migration, mark deprecated. |

---

## 2. DESIGN-SYSTEM STRATEGY

### 2.1 The core tension

The design uses **zero `var(--…)`** in the chrome — every colour is an inline hex or a JS const, and
`styles.css` is a *reference palette* that gets restated by hand. The repo is CSS-first Tailwind v4
(`@theme inline` in `globals.css`, **no `tailwind.config`**, `components.json` has `"config": ""`).

The right reconciliation is: **keep the repo's token architecture, replace the values, and add the
vocabulary the repo is missing (status tones, hairline ladder, inverted surface, diff colours).**
Do not introduce a second parallel token system, and do not inline hex in TSX.

### 2.2 What belongs in `globals.css` `@theme`

**(a) Remap the existing semantic names** — this keeps `bg-background` / `text-foreground` /
`border-border` / `text-muted-foreground` working across the 49 client components, so a huge amount of
existing markup themes for free:

```css
--background: #f2f2f3;            /* PAPER  — was oklch(0.115 0.01 50) */
--foreground: #1d1f20;            /* INK */
--card: #ffffff;                  /* the design's floating white; note the DS has NO white token */
--card-foreground: #1d1f20;
--popover: #ffffff;
--muted: #e9e9ea;                 /* --color-surface: table heads, footers, map gutters */
--muted-foreground: #5d5d60;      /* MUTED */
--primary: #5980a6;               /* STEEL — replaces paprika orange oklch(0.63 0.19 35) */
--primary-foreground: #f2f2f3;
--secondary: #f5f5f8;             /* neutral-100 */
--border: rgba(29,31,32,0.16);    /* DIV */
--input: rgba(29,31,32,0.16);
--ring: #5980a6;
--radius: 0;                      /* ⚑ the DS forces border-radius:0 on card/btn/input/tag/seg/dialog */
```

**(b) Add the hairline ladder.** The design uses four distinct alpha weights with distinct meanings and
the repo has exactly one (`--border`). Collapsing them loses the whole visual grammar:

```css
--color-rule-strong: rgba(29,31,32,0.28);  /* table-header underline, floating-surface border, DAG node */
--color-rule:        rgba(29,31,32,0.16);  /* card frames, section rules  (= --border) */
--color-rule-soft:   rgba(29,31,32,0.10);  /* in-list row separators */
--color-rule-faint:  rgba(29,31,32,0.08);  /* tight lists (rollout log, source kv) */
```

**(c) Add the two ramps** (verbatim from `styles.css`, which the design freezes by hand):

```css
--color-neutral-100..900: #f5f5f8 #e7e7ea #d4d4d7 #b7b7ba #98989b #7a7a7d #5d5d60 #424244 #2b2b2d;
--color-steel-100..900:   #eef6ff #d6ebff #b5d9fd #94bce3 #749dc4 #597ea3 #416180 #2c455d #1d2d3d;
```

**(d) Add the semantic surfaces** the design distinguishes and Tailwind has no name for:

```css
--color-zebra:        #fbfbfc;   /* odd inventory rows */
--color-inset:        #f5f5f8;   /* empty matrix cell, "menu is open" scope wash, panel tags */
--color-scope-active: #e7f0f8;   /* "this filter is engaged" — distinct from --color-inset, do not merge */
--color-selected:     #eef6ff;   /* selected chip / drift-queue row (= steel-100) */
```

**(e) Add the inverted-surface family.** The navy sidebar, the heat tooltip and the two log panels all
share one system that the repo has no vocabulary for:

```css
--color-ink-surface:   #1d2d3d;              /* sidebar, tooltip, log <pre> (= steel-900) */
--color-ink-on:        #f2f2f3;              /* foreground on it */
--color-ink-rule:      rgba(242,242,243,0.16);
--color-ink-muted:     rgba(242,242,243,0.74);   /* inactive nav label */
--color-ink-faint:     rgba(242,242,243,0.50);   /* footer role line */
--color-ink-kicker:    rgba(242,242,243,0.42);   /* nav section label */
--color-ink-accent:    #94bce3;                  /* brand sub-line, log live dot (= steel-400) */
--color-log-text:      #dfe6ee;
```

**(f) ⚑ The status tone table — the single biggest addition.** 7 statuses × 3 roles = 21 tokens.
**None of these exist in `styles.css` either** — the design invented them, and they are the core of the
new visual language:

```css
--color-status-healthy-text: #3f6b48;  --color-status-healthy-line: #7fae86;  --color-status-healthy-fill: #e6f2e8;
--color-status-progressing-*: #2c455d / #8bb0d0 / #e7f0f8;
--color-status-degraded-*:    #8a5f22 / #e0ad66 / #fdf2df;
--color-status-failed-*:      #9c3f39 / #dd9490 / #fbe9e8;
--color-status-missing-*:     #5b5468 / #aea8bd / #efedf4;
--color-status-unknown-*:     #5d5d60 / #c2c2c6 / #f4f4f6;
--color-status-pending-*:     #8e8e92 / #d4d4d7 / transparent;
```
The `statusPalette: "quiet"` prop rewrites **only the three `healthy` tokens** (`#4a4a4c / #a8a8ab /
#f0f0f2`) — implement it as a `[data-status-palette="quiet"]` block on `<html>`, not a second palette.

**(g) Diff colours are NOT status tones** (a real trap — `#2f5237` ≠ `--color-status-healthy-text`):

```css
--color-diff-add-bg: rgba(74,124,82,0.10);  --color-diff-add-text: #2f5237;
--color-diff-del-bg: rgba(168,68,59,0.10);  --color-diff-del-text: #7d3129;
--color-diff-ctx-text: #5d5d60;             --color-diff-gutter:   #98989b;
```

**(h) Shadows — exactly five, all on genuine overlays.** In-page surfaces have **zero elevation**:

```css
--shadow-dropdown:   0 3px 10px rgba(43,43,45,0.16);   /* scope menu */
--shadow-popover:    0 8px 22px rgba(29,45,61,0.18);   /* heat settings */
--shadow-tooltip:    0 8px 22px rgba(29,45,61,0.28);   /* heat tile card */
--shadow-tile-hover: 0 4px 12px rgba(29,45,61,0.16);
--shadow-drawer:     0 12px 32px rgba(43,43,45,0.22);  /* inspector */
```
Delete the `ring-1 ring-foreground/10` card idiom entirely — it is the repo's fake-elevation pattern and
reads as a near-black hairline on white.

**(i) Type scale.** The design uses ~17 distinct sizes, half of them sub-12px, which Tailwind's default
`text-xs`(12)/`text-sm`(14) cannot express. Define a named scale rather than scattering `text-[9px]`:

```css
--text-kicker: 9px;   --text-meta: 10px;   --text-micro: 10.5px;  --text-note: 11px;
--text-reason: 11.5px; --text-chip: 12px;  --text-base: 13px;     --text-label: 14px;
--text-name: 15px;    --text-card: 16px;   --text-board: 17px;    --text-count: 19px;
--text-stat: 20px;    --text-weight: 22px; --text-canary: 24px;   --text-title: 30px; --text-hero: 34px;
```
**Do not set `html { font-size: 13px }`** — that silently shrinks every existing rem-based `text-sm` to
11.4px across the app. Set `body { font-size: 13px }` and use the named scale.

**(j) Fonts + geometry:**
```css
--font-sans: var(--font-barlow);
--font-cond: var(--font-barlow-condensed);   /* → `font-cond` utility, replaces the design's `.cond` */
--font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;   /* system stack — drop JetBrains Mono */
--nav-width: 206px;  --header-height: 42px;  --row-height: 42px;  /* 52px comfortable */
--animate-blip: blip 2.4s ease-in-out infinite;
```

**(k) Global CSS that cannot be a token** (goes in `@layer base` / `@layer components`):
`@keyframes blip`; the `.blueprint > .corner::before/::after` registration marks (they need
pseudo-elements); the 9px scrollbar (`thumb #c4c4c8` / `track #e9e9ea`); `::selection #d6ebff`;
`a { color: #416180 }` + hover `#2c455d` **with** underline. Keep the existing
`:focus-visible { outline: 2px solid var(--ring) }` — **do not port the design's `:focus{outline:none}`**,
which leaves the header search field with no visible focus state at all.

### 2.3 What becomes a UI primitive (`src/components/ui/`)

New, in dependency order:

| Primitive | Replaces / why | Design source |
|---|---|---|
| `status-tone.ts` (not a component) | Single TS source of truth: `Record<FleetHealthStatus, {glyph,label,text,line,fill}>`. Needed because `fleet-treemap.tsx` paints to **canvas** and cannot read Tailwind classes. Add a unit test asserting parity with the CSS vars. | `tones()` L1288–1301 |
| `status-chip.tsx` | 16×16 square, glyph `✓ ↻ ! × ∅ ? ·`, `1px t.line` / `t.fill` / `t.c`, 10px/700. Used ~14 places. Replaces the current coloured-dot + emoji vocabulary. | `chip()` L1303 |
| `status-pill.tsx` | 2px radius, uppercase, 10px/600/.04em. **Rewrite `status-badge.tsx`'s 13-key string vocabulary to map onto the 7 tones** rather than keeping two systems. | `pill()` L1306 |
| `blueprint.tsx` | `<Blueprint>` = 1px rule frame + 4 corner marks + optional header bar (kicker / title / controls / chevron). **Every card in the design is this.** Replaces `card.tsx` for all new surfaces. | `.blueprint` + `.corner` |
| `seg.tsx` | Segmented control. Appears 11× at 4 heights (22/24/26/30px). Must expose `aria-pressed` — `fleet-console.spec.ts` asserts it on the presentation toggle. Today there are **three** hand-rolled implementations. | `.seg` + `miniSeg`/`segOpt` |
| `input.tsx` | **Missing from the repo entirely.** Two variants: chromeless (header + facet toolbar search) and boxed. Three different search inputs are hand-rolled today. | L80–83, L497 |
| `tabs.tsx` | `border-bottom: 2px solid steel` underline tabs. Three hand-rolled implementations today (app-detail, inspector, pipeline). | L686, L892 |
| `popover.tsx` / `dropdown-menu.tsx` | Scope dropdowns + heat settings. `@base-ui/react` ships both; shadcn `base-nova` has the recipes. **Also add the click-outside the design forgot** (`closeScope` is exported at L1996 but never wired). | L68–74, L187–210 |
| `drawer.tsx` | 560px right slide-over + `rgba(29,31,32,0.32)` scrim. Currently hand-rolled inside `resource-detail-panel.tsx`. | L872–939 |
| `mix-bar.tsx` | Health-distribution bar, fixed worst→best order (`failed, missing, degraded, progressing, unknown, healthy`), zero buckets dropped. Used at 4 sizes (160×8, 60×6, 8px, 6px). | `mixBar()` L1535 |
| `kicker.tsx` | mono 9–10px uppercase, `.14em`–`.20em`, `#597ea3` (page) or `#7a7a7d` (in-card). Already a house idiom — formalise it. | everywhere |

Modify: `button.tsx` — add `xxs`(21px)/`2xs`(23px)/`xs`(26px)/`sm`(28px)/`md`(30px)/`lg`(32px) heights to
match the design's six button sizes; remove `rounded-lg`, `active:scale-[0.96]`, `focus-visible:ring-3`;
switch `destructive` from a variant to the design's `secondary + color:#9c3f39; border-color:#dd9490`.

### 2.4 What stays local

Absolute-positioned canvas geometry (resource-graph node x/y, pipeline DAG, edge béziers); the heat
tooltip's `getBoundingClientRect` side/shift/clamp maths; the CPU/MEM capacity meter (one board only);
the `hairline grid` idiom (`gap-px bg-rule` over a divider background) — this is already a repo idiom in
`fleet-overview.tsx`, just document it; all one-off copy strings.

### 2.5 Dark mode

The root layout hard-locks `<html className="… dark" style={{colorScheme:"dark"}}>`. The design is
light-only with **no dark variant and no token indirection**. Recommendation: remove the `dark` class and
`colorScheme`, leave `@custom-variant dark` and the `:root.dark` block in place but unreferenced. That
makes the port a value swap rather than a structural rewrite, and leaves a dark theme buildable later.
**This drops the currently-shipping dark product — explicit product decision.**

---

## 3. DATA REALITY CHECK ⚑

Legend: **HAVE** = a typed field exists and is populated · **DERIVABLE** = computable from real fields,
with the stated caveat · **MISSING** = no representation in `paprika.v1`.

Recurring caveat, cited below as *(window)*: `QueryApplications` pages at **100**. Anything computed by
iterating applications client-side reflects only the loaded window, not the fleet. Facet buckets
(`FleetFacetBucket.count`) and `total` are the only fleet-wide numbers.

### 3.1 Chrome

| Element | Verdict | Detail |
|---|---|---|
| Scope dropdown options + per-option counts | **HAVE** | `FleetFacetBucket{dimension, object\|value, label, count}` for `PROJECT`, `CLUSTER`, `STAGE`. `fleet-query.ts` already models `projects[]/clusters[]/stages[]`. ⚑ The API is **multi-select**, the design is single-select — keep multi-select and render "3 selected". |
| `gen 4412` | **HAVE** | `indexGeneration: bigint` on every fleet response. Real, cheap, already plumbed. |
| `live · 12s` | **MISSING** | There is no push. `connection-context.events` is permanently `[]`, and `fleet-console.spec.ts` has an auto-fixture that **fails the suite if `/events` is ever requested**. Render the real poll cadence (60s fleet / 15s focused from `fleet-refresh.ts`) or "updated Ns ago". |
| Search `⌘K` | **HAVE (query) / MISSING (surface)** | `QueryApplicationsRequest.search` is real and typo-tolerant (e2e types `"checkout servce"`). But the design draws **no results dropdown, no recents, no counter, no empty state** — the palette is a net-new build. |
| `{N} of 30 targets in scope` | **DERIVABLE** *(window)* | `total` counts **applications**, not targets. Target count = `sum(app.targets.length)` over the loaded page only. |
| Nav badge `Applications 30` | **HAVE** | `total`. |
| Nav badges `Pipelines 3` / `Rollouts 3` | **DERIVABLE** | `ListPipelines({})` / `ListRollouts({})` are unpaginated. Semantics of "3" undefined in the design. |
| Nav badge `Sync & diff 8` | **DERIVABLE** *(window)* | `sum(driftCount)`. No fleet-wide drift total. |
| Nav badges `Repositories 41` / `Templates 4` / `Clusters 3` | **MISSING / DERIVABLE / HAVE** | No `ListRepositories` RPC — repos exist only as a per-app `repository: NamespacedKey`, so 41 is *(window)*-derivable at best. Templates ≈ `ListApplicationSets().length`. Clusters = `CLUSTER` facet bucket count (fleet-wide, correct). |
| `CONTROL PLANE · v2.4.1` | **MISSING** | No version RPC. `GetSystemStatus` returns index/health/attention only. |
| `sre@paprika.io` | **HAVE** | `AuthUser.email`. |
| `PLATFORM · ON-CALL` | **MISSING** | No team / on-call / role field anywhere. |

### 3.2 Overview boards

**Board 01 — Application lifecycle** (6 phases, counts, subs, 4-bar mix, `57 applications · 3 clusters · 12 changes today`)

- App count **HAVE** (`total`); cluster count **HAVE** (`CLUSTER` facets).
- `12 changes today` — **MISSING**. No change/event feed. `lastTransitionUnixMs` per app gives
  "N transitioned in 24h" **DERIVABLE** *(window)*.
- `Source 12` / `GitHub 41 · S3 9 · OCI 7 repos` — **DERIVABLE**, `SOURCE_TYPE` facets
  (`git|helm|kustomize|s3|oci|inline`). Note the design says "GitHub" (a *host*); the API has a *type*.
- `Build 3` / `in-cluster · 41 runs today` — count **DERIVABLE** from `ListPipelines`; **`41 runs today`
  MISSING** — `Pipeline` carries one `createdAt` and one `stepStatuses[]`; there is **no run history**.
- `Test 2` / `1 failing · 213/214 passed` — **MISSING**. No test-result aggregation. `StepStatus.phase`
  is per-step pass/fail, not test counts.
- `Render 4` / `Helm 33 · Kustomize 14 · Jsonnet 6` — **DERIVABLE** from `SOURCE_TYPE` facets. ⚑ The enum
  has **no Jsonnet**.
- `Deploy 7` / `releases active · 2 gates blocked` — **HAVE**: `RELEASE` facets for active states;
  blocked gates = `sum(blockedGateCount)` *(window)* or `ListGateStatus`.
- `Verify 3` / `canaries under analysis · 1 held` — **DERIVABLE**: `ROLLOUT` facets (`paused`,
  `progressing`) + `ListAnalysisRuns`.
- 4-segment mix bar per phase — **design-underspecified**; the fixture segments have no defined meaning.

**Board 02 — Health posture** — the best-supported board in the design.

- Bars variant (6 counts) — **HAVE**, exactly. Two sources: `HEALTH` facet buckets, or
  **`GetSystemStatus` → `health: FleetHealthBucket[]` + `sync: FleetSyncBucket[]`**, a purpose-built RPC
  that **the UI never calls today**. Wire it. ⚑ The design's `÷ 57` denominator is hard-coded — use `total`.
- Heatmap variant (one tile per target, grouped) — **DERIVABLE** *(window)*.
  `ApplicationSummary.targets[]: StageTargetSummary{stableId, stage, ring, cluster, clusterLabel, health,
  clusterConnection}` is exactly a tile. But 100 apps/page means the heatmap is **structurally incomplete
  at fleet scale**; `QueryFleetMap` is the fleet-wide alternative but returns *aggregates*, not tiles.
- Tooltip rows: `target` **HAVE**, `project` **HAVE**, `sync` **HAVE**, `resources` **HAVE**
  (`resourceCount`); **`release` (`r241`) MISSING** — the fleet row has `releaseState` (an enum), not a
  release id; **`{cost}/mo` MISSING** (see 3.7).
- ⚑ The design offers group-by project/cluster/stage but **not namespace**, even though `NAMESPACE` is a
  real facet dimension and `fleet-query.ts` already models `namespaces[]`. Add it back.

**Board 03 — Needs attention**

- Ranking (`ranked by blast radius`) — **HAVE and server-side**: `sort: "impact", direction: "desc"`
  → `ImpactKey{UnhealthySeverity, BlockedGates, ActiveChange, ResourceCount, LastTransitionUnixMS}`.
  `AttentionQueue` already consumes it.
- `age` (`6m`, `1h 12m`) — **HAVE** (`lastTransitionUnixMs`).
- ⚑ **`reason` prose is MISSING** — "p99 latency 41% over baseline — canary held at 25%",
  "Deployment 1/3 replicas ready · CrashLoopBackOff", "s3://acme-manifests unreachable — 403 on
  HeadObject". `ApplicationSummary` has **no message/reason field**. The raw material exists per-app
  (`Application.conditions[].message`, `ResourceHealth.message`, `GateStatus.message`,
  `AnalysisRunResult.message`) but needs a `GetApplication` per row — N+1 on a queue.
  **Recommendation:** use the design's own *Queue-view* derived reasons (`workload failing` /
  `source unreachable` / `degraded · drifted` / `rollout in progress` / `drifted`), which are computable
  from `health` + `sync` + `driftCount` + `blockedGateCount` + `rolloutState` + `repositoryConnection`.
  Do not promise the prose.
- Action verbs (`Review` / `Investigate` / `Fix source` / `Approve` / `Diff` / `View`) — **DERIVABLE**
  from `capabilities[]`, but that enum has only 4 members (`application_sync`, `release_rollback`,
  `gate_approve`, `pipeline_retry`) against the design's 6 verbs. Upside: `capabilities` is
  authorization-derived per project, so the button set is **already RBAC-correct**.

**Board 04 — Rollouts**

- In flight (name, target, canary weight, `STEP 3 / 6`, ladder) — **HAVE**. `ListRollouts({})` is
  unpaginated; `Rollout{currentStep, currentWeight, canarySteps[]{setWeight,duration}, phase, paused,
  message}`. The ladder is literally `canarySteps[].setWeight` with `currentStep` as the marker.
- `analysis` (`1 metric failing` / `4/4 passing`) — **DERIVABLE** via `ListAnalysisRuns` /
  `GetAnalysisRun` → `AnalysisRun.results[]{name, passed, message}`. One extra RPC per rollout.
- ⚑ **`Recent · 7d` tab is entirely MISSING.** No rollout-history RPC. `ListRollouts` returns *current*
  rollouts; there is no completed-rollout archive, no `took` duration, no per-step outcome history.
  `Release.promotionHistory[]{stage, result, timestamp}` is the nearest thing and is release-scoped.
  `recentStats {total:11, ok:9, aborted:2, median:"22m"}` — **MISSING**.

**Board 05 — Source triggers** — ⚑ **MISSING wholesale. The most fabricated board in the design.**

There is no webhook / trigger / source-event feed RPC. `ApplicationSource{type, repoUrl, revision, path,
bucket, key, region, pollInterval}` and `ApplicationSummary.sourceRevision` tell you the *current*
revision — not that a push happened, when, or what it triggered. The `403 HeadObject` failure surfaces
only as `repositoryConnection: unhealthy`. **Options:** drop the board, or rebuild it as "sources whose
revision changed since the previous index generation" (client-side diff across polls, *(window)*).

**Board 06 — Clusters · capacity** — ⚑ **Cannot be built against the current API.**

- ⚑ **There is no `Cluster` message in the proto at all.** A cluster is `FleetObjectKey{namespace,name}`
  + `clusterLabel: string` + `FleetConnectionState`. So `18 nodes`, `eu-west`, `v1.31.4`, `412 pods` are
  all **MISSING**.
- `CONNECTED` / `DEGRADED` pill — **HAVE** (`clusterConnection`: healthy/unhealthy/disabled/not_configured).
- `24 apps` — **HAVE** (`CLUSTER` facet bucket count).
- `$14.2k /mo` — **MISSING** (see 3.7).
- ⚑ **CPU / MEMORY used/requested/allocatable meters and `ksm · node-exporter · 15s ago` — MISSING.**
  There is **no metrics surface in `paprika.v1`**. The only observability hook is
  `effectiveObservabilitySource: NamespacedKey` + `observabilityConnection` — Paprika knows *which*
  Prometheus a project points at, not any metric value. `requestRateWeight` on map/matrix nodes is the
  sole numeric telemetry and it is a **sizing weight, not a rate**.

### 3.3 Applications view

| Column / feature | Verdict | Detail |
|---|---|---|
| APPLICATION, PROJECT, TARGET, HEALTH, SYNC, RES | **HAVE** | `identity`, `project`, `currentClusterLabel`+`currentStage`, `health`, `sync`, `resourceCount`. |
| ⚑ LIFECYCLE 6-cell strip (source/build/test/render/deploy/verify) | **MISSING** | There is **no per-application lifecycle-phase vector**. The closest field is `Application.stages[]: ApplicationStage{name, ring, phase, release, revision}` — those are **promotion rings, not lifecycle phases**, and they live on the per-app detail message, not the fleet row. |
| ⚑ COST/MO | **MISSING** | See 3.7. |
| ACTIONS | **HAVE** | `capabilities[]` → the repo *already* renders exactly `Sync`/`Rollback`/`Approve`/`Retry` from it. The design's `Promote` and `Roll back` are close; **`Promote` has no matching capability**. |
| Sync label `Drifted` | **HAVE (value) / naming conflict** | The enum is `out_of_sync`. The design ships **three spellings of one state**: `Drifted` (pill), `Out of sync` (facet chip), `3 OUT OF SYNC` (app-detail header). Pick one. |
| ⚑ Row model app → **app × target** | **DERIVABLE, high cost** | `targets[]` is real with per-target `health`. But it multiplies rows and breaks pagination arithmetic: `total` counts applications, `aria-rowcount={total+1}` and the `{loaded} loaded / {total} indexed` sentinel both assume 1 row = 1 app. **Deepest structural conflict in the design.** |
| Group-by + collapsible groups | **DERIVABLE** *(window)* | The server exposes `FleetGroupDimension` for **map/matrix only**, not for the applications list. Groups are client-side and window-limited. |
| Facet chips | **HAVE except one** | Health / sync / stage / source_type counts come from facets. ⚑ **`Blocked gate 2` is not a facet dimension** — `sum(blockedGateCount)` *(window)* only. |
| Treemap | **HAVE (data) / INCOMPATIBLE (rendering)** | `QueryFleetMap` with `sizeMetric: resource_count \| request_rate` is exactly right. But the design renders **one DOM tile per app**, which fails `fleet-scale.spec.ts` at 10k. See Risk 1. |
| Matrix | **HAVE — 1:1 mapping** | `QueryFleetMatrix{rows[], columns[], cells[]{applicationCount, targetCount, health[]}}` maps precisely onto the design's count + `N apps` + per-health pills. The design hardcodes columns=clusters, which is just `columns: "cluster"`. |
| Queue | **HAVE** | Server-ranked impact + derived reasons. Best-aligned presentation. |

### 3.4 Application detail

| Element | Verdict | Detail |
|---|---|---|
| Name, ns, `! DEGRADED`, `3 OUT OF SYNC` | **HAVE** | `health`, `driftCount` / `Application.outOfSync`. |
| ⚑ Tags `owner: payments-core`, `on-call: @rmoreau`, `tier: 1` | **MISSING** | No owner / team / tier fields. `Application.parameters: {[k]:string}` is a free map that *could* carry them, but nothing populates it. |
| Tags `helm · deploy/chart`, `prod-eu-1` | **HAVE** | `ApplicationSource{type, path}`, `currentClusterLabel`. |
| Sub-tabs Overview/Resources/Releases/Pipelines/Policy/Manifest | **HAVE (all six)** | `GetResourceTreeDetailed`, `ListReleases`, `GetPipeline`, `Application.policyResults` + `ListPolicies`, `Release.renderedManifestSnapshot`. The design leaves 5 of 6 **inert** — wiring them is a win, not a gap. |
| ⚑ Delivery timeline (6 phases, durations, detail, link) | **MISSING as one object / DERIVABLE with effort** | Pieces span 4 messages: `ApplicationSource` (source), `Pipeline.stepStatuses{startedAt, completedAt}` (build/test — durations are real), `Release.renderedManifestSnapshot` (render), `Release.promotionHistory` (deploy), `Rollout` + `AnalysisRun` (verify). Needs 3–4 RPCs and a phase-mapping convention that does not exist. |
| Resource graph / tree | **HAVE — fully** | `GetResourceTreeDetailed` → `ResourceTreeNode{kind, name, namespace, syncStatus, health, healthMessage, parentKind, parentName, uid, managed, phase, ready, total, message, containers[]}`. Every string the design's tree renders (`1/3 ready`, `CrashLoopBackOff · 12 restarts`, child counts, `Synced`/`Drifted`) is present. The hand-tuned x/y is a layout problem, not a data problem — dagre + xyflow already solve it. |
| ⚑ Drilldowns (Grafana / Loki / Tempo / Runbook / Owning team / Cost) | **MISSING** | `effectiveObservabilitySource` gives a `NamespacedKey`, **not a URL**. Runbook, team and cost have no representation. `+ Configure links` implies a settings surface that does not exist. |
| Gates & analysis | **HAVE** | `Application.gates[]: GateStatus{name, stage, status, approvedBy, type, message}` + `ListGateStatus`; mutations `ApproveGate` / `RejectGate` are real. `Application.analysisResults[]` + `ListAnalysisRuns`. The `Approve` / `View` buttons map to real RPCs. |
| Source card | **HAVE except one** | `repoUrl`, `path`, `type`, `revision`, `syncPolicy`, `strategy`. ⚑ **`Engine Helm 3.16` — the version is MISSING** (`type` is `"Helm"`). `Strategy canary 5/10/25/50/75/100` is **DERIVABLE** from `Rollout.canarySteps[].setWeight`. |
| Promotion stages (4 rings) | **HAVE** | `Application.stages[]: ApplicationStage{name, ring, phase, release, revision}` — including the release id `r241`. Relative time **DERIVABLE**. |
| Inspector: Diff / Live / Desired | **HAVE** | `GetResourceResponse{liveManifest, desiredManifest, diff}`. |
| Inspector: Events (`12 × · last 41s ago`) | **HAVE — exactly** | `KubernetesEvent{type, reason, message, lastTimestamp, count, involvedObjectKind, involvedObjectName}`. `count` + `lastTimestamp` is literally the design's format. |
| Inspector: Logs | **HAVE** | `StreamResourceLogs` (the **only** ServerStreaming RPC) → `LogChunk{podName, containerName, line, timestampMs}`. `resource-detail-panel.tsx` already implements it with backoff reconnect. |
| `Investigate` button | **HAVE** | `Investigate` → `InvestigateResponse{findings: InvestigationFinding[]{id, severity, title, description, evidence[], playbook[], narrator}}`. The design gives it one button; the repo has a 313-line panel. |
| `4 changed fields` | **DERIVABLE** | Parse `diff`; `summarizeUnifiedDiff` already exists. |
| ⚑ `drift detected 12m ago` | **MISSING** | No per-resource drift timestamp. `lastTransitionUnixMs` is application-level. |

### 3.5 Pipeline

Mostly **HAVE** — the best-backed detail screen.

- Header, DAG, step logs, artifacts, mutations: `GetPipeline` → `Pipeline{steps[]{name, image, script,
  depends[]}, stepStatuses[]{name, phase, startedAt, completedAt}, artifacts[], maxParallel, phase}`.
  ⚑ `depends[]` **is the edge list** — the DAG is fully derivable. `GetStepLogs(tailLines)` feeds the
  `<pre>`. `RetryStep` / `SkipStep` / `CancelPipeline` back `Retry step` / `Skip` / `Cancel run`.
- ⚑ `run #418 · push to main by @rmoreau · 9f3a1c2 "fix idempotent capture"` — run number **MISSING**,
  actor **MISSING**, **commit message MISSING**. No commit metadata exists anywhere in the proto; only
  revision hashes (`sourceRevision`, `revision`).
- Stats strip: `ELAPSED` **DERIVABLE** (`createdAt`/step timestamps), `STEPS 3/7` **DERIVABLE**
  (`stepStatuses` vs `steps`); ⚑ **`CACHE HIT 74%` MISSING**, ⚑ **`CPU-MIN 9.4` MISSING**, and the step
  meta `4 CPU / 8 GiB` **MISSING** (`Step` has `image` + `script` only).
- Artifacts: **HAVE** — `ArtifactRef{name, path, kind, reference, resolvedReference, digest, phase,
  producingStep, createdAt, failedReason}`. `phase` is free-form so it *could* carry `SIGNED`/`CLEAN`/
  `1 FLAKE`. ⚑ `84 MB` (size) and `412 components` are **MISSING**.

### 3.6 Rollout / Sync & diff / Fleet map

**Rollout**

- Header + traffic ladder + split bar — **HAVE**. `Rollout{phase, paused, currentStep, currentWeight,
  canarySteps[], stableRs, canaryRs, stableReadyReplicas, canaryReadyReplicas, replicas,
  currentStepStartedAt, trafficRouter}`. `STABLE 75% · checkout-api-6b9c · 6 pods` maps exactly onto
  `stableRs` + `stableReadyReplicas`; `istio VirtualService · checkout-api.payments.svc` onto
  `IstioRouterConfig{virtualService, hosts[]}`.
- Analysis table — **PARTIAL**. `RolloutAnalysisCheck{type, url, metric, threshold, windowSeconds,
  successThreshold, requestCount, timeoutSeconds}` gives METRIC + THRESHOLD (and the PromQL is
  `metric`). `AnalysisRunResult{name, passed, message, detail, checkedAt}` gives RESULT. ⚑ **BASELINE
  and CANARY observed values are MISSING as typed fields** — they exist only inside free-form
  `message`/`detail` strings.
- Explainer callout ("41% above baseline… 3 consecutive intervals") — **MISSING as structured data**;
  templatable over `AnalysisRunResult.message` at best.
- Rollout log (7 timestamped entries) — ⚑ **DERIVABLE, good match**: `Rollout.conditions[]:
  Condition{type, status, observedGeneration, lastTransitionTime, reason, message}` is exactly a
  timestamped event list. Design renders newest-first.
- Buttons: `Promote to 50%` **HAVE** (`PromoteRollout`), `Abort & roll back` **HAVE** (`AbortRollout`),
  ⚑ **`Hold` MISSING** — there is no pause RPC; `Rollout.paused` is read-only.

**Sync & diff workbench**

- Drift queue (kind / name / reason / field count) — **PARTIAL**. `Application.resources[]:
  ResourceSync{kind, name, namespace, status}` + `resourceHealth[]` give the object list and status;
  `outOfSync` and `prunedResources` counts are **HAVE**. ⚑ **The per-object changed-field count
  (`4`, `2`, `1`, `∅`) is MISSING** — it needs a `GetResource` per object and diff-hunk counting (N+1).
  ⚑ The `reason` strings ("2 keys changed outside Paprika", "annotation removed by controller",
  "maxReplicas drifted 12 → 20") are **MISSING** — those are *semantic interpretations* of a diff; the
  API returns raw unified diff text.
- Filter chips All/Drifted/Missing/Degraded/Pruned — **HAVE** (`ResourceSync.status`, `prunedResources`).
- Diff pane — **HAVE**. `GetResourceResponse.diff`; the repo's `parseUnifiedDiff` / `DiffLineRow` already
  map onto the design's `dl()` add/del/ctx.
- `Unified / Split / JSON patch` — Unified **HAVE**, Split **DERIVABLE** from the same text,
  ⚑ **JSON patch MISSING** (no patch representation on the wire).
- ⚑ **`Why this drifted` ("last written by `kubectl-client-side-apply` 12 minutes ago") — DERIVABLE**,
  and it is the **best original idea in the design**: `liveManifest` is a full manifest string, so
  `metadata.managedFields[].manager` + `.time` are parseable client-side. Genuinely implementable.
- `Sync 3 selected` — ⚑ **MISSING**. `SyncApplication` is application-scoped; there is no per-resource
  selective sync. `Ignore field` has no API. `Dry run` may be expressible via `Render`/`ApplyBundle`.

**Fleet map**

- Grid of clusters × stage/project — **HAVE** via `QueryFleetMatrix(rowGroup: stage|project,
  columnGroup: cluster)`; `FleetMatrixCell{applicationCount, targetCount, health[]}` feeds the summary
  `5 targets · 1 unhealthy` exactly.
- ⚑ But the design draws **one clickable square per application-target**, and the matrix returns
  **aggregates**. Individual squares require `QueryApplications` + client bucketing *(window)*, so the
  map **degenerates above 100 apps**.
- ⚑ Column meta `18 nodes · eu-west` — **MISSING** (same gap as board 06: no Cluster message).

### 3.7 Cross-cutting MISSING — the consolidated list

1. ⚑ **Cost, anywhere.** `grep -ci cost src/gen/paprika/v1/api_pb.d.ts` → **0**. Kills COST/MO, the
   cluster `$14.2k /mo`, the heat tooltip `$4.1k/mo`, and the `Cost — 30 day / $4,120` drilldown.
2. ⚑ **Cluster infrastructure.** No `Cluster` message at all — no node count, region, k8s version, pods.
3. ⚑ **Metrics / capacity.** No CPU/memory used-requested-allocatable, no latency, no error rate, no
   request rate per app. `requestRateWeight` is a treemap sizing weight on aggregate nodes only.
4. ⚑ **Source-trigger / webhook event feed** (board 05 entirely).
5. ⚑ **Rollout history** — completed rollouts, durations, outcomes, medians (Recent · 7d entirely).
6. ⚑ **Pipeline run history, test counts, cache-hit rate, CPU-minutes, per-step resources.**
7. ⚑ **Commit metadata** — author, message, run number.
8. ⚑ **Ownership metadata** — owner, on-call, tier, runbook, drilldown URLs.
9. ⚑ **Per-resource drift semantics** — changed-field counts, drift timestamps, human drift reasons.
10. ⚑ **Release identifiers on the fleet row** — `releaseState` is an enum; `r241` exists only on
    `ApplicationStage.release` / the legacy `Release` message.
11. ⚑ **The 6-phase lifecycle vector** per application (the LIFECYCLE strip + board 01).
12. ⚑ **Live push** — polling only, by design *and* asserted by e2e.
13. ⚑ **Mutations:** `Hold` rollout, `Ignore field`, JSON patch, per-resource selective sync.

### 3.8 HAVE-and-underused — the design's best-supported ideas

These are free wins where the design and the API already agree:

- ⚑ **`GetSystemStatus`** — health buckets + sync buckets + server-ranked attention window, with
  `attentionTotal` and `hasMoreAttention`. It is **never called anywhere in the UI today**, and it is
  precisely boards 02 + 03.
- `indexGeneration` → `gen 4412`. Real, honest, cheap.
- Facet buckets → scope-dropdown counts, with correct fleet-wide totals.
- `capabilities[]` → the ACTIONS column, already authorization-derived.
- `targets[]` → per-target heat tiles, promotion rings, the map squares.
- `QueryFleetMatrix` → the Matrix presentation *and* the fleet map, 1:1.
- `Rollout.canarySteps` + `currentStep`/`currentWeight` → the traffic ladder, 1:1.
- `Rollout.conditions[]` → the rollout log, 1:1.
- `GetResourceTreeDetailed` → the resource tree, 1:1 including `ready/total` and `message`.
- `KubernetesEvent.count` + `lastTimestamp` → `12 × · last 41s ago`, 1:1.
- `StreamResourceLogs` → the live log tab (already implemented).
- `ImpactKey` server ranking → "ranked by blast radius".
- `liveManifest` → `managedFields` → "Why this drifted".

---

## 4. FONT + ASSET NEEDS

### 4.1 Loading

Follow the existing convention exactly (`src/app/layout.tsx` uses `next/font/google` + CSS variables):

```tsx
import { Barlow, Barlow_Condensed } from "next/font/google"

const barlow = Barlow({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
})

const barlowCondensed = Barlow_Condensed({
  variable: "--font-barlow-condensed",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
})
```

Then `<html className={`${barlow.variable} ${barlowCondensed.variable} h-full antialiased`}>` — note the
`dark` class and `style={{colorScheme:"dark"}}` come off at the same time.

Weight sets are the **helmet's superset** (`console.dc.html` L13), **not** the `styles.css` `@import`
subset — the helmet adds Barlow 600 and Barlow Condensed 500 + 700, all of which are used.

### 4.2 Three decisions worth stating

1. ⚑ **Do not copy the design's `<link href="fonts.googleapis.com">` + `preconnect`.** `next/font/google`
   self-hosts at build time into `/_next/static/media`, which respects `basePath` (`/paprika` on the
   GH-Pages build) and works in air-gapped installs. A control plane should not make third-party runtime
   font requests.
2. ⚑ **Delete `JetBrains_Mono`.** The design's mono is deliberately the **system stack**
   (`ui-monospace, SFMono-Regular, Menlo, monospace`). Set `--font-mono` to that literal string in
   `@theme` — one fewer webfont, and `font-mono` keeps working across the ~40 files that use it for
   eyebrows, identity strings and tabular numbers. Metrics will shift on every one of those; that is
   intended by the design.
3. ⚑ **`--font-cond`** is the clean mapping of the design's `.cond` helper class. Register it in `@theme`
   so it becomes a `font-cond` utility; do **not** recreate `.mono`/`.cond` as global classes.

### 4.3 Non-font assets

- **None.** No images, no logo files (the design drops the `P` logo tile entirely for a wordmark).
- **Icons:** `lucide-react ^1.17.0` is already a dependency and covers all 23 keys in the design's
  `LUCIDE` map. ⚑ The design renders at **14px with `stroke-width: 1.5` and round caps/joins**;
  `lucide-react` defaults to 24px / stroke 2. Set this once via a wrapper or an
  `[&_svg:not([class*='size-'])]:size-3.5` + `[&_svg]:stroke-[1.5]` rule on the shell.
- ⚑ **Status glyphs `✓ ↻ ! × ∅ ? ·` are text characters, not icons.** No asset, but **verify Barlow has
  U+2205 (∅) and U+21BB (↻)** — if not, the chip needs a `font-family: system-ui` fallback so it does not
  render tofu. This is a concrete pre-flight check.
- `@keyframes blip` goes in `globals.css` + `--animate-blip` in `@theme`. It must respect the existing
  `@media (prefers-reduced-motion: reduce)` block (the e2e has a `chromium-reduced-motion` project).

---

## 5. RISK LIST

Ordered by likelihood × blast radius.

1. ⚑ **`e2e/fleet-scale.spec.ts` will fail if the treemap is ported literally.** It asserts, at 10,000
   applications: `treemapDOM.canvasCount === 1`, `presentationControllerCount === 1`,
   **`applicationNodeCount === 0`**, **`descendantElementCount < 200`** ("the Canvas presentation must
   keep its DOM bounded independently of fleet size"), initial p95 < 2000 ms, switch p95 < 250 ms.
   The design's Treemap is a `flex-wrap` of **one DOM tile per application**.
   **Mitigation: keep `fleet-treemap.tsx` canvas-based; port only the palette and typography into the
   paint routine.** This is why `status-tone.ts` must exist as TS, not only as CSS vars.
   The same budget threatens the design's **heatmap** (one tile per *target*) and **fleet map**
   (one square per target) — both are unbounded DOM. Cap or virtualise them.

2. ⚑ **`e2e/fleet-console.spec.ts` (6 tests, 3 browser projects, runs in CI on every PR) asserts on
   accessible names the design deletes or renames.** Contractual today:
   - `heading level 1 "Applications"` (survives).
   - `navigation "Fleet sections"` containing **exactly 5 links** with exact hrefs *including trailing
     slashes*: `/dashboard/`, `/dashboard/applications/`, `/dashboard/#pipelines`,
     `/dashboard/#releases`, `/dashboard/rollouts/`. The design ships **9 items** in FLEET / DELIVERY /
     SOURCES, drops `Releases`, and adds 3 stubs. **Breaks.**
   - `Activity` / `Admin` must be **disabled buttons** with `aria-disabled="true"` +
     `title="Available in a later plan"` and **no link of that name**. The design removes both.
     **Breaks** — and note the design's honesty posture is *worse* (3 nav stubs that silently reroute,
     5 inert app-detail tabs), so this is worth pushing back on.
   - `summary "Filter dimensions"` + `checkbox "Project team-00/payments"` — the design replaces the
     18-option checkbox panel with 6 hard-coded chips. **Breaks.**
   - `searchbox "Search applications"`, `table "Applications"`, `table "Fleet matrix"`,
     `application "Fleet treemap"`, `button "Show Matrix view"` / `"Show Table view"`,
     `button "Load 100 more applications"`, sentinel `100 loaded / 250 indexed`,
     `region "Highest impact attention"` (design renames to `Needs attention` — **breaks**),
     `text "Current Phase"` on app detail (design deletes the KPI tile — **breaks**),
     `/dashboard#applications` → `/dashboard/applications/` redirect.
   **Budget a full rewrite of both e2e specs, and treat every renamed label as a deliberate edit.**

3. ⚑ **The app×target row model breaks two pagination contracts.**
   `aria-rowcount={Number(total)+1}` and `` `${loaded} loaded / ${total} indexed` `` both assume
   1 row = 1 application; `total` is an application count. Making rows per-target invalidates both, plus
   the cursor arithmetic in `fleet-pages.ts` and the `loadMore` append in `use-fleet-data.ts`.
   **Recommendation: keep 1 row = 1 app in scopes A and B.**

4. **Unit tests that assert on markup the redesign replaces** (35 files total; `css: false` in
   `vitest.config.mts` means **nothing asserts on styles — pure restyling is test-safe**, but structure
   and label changes are not): `fleet-view.test.tsx` (680), `resource-detail-panel.test.tsx` (388),
   `app-shell.test.tsx` (282), `fleet-filters.test.tsx` (274), `fleet-treemap.test.tsx` (229),
   `fleet-overview.test.tsx` (198), `dashboard-command-center.test.tsx` (150), `fleet-matrix.test.tsx`,
   `sync-diff-workbench.test.tsx`, `investigation-triage.test.tsx`, `dashboard-refresh.test.tsx`,
   `application/page.test.tsx`. Preserved for free: `fleet-query.test.ts`, `fleet-client.test.ts`,
   `fleet-pages.test.ts`, `fleet-focus.test.ts`, `fleet-refresh.test.ts`, `use-fleet-data.test.tsx`,
   `treemap-layout.test.ts`, `treemap-navigation.test.ts` — **the entire data layer is untouched.**

5. **Large components that must be rewritten** — ~5,600 lines across 11 files:
   `application/page.tsx` (786), `fleet-filters.tsx` (786), `dashboard-command-center.tsx` (668),
   `resource-detail-panel.tsx` (553), `dashboard/page.tsx` (478), `fleet-treemap.tsx` (454),
   `sidebar.tsx` (442), `fleet-view.tsx` (391), `application-table.tsx` (372),
   `fleet-overview.tsx` (344), `rollouts/detail/page.tsx` (314).

6. **The dark → light inversion touches every one of the 49 `"use client"` components.** Specific traps:
   the `bg-destructive/10 text-destructive` tinted-button idiom reads wrong on white; the
   `ring-1 ring-foreground/10` card treatment becomes a near-black hairline; `status-badge.tsx` reaches
   outside the palette into raw `blue-500` / `orange-400`; `fleet-treemap.tsx` has its own literal
   **dark** `HEALTH_STYLE` hex map (lines 40–51) that must be replaced wholesale.

7. **`--radius: 0` invalidates the primitives.** `badge.tsx` is `rounded-4xl` with a fixed `h-5`;
   `button.tsx` is `rounded-lg` with `active:scale-[0.96]` and `focus-visible:ring-3`. The design has
   square, hairline-bordered 21–32px buttons with **no hover and no focus ring on the search input**.
   ⚑ **Do not port `:focus { outline: none }`** — keep `:focus-visible`, or the header search becomes
   keyboard-invisible.

8. ⚑ **Touch targets regress from 44px to 18–32px.** The repo uses `min-h-11` deliberately in 12 places.
   Nothing in the design reaches 44px: nav 29px, section chevron 22×22, group chevron 20×20, tree
   expander 18×18, action pill 21px, map square 18×18. Combined with the loss of `<label>` / `<legend>` /
   `<input type="checkbox">` semantics (Risk 2), this is a **material a11y regression requiring explicit
   product sign-off**, not a silent port. The `chromium-keyboard-only` e2e project will exercise it.

9. **Static-export constraints bind the two net-new routes.** `output: "export"` + `trailingSlash: true`:
   no route handlers, no middleware, no server data fetching. `/dashboard/diff/` and `/dashboard/map/`
   must read identity from `?namespace=&name=` inside `<Suspense>` (the existing house pattern) and every
   data component must be `"use client"`.

10. **Promoting `ScopeBar` to a real global scope is a state-architecture change.** `FleetQueryState`
    lives in the URL on `/dashboard/applications` only. A global header scope means
    `parseFleetQuery`/`serializeFleetQuery`/`reconcileFleetQuery` move up into `AppShell` and apply on
    `/dashboard`, `/dashboard/application`, `/dashboard/map` and `/dashboard/diff` too — including
    `fleet-view.tsx`'s `router.replace(..., {scroll:false})` reconciliation loop and the
    `react-hooks/set-state-in-effect` disable at `fleet-view.tsx:118`. `fleet-query.test.ts` survives
    unchanged (it tests pure functions), which is the saving grace.

11. ⚑ **`live · 12s` is a claim the app cannot make.** `fleet-console.spec.ts` ships an **auto-fixture
    that fails the entire suite if `/events` is ever requested**, and the Go fixture serves 404 there.
    Implementing a "live" indicator that implies streaming is both dishonest and test-breaking.

12. **`framer-motion`, `@xyflow/react` and `@dagrejs/dagre` become partly redundant.** The design has no
    motion vocabulary (`blip` only — it even drops the `spin` on in-progress work) and hand-places graph
    nodes. Dropping xyflow loses zoom/pan/fit for free and requires deleting the `vi.mock("@xyflow/react")`
    setups in `pipeline-dag.test.tsx` and `resource-graph.test.tsx`; keeping it means restyling its nodes
    and hiding its controls. **Recommendation: keep xyflow + dagre, restyle.**

13. **Design-internal inconsistencies not to reproduce**: posture divides by a hard-coded `57` while
    `APPS.length` is 16; `recentStats.total` is 11 against 6 rendered rows; the diff sub-header says
    "2 additions · 2 removals" while 4+4 render; `hint-placeholder-count="16"` against 18 diff lines;
    the group meta never pluralises "apps" (`1 apps`); the rollout-log glyph column is 14px for a 16px
    chip. All fixture artefacts — derive, do not transcribe.

---

## 6. SCOPE OPTIONS

### Option A — "Skin" (minimal)

**Ships:** the complete design-system inversion plus the two chrome surfaces, nothing else.

- `globals.css`: all tokens from §2.2 (remapped semantics, hairline ladder, 2 ramps, surfaces, inverted
  family, **21 status-tone vars**, diff colours, 5 shadows, named type scale, `--radius: 0`, `blip`,
  `.blueprint`/`.corner` CSS).
- `layout.tsx`: Barlow + Barlow Condensed, JetBrains Mono removed, `dark` lock removed.
- New primitives: `status-tone.ts`, `status-chip`, `status-pill`, `blueprint`, `seg`, `input`, `kicker`.
  Modified: `button`, `badge`, `status-badge` (remapped to the 7 tones).
- `sidebar.tsx` rebuilt as the 206px navy slab — ⚑ **keeping the existing 5 nav items, exact hrefs, and
  the disabled `Activity`/`Admin` buttons** so `fleet-console.spec.ts` test 1 still passes.
- `scope-bar.tsx` → `header.tsx`: 42px, 3 scope dropdowns **wired to real facet buckets**, clear button,
  inline search bound to `q`, `gen {indexGeneration}`, and a **poll-cadence** indicator (not `live · 12s`).
- `application-table.tsx` restyled to the new column look, **keeping 6 columns and 1 row = 1 app**.
- `fleet-treemap.tsx` canvas repainted with the new tones. `fleet-states.tsx` restyled, copy verbatim.

**Files:** ~22 touched (2 config, 1 globals, ~9 primitives, ~6 layout/fleet components, ~4 test updates).
**Zero route changes.**

**Does NOT include:** the 6-board overview, Matrix/Queue/Treemap redesign, app detail, pipeline, rollout,
sync & diff, fleet map, app×target rows, lifecycle strip, cost, capacity, ⌘K palette.

**Risk:** low. `fleet-scale.spec.ts` untouched; `fleet-console.spec.ts` needs only additive checks.
**Independently shippable and visually transformative** — this is where ~80% of the perceived redesign lives.

---

### Option B — "Fleet console" ⭐ RECOMMENDED

**A, plus every surface the API can honestly feed.**

- **Overview** rebuilt as boards, with two dropped:
  - Board 02 Health posture wired to **`GetSystemStatus`** (first use of that RPC) — bars *and* a
    bounded heatmap.
  - Board 03 Needs attention wired to server-ranked impact, with **derived** Queue-style reasons.
  - Board 01 Lifecycle reduced to the phases real facets support (source-type, release, rollout,
    gates), dropping the invented test/cache/run-count subs.
  - Board 04 Rollouts, In-flight tab only, from `ListRollouts` + `ListAnalysisRuns`.
  - ⚑ **Board 05 Source triggers and Board 06 Clusters · capacity are dropped as un-backed** (§3.2).
  - Customise / hide / collapse mode kept — it is pure client state and cheap.
- **Applications**: 7 real columns (APPLICATION / PROJECT / TARGET / HEALTH / SYNC / RES / ACTIONS),
  ⚑ **no COST/MO, no LIFECYCLE strip**; group-by + collapsible groups; the new Matrix mapped straight
  onto `QueryFleetMatrix`; the new Queue; treemap **kept on canvas**; facet chips driven by real facet
  counts. Row model stays 1 row = 1 app.
- **App detail** rebuilt: header slab, ⚑ **all six sub-tabs wired rather than inert**, the resource Tree
  from `GetResourceTreeDetailed` alongside the restyled xyflow graph, Gates & analysis with real
  `ApproveGate`/`RejectGate`, Source card, Promotion stages from `ApplicationStage[]`, and the inspector
  drawer restyled onto the existing 553-line panel. ⚑ **No Drilldowns rail, no Delivery timeline.**
- **Rollout detail** rebuilt: traffic ladder (`canarySteps` + `currentWeight`), analysis table with real
  metric/threshold/result and baseline/canary parsed from `AnalysisRunResult.message`, rollout log from
  `Rollout.conditions[]`. ⚑ **No Recent · 7d tab.**
- **Pipeline detail** restyled: DAG node treatment, step card, artifacts list, stats strip limited to
  `ELAPSED` + `STEPS n/m`. ⚑ **No cache-hit, no CPU-min, no commit metadata.**
- **Net-new `/dashboard/diff/`**: two-pane workbench reusing `sync-diff-view.tsx`'s parser, plus
  ⚑ **"Why this drifted" built from `managedFields` in `liveManifest`** — the design's best original idea.
- **Net-new `/dashboard/map/`**: `QueryFleetMatrix` grid with bounded per-cell squares.
- Delete the dead code (`landing/*`, `application-card`, `release-table`, `notification-center`).

**Files:** ~55–65 touched, ~8 net-new, ~10 deleted. Both e2e specs rewritten. ~12 unit test files updated.
Partitionable into 5 PRs by route after A lands.

**Does NOT include:** cost anywhere, cluster capacity meters, source triggers, rollout history, the
6-phase lifecycle strip, drilldown links, owner/on-call/tier tags, per-resource changed-field counts,
the ⌘K palette, the app×target row model, dark mode.

---

### Option C — "Full design" (complete)

**B, plus everything the design draws — which requires backend work, not just UI work.**

Adds board 01's true lifecycle vector, board 05 source triggers, board 06 capacity meters, COST/MO, the
LIFECYCLE strip, the app×target row model (with pagination and `aria-rowcount` re-contracted), the full
heatmap with edge-aware tooltips and settings popover, the Delivery timeline, Drilldowns +
`+ Configure links`, the Recent·7d rollout history, pipeline cache/CPU-min/commit metadata,
`Hold`/`Ignore field`/`JSON patch`/selective sync, the ⌘K palette, and the SOURCES nav section.

⚑ **Requires proto + Go changes** — roughly 7 new message families and 5–8 new RPCs:
a `Cluster` message (nodes / region / version / pods); a metrics-or-capacity surface (or a Prometheus
proxy RPC); a cost attribution source; a source-event / trigger feed; a rollout-history archive; a
per-application lifecycle-phase vector; commit metadata on the source; per-resource drift field counts;
and `HoldRollout` / selective-sync mutations.

**Files:** ~90+ in `ui/`, plus `proto/` and `internal/` work of comparable size. Multi-quarter.

**Does NOT include:** dark mode (the design has none).

---

### Recommendation

**Ship A first as a standalone PR, then B as 4–5 route-partitioned follow-ups.** Two amendments to B:

1. ⚑ **Keep the canvas treemap and the 1-row-per-app model** to protect the `fleet-scale.spec.ts`
   performance contract and the pagination arithmetic. Apply the same bounded-DOM discipline to the
   heatmap and the fleet map.
2. ⚑ **Get explicit sign-off before starting** on the deliberate drops the design has already made
   implicitly: cost, cluster capacity, source triggers and the lifecycle strip (no data); the Releases,
   Activity and Admin nav items and the sign-out control (product); and the a11y regressions — 44px
   touch targets, the checkbox facet panel, `<label>`/`<legend>` semantics, and focus rings. These are
   product decisions, not implementation details, and they are cheaper to settle now than to re-litigate
   mid-build.

Do **not** attempt C without the proto work landing first — roughly a third of what the design draws is
not data the control plane currently possesses.
