# Design spec — APPLICATIONS list view

Source: `/private/tmp/claude-501/-Users-benebsworth-projects-paprika/844ad4e2-4dd2-4687-a932-9e099bcf1f1c/scratchpad/design/console.dc.html`
Template block: **lines 468–656** (`<sc-if value="{{ isApplications }}">`).
Bindings/logic: `<script type="text/x-dc">` block, **lines 1281–2004**; the Applications-specific
derivations live at **lines 1632–1731**, with shared helpers at **1282–1310** and mock data at **1311–1329**.

Everything is inline `style=""` with literal hex. The only design-system classes used in this view are
`.mono`, `.cond`, `.seg`, `.blueprint`, `.corner`, `.btn`/`.btn-secondary`.

---

## 0. Shared foundations (needed to read the rest)

### Fonts (console.dc.html lines 13–19)
```
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700&family=Barlow:wght@400;500;600&display=swap">
body   { font-family:"Barlow", system-ui, sans-serif; font-size:13px; background:#f2f2f3; color:#1d1f20;
         -webkit-font-smoothing:antialiased; }
.mono  { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.cond  { font-family:"Barlow Condensed", system-ui, sans-serif; }
```
So: `.cond` = Barlow Condensed (all headings/names/numbers), `.mono` = system monospace (all
kickers, IDs, counts, numeric cells), default = Barlow.

### Colour constants (lines 1282–1286)
```
PAPER   #f2f2f3     INK      #1d1f20     MUTED   #5d5d60     FAINT   #7a7a7d
DIV     rgba(29,31,32,0.16)             DIV2    rgba(29,31,32,0.10)
STEEL   #5980a6     STEEL_D  #416180     STEEL_9 #1d2d3d
OCHRE   #b07a2c     OCHRE_T  #8a5f22     OXIDE   #a8443b     OXIDE_T #8e372f
GREEN   #7fae86     GREEN_T  #3f6b48
```
Surface grey used for table/matrix headers and the footer bar: `#e9e9ea`.
Zebra row tint: `#fbfbfc`. Empty-matrix-cell tint: `#f5f5f8`.

### Status tone table — `tones(palette)` (lines 1288–1301)
Each tone is `{ glyph, label, c (text), line (border), fill (background) }`.

| key | glyph (char) | label | c (text) | line (border) | fill (bg) |
|---|---|---|---|---|---|
| `healthy` (palette = `colour`, default) | `✓` U+2713 | `Healthy` | `#3f6b48` | `#7fae86` | `#e6f2e8` |
| `healthy` (palette = `quiet`) | `✓` | `Healthy` | `#4a4a4c` | `#a8a8ab` | `#f0f0f2` |
| `progressing` | `↻` U+21BB | `Progressing` | `#2c455d` | `#8bb0d0` | `#e7f0f8` |
| `degraded` | `!` | `Degraded` | `#8a5f22` | `#e0ad66` | `#fdf2df` |
| `failed` | `×` U+00D7 | `Failed` | `#9c3f39` | `#dd9490` | `#fbe9e8` |
| `missing` | `∅` U+2205 | `Missing` | `#5b5468` | `#aea8bd` | `#efedf4` |
| `unknown` | `?` | `Unknown` | `#5d5d60` | `#c2c2c6` | `#f4f4f6` |
| `pending` | `·` U+00B7 | `Pending` | `#8e8e92` | `#d4d4d7` | `transparent` |

Only the `healthy` row changes with the `statusPalette` prop. All other tones are fixed.

### `chip(t)` — the 16px square status glyph (line 1304)
```
display:inline-flex; align-items:center; justify-content:center;
width:16px; height:16px; flex:none;
border:1px solid {t.line}; background:{t.fill}; color:{t.c};
font-size:10px; font-weight:700; line-height:1;
```
**Square — no border-radius.**

### `pill(t)` — the status badge (line 1307)
```
display:inline-flex; align-items:center; gap:5px;
border:1px solid {t.line}; background:{t.fill}; border-radius:2px;
padding:1px 7px; font-size:10px; font-weight:600;
letter-spacing:0.04em; text-transform:uppercase; color:{t.c};
```
So badge text is rendered UPPERCASE via CSS from mixed-case source labels ("Healthy" → `HEALTHY`).
2px radius, hairline border, tinted fill.

### `mixBar(list)` (lines 1535–1538)
Returns one style string per non-zero health bucket, **in fixed order**:
`failed, missing, degraded, progressing, unknown, healthy`.
Each segment: `flex:{n}; background:{T[k].line};` — i.e. the *border* colour is used as the solid fill.
Empty buckets are dropped entirely.

### Props / density (line 1281 `data-props`, consumed at 1416–1419)
| prop | editor | options | default | section |
|---|---|---|---|---|
| `density` | enum | `compact`, `comfortable` | `compact` | Table |
| `showLifecycleStrip` | boolean | — | `true` | Table |
| `statusPalette` | enum | `colour`, `quiet` | `colour` | Status |

```js
const T = tones(this.props.statusPalette ?? "colour");
const dense = (this.props.density ?? "compact") === "compact";
const rowH = dense ? 42 : 52;
const showStrip = this.props.showLifecycleStrip ?? true;
```
**Density affects row height only** (42px compact / 52px comfortable). It applies to the table body
rows *and* the Queue rows. Header rows (30px), group headers (40px) and footer (auto) never change.

