# APPLICATION DETAIL view — design spec

Source: `/private/tmp/claude-501/-Users-benebsworth-projects-paprika/844ad4e2-4dd2-4687-a932-9e099bcf1f1c/scratchpad/design/console.dc.html`
Template range: **lines 658–941** (`<sc-if value="{{ isAppDetail }}">` at 659, closes at 941).
Script bindings live in the `<script type="text/x-dc">` block; the detail-specific ones are **lines 1739–1853, 1855–1864, 1980–1991**, plus shared data at **1282–1359** and helpers at **1288–1308, 1396–1413**.

Everything below is verbatim from the file. Nothing is inferred except where marked *(derived)*.

---

## 0. Shared tokens / helpers this view depends on

### Palette constants (lines 1282–1286)
```
PAPER   = #f2f2f3      INK     = #1d1f20      MUTED   = #5d5d60      FAINT   = #7a7a7d
DIV     = rgba(29,31,32,0.16)                 DIV2    = rgba(29,31,32,0.10)
STEEL   = #5980a6      STEEL_D = #416180      STEEL_9 = #1d2d3d
OCHRE   = #b07a2c      OCHRE_T = #8a5f22      OXIDE   = #a8443b      OXIDE_T = #8e372f
GREEN   = #7fae86      GREEN_T = #3f6b48
```

### Status tone map `tones(palette)` (lines 1288–1301)
Default palette prop is `"colour"` (line 1416: `tones(this.props.statusPalette ?? "colour")`). A `"quiet"` variant only changes `healthy`.

| state | glyph | label | `c` (text) | `line` (border) | `fill` (bg) |
|---|---|---|---|---|---|
| `healthy` (colour) | `✓` U+2713 | `Healthy` | `#3f6b48` | `#7fae86` | `#e6f2e8` |
| `healthy` (quiet) | `✓` | `Healthy` | `#4a4a4c` | `#a8a8ab` | `#f0f0f2` |
| `progressing` | `↻` U+21BB | `Progressing` | `#2c455d` | `#8bb0d0` | `#e7f0f8` |
| `degraded` | `!` | `Degraded` | `#8a5f22` | `#e0ad66` | `#fdf2df` |
| `failed` | `×` U+00D7 | `Failed` | `#9c3f39` | `#dd9490` | `#fbe9e8` |
| `missing` | `∅` U+2205 | `Missing` | `#5b5468` | `#aea8bd` | `#efedf4` |
| `unknown` | `?` | `Unknown` | `#5d5d60` | `#c2c2c6` | `#f4f4f6` |
| `pending` | `·` U+00B7 | `Pending` | `#8e8e92` | `#d4d4d7` | `transparent` |

### `chip(t)` — the 16px square status glyph (lines 1303–1305)
```
display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; flex:none;
border:1px solid {t.line}; background:{t.fill}; color:{t.c}; font-size:10px; font-weight:700; line-height:1;
```
Note: **no border-radius** — a hard 16×16 square.

### `pill(t)` — status pill (lines 1306–1308)
```
display:inline-flex; align-items:center; gap:5px; border:1px solid {t.line}; background:{t.fill};
border-radius:2px; padding:1px 7px; font-size:10px; font-weight:600; letter-spacing:0.04em;
text-transform:uppercase; color:{t.c};
```

### `icon(name, size, color)` (lines 1396–1398)
Inline SVG, `viewBox 0 0 24 24`, `fill:none`, `stroke:{color||currentColor}`, `stroke-width:1.5`, round caps/joins, `display:block; flex:none`, path body pulled from a `LUCIDE` map. Default size 14.

### `section(id)` — collapsible section header control (lines 1405–1413)
Returns `{ open, toggle, btnStyle, chevron }`.
`btnStyle`:
```
display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px;
border:1px solid rgba(29,31,32,0.16); background:#fff; border-radius:2px; padding:0; cursor:pointer;
color:#5d5d60; transform:rotate({open ? 0 : -90}deg); transition:transform .15s;
```
`chevron` = `icon("chevron", 12)`. Section ids used on this screen (line 1790): `timeline, graph, drill, gates, source, promotion` (full list also has `lifecycle, posture, attention, inflight, triggers, clusters`).

### Fonts (console.dc.html lines 15, 18–19, 24)
- body: `"Barlow", system-ui, sans-serif`, 13px base, `-webkit-font-smoothing:antialiased`, bg `#f2f2f3`, colour `#1d1f20`.
- `.mono` → `ui-monospace, SFMono-Regular, Menlo, monospace`.
- `.cond` → `"Barlow Condensed", system-ui, sans-serif`.
- `@keyframes blip { 0%,100% { opacity:1 } 50% { opacity:.25 } }` (used by the logs tab live dot).

