# console.dc.html — script block spec (lines 1281–2004)

Source: `/private/tmp/claude-501/-Users-benebsworth-projects-paprika/844ad4e2-4dd2-4687-a932-9e099bcf1f1c/scratchpad/design/console.dc.html`
All line numbers below refer to that file. Everything here is transcribed from the file; nothing is invented.
Template line numbers (9–1280) are cited only where they show *which element* fires a handler.

---

## 1. `data-props` on the `<script>` tag (line 1281)

```jsonc
{
  "$preview":  { "width": 1440, "height": 1000 },

  "density": {
    "editor":  "enum",
    "options": ["compact", "comfortable"],
    "default": "compact",
    "tsType":  "\"compact\" | \"comfortable\"",
    "section": "Table"
  },

  "showLifecycleStrip": {
    "editor":  "boolean",
    "default": true,
    "tsType":  "boolean",
    "section": "Table"
  },

  "statusPalette": {
    "editor":  "enum",
    "options": ["colour", "quiet"],
    "default": "colour",
    "tsType":  "\"colour\" | \"quiet\"",
    "section": "Status"
  }
}
```

Consumption inside `renderVals()` (lines 1416–1419):

| Prop | Read as | Effect |
|---|---|---|
| `statusPalette` | `const T = tones(this.props.statusPalette ?? "colour")` | swaps ONLY the `healthy` tone (see §4.1) |
| `density` | `const dense = (this.props.density ?? "compact") === "compact"; const rowH = dense ? 42 : 52;` | `rowH` px is applied to inventory-table rows and Queue-view rows only (lines 1683, 1732). Nothing else changes. |
| `showLifecycleStrip` | `const showStrip = this.props.showLifecycleStrip ?? true` | when false the per-row 6-cell lifecycle strip array is emitted as `[]` (line 1684) |

Artboard preview canvas = **1440 × 1000**.

---

## 2. Design tokens declared in the script (lines 1282–1286)

```js
PAPER  = "#f2f2f3"   INK    = "#1d1f20"   MUTED = "#5d5d60"   FAINT  = "#7a7a7d"   // FAINT is declared but never used
DIV    = "rgba(29,31,32,0.16)"            DIV2  = "rgba(29,31,32,0.10)"
STEEL  = "#5980a6"   STEEL_D = "#416180"  STEEL_9 = "#1d2d3d"
OCHRE  = "#b07a2c"   OCHRE_T = "#8a5f22"  // both declared but never used (the same hex is re-typed literally in tones())
OXIDE  = "#a8443b"   OXIDE_T = "#8e372f"
GREEN  = "#7fae86"   GREEN_T = "#3f6b48"
```

Usage counts inside the script: `OCHRE`/`OCHRE_T`/`FAINT` = declaration only (dead). `OXIDE` = selected-graph-node border. `OXIDE_T` = failing source-trigger tag + failing canary metric value. `STEEL_9` = heat-tile tooltip background.

---

## 3. State model — `class Component extends DCLogic` (lines 1400–1414)

### 3.1 Initial state (lines 1401–1403), verbatim

```js
state = {
  screen: "overview",
  view: "Table",
  panel: null,
  panelTab: "Diff",
  resourceView: "graph",
  collapsed: {},
  treeClosed: {},
  groupBy: "project",
  groupClosed: {},
  scope: { project: "All", cluster: "All", stage: "All" },
  openScope: null,
  mapRowsBy: "stage",
  customising: false,
  hiddenBoards: {},
  postureFormat: "heatmap",
  rolloutTab: "inflight",
  hoverTile: null,
  heatGroup: "project",
  heatDetail: "full",
  heatSettingsOpen: false
};
```

### 3.2 What each key controls

| Key | Type / domain | Initial | Controls |
|---|---|---|---|
| `screen` | `"overview" \| "applications" \| "appDetail" \| "pipeline" \| "rollout" \| "diff" \| "map"` | `"overview"` | which top-level screen renders (`isOverview` … `isMap`, line 1959–1961). Also drives nav highlight via `activeKey`. |
| `view` | `"Treemap" \| "Matrix" \| "Table" \| "Queue"` | `"Table"` | presentation of the Applications screen (`isTable`/`isTreemap`/`isMatrix`/`isQueue`, line 2001) |
| `panel` | `string \| null` — value is `"<KIND> <name>"` | `null` | resource side-panel. Truthy ⇒ `panelOpen`. Split on first space into `panelKind` / `panelName` (lines 1985–1987). |
| `panelTab` | `"Diff" \| "Live" \| "Desired" \| "Events" \| "Logs"` | `"Diff"` | side-panel body. `panelIsManifest = tab === "Live" \|\| tab === "Desired"` (line 1992). |
| `resourceView` | `"graph" \| "tree"` | `"graph"` | app-detail resource section. Combined with the section collapse: `isGraphView = rv==="graph" && sec.graph.open` (line 1983). |
| `collapsed` | `Record<sectionId, true>` | `{}` | per-section collapse; `open = !collapsed[id]` (line 1405). 12 section ids (§4.10). |
| `treeClosed` | `Record<nodeId, boolean>` | `{}` | resource-tree node collapse. Node ids: `app, dep, rs, svc, ing, cm, sec, p1, p2, p3`. |
| `groupBy` | `"none" \| "project" \| "cluster" \| "stage"` | `"project"` | grouping of the Applications inventory / treemap; also flips Matrix row axis. |
| `groupClosed` | `Record<groupKey, boolean>` | `{}` | collapse per inventory group header |
| `scope` | `{ project: string; cluster: string; stage: string }` | all `"All"` | global scope filter bar; filters `scopedApps` |
| `openScope` | `"project" \| "cluster" \| "stage" \| null` | `null` | which scope dropdown is open |
| `mapRowsBy` | `"stage" \| "project"` | `"stage"` | Fleet-map row axis |
| `customising` | `boolean` | `false` | overview "Customise" mode: shows the dashed BOARDS bar + per-board eye-off hide buttons |
| `hiddenBoards` | `Record<boardId, boolean>` | `{}` | which of the 6 overview boards are hidden |
| `postureFormat` | `"bars" \| "heatmap"` | `"heatmap"` | Health-posture board format |
| `rolloutTab` | `"inflight" \| "recent"` | `"inflight"` | Rollouts board tab |
| `hoverTile` | `string \| null` — `"<groupKey>:<appName>:<cluster>"` | `null` | which heat tile shows its tooltip |
| `heatGroup` | `"none" \| "project" \| "cluster" \| "stage"` | `"project"` | heatmap grouping |
| `heatDetail` | `"full" \| "name" \| "compact"` | `"full"` | heat-tile size/content |
| `heatSettingsOpen` | `boolean` | `false` | heatmap cog popover |

### 3.3 Undeclared (lazily added) state

Set only by the heat-tile `enter` handler (lines 1602–1615) — **not** present in the initial state object:

| Key | Type | Default when absent | Purpose |
|---|---|---|---|
| `hoverSide` | `"left" \| "right"` | treated as `"left"` | which edge the tooltip anchors to |
| `hoverShift` | `number` (px) | `0` (`this.state.hoverShift \|\| 0`) | `translateX` nudge to keep the tip inside the section |
| `hoverMaxW` | `number` (px) | `270` (`this.state.hoverMaxW \|\| 270`) | tooltip width |

Note: `leave` only clears `hoverTile`; the three hover-geometry keys are left stale.

### 3.4 Class methods

**`go(s)` (line 1404)** — returns a handler:
```js
go(s) { return () => this.setState({ screen: s, panel: null, openScope: null }); }
```
Navigating always closes the resource panel and any open scope dropdown.

**`section(id)` (lines 1405–1414)** — returns `{ open, toggle, btnStyle, chevron }`:
- `open = !this.state.collapsed[id]`
- `toggle` flips `collapsed[id]`
- `btnStyle` = `display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px; border:1px solid rgba(29,31,32,0.16); background:#fff; border-radius:2px; padding:0; cursor:pointer; color:#5d5d60; transform:rotate(<0 | -90>deg); transition:transform .15s;`
- `chevron = icon("chevron", 12)`

---

## 4. Colour / tone system

### 4.1 `tones(palette)` (lines 1288–1303) — the `statusPalette` branch

```js
const ok = palette === "quiet"
  ? { c: "#4a4a4c", line: "#a8a8ab", fill: "#f0f0f2" }
  : { c: GREEN_T /*#3f6b48*/, line: GREEN /*#7fae86*/, fill: "#e6f2e8" };
```
`ok` is spread into `healthy` **after** `glyph`/`label`, so only `healthy` differs between the two palettes. Every other status is identical in both.

| key | glyph (char / codepoint) | label | `c` (text) | `line` (border) | `fill` (bg) |
|---|---|---|---|---|---|
| `healthy` (colour) | `✓` U+2713 | `Healthy` | `#3f6b48` | `#7fae86` | `#e6f2e8` |
| `healthy` (quiet) | `✓` U+2713 | `Healthy` | `#4a4a4c` | `#a8a8ab` | `#f0f0f2` |
| `progressing` | `↻` U+21BB | `Progressing` | `#2c455d` | `#8bb0d0` | `#e7f0f8` |
| `degraded` | `!` | `Degraded` | `#8a5f22` | `#e0ad66` | `#fdf2df` |
| `failed` | `×` U+00D7 | `Failed` | `#9c3f39` | `#dd9490` | `#fbe9e8` |
| `missing` | `∅` U+2205 | `Missing` | `#5b5468` | `#aea8bd` | `#efedf4` |
| `unknown` | `?` | `Unknown` | `#5d5d60` | `#c2c2c6` | `#f4f4f6` |
| `pending` | `·` U+00B7 | `Pending` | `#8e8e92` | `#d4d4d7` | `transparent` |

Practical effect of `quiet`: green disappears from the whole console — healthy chips/pills/bars/tiles/heat-mix segments go neutral grey; the alert colours (blue/amber/red/violet) stay.