### Mock data — `APPS` (lines 1310–1328)
`OK6 = ["ok","ok","ok","ok","ok","ok"]`. Every record gets a derived
`stage = \`${env} · ring ${ring}\`` (line 1328). 16 records / 11 distinct names:

| # | name | ns | project | health | sync | cluster | env | ring | res | cost | actions | strip |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | checkout-api | payments | payments/core | degraded | out of sync | prod-eu-1 | prod | 2 | 14 | $4.1k | Sync, Roll back | ok,ok,fail,ok,ok,degraded |
| 2 | checkout-api | payments | payments/core | healthy | synced | staging-1 | staging | 1 | 14 | $0.6k | Promote | OK6 |
| 3 | payments-gateway | payments | payments/core | healthy | synced | prod-eu-1 | prod | 2 | 22 | $6.8k | Sync | OK6 |
| 4 | payments-gateway | payments | payments/core | healthy | synced | prod-us-1 | prod | 3 | 22 | $6.4k | Sync | OK6 |
| 5 | ledger-worker | payments | payments/core | progressing | synced | staging-1 | staging | 1 | 9 | $0.9k | Approve | ok,ok,ok,ok,run,pend |
| 6 | fraud-scorer | payments | payments/risk | healthy | synced | prod-us-1 | prod | 3 | 16 | $5.3k | Sync | OK6 |
| 7 | fraud-scorer | payments | payments/risk | healthy | synced | staging-1 | dev | 0 | 16 | $0.4k | Promote | OK6 |
| 8 | notifications | platform | platform/shared | degraded | out of sync | prod-us-1 | prod | 3 | 11 | $1.7k | Sync, Retry | ok,ok,ok,ok,degraded,pend |
| 9 | auth-service | platform | platform/shared | healthy | synced | prod-us-1 | prod | 3 | 17 | $3.2k | Sync | OK6 |
| 10 | auth-service | platform | platform/shared | healthy | synced | prod-eu-1 | prod | 2 | 17 | $3.0k | Sync | OK6 |
| 11 | search-indexer | search | platform/shared | healthy | synced | prod-eu-1 | prod | 2 | 8 | $1.1k | Sync | OK6 |
| 12 | web-frontend | web | web/storefront | healthy | synced | prod-eu-1 | prod | 2 | 12 | $2.0k | Sync, Roll back | OK6 |
| 13 | web-frontend | web | web/storefront | progressing | synced | staging-1 | staging | 1 | 12 | $0.3k | Promote | ok,ok,ok,ok,run,pend |
| 14 | cms-preview | web | web/storefront | healthy | synced | staging-1 | dev | 0 | 5 | $0.2k | Sync | OK6 |
| 15 | reporting-etl | data | data/analytics | missing | out of sync | prod-us-1 | staging | 1 | 6 | $2.4k | Sync | fail,pend,pend,pend,pend,pend |
| 16 | warehouse-sync | data | data/analytics | healthy | synced | prod-us-1 | prod | 3 | 9 | $3.9k | Sync | OK6 |

`HEALTH_RANK = { failed:0, missing:1, degraded:2, progressing:3, unknown:4, healthy:5 }` (line 1329).

### Scope + sort
- `scopedApps` (lines 1468–1471) = `APPS` filtered by `state.scope.{project,cluster,stage}`, each
  defaulting to `"All"` → **all 16 records by default**. (Scope is driven by the global scope bar
  above this view, not by anything inside it.)
- `sortedScoped` (line 1656) = `scopedApps` sorted by `HEALTH_RANK[health]` ascending, then
  `name.localeCompare`. **Worst health first.**

Resulting default order: `reporting-etl`, `checkout-api@prod-eu-1`, `notifications`,
`ledger-worker`, `web-frontend@staging-1`, then the healthy block alphabetically
(`auth-service`×2, `checkout-api@staging-1`, `cms-preview`, `fraud-scorer`×2,
`payments-gateway`×2, `search-indexer`, `warehouse-sync`, `web-frontend@prod-eu-1`).

### View / group state (lines 1401–1403)
```js
state = { …, view: "Table", groupBy: "project", groupClosed: {}, scope: {project:"All", cluster:"All", stage:"All"}, … }
```
Defaults: **presentation = Table, group by = Project.**

Flags exported (line 1998):
`isTable: view==="Table"`, `isTreemap: view==="Treemap"`, `isMatrix: view==="Matrix"`, `isQueue: view==="Queue"`.

---

## 1. Page header (lines 470–493)

Outer row (line 470):
```
display:flex; align-items:flex-end; justify-content:space-between; gap:20px; padding:18px 22px 14px;
```

**Left block (471–474)**
- Kicker: `<div class="mono" style="font-size:9px; letter-spacing:0.2em; color:#597ea3;">` — literal text **`FLEET INVENTORY`** (uppercase in the source).
- Title: `<h1 class="cond" style="margin:4px 0 0; font-size:30px; font-weight:600; letter-spacing:0.01em; line-height:1;">` — literal text **`Applications`**.

**Right block (475–492)** — `display:flex; align-items:center; gap:14px; flex-wrap:wrap; justify-content:flex-end;`
Two labelled segment groups, each wrapped in `<span style="display:flex; align-items:center; gap:8px;">`:

1. Label `GROUP BY` — `class="mono"`, `font-size:9px; letter-spacing:0.14em; color:#7a7a7d; white-space:nowrap;` (line 477).
   Then `<div class="seg" style="height:30px;">` (line 478).
2. Label `VIEW` — `class="mono"`, `font-size:9px; letter-spacing:0.14em; color:#7a7a7d;` (line 486).
   Then `<div class="seg" style="height:30px;">` (line 487).

`.seg` (styles.css 192–195 + the square override at 281):
```
display:inline-flex; overflow:hidden; border:1px solid var(--color-divider); border-radius:0;
```
`--color-divider = color-mix(in srgb, #1d1f20 16%, transparent)` ≈ `rgba(29,31,32,0.16)`.
Both segment bars are forced to **height:30px**.

---

## 2. Group-by chips — `groupChips` (template 479–481; logic 1650–1655)

Four buttons, in this order, with these exact labels:

| key | label |
|---|---|
| `none` | `None` |
| `project` | `Project` |
| `cluster` | `Cluster` |
| `stage` | `Stage` |

Per-button style (line 1654):
```
display:inline-flex; align-items:center;
border:0;
{k === "none" ? "" : "border-left:1px solid rgba(29,31,32,0.16);"}
padding:0 11px; height:100%;
font:inherit; font-size:11px; font-weight:600; cursor:pointer;
background:{active ? #5980a6 : transparent};
color:{active ? #f2f2f3 : #5d5d60};
white-space:nowrap;
```
Active = `state.groupBy === k`. Font inherits Barlow (no `.mono`/`.cond`).
No hover state is defined for these buttons.

`groupKeyOf(a)` (line 1651): `project → a.project`, `cluster → a.cluster`, `stage → a.env`,
`none → "all"`.
`groupOrder` (line 1665): when grouping by stage the order is fixed **`["prod","staging","dev"]`**;
otherwise the distinct keys sorted alphabetically.

---

## 3. Presentation switcher — `presentations` (template 487–490; logic 1632–1636)

Four buttons, **in this order** (note: Table is third, not first):

`Treemap` · `Matrix` · `Table` · `Queue`

Per-button style (line 1635):
```
display:inline-flex; align-items:center;
border:0;
{label === "Treemap" ? "" : "border-left:1px solid rgba(29,31,32,0.16);"}
padding:0 14px;
font:inherit; font-family:'Barlow',sans-serif; font-size:12px; font-weight:600; cursor:pointer;
background:{active ? #5980a6 : transparent};
color:{active ? #f2f2f3 : #5d5d60};
```
Active = `state.view === label`. Note the explicit `font-family:'Barlow',sans-serif` here (the
group-by chips omit it) and the slightly larger `12px` / wider `0 14px` padding.

---

## 4. Filter toolbar (lines 495–505) — shared by all four presentations

Container (line 495):
```
display:flex; align-items:center; gap:10px;
border-top:1px solid rgba(29,31,32,0.16);
border-bottom:1px solid rgba(29,31,32,0.16);
background:#fff; padding:0 22px; height:40px;
```

Contents, left → right:
1. Search icon (line 496): inline `<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
   stroke="#7a7a7d" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` with
   `<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>` (lucide `search`).
2. `<input type="search">` (line 497), placeholder **`name, project, cluster, revision…`**
   (with a real U+2026 ellipsis), style `width:280px; border:0; background:none; font:inherit;
   font-size:13px; outline:none;`.
3. Vertical rule (line 498): `width:1px; height:20px; background:rgba(29,31,32,0.16);`.
4. `facetChips` loop (lines 499–501) — see below.
5. Spacer `<span style="flex:1;">` (line 502).
6. `scopedCount` (line 504): `class="mono"`, `font-size:10px; color:#5d5d60;`.

### `facetChips` (lines 1638–1646)
Chip markup: `{{ f.label }} <span class="mono" style="opacity:.6; font-size:10px;">{{ f.count }}</span>`

Chip style factory (line 1638):
```
border:1px solid {on ? #5980a6 : rgba(29,31,32,0.16)};
background:{on ? #eef6ff : #fff};
border-radius:2px; padding:3px 9px;
font:inherit; font-size:11px;
color:{on ? #2c455d : #5d5d60};
cursor:pointer;
```

| label (verbatim) | count | on? |
|---|---|---|
| `Degraded` | 4 | **true** |
| `Out of sync` | 8 | **true** |
| `Failed` | 2 | false |
| `prod` | 25 | false |
| `Helm` | 33 | false |
| `Blocked gate` | 2 | false |

These are static mock values — they are NOT derived from `APPS`. No click handler is wired.

### `scopedCount` (line 1999)
```js
`${scopedApps.length} targets · ${new Set(scopedApps.map(a => a.name)).size} apps in scope`
```
Default render: **`16 targets · 11 apps in scope`**.

---

## 5. Presentation A — `isTable` (lines 507–573)

Wrappers: `<div style="overflow-x:auto;">` (508) → `<div style="min-width:1220px;">` (509).
So the table has a **hard 1220px minimum width and scrolls horizontally** below that.

### 5.1 Column grid (identical on header row 510 and body rows, line 1689)
```
grid-template-columns: minmax(190px,1.3fr) 120px minmax(120px,1fr) 92px 88px 150px 74px 78px 118px;
align-items:center; gap:12px; padding:0 22px;
```
Nine columns, in order:

| # | Header text (verbatim) | Track | Align | Cell content |
|---|---|---|---|---|
| 1 | `APPLICATION` | `minmax(190px,1.3fr)` | left | glyph chip + name, second line = `ns/name` |
| 2 | `PROJECT` | `120px` | left | `row.project`, mono, ellipsised |
| 3 | `TARGET` | `minmax(120px,1fr)` | left | cluster (cond) over stage (mono) |
| 4 | `HEALTH` | `92px` | left | health pill |
| 5 | `SYNC` | `88px` | left | sync pill |
| 6 | `LIFECYCLE` | `150px` | left | 6-cell lifecycle strip |
| 7 | `RES` | `74px` | **right** (`text-align:right` on header *and* cell) | `row.resources` |
| 8 | `COST/MO` | `78px` | **right** | `row.cost` |
| 9 | `ACTIONS` | `118px` | left | action chips |

### 5.2 Header row (lines 510–520)
Container (510):
```
display:grid; grid-template-columns:<above>; align-items:center; gap:12px;
border-bottom:1px solid rgba(29,31,32,0.28);   ← note 0.28, heavier than the body dividers
background:#e9e9ea; padding:0 22px; height:30px;
```
Every header cell (511–519):
```html
<span class="mono" style="font-size:9px; letter-spacing:0.14em; color:#5d5d60;">…</span>
```
plus `text-align:right;` on `RES` (517) and `COST/MO` (518). Labels are already uppercase in the
source — no `text-transform`. **`ACTIONS` has a visible header label** (line 519).

### 5.3 Group headers — `inventoryGroups[].isGroup` (template 524–536; logic 1657–1681)

Rendered only when `grp.isGroup`, i.e. `groupBy !== "none"` (line 1672). Wrapper `<sc-for
list="{{ inventoryGroups }}" as="grp">` at line 522, each group in its own `<div>` (523).

`headStyle` (line 1678):
```
display:flex; align-items:center; gap:12px;
border-bottom:1px solid rgba(29,31,32,0.16);
border-top:1px solid rgba(29,31,32,0.16);
background:{T[worst].fill};        ← tinted by the WORST health in the group
padding:0 22px; height:40px; cursor:pointer;
```
`worst` = the lowest `HEALTH_RANK` in the group (line 1670). Whole bar toggles `grp.toggle`.

Children, left → right (header markup is lines 525–535):
1. **Chevron button** (526) — `chevStyle` (1676):
   `display:inline-flex; align-items:center; justify-content:center; width:20px; height:20px;
   border:1px solid rgba(29,31,32,0.16); background:#fff; border-radius:2px; padding:0;
   cursor:pointer; color:#5d5d60; transform:rotate({closed ? -90 : 0}deg); transition:transform .15s;`
   Icon = lucide `chevron` `<path d="m6 9 6 6 6-6"/>` at **11px**, `stroke-width:1.5`,
   `stroke:currentColor`, `fill:none` (icon helper at 1396–1397, path at 1382).
2. **Status glyph** (527) — `chip(T[worst])` with `T[worst].glyph` (16×16 square).
3. **Kicker** (528) — `class="mono" font-size:9px; letter-spacing:0.14em; color:#7a7a7d`.
   Value from line 1673: `PROJECT` / `CLUSTER` / `STAGE` / `""` (when groupBy = none).
4. **Group label** (529) — `class="cond" font-size:17px; font-weight:600; letter-spacing:0.03em`.
   Value = the group key, or literally **`All applications`** when `groupBy === "none"` (1672).
5. **Meta line** (530) — `font-size:11px; color:#5d5d60` (default Barlow).
   Built by `groupMeta` (1657–1664), joined with `" · "`:
   `"{n} target{s}"`, `"{m} apps"`, then `"{k} unhealthy"` if any `HEALTH_RANK < 3`,
   then `"{d} drifted"` if any `sync !== "synced"`.
   *Note the asymmetric pluralisation: `target`/`targets` is pluralised, `apps` never is.*
6. Flex spacer (531).
7. **Mix bar** (532–534) — `display:flex; width:160px; height:8px; gap:1px;` with one
   `<span style="{{ m }}">` per `mixBar` segment (see §0).

Default render (groupBy = project), 5 groups in alphabetical order:

| group | worst → header tint | kicker | label | meta (verbatim) |
|---|---|---|---|---|
| data/analytics | `missing` → `#efedf4` | `PROJECT` | `data/analytics` | `2 targets · 2 apps · 1 unhealthy · 1 drifted` |
| payments/core | `degraded` → `#fdf2df` | `PROJECT` | `payments/core` | `5 targets · 3 apps · 1 unhealthy · 1 drifted` |
| payments/risk | `healthy` → `#e6f2e8` | `PROJECT` | `payments/risk` | `2 targets · 1 apps` |
| platform/shared | `degraded` → `#fdf2df` | `PROJECT` | `platform/shared` | `4 targets · 3 apps · 1 unhealthy · 1 drifted` |
| web/storefront | `progressing` → `#e7f0f8` | `PROJECT` | `web/storefront` | `3 targets · 2 apps` |