### Design-system classes referenced (styles.css)
- `.blueprint` (73–77): `position:relative; border:1px solid var(--color-divider); border-radius:0;` where `--color-divider = color-mix(in srgb, #1d1f20 16%, transparent)`.
- `.blueprint > .corner` (83–95): 11×11px absolutely-positioned registration mark, colour = 55% ink; `::before` = 1px vertical rule at `left:5px`, `::after` = 1px horizontal rule at `top:5px`; corners offset `-6px` (`.tl/.tr/.bl/.br`). Every section in this view emits all four: `<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>`.
- `.btn` (140–149): inline-flex, gap 6px, `font-family:"Barlow Condensed"`, weight 600, 14px/1.2, `padding: 6.8px 12.24px` (`var(--space-2) calc(var(--space-3)*1.2)`), `border-radius:4px` (`--radius-md`), 1px transparent border.
- `.btn-primary` (152): `background:#5980a6; color:#f2f2f3` (hover `#597ea3`, active `#416180`).
- `.btn-secondary` (155): `border-color: var(--color-divider)` (hover 7% ink wash, active 14%).
- `.tag` (225–229): inline-flex, 11px, `letter-spacing:0.02em`, `padding:3px 10px`, `border-radius:3px` (`calc(4px*0.75)`) — but this view overrides to `border-radius:2px`.
- `.tag-neutral` (232): `background:#f5f5f8; color:#424244`.
- `.seg` (192–195): `display:inline-flex; overflow:hidden; border:1px solid var(--color-divider); border-radius:4px`. Buttons inside are styled inline (see §3), not with `.seg-opt`.
- spacing scale: `--space-1..8 = 3.4 / 6.8 / 10.2 / 13.6 / 20.4 / 27.2px`; radii `2 / 4 / 7px`; `--shadow-lg: 0 12px 32px color-mix(in srgb,#2b2b2d 22%,transparent)`.

---

## 1. Detail header (lines 665–689)

Outer bar (line 666):
```
border-bottom:1px solid rgba(29,31,32,0.16); background:#fff; padding:16px 22px 0;
```
Top row (667): `display:flex; align-items:flex-start; justify-content:space-between; gap:20px;`

### Breadcrumb (line 669)
`<div class="mono" style="font-size:10px; color:#7a7a7d;">` containing:
- clickable `<span style="color:#416180; cursor:pointer;" onClick="{{ goApplications }}">Applications</span>`
- then literal text ` / payments / checkout-api`

`goApplications` = `this.go("applications")` (line 1965); `go(s)` resets `screen`, and clears `panel` and `openScope` (line 1404).

### Title row (line 670)
`display:flex; align-items:center; gap:12px; margin-top:5px;`

1. `<h1 class="cond">checkout-api</h1>` — `margin:0; font-size:30px; font-weight:600; letter-spacing:0.01em; line-height:1;`
2. Status badge, literal text **`! DEGRADED`** (line 672):
   ```
   display:inline-flex; align-items:center; gap:6px; border:1px solid #b07a2c;
   background:rgba(176,122,44,0.10); border-radius:2px; padding:2px 8px;
   font-size:11px; font-weight:600; color:#8a5f22;
   ```
3. Sync badge, literal text **`3 OUT OF SYNC`** (line 673) — **identical style string** to the badge above (same ochre border `#b07a2c`, same 10% fill, same `#8a5f22` text).

Both badges are hard-coded literals in the template, not bound.

### Tag strip (lines 674–678)
`display:flex; flex-wrap:wrap; gap:6px; margin-top:9px;`
Each item: `<span class="tag tag-neutral" style="border-radius:2px;">{{ t }}</span>`

`appTags` (line 1739), verbatim, in order:
```
"owner: payments-core", "on-call: @rmoreau", "tier: 1", "helm · deploy/chart", "prod-eu-1"
```

### Action buttons (lines 680–684)
Container: `display:flex; gap:7px; flex:none;`
| # | Label | Class | Inline style | Handler |
|---|---|---|---|---|
| 1 | `Rollback` | `btn btn-secondary` | `height:30px; background:#fff;` | none |
| 2 | `Diff` | `btn btn-secondary` | `height:30px; background:#fff;` | `{{ goDiff }}` → `this.go("diff")` (line 1965) |
| 3 | `Sync now` | `btn btn-primary` | `height:30px;` | none |