### 4.2 `chip(t)` (lines 1305–1307) — the 16px status glyph square
```
display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; flex:none;
border:1px solid {t.line}; background:{t.fill}; color:{t.c}; font-size:10px; font-weight:700; line-height:1;
```

### 4.3 `pill(t, label)` (lines 1308–1310) — status pill. (`label` param is declared and never used.)
```
display:inline-flex; align-items:center; gap:5px; border:1px solid {t.line}; background:{t.fill};
border-radius:2px; padding:1px 7px; font-size:10px; font-weight:600; letter-spacing:0.04em;
text-transform:uppercase; color:{t.c};
```

### 4.4 `bar(tone)` (line 1467) — lifecycle micro-bar: `flex:1; height:5px; background:{tone};`

### 4.5 `mixSeg(frac, tone)` (line 1520) — `flex:{frac}; background:{tone};`

### 4.6 `mixBar(list)` (lines 1521–1524) — health distribution bar
Iterates statuses in the fixed order **`failed, missing, degraded, progressing, unknown, healthy`**; for each, `n = count in list`; emits `flex:{n}; background:{T[k].line};` when `n > 0`, else the sentinel `display:none;` which is then filtered out. So the bar is always ordered worst→best, weighted by count.

### 4.7 `ladderStep(w, state, h)` (lines 1493–1496) — canary ladder segment. **`w` is unused.**
```
flex:1; height:{h}px; border:1px solid {t.line}; background:{state === "pending" ? "transparent" : t.fill};
```

### 4.8 `trigTag(c)` (line 1508)
```
display:inline-flex; align-items:center; justify-content:center; height:17px; border:1px solid rgba(29,31,32,0.16);
background:#f5f5f8; border-radius:2px; font-family:ui-monospace,monospace; font-size:9px; letter-spacing:0.06em; color:{c};
```

### 4.9 `usage(label, used, req, alloc, unit)` (lines 1525–1533) — cluster capacity meter
```js
const up = used / alloc, rp = req / alloc, hot = rp > 0.85;
```
Returns:
- `usedPct` = `Math.round(up*100) + "%"`, `reqPct` = `Math.round(rp*100) + "%"`
- `text` = `` `${used} / ${req} / ${alloc} ${unit}` `` (used / requested / allocatable)
- `trackStyle` = `position:relative; height:9px; margin-top:4px; background:#e7e7ea; border:1px solid rgba(29,31,32,0.16);`
- `usedStyle` = filled bar, `width:{(up*100).toFixed(1)}%`, `background:{hot ? "#e0ad66" : "#5980a6"}`
- `reqStyle` = 2px request marker, `left:{(rp*100).toFixed(1)}%; top:-3px; bottom:-3px; background:{hot ? "#9c3f39" : "#1d1f20"}`
- `reqPctStyle` = mono 9px, `color:{hot ? "#9c3f39" : "#8e8e92"}`, `font-weight:{hot ? 700 : 400}`

With the literal cluster data, only **prod-us-1 CPU** is hot (78.1/88 = 0.8875). prod-eu-1 CPU is exactly 0.85 → not hot.

### 4.10 Section ids driving `sec` (line 1770)
`["lifecycle","posture","attention","inflight","triggers","clusters","timeline","graph","drill","gates","source","promotion"]` → `sec[id] = this.section(id)`.

### 4.11 Segmented-control style helpers
- `miniSeg(on, first)` (line 1569): `display:inline-flex; align-items:center; border:0; {first ? "" : "border-left:1px solid rgba(29,31,32,0.16);"} padding:0 9px; height:100%; font:inherit; font-size:10.5px; font-weight:600; cursor:pointer; background:{on ? #5980a6 : transparent}; color:{on ? #f2f2f3 : #5d5d60}; white-space:nowrap;`
- `segOpt(on, first)` (line 1765): same shape, `padding:0 9px; font-size:11px` (no `font-weight`).
- `facetChip(on)` (line 1653): `border:1px solid {on ? #5980a6 : rgba(29,31,32,0.16)}; background:{on ? "#eef6ff" : "#fff"}; border-radius:2px; padding:3px 9px; font:inherit; font-size:11px; color:{on ? "#2c455d" : "#5d5d60"}; cursor:pointer;`
- `sq(st)` (line 1932) — fleet-map app square: `display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; border:1px solid {T[st].line}; background:{T[st].fill}; color:{T[st].c}; font-size:10px; font-weight:700; cursor:pointer;`

---

## 5. Static datasets

### 5.1 `APPS` (lines 1313–1330) — the single source of truth, 16 target rows

```ts
interface App {
  name: string;            // 11 distinct application names
  ns: string;              // payments | platform | search | web | data
  project: string;         // payments/core | payments/risk | platform/shared | web/storefront | data/analytics
  health: "healthy" | "progressing" | "degraded" | "failed" | "missing" | "unknown";
  sync: "synced" | "out of sync";
  cluster: "prod-eu-1" | "prod-us-1" | "staging-1";
  env: "prod" | "staging" | "dev";
  ring: 0 | 1 | 2 | 3;
  res: number;             // managed resource count
  cost: string;            // "$4.1k"
  actions: string[];       // ["Sync"], ["Promote"], ["Sync","Roll back"], ["Approve"], ["Sync","Retry"]
  strip: ("ok"|"fail"|"degraded"|"run"|"pend")[];  // exactly 6 entries, one per lifecycle phase
  stage: string;           // DERIVED by .map(): `${env} · ring ${ring}`
}
```
`const OK6 = ["ok","ok","ok","ok","ok","ok"];` (line 1312) is reused by 10 rows.

Representative rows verbatim:
```js
{ name: "checkout-api", ns: "payments", project: "payments/core", health: "degraded", sync: "out of sync",
  cluster: "prod-eu-1", env: "prod", ring: 2, res: 14, cost: "$4.1k",
  actions: ["Sync", "Roll back"], strip: ["ok","ok","fail","ok","ok","degraded"] }

{ name: "reporting-etl", ns: "data", project: "data/analytics", health: "missing", sync: "out of sync",
  cluster: "prod-us-1", env: "staging", ring: 1, res: 6, cost: "$2.4k",
  actions: ["Sync"], strip: ["fail","pend","pend","pend","pend","pend"] }
```

Full name list (16 rows): checkout-api ×2 (prod-eu-1 degraded, staging-1 healthy), payments-gateway ×2, ledger-worker ×1 (progressing), fraud-scorer ×2, notifications ×1 (degraded), auth-service ×2, search-indexer ×1, web-frontend ×2 (prod healthy, staging progressing), cms-preview ×1, reporting-etl ×1 (missing), warehouse-sync ×1.
Health census over APPS: healthy 11, degraded 2, progressing 2, missing 1. (Note the header copy and the `posture` board quote a *different*, larger fleet — 57 applications — that is not derived from APPS.)

`const HEALTH_RANK = { failed: 0, missing: 1, degraded: 2, progressing: 3, unknown: 4, healthy: 5 };` (line 1331) — used for worst-first sorting and for `bad = rank < 3` (i.e. failed/missing/degraded count as "unhealthy"; progressing does not).

### 5.2 `GRAPH` (lines 1333–1344) — 10 absolutely-positioned resource-graph nodes
```ts
interface GraphNode { kind: string; name: string; x: number; y: number; w: number; badge: string; state: StatusKey }
```
```js
{ kind: "APPLICATION", name: "checkout-api",      x: 16,  y: 170, w: 170, badge: "r241",  state: "degraded" }
{ kind: "POD",         name: "…7d4f-m4p1",        x: 706, y: 132, w: 118, badge: "CLB",   state: "failed" }
```
Others: DEPLOYMENT checkout-api (246,40,170,"1/3",degraded), SERVICE checkout-api (246,150,170,"",healthy), CONFIGMAP checkout-api-env (246,220,170,"drift",degraded), SECRET checkout-api-tls (246,280,170,"",healthy), REPLICASET checkout-api-7d4f (476,40,170,"",progressing), INGRESS checkout-api (476,150,170,"",healthy), POD …7d4f-x9k2 (706,12,118,"",healthy), POD …7d4f-p2vn (706,72,118,"",healthy).

### 5.3 `TREE` (lines 1346–1363) — nested resource tree, root `checkout-api`
```ts
interface TreeNode { id: string; kind: string; name: string; st: StatusKey;
                     sync: "Synced" | "OutOfSync"; meta: string; children?: TreeNode[] }
```
```js
{ id: "app", kind: "Application", name: "checkout-api", st: "degraded", sync: "OutOfSync",
  meta: "release r241 · 14 managed", children: [ …dep, …svc, …cm, …sec ] }
{ id: "p3", kind: "Pod", name: "checkout-api-7d4f-m4p1", st: "failed", sync: "Synced",
  meta: "CrashLoopBackOff · 12 restarts" }
```
Shape: `app` → [`dep` (Deployment, degraded/OutOfSync, "1/3 ready · 4 fields drifted") → `rs` (ReplicaSet, progressing/Synced, "2/3 available") → `p1`,`p2`,`p3`; `svc` (Service, healthy, "ClusterIP · 3 endpoints") → `ing` (Ingress, healthy, "checkout.acme.io · TLS"); `cm` (ConfigMap checkout-api-env, degraded/OutOfSync, "2 keys changed outside Paprika"); `sec` (Secret checkout-api-tls, healthy, "kubernetes.io/tls · protected")].

### 5.4 `DAG` (lines 1365–1373) — 7 pipeline nodes
```ts
interface DagNode { name: string; meta: string; x: number; y: number; state: StatusKey; sel?: boolean }
```
```js
{ name: "checkout",  meta: "git · 4s",         x: 30,  y: 20,  state: "healthy" }
{ name: "unit-test", meta: "running · 1m06s",  x: 30,  y: 208, state: "progressing", sel: true }
```
Others: build (kaniko · 48s, 30/112, healthy), lint (golangci · 12s, 230/208, healthy), sbom-scan (trivy · 19s, 430/208, healthy), package (queued, 230/300, pending), deploy dev (queued, 230/392, pending).