**Exact template structure (lines 507-573):**
```
507  <sc-if value="{{ isTable }}" hint-placeholder-val="{{ true }}">
508    <div style="overflow-x:auto;">
509      <div style="min-width:1220px;">
510        ... header row (510-520) ...
522        <sc-for list="{{ inventoryGroups }}" as="grp" hint-placeholder-count="3">
523          <div>
524            <sc-if value="{{ grp.isGroup }}">
525              <div onClick="{{ grp.toggle }}" style="{{ grp.headStyle }}">   ... 525-535 ...
536            </sc-if>
537            <sc-if value="{{ grp.open }}" hint-placeholder-val="{{ true }}">
538              <sc-for list="{{ grp.rows }}" as="row" hint-placeholder-count="4">
539                <div onClick="{{ row.open }}" style="{{ row.rowStyle }}">    ... cells 540-565 ...
566                </div>
567              </sc-for>
568            </sc-if>
569          </div>
570        </sc-for>
571      </div>
572    </div>
573  </sc-if>
```
`grp.open = !state.groupClosed[key]` (lines 1669/1672) -> **all groups start open**.

### 5.4 Body row (template 539-566; logic 1682-1695)

`rowStyle` (line 1689):
```
display:grid;
grid-template-columns:minmax(190px,1.3fr) 120px minmax(120px,1fr) 92px 88px 150px 74px 78px 118px;
align-items:center; gap:12px;
border-bottom:1px solid rgba(29,31,32,0.10);      ← DIV2, lighter than the header rule
background:{i % 2 ? "#fbfbfc" : "#fff"};          ← zebra, index is per-GROUP not global
padding:0 22px;
height:{42 | 52}px;                               ← density
cursor:pointer;
```
`onClick = row.open = openApp` (line 1421) → `setState({ screen:"appDetail", panel:null })`.
**No hover style is defined anywhere in this view** (grep: the only `:hover` rules in the document
are the global `a:hover` at line 17 and the `.btn-secondary:hover` in styles.css).

Cell-by-cell:

**1. APPLICATION (530–546)**
```html
<span style="min-width:0;">
  <span style="display:flex; align-items:center; gap:7px;">
    <span style="{{ row.glyphStyle }}">{{ row.glyph }}</span>     <!-- chip(T[health]) 16×16 -->
    <span class="cond" style="font-size:15px; font-weight:600; letter-spacing:0.02em;
                              white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ row.name }}</span>
  </span>
  <span class="mono" style="display:block; padding-left:19px; font-size:10px; color:#7a7a7d;">{{ row.id }}</span>
</span>
```
`row.id = a.ns + "/" + a.name` (line 1686), e.g. `payments/checkout-api`.
The `padding-left:19px` on the id line = 16px chip + 3px, aligning it under the name (gap is 7px, so
this is deliberately 3px short of a perfect 23px alignment — reproduce the 19px literally).

**2. PROJECT (547)**
```html
<span class="mono" style="font-size:11px; color:#5d5d60; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{{ row.project }}</span>
```

**3. TARGET (548–551)**
```html
<span style="min-width:0;">
  <span class="cond" style="display:block; font-size:14px; font-weight:500; letter-spacing:0.02em;">{{ row.cluster }}</span>
  <span class="mono" style="display:block; font-size:10px; color:#7a7a7d;">{{ row.stage }}</span>
</span>
```
`row.stage` is `"{env} · ring {ring}"`, e.g. `prod · ring 2`, `dev · ring 0`.
Note weight **500** here vs 600 for the app name.

**4. HEALTH (552)** — `<span><span style="{{ row.healthStyle }}">{{ row.health }}</span></span>`
`row.health = T[a.health].label` (`Healthy`/`Progressing`/`Degraded`/`Missing`/…), `healthStyle = pill(T[a.health])`.
Renders uppercase via `text-transform:uppercase` in `pill()`.

**5. SYNC (553)** — same shape.
`row.sync = a.sync === "synced" ? "Synced" : "Drifted"` (line 1687) — the label is **`Drifted`**, not "OutOfSync".
`syncStyle = pill(syncOk ? T.healthy : T.degraded)` — i.e. drift is styled with the **degraded ochre**
tone (`#8a5f22` on `#fdf2df`, border `#e0ad66`), not a dedicated sync colour.

**6. LIFECYCLE (554–558)**
```html
<span style="display:flex; gap:2px;">
  <sc-for list="{{ row.strip }}" as="c"><span style="{{ c.style }}" title="{{ c.title }}"></span></sc-for>
</span>
```
Logic (1690–1693), gated on `showLifecycleStrip`; when false `row.strip = []` and the column renders
empty (the grid track stays 150px).
Each of the 6 cells:
```
width:20px; height:16px; border:1px solid {t.line}; background:{k === "pend" ? "transparent" : t.fill};
```
6×20 + 5×2 gap = **130px**, inside the 150px track.
Stage → tone map (line 1648): `ok → healthy`, `fail → failed`, `degraded → degraded`,
`run → progressing`, `pend → pending`.
Stage names (line 1649): **`["source","build","test","render","deploy","verify"]`**.
`title` = `"{stageName} · {tone.label}"`, e.g. `test · Failed`, `verify · Degraded`,
`deploy · Progressing`, `build · Pending`. These `title` attributes are the only tooltips in the view.