### Sub-tab bar (lines 686–694)
Container: `display:flex; gap:0; margin-top:14px;` (no top border — it sits inside the white header block, above the header's own bottom border).

Active tab wrapped in `<sc-if value="{{ true }}" hint-placeholder-val="{{ true }}">` — i.e. **hard-coded active, not stateful**:
- **Overview** (active): `border-bottom:2px solid #5980a6; padding:0 12px 8px; font-size:12px; font-weight:600; color:#1d1f20;`
- Inactive tabs, each `padding:0 12px 8px; font-size:12px; color:#5d5d60;`, in order: `Resources`, `Releases`, `Pipelines`, `Policy`, `Manifest`.

Inactive tabs are `<span>` (no click handler, no cursor:pointer).

---

## 2. Body layout + summary strip (lines 696–719)

Body container (line 693 area, line 693→`<div style="padding:18px 22px 32px; display:flex; flex-direction:column; gap:16px;">`).

There is **no separate KPI/meta strip**. The "summary/meta" role is filled by the **Delivery timeline** section — a 6-cell horizontal band at the top of the body.

### Section: `Delivery timeline · release r241` (lines 696–718)
`<section class="blueprint" style="background:#fff;">` + 4 corner marks.

Header (line 699): `display:flex; align-items:baseline; justify-content:space-between; border-bottom:1px solid rgba(29,31,32,0.16); padding:8px 14px;`
- `<h2 class="cond">` verbatim **`Delivery timeline · release r241`** — `margin:0; font-size:16px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase;`
- Right group `display:flex; align-items:center; gap:10px;`:
  - `.mono` 10px `#5d5d60`, verbatim: **`triggered by push to main · 9f3a1c2 · 34m ago`**
  - collapse chevron button `{{ sec.timeline.btnStyle }}` / `{{ sec.timeline.chevron }}`

Body wrapped in `<sc-if value="{{ sec.timeline.open }}">`.
Grid (line 703): `display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:1px; background:rgba(29,31,32,0.16);`
→ the 1px gap over a divider-coloured background produces hairline separators between cells.

Cell (`t.cellStyle`, line 1752): `background:{st === "healthy" ? "#fff" : T[st].fill}; padding:11px 13px 13px; cursor:pointer;`

Cell internals (lines 705–711):
1. row: `display:flex; align-items:center; justify-content:space-between;` → `chip(t)` glyph on the left, `.mono` 9px `#7a7a7d` duration on the right.
2. `.cond` label — `margin-top:7px; font-size:14px; font-weight:600; letter-spacing:0.07em; text-transform:uppercase;`
3. detail — `margin-top:3px; font-size:11px; line-height:1.4; color:#5d5d60;`
4. `.mono` link — `margin-top:7px; font-size:10px; color:#416180;`

`tlData` (lines 1741–1748), verbatim `[label, state, dur, detail, link]`:
| # | label | state | dur | detail | link | onClick (line 1753) |
|---|---|---|---|---|---|---|
| 0 | Source | healthy | `4s` | `push to main · 9f3a1c2` | `View commit ↗` | go("appDetail") |
| 1 | Build | healthy | `48s` | `kaniko · image pushed ghcr` | `ghcr.io/acme/checkout-api` | go("appDetail") |
| 2 | Test | degraded | `1m 06s` | `213 passed · 1 failed (retried, green)` | `Open run #418` | **go("pipeline")** |
| 3 | Render | healthy | `2s` | `Helm · deploy/chart · 14 objects` | `View manifest` | go("appDetail") |
| 4 | Deploy | healthy | `31s` | `applied prod-eu-1 · ring 2` | `3 fields drifted since` | go("appDetail") |
| 5 | Verify | failed | `6m 12s` | `canary held · p99 latency breach` | `Open rollout` | **go("rollout")** |

---

## 3. Two-column region (line 719): `grid-template-columns:minmax(0,1fr) 300px; gap:16px; align-items:start;`

Left = Resource graph section. Right = a `display:flex; flex-direction:column; gap:14px;` stack of Drilldowns / Gates & analysis / Source (§7–9).

### Resource graph section header (lines 721–738)
`<section class="blueprint" style="background:#fff;">` + 4 corners.
Header bar (723): `display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; border-bottom:1px solid rgba(29,31,32,0.16); padding:6px 10px 6px 14px;`
- `<h2 class="cond">` verbatim **`Resource graph`** — `margin:0; font-size:16px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase; white-space:nowrap;`
- Right cluster: `display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-left:auto;`
  - `.mono` 10px `#5d5d60` verbatim: **`14 managed · 3 drifted`**
  - **Only when `isTreeView`** (lines 727–732): a `display:flex; gap:4px;` pair of buttons **`Expand all`** / **`Collapse all`**, each:
    ```
    border:1px solid rgba(29,31,32,0.16); background:#fff; border-radius:2px; padding:2px 7px;
    font:inherit; font-size:10px; color:#5d5d60; cursor:pointer; white-space:nowrap;
    ```
    `expandAll` → `treeClosed: {}` (line 1788). `collapseAll` → `treeClosed: { app:false, dep:true, svc:true, rs:true }` (1789) — i.e. app stays open, everything under it collapses.

### Tree-vs-graph toggle (lines 733–736)
`<div class="seg" style="height:24px;">` containing two buttons: **`Graph`** then **`Tree`**.

`segOpt(on, first)` (line 1785):
```
display:inline-flex; align-items:center; border:0;
{first ? "" : "border-left:1px solid rgba(29,31,32,0.16);"}
padding:0 9px; height:100%; font:inherit; font-size:11px; cursor:pointer;
background:{on ? #5980a6 : transparent}; color:{on ? #f2f2f3 : #5d5d60};
```
- `graphSegStyle = segOpt(rv === "graph", true)` — no left border.
- `treeSegStyle  = segOpt(rv === "tree", false)` — 1px left divider.
- Handlers: `setGraph` → `resourceView:"graph"`, `setTree` → `resourceView:"tree"` (1787).

Then the section collapse chevron `{{ sec.graph.btnStyle }}` / `{{ sec.graph.chevron }}`.

**Critical coupling (line 1981):**
```js
isGraphView: rv === "graph" && sec.graph.open,
isTreeView : rv === "tree"  && sec.graph.open
```
Collapsing the section hides *both* bodies; the segmented control and Expand/Collapse buttons remain in the header. Default state (line 1401): `resourceView: "graph"`, `collapsed: {}` (so `sec.graph.open === true`) → **graph is the default view**.

---

## 4. `isTreeView` resource tree (lines 740–763)

Scroll wrapper: `<div style="overflow-x:auto;"><div style="min-width:720px;">`

### Column header row (line 742)
```
display:grid; grid-template-columns:minmax(0,1fr) 92px 84px; align-items:center; gap:12px;
border-bottom:1px solid rgba(29,31,32,0.28); background:#e9e9ea; padding:0 14px; height:28px;
```
Three `.mono` labels, `font-size:9px; letter-spacing:0.14em; color:#5d5d60;`, verbatim and in order: **`RESOURCE`**, **`HEALTH`**, **`SYNC`**.

### Row (lines 748–760; styles from 1769–1779)
`r.rowStyle`:
```
display:grid; grid-template-columns:minmax(0,1fr) 92px 84px; align-items:center; gap:12px;
border-bottom:1px solid rgba(29,31,32,0.10);
background:{n.st === "failed" ? T.failed.fill (#fbe9e8) : "#fff"};
padding:0 14px; height:38px; cursor:pointer;
```
Row click → `open()` sets `panel: n.kind.toUpperCase() + " " + n.name, panelTab: "Diff"` (line 1777).

Column 1 (`display:flex; align-items:center; gap:8px; min-width:0;`), in order:
1. **Indent spacer**: `width:{depth * 22}px; flex:none;` — 22px per depth level (line 1772).
2. **Expander button** (`r.expStyle`, line 1774):
   ```
   display:inline-flex; align-items:center; justify-content:center; width:18px; height:18px; flex:none;
   border:1px solid {kids.length ? rgba(29,31,32,0.16) : transparent};
   background:{kids.length ? "#fff" : "transparent"}; border-radius:2px; padding:0;
   cursor:{kids.length ? "pointer" : "default"}; color:#5d5d60;
   transform:rotate({closed ? -90 : 0}deg); transition:transform .15s;
   ```
   Icon: `icon("chevron", 11)` when it has children, otherwise `null` (leaves render an invisible 18px placeholder that preserves alignment). `toggle` calls `stopPropagation()` then flips `treeClosed[n.id]`.
3. **Status chip**: `chip(T[n.st])` — 16×16 square, glyph inside.
4. **Kind**: `.mono`, `font-size:9px; letter-spacing:0.08em; color:#7a7a7d; width:82px; flex:none;` — `n.kind.toUpperCase()`.
5. **Name**: `.cond`, `font-size:14px; font-weight:600; letter-spacing:0.02em; white-space:nowrap;`
6. **Meta**: `font-size:11px; color:#5d5d60; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`
7. **Child count**: `.mono`, `font-size:9px; color:#98989b; margin-left:auto; padding-left:8px;` — the raw number of direct children, or `""` for leaves.

Column 2: `pill(T[n.st])` with the tone's `label` (`Healthy` / `Degraded` / `Progressing` / `Failed`).
Column 3: `pill(n.sync === "Synced" ? T.healthy : T.degraded)` with text **`Synced`** or **`Drifted`** — note the data says `"OutOfSync"` but the rendered word is **`Drifted`** (line 1771).

### TREE data (lines 1344–1359), verbatim, in render order
| depth | id | kind | name | st | sync | meta | children |
|---|---|---|---|---|---|---|---|
| 0 | `app` | Application | `checkout-api` | degraded | OutOfSync | `release r241 · 14 managed` | 4 |
| 1 | `dep` | Deployment | `checkout-api` | degraded | OutOfSync | `1/3 ready · 4 fields drifted` | 1 |
| 2 | `rs` | ReplicaSet | `checkout-api-7d4f` | progressing | Synced | `2/3 available` | 3 |
| 3 | `p1` | Pod | `checkout-api-7d4f-x9k2` | healthy | Synced | `Running · ip-10-2-31-4` | — |
| 3 | `p2` | Pod | `checkout-api-7d4f-p2vn` | healthy | Synced | `Running · ip-10-2-31-6` | — |
| 3 | `p3` | Pod | `checkout-api-7d4f-m4p1` | **failed** | Synced | `CrashLoopBackOff · 12 restarts` | — |
| 1 | `svc` | Service | `checkout-api` | healthy | Synced | `ClusterIP · 3 endpoints` | 1 |
| 2 | `ing` | Ingress | `checkout-api` | healthy | Synced | `checkout.acme.io · TLS` | — |
| 1 | `cm` | ConfigMap | `checkout-api-env` | degraded | OutOfSync | `2 keys changed outside Paprika` | — |
| 1 | `sec` | Secret | `checkout-api-tls` | healthy | Synced | `kubernetes.io/tls · protected` | — |

Fully expanded = 10 rows. Walk is depth-first pre-order (`walk(nodes, depth)`, lines 1765–1783); collapsed nodes stop recursion but still render themselves.

---

## 5. `isGraphView` resource graph (lines 764–787)

### Canvas
Scroll wrapper `<div style="overflow-x:auto;">` (765), then the canvas (766):
```
position:relative; height:372px; min-width:840px;
background-image:
  linear-gradient(rgba(29,31,32,0.055) 1px, transparent 1px),
  linear-gradient(90deg, rgba(29,31,32,0.055) 1px, transparent 1px);
background-size:22px 22px;
```
→ a **22×22px blueprint grid** at 5.5% ink. Canvas background is the section's white (`background:#fff` on the `<section>`); the grid lines sit on top of white.

### Edges — SVG overlay (lines 767–777)
`<svg viewBox="0 0 840 372" width="840" height="372" style="position:absolute; inset:0;">`

All edges are cubic Béziers of the form `M x1,y1 C x1+30,y1  x2-30,y2  x2,y2` (horizontal S-curve, 30px control-point offset on both sides). Default stroke `rgba(29,31,32,0.32)`, `stroke-width:1`, `fill:none`.

| # | `d` | stroke | width | dasharray | from → to |
|---|---|---|---|---|---|
| 1 | `M186,190 C216,190 216,60 246,60` | rgba(29,31,32,0.32) | 1 | — | Application → Deployment |
| 2 | `M186,190 C216,190 216,170 246,170` | rgba(29,31,32,0.32) | 1 | — | Application → Service |
| 3 | `M186,190 C216,190 216,240 246,240` | rgba(29,31,32,0.32) | 1 | — | Application → ConfigMap |
| 4 | `M186,190 C216,190 216,300 246,300` | rgba(29,31,32,0.32) | 1 | — | Application → Secret |
| 5 | `M416,60 C446,60 446,60 476,60` | rgba(29,31,32,0.32) | 1 | — | Deployment → ReplicaSet (straight) |
| 6 | `M416,170 C446,170 446,170 476,170` | rgba(29,31,32,0.32) | 1 | — | Service → Ingress (straight) |
| 7 | `M646,60 C676,60 676,32 706,32` | rgba(29,31,32,0.32) | 1 | — | ReplicaSet → Pod x9k2 |
| 8 | `M646,60 C676,60 676,92 706,92` | rgba(29,31,32,0.32) | 1 | — | ReplicaSet → Pod p2vn |
| 9 | `M646,60 C676,60 676,152 706,152` | **`#a8443b`** (OXIDE) | **1.4** | **`3 2`** | ReplicaSet → Pod m4p1 (**failed**) |

**Edge-to-failed-node rule:** the single edge terminating on the failed pod is drawn oxide red, 1.4px, dashed `3 2`. All others are hairline neutral. No arrowheads, no markers.

**Anchor geometry** *(derived from the coordinates)*: an edge leaves at `x = node.x + node.w` and enters at `x = node.x` — e.g. Application `16 + 170 = 186`, Deployment column enters at `246`, leaves at `246 + 170 = 416`, next column enters at `476`, leaves at `646`, pod column enters at `706`. The `y` used is `node.y + 20` (node vertical centre for the ~40px-tall boxes): Application `170+20=190`; Deployment `40+20=60`; Service `150+20=170`; ConfigMap `220+20=240`; Secret `280+20=300`; ReplicaSet `40+20=60`; Ingress `150+20=170`; Pods `12+20=32`, `72+20=92`, `132+20=152`. So node height is effectively **40px** and the anchor is the vertical mid-point of each side.

### Nodes (lines 778–786; style built at 1756–1763)
Node markup:
```html
<div onClick="{{ n.open }}" style="{{ n.style }}">
  <span style="{{ n.glyphStyle }}">{{ n.glyph }}</span>
  <span style="min-width:0; flex:1;">
    <span class="mono" style="display:block; font-size:10px; letter-spacing:0.08em; color:#7a7a7d;">{{ n.kind }}</span>
    <span class="cond" style="display:block; font-size:13px; font-weight:600; letter-spacing:0.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ n.name }}</span>
  </span>
  <span style="{{ n.badgeStyle }}">{{ n.badge }}</span>
</div>
```

`n.style` (line 1761):
```
position:absolute; left:{n.x}px; top:{n.y}px; width:{n.w}px; box-sizing:border-box;
display:flex; align-items:center; gap:8px;
border:1px solid {sel ? #a8443b : rgba(29,31,32,0.28)};
outline:{sel ? "2px solid rgba(168,68,59,0.25)" : "none"};
background:#fff; padding:6px 8px; cursor:pointer;
```
- `sel` is computed as `n.name === "…7d4f-m4p1"` (line 1758) — the failed pod is **hard-selected**, giving it an oxide 1px border plus a 2px 25%-opacity oxide outline halo.
- **Node border does NOT vary by health.** Only the selected/failed pod differs. Health shows through the 16×16 `chip()` glyph and the badge colours.
- Node height is not set explicitly — it is `6px + max(16px glyph, 10px kind line + 13px name line) + 6px + 2px border` ≈ **40px** *(derived; matches the 20px edge-anchor offset)*.

`n.glyphStyle` = `chip(T[n.state])` — 16×16 square, `t.line` border, `t.fill` background, `t.c` glyph.

`n.badgeStyle` (line 1760), rendered only when `n.badge` is truthy, else `display:none;`:
```
flex:none; border:1px solid {t.line}; background:{t.fill}; border-radius:2px; padding:1px 5px;
font-family:ui-monospace,monospace; font-size:9px; color:{t.c};
```
→ the badge inherits the node's health tone.

`n.open` (1762): `this.setState({ panel: n.kind + " " + n.name, panelTab: "Diff" })` — `GRAPH.kind` is already uppercase, so no `.toUpperCase()` here (unlike the tree).

### GRAPH data (lines 1331–1342), verbatim
| kind | name | x | y | w | badge | state |
|---|---|---|---|---|---|---|
| `APPLICATION` | `checkout-api` | 16 | 170 | 170 | `r241` | degraded |
| `DEPLOYMENT` | `checkout-api` | 246 | 40 | 170 | `1/3` | degraded |
| `SERVICE` | `checkout-api` | 246 | 150 | 170 | `""` | healthy |
| `CONFIGMAP` | `checkout-api-env` | 246 | 220 | 170 | `drift` | degraded |
| `SECRET` | `checkout-api-tls` | 246 | 280 | 170 | `""` | healthy |
| `REPLICASET` | `checkout-api-7d4f` | 476 | 40 | 170 | `""` | progressing |
| `INGRESS` | `checkout-api` | 476 | 150 | 170 | `""` | healthy |
| `POD` | `…7d4f-x9k2` (U+2026 leading ellipsis) | 706 | 12 | 118 | `""` | healthy |
| `POD` | `…7d4f-p2vn` | 706 | 72 | 118 | `""` | healthy |
| `POD` | `…7d4f-m4p1` | 706 | 132 | 118 | `CLB` | failed |

### Layout algorithm implied by the coordinates *(derived)*
- **Left-to-right layered / Sugiyama-style DAG**, 4 columns.
- Column x positions: `16, 246, 476, 706`. Column pitch = **230px** = node width 170 + **60px** horizontal gutter. Last column narrows to `w:118` so `706 + 118 = 824` fits inside the 840px canvas with a 16px right margin (mirrors the 16px left margin of column 0).
- Within a column, nodes are stacked by y. Column 1 (`246`) uses y `40, 150, 220, 280` — gaps of 110, 70, 60 (non-uniform: the Deployment gets extra headroom because it fans out to the pod column). Column 3 (`706`) uses y `12, 72, 132` — a uniform **60px pitch** (40px box + 20px gutter).
- Parents are **not** vertically centred on their children: the Application sits at y 170 (centre 190) while its children span centres 60→300; the ReplicaSet sits at centre 60 while its pods span 32→152. So the algorithm is "fixed hand-tuned coordinates", not auto-centring.
- Canvas height 372 vs lowest node bottom (`280 + 40 = 320`) leaves 52px for the legend chrome at the bottom-left.
- Everything is a **static, non-interactive canvas** — no pan, no zoom, no drag; the only interaction is clicking a node to open the panel.

### Legend (lines 788–792)
```
position:absolute; left:12px; bottom:12px; display:flex; gap:10px;
background:rgba(242,242,243,0.9); border:1px solid rgba(29,31,32,0.16); padding:4px 9px;
```
Each entry: `display:inline-flex; align-items:center; gap:4px; font-size:10px; color:#5d5d60;` containing `chip(T[k])` then the label text.

`graphLegend` (line 1793) = `["healthy","progressing","degraded","failed"]` → labels **`Healthy`**, **`Progressing`**, **`Degraded`**, **`Failed`**. `missing`/`unknown`/`pending` are **not** in the legend.

---

## 6–9. Right rail (lines 797–849)

Column: `display:flex; flex-direction:column; gap:14px;` — width fixed at **300px** by the parent grid.

Each is `<section class="blueprint" style="background:#fff;">` + 4 corners, with an `<h3 class="cond">` header:
```
margin:0; font-size:14px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase;
```
Header bar: `display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(29,31,32,0.16); padding:6px 8px 6px 12px;` with the 22px collapse chevron on the right.

### 6. `Drilldowns` (lines 799–815, data 1795–1802)
Rows are `<a href="#">`:
```
display:flex; align-items:center; gap:9px; border-bottom:1px solid rgba(29,31,32,0.10);
padding:0 12px; height:33px; font-size:12px; color:#1d1f20; text-decoration:none;
```
Layout: `<span style="width:14px; display:flex;">` glyph, `<span style="flex:1;">` label, `.mono` 10px `#7a7a7d` meta, then a plain `↗` at `font-size:10px; color:#7a7a7d;`.

All glyphs are `icon(name, 14, "#416180")`.

| icon | label (verbatim) | meta |
|---|---|---|
| `gauge` | `Grafana — service overview` | `golden signals` |
| `logs` | `Logs — Loki` | `app=checkout-api` |
| `traces` | `Traces — Tempo` | `p99 3.4s` |
| `book` | `Runbook — payment capture` | `confluence` |
| `users` | `Owning team — payments-core` | `@rmoreau` |
| `coins` | `Cost — 30 day` | `$4,120` |

Footer (line 812): `<div style="padding:8px 12px;">` with `<button class="btn btn-secondary" style="height:26px; width:100%; font-size:11px;">+ Configure links</button>`.

### 7. `Gates & analysis` (lines 817–832, data 1804–1810)
Row: `display:flex; align-items:center; gap:9px; border-bottom:1px solid rgba(29,31,32,0.10); padding:8px 12px;`
- `chip(T[st])` glyph
- middle `flex:1; min-width:0;` with name `display:block; font-size:12px; font-weight:600;` and detail `display:block; font-size:11px; color:#5d5d60;`
- action button `g.actionStyle`:
  ```
  display:inline-flex; align-items:center; height:21px; border:1px solid rgba(29,31,32,0.16);
  background:#fff; border-radius:2px; padding:0 8px; font-size:10px; font-weight:600;
  color:#416180; cursor:pointer;
  ```
  or `display:none;` when `action` is `""`.

| name | detail | st | action |
|---|---|---|---|
| `manual-approval` | `ring 2 · release manager` | degraded | `Approve` |
| `conftest: resource-limits` | `4 rules · all passed` | healthy | (none) |
| `analysis: golden-signals` | `3 of 4 metrics passing` | failed | `View` |
| `sync window` | `open until 18:00 UTC` | healthy | (none) |

### 8. `Source` (lines 834–849, data 1812–1819)
Body: `padding:4px 12px 10px;`
Row: `display:flex; justify-content:space-between; gap:10px; padding:5px 0; border-bottom:1px solid rgba(29,31,32,0.08); font-size:11px;`
- key `color:#5d5d60;`
- value `.mono`, `text-align:right; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`

| key | value |
|---|---|
| `Repository` | `github.com/acme/checkout-api` |
| `Path` | `deploy/chart` |
| `Engine` | `Helm 3.16` |
| `Revision` | `9f3a1c2` |
| `Sync policy` | `auto · self-heal` |
| `Strategy` | `canary 5/10/25/50/75/100` |

---

## 10. `Promotion stages` — full-width section (lines 851–869, data 1821–1827)

`<section class="blueprint" style="background:#fff;">` + 4 corners, below the two-column grid.
Header (853): `padding:6px 10px 6px 14px;` with `<h2 class="cond">` verbatim **`Promotion stages`** (`font-size:16px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase;`) and the collapse chevron.

Grid (855): `display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1px; background:rgba(29,31,32,0.16);` — same hairline-via-gap technique as the timeline.

Cell (`p.cellStyle`, 1827): `background:{st === "healthy" ? "#fff" : T[st].fill}; padding:11px 13px 13px;` — note **no `cursor:pointer`** here (unlike the timeline cells).

Cell internals (857–864):
1. top row `display:flex; align-items:center; justify-content:space-between;` → `.mono` `RING {{ p.ring }}` at `font-size:9px; letter-spacing:0.14em; color:#7a7a7d;` on the left, `chip(T[st])` on the right.
2. `.cond` name — `margin-top:6px; font-size:18px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase;`
3. `.mono` cluster — `margin-top:3px; font-size:10px; color:#7a7a7d;`
4. state — `margin-top:8px; font-size:11px; color:#5d5d60;`

| ring | name | cluster | state (verbatim) | st | cell bg |
|---|---|---|---|---|---|
| 0 | `dev` | `staging-1` | `r241 · synced 41m ago` | healthy | `#fff` |
| 1 | `staging` | `staging-1` | `r241 · synced 38m ago` | healthy | `#fff` |
| 2 | `prod-eu` | `prod-eu-1` | `r241 · canary held at 25%` | degraded | `#fdf2df` |
| 3 | `prod-us` | `prod-us-1` | `r240 · awaiting ring 2` | pending | `transparent` |

---

## 11. Inspector / side panel (lines 872–939)

Gated by `<sc-if value="{{ panelOpen }}">`; `panelOpen = Boolean(this.state.panel)` (line 1982). Opened by clicking a graph node or a tree row; both also force `panelTab: "Diff"`.

### Scrim (line 873)
`<div onClick="{{ closePanel }}" style="position:fixed; inset:0; z-index:60; background:rgba(29,31,32,0.32);"></div>`
`closePanel` = `() => this.setState({ panel: null })`.

### Drawer (line 874)
```
position:fixed; top:0; right:0; bottom:0; z-index:61; width:560px;
display:flex; flex-direction:column; background:#f2f2f3;
border-left:1px solid rgba(29,31,32,0.28); box-shadow:0 12px 32px rgba(43,43,45,0.22);
```
Right-anchored, full-height, **560px wide**, paper background (not white).

### Panel header (lines 875–891)
Bar: `border-bottom:1px solid rgba(29,31,32,0.16); background:#fff; padding:12px 16px;`
Row: `display:flex; align-items:flex-start; justify-content:space-between; gap:12px;`
- `{{ panelKind }}` — `.mono`, `font-size:10px; letter-spacing:0.12em; color:#7a7a7d;` — computed as `panel.split(" ")[0]` (1983), e.g. `POD`.
- `{{ panelName }}` — `.cond`, `margin-top:2px; font-size:22px; font-weight:600; letter-spacing:0.02em;` — `panel.split(" ").slice(1).join(" ")` (1984).
- Tag row `margin-top:6px; display:flex; flex-wrap:wrap; gap:5px;` — each tag `.mono`:
  ```
  border:1px solid rgba(29,31,32,0.16); border-radius:2px; padding:1px 6px;
  font-size:10px; color:#5d5d60; background:#f5f5f8;
  ```
  `panelTags` (1985) is **static**: `"payments"`, `"sync: OutOfSync"`, `"health: Degraded"`, `"restarts: 12"`.
- Right buttons `display:flex; gap:6px; flex:none;`:
  - `Investigate` — `btn btn-secondary`, `height:26px; font-size:11px; background:#fff;`
  - `✕` — `btn btn-secondary`, `height:26px; width:26px; padding:0; background:#fff;`, `onClick={{ closePanel }}`

### Panel tab bar (lines 892–896; styles 1855–1858)
`display:flex; border-bottom:1px solid rgba(29,31,32,0.16); background:#fff; padding:0 16px;`
Tabs in order: **`Diff`**, **`Live`**, **`Desired`**, **`Events`**, **`Logs`**.
```
border:0; background:none; padding:9px 12px; font:inherit; font-size:12px; cursor:pointer;
{active ? "border-bottom:2px solid #5980a6; font-weight:600; color:#1d1f20;" : "color:#5d5d60;"}
```
Routing (1986–1988): `panelIsDiff = tab==="Diff"`; `panelIsEvents = tab==="Events"`; `panelIsLogs = tab==="Logs"`; `panelIsManifest = tab==="Live" || tab==="Desired"` — **Live and Desired render the same manifest block**.

### Panel body (line 897)
`flex:1; overflow:auto; padding:14px 16px;`

#### Diff tab (898–910; data 1829–1853)
Frame: `border:1px solid rgba(29,31,32,0.16); background:#fff;`
Sub-header `display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(29,31,32,0.16); padding:6px 10px;`:
- left `.mono` 10px `#5d5d60`: **`desired ↔ live · 4 changed fields`**
- right `.mono` 10px **`#a8443b`**: **`drift detected 12m ago`**

Diff body `.mono`, `font-size:11px; line-height:1.75;`. Each line:
`<div style="{{ d.style }}"><span style="display:inline-block; width:26px; color:#98989b; text-align:right; margin-right:10px;">{{ d.n }}</span>{{ d.text }}</div>`

`dl()` line styles (1829–1833), each suffixed with `padding:0 10px; white-space:pre;`:
| kind | style prefix |
|---|---|
| `add` | `background:rgba(74,124,82,0.10); color:#2f5237;` |
| `del` | `background:rgba(168,68,59,0.10); color:#7d3129;` |
| `ctx` | `color:#5d5d60;` (no background) |

`diffLines` (1834–1853), verbatim `n` / `text` (the `+`/`-`/` ` sign is baked into the text):
```
18 ctx "  spec:"
19 ctx "    replicas: 3"
20 del "-   replicas: 1"
21 add "+   replicas: 3"
22 ctx "    template:"
23 ctx "      spec:"
24 ctx "        containers:"
25 ctx "        - name: app"
26 del "-         image: ghcr.io/acme/checkout-api:8c22b90"
27 add "+         image: ghcr.io/acme/checkout-api:9f3a1c2"
28 ctx "          resources:"
29 ctx "            limits:"
30 del "-             memory: 512Mi"
31 add "+             memory: 1Gi"
32 ctx "              cpu: \"1\""
33 ctx "          readinessProbe:"
34 del "-           timeoutSeconds: 1"
35 add "+           timeoutSeconds: 3"
```
(18 lines; the `hint-placeholder-count` is 14.)

#### Events tab (911–922; data 1859–1864)
Card: `display:flex; gap:10px; border:1px solid rgba(29,31,32,0.16); background:#fff; padding:9px 11px; margin-bottom:8px;`
- `chip(T[e.st])` glyph
- reason: `display:block; font-size:12px; font-weight:600;`
- message: `display:block; margin-top:2px; font-size:11px; color:#5d5d60;`
- at: `.mono`, `display:block; margin-top:3px; font-size:10px; color:#7a7a7d;`

| reason | message | at | st |
|---|---|---|---|
| `BackOff` | `Back-off restarting failed container app in pod checkout-api-7d4f-m4p1` | `12 × · last 41s ago` | failed |
| `Unhealthy` | `Readiness probe failed: HTTP probe failed with statuscode: 503` | `31 × · last 1m 12s ago` | degraded |
| `Pulled` | `Successfully pulled image ghcr.io/acme/checkout-api:9f3a1c2 in 2.1s` | `1 × · 6m ago` | healthy |
| `Scheduled` | `Successfully assigned payments/checkout-api-7d4f-m4p1 to ip-10-2-31-8` | `1 × · 6m ago` | healthy |

#### Logs tab (923–933)
Dark terminal panel: `border:1px solid rgba(29,31,32,0.16); background:#1d2d3d;` (= `STEEL_9`).
Toolbar `display:flex; align-items:center; gap:8px; border-bottom:1px solid rgba(242,242,243,0.16); padding:6px 10px;`:
- live dot: `width:6px; height:6px; background:#94bce3; animation:blip 1.6s infinite;` (square, no radius)
- `.mono` 10px `#94bce3`: **`live · pod/checkout-api-7d4f-m4p1 · 842 lines`**
- spacer `flex:1`
- `.mono` 10px `rgba(242,242,243,0.6)`: **`pause`**

`<pre class="mono" style="margin:0; padding:11px; font-size:11px; line-height:1.7; color:#dfe6ee; white-space:pre-wrap;">` with `panelLogs` (line 1990), verbatim:
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
(Two spaces between columns; no per-level colouring — the whole block is `#dfe6ee`.)

#### Live / Desired tab (934–936)
`<pre class="mono" style="margin:0; border:1px solid rgba(29,31,32,0.16); background:#fff; padding:12px; font-size:11px; line-height:1.7; white-space:pre-wrap;">` with `panelManifest` (line 1991), verbatim:
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: checkout-api-7d4f-m4p1
  namespace: payments
  labels:
    app.kubernetes.io/name: checkout-api
    paprika.io/release: r241
spec:
  containers:
  - name: app
    image: ghcr.io/acme/checkout-api:9f3a1c2
    resources:
      limits:
        cpu: "1"
        memory: 1Gi
status:
  phase: Running
  containerStatuses:
  - restartCount: 12
    state:
      waiting:
        reason: CrashLoopBackOff
```
No syntax highlighting.

---

## 12. Implementation gotchas noted while reading

1. `isGraphView` / `isTreeView` are `resourceView === X && sec.graph.open` (line 1981) — the collapse chevron and the segmented control are two independent axes that AND together.
2. The tree renders the string **`Drifted`** for any `sync !== "Synced"`, while the underlying data value is `"OutOfSync"` (line 1771). The header badge says `3 OUT OF SYNC`, but the TREE data actually has **3** OutOfSync nodes (`app`, `dep`, `cm`) — consistent.
3. Header status badges (`! DEGRADED`, `3 OUT OF SYNC`) and the `14 managed · 3 drifted` counter are **hard-coded literals**, not derived from `GRAPH`/`TREE`.
4. The "Overview" sub-tab is inside `<sc-if value="{{ true }}">` — permanently active; the other five tabs are inert `<span>`s.
5. Graph node selection is a literal name compare against `"…7d4f-m4p1"` (line 1758) — in a real implementation this should be driven by the open panel / selected id.
6. Node names in `GRAPH` use a leading U+2026 ellipsis (`…7d4f-x9k2`) as a manual truncation; the tree uses the full names.
7. Graph and tree `open()` differ: graph passes `n.kind` (already uppercase), tree passes `n.kind.toUpperCase()`. The panel then splits on the **first space**, so any resource kind containing a space would break `panelKind`/`panelName`.
8. `chip()` squares and `pill()` badges never round beyond 2px; the whole system is square-edged (`.blueprint { border-radius: 0 }`).
9. `graphLegend` omits `missing`/`unknown`/`pending` even though the tone map and the drift queue elsewhere use them.
10. Both the timeline grid and the promotion grid use `gap:1px` over a `rgba(29,31,32,0.16)` background to draw hairlines — not borders on the cells.