### 5.5 `LUCIDE` + `icon()` (lines 1375–1400)
23 inline SVG path bundles keyed: `grid, boxes, map, workflow, rocket, diff, git, layers, server, search, chevron, gauge, logs, traces, book, users, coins, pkg, file, eyeOff, cog, sliders, flask`. `search` and `sliders` are declared but never used.

```js
function icon(name, size, color) // → <svg width=size||14 height=size||14 viewBox="0 0 24 24"
  // fill:none, stroke: color||"currentColor", strokeWidth:1.5, strokeLinecap/Join:"round",
  // style:{ display:"block", flex:"none" }, dangerouslySetInnerHTML: LUCIDE[name]
```

### 5.6 `RELEASE` (line 1572) — app name → release tag
`checkout-api r241, payments-gateway r188, ledger-worker r77, fraud-scorer r132, notifications r142, auth-service r97, search-indexer r61, web-frontend r310, cms-preview r19, reporting-etl r54, warehouse-sync r88`. Fallback in tooltips: `"—"`.

### 5.7 `NOTE` (line 1573) — health → tooltip sentence
```
degraded    : "Health check failing; see attention queue for the reason."
failed      : "Workload failing — pods restarting."
missing     : "Source unreachable; last good sync retained."
progressing : "Rollout in progress; analysis running."
healthy     : "All health checks passing."
unknown     : "Health not yet reported."
```

---

## 6. Derived values, board by board

### 6.1 Navigation — `navDef` → `navSections` (lines 1422–1451)

```ts
interface NavItem { label: string; glyph: string /*LUCIDE key*/; key: ScreenId; id: string; badge: string }
```
| Section | Label | glyph | `key` (screen it navigates to) | `id` (highlight id) | badge |
|---|---|---|---|---|---|
| `FLEET` | Overview | grid | overview | overview | `""` |
| | Applications | boxes | applications | applications | `String(APPS.length)` = `"16"` |
| | Fleet map | map | map | map | `""` |
| `DELIVERY` | Pipelines | workflow | pipeline | pipeline | `"3"` |
| | Rollouts | rocket | rollout | rollout | `"3"` |
| | Sync & diff | diff | diff | diff | `"8"` |
| `SOURCES` | Repositories | git | **overview** | repos | `"41"` |
| | Templates | layers | **overview** | templates | `"4"` |
| | Clusters | server | **map** | clusters | `"3"` |

The three SOURCES entries deliberately reuse existing screens (`overview`, `overview`, `map`) — they are not separate screens.

`navBase` (line 1437, verbatim):
```
display:flex; align-items:center; gap:9px; width:100%; height:29px; border:0; padding:0 16px;
font-family:'Barlow Condensed',sans-serif; font-size:14px; font-weight:500; letter-spacing:0.05em;
text-transform:uppercase; cursor:pointer; text-align:left;
```
`activeKey = s === "appDetail" ? "applications" : s` (line 1438) — the app-detail screen keeps "Applications" lit.
Active suffix: `background:#5980a6; color:#f2f2f3;`  Inactive suffix: `background:none; color:rgba(242,242,243,0.74);`
Each item exposes `glyph: icon(it.glyph, 14)` and `go: this.go(it.key)`.

### 6.2 Scope bar — `scopes`, `scopedApps` (lines 1453–1476)

`scopeVals`:
- `project` = `["All", ...new Set(APPS.map(a => a.project))]` → All, payments/core, payments/risk, platform/shared, web/storefront, data/analytics (insertion order, NOT sorted)
- `cluster` = `["All", ...new Set(APPS.map(a => a.cluster))]` → All, prod-eu-1, staging-1, prod-us-1
- `stage`   = `["All", "prod", "staging", "dev"]` (hard-coded order)

```ts
interface Scope {
  label: "PROJECT" | "CLUSTER" | "STAGE";   // k.toUpperCase()
  value: string; key: "project"|"cluster"|"stage"; isOpen: boolean;
  toggle(): void; btnStyle: string;
  options: { label: string; count: number; select(): void; style: string }[];
}
```
- `btnStyle` background precedence: value ≠ "All" → `#e7f0f8`; else open → `#f5f5f8`; else `none`. Plus `height:100%; border:0; border-right:1px solid rgba(29,31,32,0.16); padding:0 14px; gap:7px; font:inherit; cursor:pointer; color:#1d1f20; position:relative;`
- option `count`: `v === "All" ? APPS.length : APPS.filter(a => (k === "stage" ? a.env : a[k]) === v).length` — counts are over ALL apps, unaffected by the other two scope axes.
- option `style`: 30px tall row, `justify-content:space-between; gap:14px; border-bottom:1px solid rgba(29,31,32,0.10); background:{selected ? "#e7f0f8" : "#fff"}; padding:0 12px; font-size:12px; white-space:nowrap;`
- `scopedApps` = AND of the three axes (stage matches `a.env`).
- `scopeSummary` = `` `${scopedApps.length} of ${APPS.length} targets in scope` `` (default state: `"16 of 16 targets in scope"`). Rendered with the suffix ` · clear` at template line 78.
- `scopeActive` = any axis ≠ "All".
- `scopedCount` (line 2002) = `` `${scopedApps.length} targets · ${new Set(scopedApps.map(a=>a.name)).size} apps in scope` `` → default `"16 targets · 11 apps in scope"`.

### 6.3 Board 01 — `lifecycle` (lines 1468–1484)

```ts
interface LifecycleRaw { idx: string; arrow: "›" | ""; label: string; value: string; st: StatusKey; sub: string; mix: StatusKey[] /*4*/ }
```
| idx | arrow | label | value | st | sub | mix |
|---|---|---|---|---|---|---|
| 01 | `›` | Source | 12 | healthy | `GitHub 41 · S3 9 · OCI 7 repos` | healthy, healthy, healthy, unknown |
| 02 | `›` | Build | 3 | progressing | `in-cluster · 41 runs today` | progressing, healthy, healthy, unknown |
| 03 | `›` | Test | 2 | degraded | `1 failing · 213/214 passed` | degraded, progressing, healthy, unknown |
| 04 | `›` | Render | 4 | healthy | `Helm 33 · Kustomize 14 · Jsonnet 6` | healthy ×4 |
| 05 | `›` | Deploy | 7 | progressing | `releases active · 2 gates blocked` | progressing, degraded, healthy, unknown |
| 06 | `""` | Verify | 3 | failed | `canaries under analysis · 1 held` | failed, progressing, healthy, unknown |

Derived styles per cell:
- `cellStyle` = `background:{t.fill}; padding:12px 14px 13px; min-width:0;`
- `idxStyle` = `font-family:ui-monospace,monospace; font-size:9px; letter-spacing:0.16em; color:{t.c};`
- `numStyle` = `margin-top:6px; font-size:34px; font-weight:600; line-height:1; font-variant-numeric:tabular-nums; color:{t.c};`
- `bars` = `l.mix.map(k => bar(T[k].line))` → four 5px-tall flex:1 bars.

### 6.4 Board 02 — `posture` (lines 1486–1491) and the heatmap

`postureData = [["healthy",41],["progressing",6],["degraded",4],["failed",2],["missing",1],["unknown",3]]` — total 57, and **57 is hard-coded** in the bar-width formula.
```ts
interface PostureRow { label: string; count: number; glyph: string; glyphStyle: string /*chip(t)*/; barStyle: string }
```
`barStyle` = `position:absolute; left:0; top:0; bottom:0; width:{Math.round(n/57*100)}%; background:{t.line};`
→ widths: 72%, 11%, 7%, 4%, 2%, 5%.

`postureFormats` (line 1570): `[["bars","Bars"],["heatmap","Heatmap"]]` → `{ label, select, style: miniSeg(active, i===0) }`.
Exported flags: `postureIsBars`, `postureIsHeatmap` (line 1997).

#### `heatRows` (lines 1578–1621)
```ts
interface HeatRow {
  label: string; isGroup: boolean; kicker: string; meta: string; headStyle: string;
  mix: string[]; tiles: HeatTile[];
}
```
- `heatKeyOf(a)` = project | cluster | env | `"all"` depending on `heatGroup`.
- `heatKeys` = `heatGroup === "none" ? ["all"] : heatGroup === "stage" ? ["prod","staging","dev"] : [...new Set(APPS.map(heatKeyOf))].sort()`.
- `list` = APPS with that key, sorted `HEALTH_RANK asc` then `name.localeCompare`.
- `bad` = count with `HEALTH_RANK < 3`; `worst` = reduce to the lowest-rank health, seed `"healthy"`.
- `kicker` = `heatGroup.toUpperCase()` (e.g. `PROJECT`).
- `meta` = `` `${n} target${n===1?"":"s"} · ${distinctNames} apps${bad ? " · "+bad+" unhealthy" : " · all healthy"}` ``
- `headStyle` = `display:flex; align-items:baseline; gap:8px; min-width:0; padding:0 0 6px; border-bottom:1px solid {T[worst].line};`
- `mix` = `mixBar(list)`

```ts
interface HeatTile {
  glyph: string; hovered: boolean; name: string; health: string; pillStyle: string;
  showName: boolean; showSub: boolean; isCompact: boolean;
  label: string; sub: string; target: string; project: string; sync: string;
  release: string; res: number; cost: string; note: string;
  enter(e): void; leave(): void; open(): void; style: string; tipStyle: string;
}
```
Tile rules:
- id = `` `${key}:${a.name}:${a.cluster}` ``, `hov = state.hoverTile === id`
- `bigTile = heatGroup === "none" || list.length <= 6`
- `dims` by `heatDetail`:
  - `compact` → `width:22px; height:22px; padding:0; align-items:center; justify-content:center;`
  - `name` → `width:{bigTile?96:84}px; height:30px; padding:0 7px; justify-content:center;`
  - `full` → `width:{bigTile?108:92}px; height:{bigTile?58:50}px; padding:5px 7px; justify-content:space-between;`