**7. RES (559)**
```html
<span class="mono" style="font-size:11px; text-align:right; font-variant-numeric:tabular-nums;">{{ row.resources }}</span>
```
`row.resources = a.res` — a bare integer, **no unit suffix** (e.g. `14`). Inherits default ink colour.

**8. COST/MO (560)**
```html
<span class="mono" style="font-size:11px; text-align:right; color:#5d5d60; font-variant-numeric:tabular-nums;">{{ row.cost }}</span>
```
`row.cost` is a pre-formatted string like `$4.1k`. **Muted `#5d5d60`** — unlike RES.

**9. ACTIONS (561–565)**
```html
<span style="display:flex; gap:5px;">
  <sc-for list="{{ row.actions }}" as="a">
    <span style="display:inline-flex; align-items:center; height:21px;
                 border:1px solid rgba(29,31,32,0.16); border-radius:2px; padding:0 7px;
                 font-size:10px; color:#424244; background:#fff;">{{ a }}</span>
  </sc-for>
</span>
```
They are **`<span>`s, not buttons** — no click handler, no hover. 1 or 2 per row.
Verbatim action labels present in the data: `Sync`, `Roll back`, `Promote`, `Approve`, `Retry`.

### 5.5 Empty state
There is **no empty state** for the table. If a group has zero rows it is dropped upstream
(`if (!list.length) return null;` at line 1668, then `.filter(Boolean)` at 1681), and there is no
"no results" branch anywhere in the Applications template.

---

## 6. Presentation B — `isTreemap` (lines 575–600; logic 1697–1705)

Outer container (576): `padding:16px 22px; display:flex; flex-direction:column; gap:14px;`

One `<section class="blueprint" style="background:#fff;">` per group (578), each carrying the four
corner marks (579): `<i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>`.
`.blueprint > .corner` (styles.css 83–95): 11×11px, colour `color-mix(in srgb, #1d1f20 55%, transparent)`,
drawn as two 1px rules (`::before` vertical at `left:5px`, `::after` horizontal at `top:5px`),
positioned `-6px` outside each corner.

**Section head (580–584)**
```
display:flex; align-items:baseline; gap:10px;
border-bottom:1px solid rgba(29,31,32,0.16); padding:7px 12px;
```
- `{{ g.kicker }}` — `class="mono" font-size:9px; letter-spacing:0.14em; color:#597ea3;`
  (**note: `#597ea3` steel-600 here, vs `#7a7a7d` on the table group header**)
- `{{ g.label }}` — `class="cond" font-size:16px; font-weight:600; letter-spacing:0.03em;`
- `{{ g.meta }}` — `font-size:11px; color:#5d5d60;`

`tmGroups` (1697–1698) reuses the same `label / meta / isGroup / kicker` values as the table groups.
There is no chevron/collapse and no mix bar in the treemap head.

**Tile container (585)**: `display:flex; flex-wrap:wrap; gap:4px; padding:8px;`

**Tile (587–593)**, style from line 1703, with `w = Math.max(150, Math.round(a.res * 9))` (line 1701):
```
flex:{a.res} 1 {w}px;
min-width:{w}px; min-height:66px; box-sizing:border-box;
border:1px solid {t.line}; background:{t.fill};
padding:7px 9px; cursor:pointer; color:{t.c};
```
So **tile size is driven by managed-resource count** (`flex-grow: res`, basis `max(150, res*9)`) and
**fill/border/text colour by health**. Concrete widths from the data: res 5,6,8,9,11,12,14,16 all
clamp to `150px`; res 17 → `153px`; res 22 → `198px`.

Tile contents:
- Line 1 (588): `class="cond" font-size:14px; font-weight:600; letter-spacing:0.02em; white-space:nowrap;
  overflow:hidden; text-overflow:ellipsis;` rendering `{{ t.glyph }} {{ t.name }}` — the status glyph
  character followed by a space and the app name (glyph is *inline text here*, not a chip).
- Line 2 (589): `margin-top:4px; display:flex; justify-content:space-between; gap:8px;`
  - `{{ t.sub }}` — `class="mono" font-size:10px; opacity:.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`
    Value = `` `${a.cluster} · ${a.stage}` `` → e.g. `prod-eu-1 · prod · ring 2`.
  - `{{ t.res }}` — `class="mono" font-size:9px; opacity:.75; white-space:nowrap;`
    Value = `` `${a.res} res` `` → e.g. `14 res`.

`onClick = t.open = openApp`.

**Caption (598)**, verbatim, `margin:0; font-size:11px; color:#5d5d60;`:
> Tiles are sized by managed resource count; the fill is the target's health. Switch *Group by* to re-partition by project, cluster or stage.

(`Group by` is wrapped in `<em>`.)

---

## 7. Presentation C — `isMatrix` (lines 602–630; logic 1707–1724)

Outer (603): `padding:16px 22px;`
One `<section class="blueprint" style="background:#fff;">` (604) with the four corner marks (605).

**Grid (606)** — `matrix.colStyle` (line 1713):
```
display:grid; grid-template-columns:150px repeat({nCols},minmax(0,1fr));
gap:1px; background:rgba(29,31,32,0.16);
```
The 1px gap over the divider-coloured background *is* the grid rule — cells paint their own white/grey.