- `showName = heatDetail !== "compact"`, `showSub = heatDetail === "full"`, `isCompact = heatDetail === "compact"`
- `sub` = `heatGroup === "cluster" ? a.env : a.cluster.replace("-1","")` (so `prod-eu-1` renders as `prod-eu`)
- `target` = `` `${a.cluster} · ${a.stage}` ``; `sync` = `a.sync === "synced" ? "Synced" : "Drifted · " + a.sync`; `release` = `RELEASE[a.name] || "—"`; `note` = `NOTE[a.health]`
- `pillStyle` = `pill(t) + " background:#fff;"` (pill fill overridden to white inside the dark tooltip)
- `style` = `display:flex; flex-direction:column; {dims} box-sizing:border-box; border:1px solid {t.line}; background:{compact ? t.line : t.fill}; color:{compact ? "#fff" : t.c}; cursor:pointer;` plus, when hovered: `outline:2px solid {t.line}; outline-offset:1px; box-shadow:0 4px 12px rgba(29,45,61,0.16);`
  — i.e. **compact tiles are solid saturated squares in white text; the other two modes are tinted with coloured text.**
- `tipStyle` = `position:absolute; z-index:70; top:calc(100% + 6px); {hoverSide==="right" ? "right:0;" : "left:0;"} transform:translateX({hoverShift||0}px); width:{hoverMaxW||270}px; background:#1d2d3d; color:#f2f2f3; border:1px solid rgba(242,242,243,0.16); box-shadow:0 8px 22px rgba(29,45,61,0.28); pointer-events:none;`

`enter(e)` geometry (lines 1602–1615), verbatim logic:
```js
let side = "left", shift = 0, maxW = 270;
const el = e.currentTarget, sec = el.closest("section");
const r = el.getBoundingClientRect(), s = sec.getBoundingClientRect();
maxW = Math.max(180, Math.min(270, s.width - 28));
const centre = (r.left + r.right) / 2;
side = centre > (s.left + s.right) / 2 ? "right" : "left";
// shift so the tooltip stays inside the section with 14px margin
if (side === "left") { const over = (r.left + maxW) - (s.right - 14); if (over > 0) shift = -over; }
else                 { const over = (s.left + 14) - (r.right - maxW); if (over > 0) shift = over; }
this.setState({ hoverTile: id, hoverSide: side, hoverShift: shift, hoverMaxW: maxW });
```
The whole block is wrapped in `try { … } catch (_) {}` — on failure the defaults (left / 0 / 270) apply.

Heatmap controls:
- `heatGroupChips` (line 1575) = `[["none","All"],["project","Project"],["cluster","Cluster"],["stage","Stage"]]`, styled with `miniSeg(hg===k, i===0)`
- `heatDetailChips` (line 1577) = `[["full","Name + target"],["name","Name"],["compact","Compact"]]`
- `heatSummary` (line 1996) = `` `${hg === "none" ? "ungrouped" : "by " + hg} · ${hd === "full" ? "name + target" : hd === "name" ? "name" : "compact"}` `` → default `"by project · name + target"`
- `cogStyle` (line 1995) = 22×22 button, `border:1px solid {open ? #5980a6 : rgba(29,31,32,0.16)}; background:{open ? "#e7f0f8" : "#fff"}; border-radius:2px; color:{open ? "#2c455d" : "#5d5d60"};`
- Popover copy (template line 206): `"Compact hides names and shows solid colour squares; hover any tile for full detail."`; headers `GROUP BY`, `TILE DETAIL`, title `Heatmap settings`.

### 6.5 Board 03 — `attention` (lines 1498–1506)

Source is a 7-tuple array `[rank, name, id, reason, st, age, action]`:
```
["01","checkout-api","payments/checkout-api","p99 latency 41% over baseline — canary held at 25%","failed","6m","Review"]
["02","notifications","platform/notifications","Deployment 1/3 replicas ready · CrashLoopBackOff","degraded","23m","Investigate"]
["03","reporting-etl","data/reporting-etl","s3://acme-manifests unreachable — 403 on HeadObject","missing","41m","Fix source"]
["04","ledger-worker","payments/ledger-worker","Approval gate blocked · awaiting release manager","progressing","1h 12m","Approve"]
["05","web-frontend","web/web-frontend","3 fields drifted from rendered manifest","degraded","2h","Diff"]
["06","auth-service","platform/auth-service","Policy signed-images-only warned on 1 image","unknown","3h","View"]
```
```ts
interface AttentionRow { rank: string; name: string; ns: string; reason: string; age: string; action: string;
                         glyph: string; glyphStyle: string; open(): void; rowStyle: string; actionStyle: string }
```
- `ns = id.split("/")[0]`
- `rowStyle` = `display:grid; grid-template-columns:20px 16px minmax(0,1fr) 46px 82px; align-items:center; gap:9px; border-bottom:1px solid rgba(29,31,32,0.10); border-left:3px solid {t.line}; background:{i < 3 ? t.fill : "#fff"}; padding:0 14px 0 11px; height:46px; cursor:pointer;`
  — **the top 3 rows get a tinted background, the rest are white.**
- `actionStyle` = `width:100%; height:23px; border:1px solid {t.line}; background:#fff; border-radius:2px; font-size:10.5px; font-weight:600; letter-spacing:0.02em; color:{t.c};`
- `open` = `openApp` (jumps to app detail).
- Board header decoration text (template line 281): `"ranked radius"`.

### 6.6 Board 04 — `inflight` (lines 1497–1506) and `recentRollouts`

```ts
interface Inflight { name: string; meta: string; weight: string; stepLabel: string; analysis: string;
                     steps: { style: string; title: string }[] }
```
```js
{ name: "checkout-api", meta: "prod-eu-1 · canary", weight: "25%", stepLabel: "STEP 3 / 6 · HELD",
  analysis: "1 metric failing",
  steps: [["5","healthy",8],["10","healthy",11],["25","degraded",14],["50","pending",17],["75","pending",20],["100","pending",22]] }
{ name: "ledger-worker", meta: "staging-1 · blue/green", weight: "0%", stepLabel: "STEP 1 / 3 · GATE",
  analysis: "awaiting approval",
  steps: [["0","progressing",10],["50","pending",16],["100","pending",22]] }
```
(middle row: `web-frontend`, `prod-eu-1 · canary`, `75%`, `STEP 5 / 6 · RUNNING`, `4/4 passing`, steps 5/10/25 healthy, 75 progressing, 100 pending — heights 8/11/14/17/20/22)
Each step tuple `[w, st, h]` → `{ style: ladderStep(w, st, h), title: w + "% · " + st }`. Note `title` uses the raw status key, not the label.

`rolloutTabs` (line 1571) = `[["inflight","In flight · 3"],["recent","Recent · 7d"]]`; exported flags `rolloutIsInflight`, `rolloutIsRecent`.

`recentRaw` / `recentRollouts` (lines 1622–1637):
```ts
interface RecentRaw { name: string; release: string; target: string;
                      outcome: "healthy"|"failed"|"degraded"; label: string; note: string;
                      steps: (0|1|2)[]; took: string; when: string }
```
```js
{ name: "payments-gateway", release: "r188", target: "prod-us-1 · ring 3", outcome: "healthy", label: "COMPLETED",
  note: "6 steps · 4/4 metrics passed at every step", steps: [1,1,1,1,1,1], took: "24m", when: "2h" }
{ name: "notifications", release: "r142", target: "prod-us-1 · ring 3", outcome: "failed", label: "ABORTED",
  note: "error rate 2.1% > 1% at 10% · auto rolled back to r141", steps: [1,2,0,0,0,0], took: "7m", when: "5h" }
```
Remaining: auth-service r97 (healthy/COMPLETED, `3 steps · blue/green · switched at 09:12`, [1,1,1], 18m, 3h); search-indexer r61 (healthy/COMPLETED, `6 steps · one manual approval at 50%`, 41m, 1d); web-frontend r309 (healthy/COMPLETED, `6 steps · p99 within 6% of baseline`, 31m, 1d); fraud-scorer r131 (degraded/ROLLED BACK, `operator abort at 25% · saturation alert · rolled back to r130`, [1,1,2,0,0,0], 12m, 2d).

Step-bar rule: `s===1 → T.healthy`, `s===2 → T.failed`, `s===0 → T.pending`; style = `flex:1; width:10px; height:{6 + j*1.6}px; border:1px solid {t.line}; background:{s===0 ? "transparent" : t.fill};` — an ascending staircase, index-based height.
`rowStyle` = `display:grid; grid-template-columns:minmax(150px,1fr) 88px 84px 44px 44px; align-items:center; gap:8px; border-bottom:1px solid rgba(29,31,32,0.10); border-left:3px solid {T[outcome].line}; background:{outcome === "healthy" ? "#fff" : T[outcome].fill}; padding:9px 14px 9px 11px; cursor:pointer;`
`pillStyle` = `pill(T[outcome])`; the pill text is `outcome: r.label` (COMPLETED / ABORTED / ROLLED BACK).
`recentStats` (line 1638) = `{ total: 11, ok: 9, aborted: 2, median: "22m" }`.