**Corner cell (607)**: `background:#e9e9ea; display:flex; align-items:center; padding:0 12px;`
containing `class="mono" font-size:9px; letter-spacing:0.14em; color:#5d5d60;` with the literal text
`{{ matrix.rowLabel }} ↓ · CLUSTER →` (U+2193 down arrow, U+00B7, U+2192 right arrow).
`matrix.rowLabel` (1711) = `"STAGE"` when groupBy is `cluster` or `stage`, else `"PROJECT"`.

**Column headers (608–610)**: `background:#e9e9ea; padding:8px 12px;` with
`class="cond" font-size:15px; font-weight:600; letter-spacing:0.04em;`.
`matrix.cols` (1707/1712) = distinct `scopedApps` clusters, sorted → default
**`prod-eu-1`, `prod-us-1`, `staging-1`** (3 columns).

**Row headers (612)**: `background:#e9e9ea; display:flex; align-items:center; padding:0 12px;` with
`class="cond" font-size:14px; font-weight:600; letter-spacing:0.03em; overflow:hidden;
text-overflow:ellipsis; white-space:nowrap;`.
`matrix.rows` (1708) = fixed `["prod","staging","dev"]` when groupBy = stage; otherwise distinct
`a.env` (when groupBy = cluster) or distinct `a.project`, sorted. Default (groupBy = project) →
**`data/analytics`, `payments/core`, `payments/risk`, `platform/shared`, `web/storefront`**.
Row key function `mxRowKey` (1709): `cluster → a.env`, `stage → a.env`, else `a.project`.

**Cell (614–621)**, style from line 1721:
```
background:{list.length ? "#fff" : "#f5f5f8"};   ← EMPTY intersections are shaded #f5f5f8
padding:10px 12px; min-height:64px;
```
Cells are **not clickable** (no onClick).

Cell contents:
- Row 1 (615–618): `display:flex; align-items:baseline; gap:8px;`
  - count — `class="cond" font-size:20px; font-weight:600; font-variant-numeric:tabular-nums;`
    Value = `String(list.length)`, or the literal **em-dash `—` (U+2014)** when empty (line 1719).
  - apps — `class="mono" font-size:10px; color:#7a7a7d;`
    Value = `` `${distinctNames} apps` `` — **always rendered, even when empty** (`0 apps`).
- Row 2 (619–620): `margin-top:6px; display:flex; flex-wrap:wrap; gap:4px;`
  One `pill(T[k])` per non-empty health bucket, in fixed order
  **`failed, missing, degraded, progressing, healthy`** (line 1718 — note `unknown` is *not* in the
  matrix bucket list, unlike `mixBar`). Pill label = `` `${T[k].glyph} ${n}` `` e.g. `✓ 2`, `! 1`, `∅ 1`.

**Caption (627)**, `margin:12px 0 0; font-size:11px; color:#5d5d60;`, verbatim:
> Rows follow *Group by* (project, or stage when grouping by cluster/stage); columns are always clusters. Empty intersections are shaded.

(`Group by` in `<em>`.)

---

## 8. Presentation D — `isQueue` (lines 631–649; logic 1726–1731)

A flat, ungrouped, worst-first work queue. **No `blueprint` frame, no group headers.**

### 8.1 Column grid (header 632 and rows 1730 use the same tracks)
```
grid-template-columns: 28px 16px minmax(0,1.2fr) minmax(0,1fr) 140px minmax(0,1fr);
align-items:center; gap:12px;
padding:0 22px 0 19px;     ← left padding 19px, not 22px, to absorb the 3px left accent border
```

| # | Header text | Track | Cell |
|---|---|---|---|
| 1 | `#` | `28px` | `q.rank` |
| 2 | *(empty header cell)* | `16px` | status chip |
| 3 | `APPLICATION` | `minmax(0,1.2fr)` | name + id |
| 4 | `TARGET` | `minmax(0,1fr)` | `q.target` |
| 5 | `PROJECT` | `140px` | `q.project` |
| 6 | `WHY` | `minmax(0,1fr)` | `q.reason` |

Header (632–638): `border-bottom:1px solid rgba(29,31,32,0.28); background:#e9e9ea; height:30px;`
Header cells: `class="mono" font-size:9px; letter-spacing:0.14em; color:#5d5d60;`.
Line 633 emits `#` followed immediately by an **empty `<span></span>`** for the glyph column.

### 8.2 Row (640–647), style from line 1730
```
display:grid; grid-template-columns:28px 16px minmax(0,1.2fr) minmax(0,1fr) 140px minmax(0,1fr);
align-items:center; gap:12px;
border-bottom:1px solid rgba(29,31,32,0.10);
border-left:3px solid {t.line};                  ← health-coloured left accent on EVERY row
background:{i < 3 ? t.fill : "#fff"};            ← only the TOP 3 rows are tinted
padding:0 22px 0 19px;
height:{42 | 52}px;                              ← same density variable as the table
cursor:pointer;
```
`onClick = q.open = openApp`.

Cells:
1. **Rank (641)** — `class="mono" font-size:10px; color:#8e8e92;`
   Value = `String(i+1).padStart(2,"0")` → `01`, `02`, `03`, …
2. **Glyph (642)** — `chip(T[health])`, the 16×16 square.
3. **Application (643)** — `<span style="min-width:0;">` containing
   `class="cond" display:block; font-size:15px; font-weight:600; letter-spacing:0.02em;` (name) over
   `class="mono" display:block; font-size:10px; color:#7a7a7d;` (`ns/name`).