### 6.7 Board 05 — `triggers` (lines 1509–1515)
```ts
interface Trigger { kind: "GIT"|"S3"|"OCI"; ref: string; effect: string; age: string; tagStyle: string }
```
```js
{ kind: "GIT", ref: "acme/checkout-api@9f3a1c2 → main", effect: "run #418 · build, test, deploy dev", age: "34m", tagStyle: trigTag("#416180") }
{ kind: "S3",  ref: "s3://acme-manifests/etl/", effect: "403 HeadObject · reporting-etl source failed", age: "1h 41m", tagStyle: trigTag("#8e372f") }
```
Others: S3 `s3://acme-manifests/web/prod.tar.gz` → `re-rendered web-frontend · 2 fields changed`, 51m; GIT `acme/platform-charts@4c81de0 → main` → `ApplicationSet fan-out · 6 applications`, 1h 08m; OCI `ghcr.io/acme/auth-service:1.19.2` → `digest changed · auth-service resynced`, 2h 15m.
Only the failing S3 row uses `OXIDE_T` (#8e372f); all others `STEEL_D` (#416180).

### 6.8 Board 06 — `clusters` (lines 1534–1541)
```ts
interface Cluster { name: string; meta: string; conn: "CONNECTED" | "DEGRADED"; apps: number; nodes: number;
                    pods: number; cost: string; mix: string[]; usage: UsageMeter[]; connStyle: string }
```
```js
{ name: "prod-eu-1", meta: "vke · eu-west · v1.31.4", conn: "CONNECTED", apps: 24, nodes: 18, pods: 412, cost: "$14.2k",
  mix: [mixSeg(20, T.healthy.line), mixSeg(3, T.degraded.line), mixSeg(1, T.failed.line)],
  usage: [usage("CPU", 34.6, 61.2, 72, "cores"), usage("MEMORY", 171, 198, 288, "GiB")] }
{ name: "staging-1", meta: "kind · shared · v1.32.0", conn: "DEGRADED", apps: 11, nodes: 4, pods: 96, cost: "$0.8k",
  mix: [mixSeg(9, T.healthy.line), mixSeg(2, T.progressing.line)],
  usage: [usage("CPU", 5.8, 9.1, 16, "cores"), usage("MEMORY", 29, 41, 64, "GiB")] }
```
prod-us-1: `eks · us-east-2 · v1.31.2`, CONNECTED, 22 apps / 22 nodes / 488 pods / `$18.6k`, mix 18 healthy + 2 degraded + 2 missing, CPU 41.9/78.1/88 cores, MEMORY 206/251/352 GiB.
`connStyle = pill(conn === "CONNECTED" ? T.healthy : T.degraded)`.
These `mix`/`usage` numbers are literals — they are NOT derived from `APPS`.
Board footer copy (template line 414): `"ksm · node-exporter · 15s ago"` and a `Fleet map →` link (`goMap`); each cluster card is clickable → `goMap` (template line 420).

### 6.9 Board show/hide & customise (lines 1554–1568)

`boardDefs` = `[["lifecycle","01","Lifecycle"], ["posture","02","Health posture"], ["attention","03","Needs attention"], ["inflight","04","Rollouts"], ["triggers","05","Source triggers"], ["clusters","06","Clusters · capacity"]]`

- `boards[id] = { on: !hiddenBoards[id], hide: () => set hiddenBoards[id] = true }`
- `boardChips[i] = { n, label, toggle: () => flip hiddenBoards[id], style }` where
  `style` = `display:inline-flex; align-items:center; gap:6px; border:1px solid {hidden ? rgba(29,31,32,0.16) : "#5980a6"}; background:{hidden ? "#fff" : "#5980a6"}; color:{hidden ? "#5d5d60" : "#f2f2f3"}; border-radius:2px; padding:3px 9px; font:inherit; font-size:11px; font-weight:600; cursor:pointer; text-decoration:{hidden ? "line-through" : "none"};`
- Responsive row collapse:
  - `row2on = boards.posture.on || boards.attention.on`
  - `row3on = boards.inflight.on || boards.triggers.on`
  - `row2Style` = `display:grid; grid-template-columns:{both ? "minmax(0,1.05fr) minmax(0,1.25fr)" : "minmax(0,1fr)"}; gap:16px;`
  - `row3Style` = `display:grid; grid-template-columns:{both ? "minmax(0,1.3fr) minmax(0,1fr)" : "minmax(0,1fr)"}; gap:16px;`
- `customiseLabel` = `customising ? "Done" : "Customise"` (line 1972)
- `customiseBtnStyle` = `height:32px;` plus, when customising, `background:#5980a6; color:#f2f2f3; border-color:#5980a6;`
- `resetBoards` (line 1974) = `setState({ hiddenBoards: {}, postureFormat: "heatmap", rolloutTab: "inflight" })` — note it does NOT reset `heatGroup`/`heatDetail`/`collapsed`.
- Customise bar copy (template line 119): `"Click a board to show or hide it. Hidden boards keep their settings. Layout is saved per user."`, kicker `BOARDS`, button `Reset to default`.
- Per-board hide button (template lines 133/168/281/318/387/414): 22×22, `border:1px solid #dd9490; background:#fbe9e8; color:#9c3f39;`, `title="Hide board"`, icon `eyeOff` at 12px. Only rendered when `customising`.
- Overview header (template lines 102–107): kicker `FLEET · ALL PROJECTS`, h1 `Operations overview` (Barlow Condensed, 30px, weight 600, ls 0.01em), buttons `Customise` / `Open inventory` (→ `goApplications`). Lifecycle board header meta: `"57 applications · 3 clusters · 12 changes today"`.

### 6.10 Applications screen

`presentations` (lines 1640–1645) — `["Treemap","Matrix","Table","Queue"]`; active = `state.view`.
Style: `display:inline-flex; align-items:center; border:0; {label==="Treemap" ? "" : "border-left:1px solid rgba(29,31,32,0.16);"} padding:0 14px; font:inherit; font-family:'Barlow',sans-serif; font-size:12px; font-weight:600; cursor:pointer; background:{on ? "#5980a6" : "transparent"}; color:{on ? "#f2f2f3" : "#5d5d60"};`

`facetChips` (lines 1654–1661) — six **static, non-interactive** chips (no `select` handler):
`Degraded 4` (on), `Out of sync 8` (on), `Failed 2`, `prod 25`, `Helm 33`, `Blocked gate 2`.

`stripTone` (line 1663) = `{ ok: T.healthy, fail: T.failed, degraded: T.degraded, run: T.progressing, pend: T.pending }`
`stripNames` (line 1664) = `["source","build","test","render","deploy","verify"]`

`groupChips` (lines 1667–1671) = `[["none","None"],["project","Project"],["cluster","Cluster"],["stage","Stage"]]`, style: same segmented pattern, `padding:0 11px; height:100%; font-size:11px; font-weight:600;` active `#5980a6`/`#f2f2f3`.

`sortedScoped` = `[...scopedApps].sort((a,b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health] || a.name.localeCompare(b.name))` — worst first, then alphabetical.

`groupMeta(list)` (lines 1673–1680):
```js
parts = [`${n} target${n===1?"":"s"}`, `${distinctNames} apps`];
if (bad)   parts.push(`${bad} unhealthy`);   // bad = HEALTH_RANK < 3
if (drift) parts.push(`${drift} drifted`);   // drift = sync !== "synced"
return parts.join(" · ");
```
`groupOrder` = `gb === "stage" ? ["prod","staging","dev"] : [...new Set(sortedScoped.map(groupKeyOf))].sort()`.

`groups` (lines 1682–1697), empty groups filtered out:
```ts
interface Group {
  key: string; label: string;   // gb === "none" ? "All applications" : key
  isGroup: boolean; open: boolean;
  kicker: "PROJECT" | "CLUSTER" | "STAGE" | "";
  meta: string; mix: string[]; glyph: string; glyphStyle: string;
  toggle(): void; chevStyle: string; chev: ReactNode; headStyle: string; rows: App[];
}
```
- `worst` drives glyph/chip and the header background.
- `chevStyle` = 20×20 button, `border:1px solid rgba(29,31,32,0.16); background:#fff; border-radius:2px; color:#5d5d60; transform:rotate({closed ? -90 : 0}deg); transition:transform .15s;`, `chev = icon("chevron", 11)`
- `headStyle` = `display:flex; align-items:center; gap:12px; border-bottom:1px solid rgba(29,31,32,0.16); border-top:1px solid rgba(29,31,32,0.16); background:{T[worst].fill}; padding:0 22px; height:40px; cursor:pointer;`

`inventoryGroups` (lines 1698–1717) — Table view rows:
```ts
interface InventoryRow {
  name: string; id: string;        // `${ns}/${name}`
  project: string; cluster: string; stage: string;
  health: string; healthStyle: string;                 // pill(healthTone)
  sync: "Synced" | "Drifted"; syncStyle: string;       // pill(synced ? T.healthy : T.degraded)
  glyph: string; glyphStyle: string;                   // chip(healthTone)
  resources: number; cost: string; actions: string[];
  open(): void; rowStyle: string;
  strip: { title: string; style: string }[];           // [] when showLifecycleStrip is false
}
```
- `rowStyle` = `display:grid; grid-template-columns:minmax(190px,1.3fr) 120px minmax(120px,1fr) 92px 88px 150px 74px 78px 118px; align-items:center; gap:12px; border-bottom:1px solid rgba(29,31,32,0.10); background:{i % 2 ? "#fbfbfc" : "#fff"}; padding:0 22px; height:{rowH}px; cursor:pointer;`
  → **9 columns**, zebra striping, height 42px (compact) / 52px (comfortable).
- strip cell: `style` = `width:20px; height:16px; border:1px solid {t.line}; background:{k === "pend" ? "transparent" : t.fill};`, `title` = `` `${stripNames[j]} · ${t.label}` `` e.g. `"test · Failed"`.

`tmGroups` (lines 1719–1728) — Treemap view:
- `w = Math.max(150, Math.round(a.res * 9))`
- tile `style` = `flex:{a.res} 1 {w}px; min-width:{w}px; min-height:66px; box-sizing:border-box; border:1px solid {t.line}; background:{t.fill}; padding:7px 9px; cursor:pointer; color:{t.c};`
- tile fields: `name`, `sub` = `` `${a.cluster} · ${a.stage}` ``, `glyph`, `res` = `` `${a.res} res` ``, `open`.

`matrix` (lines 1730–1747) — Matrix view:
- `mxCols` = distinct `scopedApps` clusters, **sorted** → `prod-eu-1, prod-us-1, staging-1`
- `mxRows` = `gb === "stage" ? ["prod","staging","dev"] : [...new Set(scopedApps.map(a => gb === "cluster" ? a.env : a.project))].sort()`
- `mxRowKey(a)` = `gb === "cluster" ? a.env : gb === "stage" ? a.env : a.project`
- `rowLabel` = `gb === "cluster" || gb === "stage" ? "STAGE" : "PROJECT"`
- `colStyle` = `display:grid; grid-template-columns:150px repeat({mxCols.length},minmax(0,1fr)); gap:1px; background:rgba(29,31,32,0.16);`
- cell: `buckets` iterate `["failed","missing","degraded","progressing","healthy"]` (**`unknown` is omitted here**), keep non-zero; `pills[i].label` = `` `${T[k].glyph} ${n}` ``; `count` = `list.length || "—"`; `apps` = `` `${distinctNames} apps` ``; `style` = `background:{list.length ? "#fff" : "#f5f5f8"}; padding:10px 12px; min-height:64px;`

`queueRows` (lines 1749–1756) — Queue view. Filter: `a.health !== "healthy" || a.sync !== "synced"`.
Reason ladder (exact):
```js
failed      -> "workload failing"
missing     -> "source unreachable"
degraded    -> sync !== "synced" ? "degraded · drifted" : "degraded"
progressing -> "rollout in progress"
otherwise   -> "drifted"
```
- `rank` = `String(i+1).padStart(2,"0")`; `id` = `` `${a.ns}/${a.name}` ``; `target` = `` `${a.cluster} · ${a.stage}` ``
- `style` = `display:grid; grid-template-columns:28px 16px minmax(0,1.2fr) minmax(0,1fr) 140px minmax(0,1fr); align-items:center; gap:12px; border-bottom:1px solid rgba(29,31,32,0.10); border-left:3px solid {t.line}; background:{i < 3 ? t.fill : "#fff"}; padding:0 22px 0 19px; height:{rowH}px; cursor:pointer;`

### 6.11 App-detail screen

`appTags` (line 1765) = `["owner: payments-core", "on-call: @rmoreau", "tier: 1", "helm · deploy/chart", "prod-eu-1"]`
Breadcrumb (template line 664): `Applications / payments / checkout-api` — the `Applications` word is a `goApplications` link. Header button `Diff` → `goDiff` (template line 678).

`timeline` (lines 1767–1786) — from `tlData` `[label, st, dur, detail, link]`:
```
["Source",  "healthy",     "4s",      "push to main · 9f3a1c2",                      "View commit ↗"]
["Build",   "healthy",     "48s",     "kaniko · image pushed to ghcr",               "ghcr.io/acme/checkout-api"]
["Test",    "degraded",    "1m 06s",  "213 passed · 1 failed (retried, green)",      "Open run #418"]
["Render",  "healthy",     "2s",      "Helm · deploy/chart · 14 objects",            "View manifest"]
["Deploy",  "healthy",     "31s",     "applied to prod-eu-1 · ring 2",               "3 fields drifted since"]
["Verify",  "failed",      "6m 12s",  "canary held · p99 latency breach",            "Open rollout"]
```
- `cellStyle` = `background:{st === "healthy" ? "#fff" : t.fill}; padding:11px 13px 13px; cursor:pointer;`
- `go` routing: `i === 5 → this.go("rollout")`, `i === 2 → this.go("pipeline")`, otherwise `this.go("appDetail")` (a no-op re-navigation).
- Section meta (template line 700): `"triggered by push to main · 9f3a1c2 · 34m ago"`.

`graphNodes` (lines 1788–1796):
- `sel = n.name === "…7d4f-m4p1"` (the crash-looping pod is pre-selected)
- `badgeStyle` = `flex:none; border:1px solid {t.line}; background:{t.fill}; border-radius:2px; padding:1px 5px; font-family:ui-monospace,monospace; font-size:9px; color:{t.c};` or `display:none;` when the badge is empty
- `style` = `position:absolute; left:{x}px; top:{y}px; width:{w}px; box-sizing:border-box; display:flex; align-items:center; gap:8px; border:1px solid {sel ? "#a8443b" : "rgba(29,31,32,0.28)"}; outline:{sel ? "2px solid rgba(168,68,59,0.25)" : "none"}; background:#fff; padding:6px 8px; cursor:pointer;`
- `open` = `setState({ panel: n.kind + " " + n.name, panelTab: "Diff" })`

`treeRows` (lines 1797–1820) — flattened depth-first by `walk(nodes, depth)`; children are only walked when `!treeClosed[id]`:
```ts
interface TreeRow {
  kind: string;      // n.kind.toUpperCase()
  name: string; meta: string; glyph: string; glyphStyle: string;
  health: string; healthStyle: string;
  sync: "Synced" | "Drifted"; syncStyle: string;
  indentStyle: string;        // `width:${depth*22}px; flex:none;`
  hasKids: boolean; expStyle: string; expIcon: ReactNode | null;
  toggle(e): void; open(): void; rowStyle: string; countLabel: string;
}
```
- `expStyle` = 18×18, `border:1px solid {kids ? rgba(29,31,32,0.16) : "transparent"}; background:{kids ? "#fff" : "transparent"}; border-radius:2px; cursor:{kids ? "pointer" : "default"}; color:#5d5d60; transform:rotate({closed ? -90 : 0}deg); transition:transform .15s;`; `expIcon = kids.length ? icon("chevron", 11) : null`
- `toggle(e)` calls `e.stopPropagation()` first so expanding does not open the panel
- `rowStyle` = `display:grid; grid-template-columns:minmax(0,1fr) 92px 84px; align-items:center; gap:12px; border-bottom:1px solid rgba(29,31,32,0.10); background:{n.st === "failed" ? t.fill : "#fff"}; padding:0 14px; height:38px; cursor:pointer;`
- `countLabel` = child count as string, or `""`

Resource-view switch (lines 1821–1827):
- `graphSegStyle = segOpt(rv === "graph", true)`, `treeSegStyle = segOpt(rv === "tree", false)`
- `setGraph` / `setTree` set `resourceView`
- `expandAll = () => setState({ treeClosed: {} })`
- `collapseAll = () => setState({ treeClosed: { app: false, dep: true, svc: true, rs: true } })` — deliberately keeps the root `app` open
- `isGraphView = rv === "graph" && sec.graph.open`; `isTreeView = rv === "tree" && sec.graph.open`
- Section meta (template line 726): `"14 managed · 3 drifted"`; buttons `Expand all` / `Collapse all` (only in tree view), segmented `Graph` / `Tree`.

`graphLegend` (line 1772) = `["healthy","progressing","degraded","failed"].map(k => ({ label: T[k].label, glyph, glyphStyle: chip(T[k]) }))`.

`drilldowns` (lines 1774–1781) — all icons at 14px in `#416180`:
```
gauge  "Grafana — service overview"   meta "golden signals"
logs   "Logs — Loki"                  meta "app=checkout-api"
traces "Traces — Tempo"               meta "p99 3.4s"
book   "Runbook — payment capture"    meta "confluence"
users  "Owning team — payments-core"  meta "@rmoreau"
coins  "Cost — 30 day"                meta "$4,120"
```

`gates` (lines 1783–1789):
```
{ name: "manual-approval",             detail: "ring 2 · release manager",  st: "degraded", action: "Approve" }
{ name: "conftest: resource-limits",   detail: "4 rules · all passed",      st: "healthy",  action: "" }
{ name: "analysis: golden-signals",    detail: "3 of 4 metrics passing",    st: "failed",   action: "View" }
{ name: "sync window",                 detail: "open until 18:00 UTC",      st: "healthy",  action: "" }
```
`actionStyle` = `height:21px; border:1px solid rgba(29,31,32,0.16); background:#fff; border-radius:2px; padding:0 8px; font-size:10px; font-weight:600; color:#416180; cursor:pointer;` or `display:none;` when `action` is empty. The action buttons carry **no handler**.

`sourceRows` (lines 1791–1798) — key/value list:
```
Repository  github.com/acme/checkout-api
Path        deploy/chart
Engine      Helm 3.16
Revision    9f3a1c2
Sync policy auto · self-heal
Strategy    canary 5/10/25/50/75/100
```

`promotion` (lines 1800–1806):
```
{ ring: 0, name: "dev",     cluster: "staging-1",  state: "r241 · synced 41m ago",     st: "healthy" }
{ ring: 1, name: "staging", cluster: "staging-1",  state: "r241 · synced 38m ago",     st: "healthy" }
{ ring: 2, name: "prod-eu", cluster: "prod-eu-1",  state: "r241 · canary held at 25%", st: "degraded" }
{ ring: 3, name: "prod-us", cluster: "prod-us-1",  state: "r240 · awaiting ring 2",    st: "pending" }
```
`cellStyle` = `background:{st === "healthy" ? "#fff" : T[st].fill}; padding:11px 13px 13px;`

### 6.12 Resource side panel

Open: `panel = "<KIND> <name>"` set by graph nodes and tree rows; both also force `panelTab: "Diff"`.
- `panelOpen = Boolean(state.panel)`; `closePanel = () => setState({ panel: null })`
- `panelKind = String(panel).split(" ")[0]`; `panelName = String(panel).split(" ").slice(1).join(" ")`
- `panelTags` (line 1988) = `["payments", "sync: OutOfSync", "health: Degraded", "restarts: 12"]` — static
- `panelTabs` (lines 1841–1844): `["Diff","Live","Desired","Events","Logs"]`; style = `border:0; background:none; padding:9px 12px; font:inherit; font-size:12px; cursor:pointer;` plus active `border-bottom:2px solid #5980a6; font-weight:600; color:#1d1f20;` / inactive `color:#5d5d60;`
- Flags: `panelIsDiff`, `panelIsEvents`, `panelIsLogs`, `panelIsManifest = tab === "Live" || tab === "Desired"`

`diffLines` — `dl(kind, n, text)` (lines 1826–1831):
```js
add: background:rgba(74,124,82,0.10); color:#2f5237;
del: background:rgba(168,68,59,0.10); color:#7d3129;
ctx: color:#5d5d60;
// final style = `${st} padding:0 10px; white-space:pre;`
```
(The map values also carry a second element `"+" / "-" / " "` which is destructured away and never used — the marker lives in the `text` itself.)
18 lines numbered 18–35, verbatim:
```
 18   "  spec:"                     ctx
 19   "    replicas: 3"             ctx
 20   "-   replicas: 1"             del
 21   "+   replicas: 3"             add
 22   "    template:"               ctx
 23   "      spec:"                 ctx
 24   "        containers:"         ctx
 25   "        - name: app"         ctx
 26   "-         image: ghcr.io/acme/checkout-api:8c22b90"  del
 27   "+         image: ghcr.io/acme/checkout-api:9f3a1c2"  add
 28   "          resources:"        ctx
 29   "            limits:"         ctx
 30   "-             memory: 512Mi" del
 31   "+             memory: 1Gi"   add
 32   "              cpu: \"1\""    ctx
 33   "          readinessProbe:"   ctx
 34   "-           timeoutSeconds: 1"  del
 35   "+           timeoutSeconds: 3"  add
```

`panelEvents` (lines 1845–1851):
```
{ reason: "BackOff",   message: "Back-off restarting failed container app in pod checkout-api-7d4f-m4p1", at: "12 × · last 41s ago",   st: "failed" }
{ reason: "Unhealthy", message: "Readiness probe failed: HTTP probe failed with statuscode: 503",         at: "31 × · last 1m 12s ago", st: "degraded" }
{ reason: "Pulled",    message: "Successfully pulled image ghcr.io/acme/checkout-api:9f3a1c2 in 2.1s",    at: "1 × · 6m ago",           st: "healthy" }
{ reason: "Scheduled", message: "Successfully assigned payments/checkout-api-7d4f-m4p1 to ip-10-2-31-8",  at: "1 × · 6m ago",           st: "healthy" }
```

`panelLogs` (line 1990) — 8 lines, `\n`-joined, format `HH:MM:SS.mmm  LEVEL  message`:
```
09:41:02.118  ERRO  capture: duplicate charge detected, refusing write
09:41:02.119  INFO  capture: rolling back tx 0x8812fa
09:41:03.402  WARN  readyz: dependency ledger-grpc unavailable (3 of 3 attempts)
09:41:04.771  ERRO  readyz: returning 503
09:41:06.010  INFO  shutting down: received SIGTERM
09:41:06.221  INFO  drained 41 in-flight requests in 208ms
09:41:07.004  INFO  starting checkout-api 9f3a1c2 (go1.25.1)
09:41:07.910  WARN  ledger-grpc: dial tcp 10.2.44.9:9090: i/o timeout
```

`panelManifest` (line 1991) — a Pod YAML for `checkout-api-7d4f-m4p1` in namespace `payments`, labels `app.kubernetes.io/name: checkout-api` / `paprika.io/release: r241`, container image `ghcr.io/acme/checkout-api:9f3a1c2`, limits `cpu: "1"` / `memory: 1Gi`, status `phase: Running`, `restartCount: 12`, `state.waiting.reason: CrashLoopBackOff`.

### 6.13 Sync & diff screen

`diffFilters` (lines 1853–1855) = `[["All",14],["Drifted",3],["Missing",1],["Degraded",2],["Pruned",0]]`.
The **index-1 (`Drifted`) chip is hard-coded active**: `border:1px solid #5980a6; background:#eef6ff; color:#2c455d;`; others `border:1px solid rgba(29,31,32,0.16); background:#fff; color:#5d5d60;`. Common: `display:inline-flex; align-items:center; gap:5px; border-radius:2px; padding:3px 8px; font-size:11px; cursor:pointer;`. No handlers.

`driftQueue` (lines 1857–1867):
```ts
interface DriftItem { kind: string; name: string; reason: string; fields: string; st: StatusKey; sel?: boolean;
                      glyph: string; glyphStyle: string; select(): void; style: string }
```
```
DEPLOYMENT checkout-api            "replicas, image, memory, probe"        fields "4" degraded  sel:true
CONFIGMAP  checkout-api-env        "2 keys changed outside Paprika"        fields "2" degraded
SERVICE    notifications           "annotation removed by controller"      fields "1" degraded
CRONJOB    reporting-etl-nightly   "object missing in cluster"             fields "∅" missing
HPA        web-frontend            "maxReplicas drifted 12 → 20"           fields "1" degraded
INGRESS    auth-service            "TLS secret rotated in place"           fields "1" unknown
SECRET     payments-gateway-key    "protected · excluded from prune"       fields "0" healthy
POD        checkout-api-7d4f-m4p1  "CrashLoopBackOff · 12 restarts"        fields "–" failed
```
`style` = `border-bottom:1px solid rgba(29,31,32,0.10); border-left:3px solid {sel ? "#5980a6" : "transparent"}; background:{sel ? "#eef6ff" : "#fff"}; padding:9px 13px; cursor:pointer;`
`select: () => {}` — **a deliberate no-op**; the selection is fixed on the first row.

### 6.14 Pipelines screen

`dagNodes` (lines 1880–1885): width fixed at 170px regardless of `DAG.w`;
`style` = `position:absolute; left:{x}px; top:{y}px; width:170px; box-sizing:border-box; display:flex; align-items:center; gap:8px; border:1px solid {sel ? "#5980a6" : "rgba(29,31,32,0.28)"}; border-left:3px solid {t.line}; outline:{sel ? "2px solid rgba(89,128,166,0.25)" : "none"}; background:#fff; padding:7px 9px; cursor:pointer;`; `select: () => {}` (no-op).

`pipelineStats` (lines 1886–1889) = `ELAPSED 2m 14s`, `CACHE HIT 74%`, `STEPS 3/7`, `CPU-MIN 9.4`.

`artifacts` (lines 1890–1895):
```
pkg   "ghcr.io/acme/checkout-api:9f3a1c2"  meta "oci image · 84 MB · sha256:4a1f…"  badge "SIGNED"  st healthy
file  "sbom.cyclonedx.json"                meta "412 components · 0 critical"       badge "CLEAN"   st healthy
flask "junit-report.xml"                   meta "214 tests · 1 flake retried"       badge "1 FLAKE" st degraded
```
`badgeStyle = pill(T[st])`.

`pipelineLogs` (line 1998) — 10 `\n`-joined lines beginning `09:39:41  ==> go test ./... -count=1 -race`, including `09:40:01  --- FAIL: TestIdempotentCapture (0.31s)`, `09:40:01      capture_test.go:118: want 1 charge, got 2`, `09:40:02  ==> retrying 1 failed test (flake policy: 1 retry)`, ending `09:40:14  ==> 214 passed, 0 failed, 1 retried`.

### 6.15 Rollouts screen

`ladder` (lines 1897–1904):
```
{ n:1, weight:"5%",   note:"passed 4/4",     st:"healthy",  h:26  }
{ n:2, weight:"10%",  note:"passed 4/4",     st:"healthy",  h:38  }
{ n:3, weight:"25%",  note:"held · latency", st:"degraded", h:52  }
{ n:4, weight:"50%",  note:"queued",         st:"pending",  h:68  }
{ n:5, weight:"75%",  note:"queued",         st:"pending",  h:84  }
{ n:6, weight:"100%", note:"queued",         st:"pending",  h:100 }
```
- `weightStyle` = `font-size:22px; font-weight:600; font-variant-numeric:tabular-nums; color:{st === "pending" ? "#8e8e92" : T[st].c};`
- `barStyle` = `width:100%; height:{h}px; border:1px solid {T[st].line};` then either `border-style:dashed; background:transparent;` (pending) or `background:{T[st].fill};`

`analysis` (lines 1906–1912):
```
{ name:"success rate",      query:'sum(rate(http_requests_total{code!~"5.."}[2m]))',        baseline:"99.94%", canary:"99.91%", threshold:"≥ 99.5%", st:"healthy" }
{ name:"p99 latency",       query:"histogram_quantile(0.99, …)",                            baseline:"412 ms", canary:"581 ms", threshold:"≤ 500 ms", st:"failed" }
{ name:"error budget burn", query:"burn_rate_1h / 14.4",                                    baseline:"0.3×",   canary:"0.9×",   threshold:"≤ 2×",     st:"healthy" }
{ name:"pod restarts",      query:"increase(kube_pod_container_status_restarts[5m])",       baseline:"0",      canary:"0",      threshold:"= 0",      st:"healthy" }
```
- `result` = `st === "failed" ? "FAIL" : "PASS"`, `resultStyle = pill(T[st])`
- `canaryStyle` = `font-family:ui-monospace,monospace; font-size:12px; text-align:right; font-variant-numeric:tabular-nums; color:{st === "failed" ? "#8e372f" : "#1d1f20"}; font-weight:{st === "failed" ? 700 : 400};`

`rolloutLog` (lines 1914–1922) — `[at, st, text]` → `{ at, text, glyph, glyphStyle }`:
```
09:41 failed       "Analysis run golden-signals failed · p99 581 ms > 500 ms threshold (3 consecutive intervals)"
09:38 degraded     "Rollout paused automatically at step 3. Traffic frozen at 25%."
09:35 progressing  "Weight advanced 10% → 25% · VirtualService updated"
09:33 healthy      "Analysis run golden-signals passed at 10% · 4/4 metrics"
09:30 progressing  "Weight advanced 5% → 10%"
09:28 healthy      "Canary ReplicaSet checkout-api-7d4f scaled to 2 · pods ready"
09:27 progressing  "Rollout started from release r241 · image 9f3a1c2"
```

### 6.16 Fleet-map screen

`mapClusters` (lines 1924–1928) = `[{ name:"prod-eu-1", meta:"18 nodes · eu-west" }, { name:"prod-us-1", meta:"22 nodes · us-east-2" }, { name:"staging-1", meta:"4 nodes · shared" }]`
`mapRowChips` (lines 1758–1762) = `[["stage","Stage"],["project","Project"]]`, segmented style, `padding:0 11px; height:100%; font-size:11px; font-weight:600;`

`mapRowsLive` (lines 1934–1944) — **this is what is exported as `mapRows`** (line 1999 does `mapRows: mapRowsLive`):
```ts
interface MapRow { stage: string; cells: { apps: { style; glyph; title; open }[]; summary: string }[] }
```
- `mapRowKeys` = `mapRowsBy === "stage" ? ["prod","staging","dev"] : [...new Set(APPS.map(a=>a.project))].sort()`
- for each row key × each of the 3 `mapClusters`: filter APPS matching row key and `a.cluster === c.name`, sorted by `HEALTH_RANK` asc
- each app square: `style: sq(a.health)`, `glyph: T[a.health].glyph`, `title: `${a.name} · ${T[a.health].label}``, `open: openApp`
- `summary` = `` list.length ? `${n} target${n===1?"":"s"}${bad ? ` · ${bad} unhealthy` : " · all healthy"}` : "no targets" ``

**Dead code:** a hard-coded `mapRows` array (lines 1946–1962) with `cell(...)` helper (line 1933) and stage summaries such as `"12 apps · 1 degraded · 1 failed"`, `"no prod targets"`, `"6 apps · 1 progressing"` is built but immediately shadowed by `mapRows: mapRowsLive` in the return object. It is never rendered.

---

## 7. Complete interaction inventory

| # | Handler (returned key) | State change | Triggering element (template line) |
|---|---|---|---|
| 1 | `item.go` (per nav item) | `{ screen: key, panel: null, openScope: null }` | sidebar nav `<button>` (41) |
| 2 | `goApplications` | screen → `applications` | overview header `Open inventory` button (107); app-detail breadcrumb `Applications` (664) |
| 3 | `goRollout` | screen → `rollout` | exported for cross-links (line 1962) |
| 4 | `goMap` | screen → `map` | clusters board `Fleet map →` link (414) and each cluster card (420) |
| 5 | `goDiff` | screen → `diff` | app-detail header `Diff` button (678) |
| 6 | `sc.toggle` / `sec.<id>.toggle` | flips `collapsed[id]` | the 22×22 chevron button on every section header (63, 133, 168, 281, 318, 387, 414, 700, 737, 801, 819, 836, 853) |
| 7 | `s.toggle` (scope) | `openScope = (openScope === k ? null : k)` | each scope dropdown button in the scope bar |
| 8 | `o.select` (scope option) | `{ scope: { ...scope, [k]: v }, openScope: null }` | dropdown option row (71) |
| 9 | `clearScope` | `{ scope: all "All", openScope: null }` | scope bar `… · clear` button (78) |
| 10 | `closeScope` | `openScope = null` | full-screen click-catcher behind an open dropdown |
| 11 | `toggleCustomise` | flips `customising` | overview header `Customise` / `Done` button (106) |
| 12 | `b.toggle` (board chip) | flips `hiddenBoards[id]` | dashed BOARDS bar chips (116) |
| 13 | `boards.<id>.hide` | sets `hiddenBoards[id] = true` | per-board eye-off button, only rendered while customising (133/168/281/318/387/414) |
| 14 | `resetBoards` | `{ hiddenBoards: {}, postureFormat: "heatmap", rolloutTab: "inflight" }` | `Reset to default` button (121) |
| 15 | `f.select` (posture format) | `postureFormat = "bars" \| "heatmap"` | posture board segmented control (168) |
| 16 | `toggleHeatSettings` | flips `heatSettingsOpen` | cog button, `title="Heatmap settings"` (186) |
| 17 | `closeHeatSettings` | `heatSettingsOpen = false` | full-screen overlay `position:fixed; inset:0; z-index:75` (188) and the popover `✕` (192) |
| 18 | `g.select` (heat group) | `heatGroup = k` | GROUP BY segmented control in the popover (198) |
| 19 | `g.select` (heat detail) | `heatDetail = k` | TILE DETAIL segmented control in the popover (204) |
| 20 | `t.enter` (heat tile) | `{ hoverTile: id, hoverSide, hoverShift, hoverMaxW }` — see §6.4 | `onMouseEnter` on each heat tile (228) |
| 21 | `t.leave` | `hoverTile = null` | `onMouseLeave` on each heat tile (228) |
| 22 | `t.open` (heat tile) | `openApp`: `{ screen: "appDetail", panel: null }` | `onClick` on each heat tile (228) |
| 23 | `a.open` (attention row) | `openApp` | whole attention row div (286) |
| 24 | `f.select` (rollout tab) | `rolloutTab = "inflight" \| "recent"` | rollouts board segmented control (318) |
| 25 | `r.rowStyle` row | (row is `cursor:pointer` but carries **no** handler) | recent-rollouts row (354) |
| 26 | `g.select` (group chip) | `groupBy = k` | Applications grouping segmented control (481) |
| 27 | `p.select` (presentation) | `view = "Treemap"\|"Matrix"\|"Table"\|"Queue"` | Applications presentation segmented control (489) |
| 28 | `grp.toggle` | flips `groupClosed[key]` | inventory group header row (525) |
| 29 | `row.open` | `openApp` | inventory table row (539) |
| 30 | `t.open` (treemap tile) | `openApp` | treemap tile (587) |
| 31 | `q.open` (queue row) | `openApp` | queue row (640) |
| 32 | `t.go` (timeline cell) | screen → `rollout` (Verify) / `pipeline` (Test) / `appDetail` (others) | app-detail timeline cell (705) |
| 33 | `expandAll` | `treeClosed = {}` | `Expand all` button, tree view only (729) |
| 34 | `collapseAll` | `treeClosed = { app:false, dep:true, svc:true, rs:true }` | `Collapse all` button (730) |
| 35 | `setGraph` / `setTree` | `resourceView = "graph" \| "tree"` | `Graph` / `Tree` segmented control (734, 735) |
| 36 | `r.open` (tree row) | `{ panel: "<KIND> <name>", panelTab: "Diff" }` | resource tree row (748) |
| 37 | `r.toggle` (tree row) | `stopPropagation()` then flips `treeClosed[id]` | tree row expand chevron (751) |
| 38 | `n.open` (graph node) | `{ panel: "<KIND> <name>", panelTab: "Diff" }` | resource graph node (779) |
| 39 | `closePanel` | `panel = null` | scrim `position:fixed; inset:0; z-index:60; background:rgba(29,31,32,0.32)` (873) and the panel `✕` button (888) |
| 40 | `pt.select` (panel tab) | `panelTab = label` | panel tab buttons (894) |
| 41 | `d.select` (DAG node) | **no-op** `() => {}` | pipeline DAG node (983) |
| 42 | `q.select` (drift item) | **no-op** `() => {}` | drift-queue item (1172) |
| 43 | `g.select` (map rows) | `mapRowsBy = "stage" \| "project"` | fleet-map ROWS segmented control (1237) |
| 44 | `ap.open` (map square) | `openApp` | each 18×18 app square in a map cell (1262) |

Elements with `cursor:pointer` but **no** handler: `facetChips`, `diffFilters`, gate `action` buttons, recent-rollout rows, board header `All →` link, `sourceRows`, `drilldowns`, `artifacts`, `promotion` cells.

---

## 8. Full shape of the object returned by `renderVals()` (lines 1957–2003)

```
navSections, scopes
isOverview, isApplications, isAppDetail, isPipeline, isRollout, isDiff, isMap
goApplications, goRollout, goMap, goDiff
lifecycle, posture, attention, inflight, triggers, clusters
boards, boardChips, row2on, row3on, row2Style, row3Style, customising, eyeOff
toggleCustomise, customiseLabel, customiseBtnStyle, resetBoards
postureFormats, postureIsBars, postureIsHeatmap, heatRows, heatGroupChips, heatDetailChips
heatSettingsOpen, cog, toggleHeatSettings, closeHeatSettings, cogStyle, heatSummary
rolloutTabs, rolloutIsInflight, rolloutIsRecent, recentRollouts, recentStats
presentations, facetChips
appTags, timeline, graphNodes, graphLegend, drilldowns, gates, sourceRows, promotion
treeRows, isGraphView, isTreeView, graphSegStyle, treeSegStyle, setGraph, setTree, expandAll, collapseAll, sec
panelOpen, closePanel, panelKind, panelName, panelTags, panelTabs
panelIsDiff, panelIsEvents, panelIsLogs, panelIsManifest
panelEvents, diffLines, panelLogs, panelManifest
diffFilters, driftQueue
dagNodes, pipelineStats, artifacts, pipelineLogs
ladder, analysis, rolloutLog, mapClusters, mapRows (= mapRowsLive), mapRowChips
scopeSummary, clearScope, scopeActive, closeScope
groupChips, inventoryGroups, tmGroups, matrix, queueRows
isTable, isTreemap, isMatrix, isQueue
scopedCount
```

---

## 9. Implementation gotchas worth carrying forward

1. **`statusPalette` only touches `healthy`.** A `quiet` toggle should be implemented as a single-tone override, not a whole second palette.
2. **`rowH` (density) applies to exactly two places**: inventory table rows and queue rows. All other row heights (46px attention, 38px tree, 40px group header) are fixed.
3. **The posture board divides by a hard-coded `57`**, and the header quotes "57 applications" while `APPS.length === 16`. The overview boards mix real derived data (heatmap, scope counts) with fixture totals (posture, clusters, facets, lifecycle).
4. **`bad`/"unhealthy" means `HEALTH_RANK < 3`** — failed, missing, degraded. `progressing` and `unknown` are not counted as unhealthy.
5. **Sort order is always worst-first**: `HEALTH_RANK` ascending, tie-broken by `name.localeCompare`.
6. **Tinting is rank-positional in the attention and queue boards**: only the first three rows (`i < 3`) get a tinted background; the rest are white with a coloured 3px left border.
7. **`mixBar` order is fixed and worst-first** (`failed, missing, degraded, progressing, unknown, healthy`), and zero-count statuses are dropped entirely.
8. **Panel identity is a string**, `"<KIND> <name>"`, split on the first space. Any real implementation should use an object instead.
9. **No-op handlers exist deliberately** (DAG node select, drift-queue select) — those views show a fixed selection.
10. **Dead code to skip**: the literal `mapRows` array + `cell()` helper (lines 1933, 1946–1962), the `OCHRE`/`OCHRE_T`/`FAINT` constants, the `search` and `sliders` icons, the `label` param of `pill()`, the `w` param of `ladderStep()`, and the `+`/`-`/` ` marker in `dl()`'s map.