4. **Target (644)** — `class="mono" font-size:11px; color:#424244;` value `` `${cluster} · ${stage}` ``
   e.g. `prod-eu-1 · prod · ring 2`. (Darker `#424244` than the project column.)
5. **Project (645)** — `class="mono" font-size:11px; color:#5d5d60;`
6. **Why (646)** — `font-size:11.5px; color:#5d5d60;` (default Barlow, note the **11.5px**).

### 8.3 Row set and `reason` strings (line 1726–1728)
Filter: `a.health !== "healthy" || a.sync !== "synced"`, applied to `sortedScoped` (worst-first).

`reason` is derived, verbatim strings:
| condition | reason |
|---|---|
| `health === "failed"` | `workload failing` |
| `health === "missing"` | `source unreachable` |
| `health === "degraded"` && `sync !== "synced"` | `degraded · drifted` |
| `health === "degraded"` && synced | `degraded` |
| `health === "progressing"` | `rollout in progress` |
| otherwise (healthy but out of sync, unknown) | `drifted` |

Default render — **5 rows**:

| rank | glyph/tone | name | id | target | project | why | bg |
|---|---|---|---|---|---|---|---|
| `01` | `∅` missing | reporting-etl | data/reporting-etl | `prod-us-1 · staging · ring 1` | data/analytics | `source unreachable` | `#efedf4` |
| `02` | `!` degraded | checkout-api | payments/checkout-api | `prod-eu-1 · prod · ring 2` | payments/core | `degraded · drifted` | `#fdf2df` |
| `03` | `!` degraded | notifications | platform/notifications | `prod-us-1 · prod · ring 3` | platform/shared | `degraded · drifted` | `#fdf2df` |
| `04` | `↻` progressing | ledger-worker | payments/ledger-worker | `staging-1 · staging · ring 1` | payments/core | `rollout in progress` | `#fff` |
| `05` | `↻` progressing | web-frontend | web/web-frontend | `staging-1 · staging · ring 1` | web/storefront | `rollout in progress` | `#fff` |

Left accent colours: `#aea8bd`, `#e0ad66`, `#e0ad66`, `#8bb0d0`, `#8bb0d0`.

**Empty state:** none. If nothing matches the filter the queue renders header-only.

---

## 9. Footer bar (lines 651–654) — shared by all four presentations

```
display:flex; align-items:center; justify-content:space-between;
border-top:1px solid rgba(29,31,32,0.16); background:#e9e9ea; padding:10px 22px;
```
- Left (652): `class="mono" font-size:10px; color:#5d5d60;` with
  `{{ scopedCount }} · facets are self-excluding` → default
  **`16 targets · 11 apps in scope · facets are self-excluding`**.
- Right (653): `<button type="button" class="btn btn-secondary" style="height:28px; background:#fff;">`
  with the verbatim label **`Load next 100`**.
  `.btn` (styles.css 140–148 + the square override at 281): `display:inline-flex; align-items:center;
  justify-content:center; gap:6px; font-family:var(--font-heading); font-weight:600; font-size:14px;
  line-height:1.2; color:#1d1f20; border:1px solid var(--color-divider); border-radius:0;
  padding:6.8px 12.24px;` — the inline `height:28px` and `background:#fff` override.
  `.btn-secondary:hover` → `background: color-mix(in srgb, #1d1f20 7%, transparent)`;
  `:active` → 14%.

---

## 10. Cross-cutting notes for implementers

1. **The only interaction states in this view are `cursor:pointer` and the `title` tooltips on the
   lifecycle strip cells.** No hover, focus or selected-row styling is specified for rows, tiles,
   matrix cells, facet chips or action chips.
2. **Every row, tile and queue entry opens the same destination** — `openApp()` sets
   `screen: "appDetail"` (line 1421). Row clicks are not per-cell.
3. Group ordering, group membership and the flat sort are **all recomputed from `groupBy`**; the
   Treemap and the Table share the exact same `groups` array (1666–1681 → 1682, 1697). The Matrix and
   the Queue do *not* use groups (Matrix builds its own row/col axes from `scopedApps`; Queue uses
   the flat `sortedScoped`).
4. **Zebra striping is per-group**, not per-table (`i` is the index inside `g.rows`, line 1682/1689),
   so the first row after every group header is white.
5. Two different divider weights are in play: `rgba(29,31,32,0.28)` under sticky header rows,
   `rgba(29,31,32,0.16)` for section/frame borders, `rgba(29,31,32,0.10)` between body rows.
6. Numeric cells use `font-variant-numeric:tabular-nums` (`RES`, `COST/MO`, matrix count).
7. `RES` shows a bare integer with no unit; `COST/MO` values are pre-formatted strings (`$4.1k`).
8. The sync badge label is **`Drifted`** (not "OutOfSync") and is painted with the **degraded ochre**
   tone, deliberately reusing the warning colour rather than introducing a fourth hue.
9. `statusPalette: "quiet"` desaturates **only** the healthy tone to greys
   (`#4a4a4c` / `#a8a8ab` / `#f0f0f2`) — everything abnormal keeps its colour.
10. Facet chip counts (4, 8, 2, 25, 33, 2) are hard-coded mock values inconsistent with the 16-record
    `APPS` array; they are illustrative of a larger fleet, not derived.
