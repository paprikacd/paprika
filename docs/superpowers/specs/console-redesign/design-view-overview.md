# Design spec — OVERVIEW view (`console.dc.html` lines 96–467)

Source of truth: `/private/tmp/claude-501/-Users-benebsworth-projects-paprika/844ad4e2-4dd2-4687-a932-9e099bcf1f1c/scratchpad/design/console.dc.html`
Template lines cited as `T:nnn`; script (`<script type="text/x-dc">`, lines 1281–2004) cited as `S:nnn`.
Design-system stylesheet: `.../design/styles.css` (cited `C:nnn`).

---

## 0. Global primitives this view depends on

### 0.1 Fonts / helper classes (T:14–25, dc.html `<style>` block)
| Class | Definition |
|---|---|
| `.mono` | `font-family: ui-monospace, SFMono-Regular, Menlo, monospace` |
| `.cond` | `font-family:"Barlow Condensed", system-ui, sans-serif` |
| body default | `font-family:"Barlow", system-ui, sans-serif; font-size:13px; background:#f2f2f3; color:#1d1f20; -webkit-font-smoothing:antialiased` |
| link | `a { color:#416180; text-decoration:none }`, hover `#2c455d` + underline |
| `::selection` | `#d6ebff` |
| scrollbar | 9px; thumb `#c4c4c8`; track `#e9e9ea` |

Google font imports (T:13): `Barlow Condensed` 400/500/600/700 and `Barlow` 400/500/600.

### 0.2 Colour constants (S:1282–1286)
```
PAPER   #f2f2f3      INK    #1d1f20      MUTED  #5d5d60      FAINT  #7a7a7d
DIV     rgba(29,31,32,0.16)              DIV2   rgba(29,31,32,0.10)
STEEL   #5980a6      STEEL_D #416180     STEEL_9 #1d2d3d
OCHRE   #b07a2c      OCHRE_T #8a5f22     OXIDE  #a8443b      OXIDE_T #8e372f
GREEN   #7fae86      GREEN_T #3f6b48
```

### 0.3 Status tone table `T` (S:1288–1301) — `tones("colour")` is the default (`this.props.statusPalette ?? "colour"`, S:1416)
| key | glyph | label | `c` (text) | `line` (border/solid) | `fill` (background) |
|---|---|---|---|---|---|
| `healthy` | `✓` U+2713 | Healthy | `#3f6b48` | `#7fae86` | `#e6f2e8` |
| `progressing` | `↻` U+21BB | Progressing | `#2c455d` | `#8bb0d0` | `#e7f0f8` |
| `degraded` | `!` | Degraded | `#8a5f22` | `#e0ad66` | `#fdf2df` |
| `failed` | `×` U+00D7 | Failed | `#9c3f39` | `#dd9490` | `#fbe9e8` |
| `missing` | `∅` U+2205 | Missing | `#5b5468` | `#aea8bd` | `#efedf4` |
| `unknown` | `?` | Unknown | `#5d5d60` | `#c2c2c6` | `#f4f4f6` |
| `pending` | `·` U+00B7 | Pending | `#8e8e92` | `#d4d4d7` | `transparent` |

There is a `"quiet"` palette variant that only remaps `healthy` to `{ c:#4a4a4c, line:#a8a8ab, fill:#f0f0f2 }` (S:1289–1291). Not used by default.

`HEALTH_RANK` (S:1329): `failed:0, missing:1, degraded:2, progressing:3, unknown:4, healthy:5`. "Unhealthy" everywhere = `HEALTH_RANK < 3`.

### 0.4 Shared style helpers
```js
chip(t)   // S:1303–1305  — 16×16 status square
  display:inline-flex; align-items:center; justify-content:center;
  width:16px; height:16px; flex:none;
  border:1px solid {t.line}; background:{t.fill}; color:{t.c};
  font-size:10px; font-weight:700; line-height:1;

pill(t)   // S:1306–1308  — status pill
  display:inline-flex; align-items:center; gap:5px;
  border:1px solid {t.line}; background:{t.fill}; border-radius:2px;
  padding:1px 7px; font-size:10px; font-weight:600;
  letter-spacing:0.04em; text-transform:uppercase; color:{t.c};

bar(tone)          // S:1476  — lifecycle mini bar: flex:1; height:5px; background:{tone};
mixSeg(frac,tone)  // S:1534  — flex:{frac}; background:{tone};
mixBar(list)       // S:1535–1538 — for each of ["failed","missing","degraded","progressing","unknown","healthy"]
                   //   n = count in list;  emits `flex:{n}; background:{T[k].line};`  (zero counts dropped)
miniSeg(on,first)  // S:1570  — segmented-control button:
  display:inline-flex; align-items:center; border:0;
  {first ? "" : "border-left:1px solid rgba(29,31,32,0.16);"}
  padding:0 9px; height:100%; font:inherit; font-size:10.5px; font-weight:600;
  cursor:pointer; background:{on ? #5980a6 : transparent}; color:{on ? #f2f2f3 : #5d5d60};
  white-space:nowrap;
```

### 0.5 Design-system classes used in this view
- `.blueprint` (C:73–95): `position:relative; border:1px solid var(--color-divider) (= rgba(29,31,32,0.16)); border-radius:0;`
  `> .corner` = absolute 11×11 box, `color: color-mix(in srgb, #1d1f20 55%, transparent)`; `::before` = 1px×100% at `left:5px; top:0`; `::after` = 100%×1px at `top:5px; left:0`. Positions: `.tl{top:-6px;left:-6px}` `.tr{top:-6px;right:-6px}` `.bl{bottom:-6px;left:-6px}` `.br{bottom:-6px;right:-6px}`. **Every board renders all four corner marks.**
- `.btn` (C:139–150): `inline-flex; align-items:center; justify-content:center; gap:6px; font-family:"Barlow Condensed"; font-weight:600; font-size:14px; line-height:1.2; color:#1d1f20; background:transparent; border:1px solid transparent; padding:6.8px 12.24px; border-radius:4px` → overridden to `border-radius:0` by C:281.
  - `.btn-primary` → `background:#5980a6; color:#f2f2f3; border-color:#5980a6`.
  - `.btn-secondary` → `border-color: rgba(29,31,32,0.16)`; hover `color-mix(in srgb,#1d1f20 7%,transparent)`.
- `.seg` (C:192–195): `display:inline-flex; overflow:hidden; border:1px solid rgba(29,31,32,0.16); border-radius:4px` → `border-radius:0` via C:281.

### 0.6 Lucide icons used (S:1371–1396, renderer S:1397–1399)
`icon(name, size, color)` → `<svg width height viewBox="0 0 24 24" fill="none" stroke={color||currentColor} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display:block; flex:none">`.
- `chevron` = `<path d="m6 9 6 6 6-6"/>` — used at 12px for every section collapse toggle.
- `eyeOff` (4 paths incl. `m2 2 20 20`) — used at 12px for the customise-mode hide button.
- `cog` (gear path + `<circle cx=12 cy=12 r=3/>`) — used at 12px for the heatmap settings button.

### 0.7 Section collapse helper `section(id)` (S:1405–1413)
```js
open      = !this.state.collapsed[id]                       // default: all open
toggle    = flip collapsed[id]
btnStyle  = display:inline-flex; align-items:center; justify-content:center;
            width:22px; height:22px; border:1px solid rgba(29,31,32,0.16);
            background:#fff; border-radius:2px; padding:0; cursor:pointer;
            color:#5d5d60; transform:rotate({open ? 0 : -90}deg); transition:transform .15s;
chevron   = icon("chevron", 12)
```
`secIds` (S:1790) includes `lifecycle, posture, attention, inflight, triggers, clusters` for this view.

### 0.8 Initial state relevant to overview (S:1401–1403)
```
screen: "overview"
customising: false
hiddenBoards: {}
postureFormat: "heatmap"      <-- HEATMAP IS THE DEFAULT, not bars
rolloutTab: "inflight"
hoverTile: null
heatGroup: "project"
heatDetail: "full"
heatSettingsOpen: false
collapsed: {}                 <-- all boards expanded
```

---

## 1. View shell (T:97–99, T:465–466)

```html
<sc-if value="{{ isOverview }}">        <!-- isOverview = screen === "overview" (S:1963) -->
  <div style="padding:20px 22px 32px; display:flex; flex-direction:column; gap:20px;">
```
- Outer column: **padding `20px 22px 32px`**, `display:flex; flex-direction:column; gap:20px`.
- Children in order: page header (T:100–109), customise strip (T:111–123), board 01 lifecycle (T:125–155), row 2 wrapper (T:157–305), row 3 wrapper (T:307–404), board 06 clusters (T:406–464).

---

## 2. Page header (T:100–109)

```html
<div style="display:flex; align-items:flex-end; justify-content:space-between; gap:20px;">
  <div>
    <div class="mono" style="font-size:9px; letter-spacing:0.2em; color:#597ea3;">FLEET · ALL PROJECTS</div>
    <h1 class="cond" style="margin:4px 0 0; font-size:30px; font-weight:600; letter-spacing:0.01em; line-height:1;">Operations overview</h1>
  </div>
  <div style="display:flex; gap:8px;">
    <button class="btn btn-secondary" style="{{ customiseBtnStyle }}">{{ customiseLabel }}</button>
    <button class="btn btn-primary"   style="height:32px;">Open inventory</button>
  </div>
</div>
```
- Kicker: verbatim `FLEET · ALL PROJECTS`, mono 9px, letter-spacing `0.2em`, colour `#597ea3` (accent-600).
- Title: verbatim `Operations overview`, Barlow Condensed, 30px/600, ls `0.01em`, line-height 1, margin-top 4px.
- Right buttons, `gap:8px`:
  - **Customise** (`.btn .btn-secondary`), label toggles `Customise` ⇄ `Done` (S:1969).
    `customiseBtnStyle` (S:1970) = `height:32px;` and when `customising` also `background:#5980a6; color:#f2f2f3; border-color:#5980a6;`
  - **Open inventory** (`.btn .btn-primary`, `height:32px`) → `goApplications` = `go("applications")` (S:1965).

---

## 3. Customise strip (T:111–123) — visible only when `customising`

```html
<div style="border:1px dashed #5980a6; background:#e7f0f8; padding:10px 14px;
            display:flex; flex-wrap:wrap; align-items:center; gap:10px 18px;">
```
Contents, in order:
1. `<span class="mono" style="font-size:9px; letter-spacing:0.16em; color:#2c455d;">BOARDS</span>`
2. Chip row: `display:flex; flex-wrap:wrap; gap:6px;` iterating `boardChips`.
   Each chip (T:116) is `<button>` containing `<span class="mono" style="font-size:9px; opacity:.7;">{{ b.n }}</span>` then `{{ b.label }}`.
   `b.style` (S:1563):
   ```
   display:inline-flex; align-items:center; gap:6px;
   border:1px solid {hidden ? rgba(29,31,32,0.16) : #5980a6};
   background:{hidden ? #fff : #5980a6};
   color:{hidden ? #5d5d60 : #f2f2f3};
   border-radius:2px; padding:3px 9px; font:inherit; font-size:11px; font-weight:600;
   cursor:pointer; text-decoration:{hidden ? line-through : none};
   ```
   `boardDefs` (S:1557) — id / number / chip label, in this order:
   | id | n | label |
   |---|---|---|
   | `lifecycle` | `01` | `Lifecycle` |
   | `posture` | `02` | `Health posture` |
   | `attention` | `03` | `Needs attention` |
   | `inflight` | `04` | `Rollouts` |
   | `triggers` | `05` | `Source triggers` |
   | `clusters` | `06` | `Clusters · capacity` |
3. `<span style="flex:1;"></span>` spacer.
4. Help text, verbatim, `font-size:11px; color:#2c455d`:
   `Click a board to show or hide it. Hidden boards keep their settings. Layout is saved per user.`
5. **Reset to default** button (T:121):
   `border:1px solid #5980a6; background:#fff; border-radius:2px; padding:3px 9px; font:inherit; font-size:11px; color:#2c455d; cursor:pointer;`
   `resetBoards` (S:1971) resets `hiddenBoards:{}`, `postureFormat:"heatmap"`, `rolloutTab:"inflight"`.

`boards[id] = { on: !hidden[id], hide: () => set hiddenBoards[id]=true }` (S:1559–1560).

---

## 4. Shared board chrome

Every board is:
```html
<section class="blueprint" style="background:#fff;">
  <i class="corner tl"></i><i class="corner tr"></i><i class="corner bl"></i><i class="corner br"></i>
  <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between;
              gap:6px 12px; border-bottom:1px solid rgba(29,31,32,0.16); padding:6px 10px 6px 14px;">
    <div style="display:flex; align-items:baseline; gap:10px; min-width:0;">
      <span class="mono" style="font-size:10px; letter-spacing:0.14em; color:#597ea3;">NN</span>
      <h2 class="cond" style="margin:0; font-size:17px; font-weight:600; letter-spacing:0.04em;
                              text-transform:uppercase; white-space:nowrap;">TITLE</h2>
    </div>
    <span style="display:flex; align-items:center; gap:10px; [margin-left:auto;]"> ...controls... </span>
  </div>
  <sc-if value="{{ sec.<id>.open }}"> ...body... </sc-if>
</section>
```
- Header bar padding `6px 10px 6px 14px`, bottom hairline `rgba(29,31,32,0.16)`, `gap:6px 12px`, wraps.
- Kicker number: mono 10px, ls `0.14em`, `#597ea3`.
- Title `h2.cond`: 17px / 600 / ls `0.04em` / uppercase / nowrap. (CSS also applies `font-family:var(--font-heading)` from C:71 — `.cond` matches.)
- The right control cluster carries `margin-left:auto` on boards 01/03 (T:133, T:281) but **not** on 02/04/05/06 (T:168, 318, 387, 414) — those already sit at the flex end.
- **Hide button** (identical on all six boards, only inside `<sc-if value="{{ customising }}">`), `title="Hide board"`:
  ```
  display:inline-flex; align-items:center; justify-content:center;
  width:22px; height:22px; border:1px solid #dd9490; background:#fbe9e8;
  border-radius:2px; padding:0; cursor:pointer; color:#9c3f39;
  ```
  content = `eyeOff` icon @12px.
- **Collapse chevron** button = `sec.<id>.btnStyle` / `sec.<id>.chevron` (see §0.7). Always last in the cluster.

---

## 5. Board 01 — Application lifecycle (T:125–155)

**Header**
- Kicker `01`; title verbatim `Application lifecycle — one control plane` (em dash).
- Meta (T:133), mono 10px `#5d5d60`, nowrap, **hard-coded**: `57 applications · 3 clusters · 12 changes today`
- Controls: [hide (if customising)] + chevron. `margin-left:auto` on the cluster span.

**Body** (T:136–151) — a 6-column hairline grid:
```html
<div style="display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:1px; background:rgba(29,31,32,0.16);">
```
The 1px gap over a `rgba(29,31,32,0.16)` background produces the internal hairlines; each cell paints its own tone fill.

Per cell (S:1484–1491):
- `cellStyle` = `background:{T[st].fill}; padding:12px 14px 13px; min-width:0;`
- Row 1: `display:flex; align-items:baseline; justify-content:space-between;`
  - index `idxStyle` = `font-family:ui-monospace,monospace; font-size:9px; letter-spacing:0.16em; color:{T[st].c};`
  - arrow `<span style="font-size:11px; color:#a0a0a4;">` — glyph `›` (U+203A) on stages 01–05, empty string on 06.
- Label (`div.cond`): `margin-top:6px; font-size:15px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase;`
- Number (`div.cond`, `numStyle`): `margin-top:6px; font-size:34px; font-weight:600; line-height:1; font-variant-numeric:tabular-nums; color:{T[st].c};`
- Sub: `margin-top:6px; font-size:11px; line-height:1.45; color:#5d5d60;`
- Bars: `margin-top:8px; display:flex; gap:3px;` — 4 spans, each `flex:1; height:5px; background:{T[mix_k].line};`

Data (S:1477–1483), verbatim:
| idx | arrow | label | value | tone (`st`) | sub | mix (bar tones, L→R) |
|---|---|---|---|---|---|---|
| `01` | `›` | `Source` | `12` | healthy | `GitHub 41 · S3 9 · OCI 7 repos` | healthy, healthy, healthy, unknown |
| `02` | `›` | `Build` | `3` | progressing | `in-cluster · 41 runs today` | progressing, healthy, healthy, unknown |
| `03` | `›` | `Test` | `2` | degraded | `1 failing · 213/214 passed` | degraded, progressing, healthy, unknown |
| `04` | `›` | `Render` | `4` | healthy | `Helm 33 · Kustomize 14 · Jsonnet 6` | healthy, healthy, healthy, healthy |
| `05` | `›` | `Deploy` | `7` | progressing | `releases active · 2 gates blocked` | progressing, degraded, healthy, unknown |
| `06` | *(none)* | `Verify` | `3` | failed | `canaries under analysis · 1 held` | failed, progressing, healthy, unknown |

**Footer** (T:152): `border-top:1px solid rgba(29,31,32,0.16); padding:7px 14px; font-size:11px; color:#5d5d60;` — verbatim:
`CI, CD, traffic and verification are one reconciliation loop — not four operators stitched together. Every stage below links to the same Application record.`

---

## 6. Row 2 wrapper (T:157–158, 304–305)

```js
row2on    = boards.posture.on || boards.attention.on                    // S:1564
row2Style = `display:grid; grid-template-columns:${both ? "minmax(0,1.05fr) minmax(0,1.25fr)"
                                                        : "minmax(0,1fr)"}; gap:16px;`   // S:1566
```
Left = posture (02), right = attention (03). Gap 16px.

---

## 7. Board 02 — Health posture (T:160–271)

**Header** (T:163–169)
- Kicker `02`; title verbatim `Health posture`.
- Controls, `gap:10px`, no `margin-left:auto`:
  1. `<div class="seg" style="height:22px;">` containing `postureFormats` buttons (S:1571) styled with `miniSeg(on, i===0)`:
     - `Bars` → `postureFormat = "bars"`
     - `Heatmap` → `postureFormat = "heatmap"` (**default on**)
  2. hide button (if customising)
  3. chevron.

Body is wrapped in `<sc-if value="{{ sec.posture.open }}">` and then split into the two variants.

### 7.1 Variant A — BARS (T:171–182), shown when `postureIsBars`

A plain `<div>` of six full-width `<button>` rows, each `onClick = goApplications`:
```
display:grid; width:100%;
grid-template-columns:20px 96px 44px minmax(0,1fr);
align-items:center; gap:10px;
border:0; border-bottom:1px solid rgba(29,31,32,0.10);
background:none; padding:0 14px; height:38px;
font:inherit; cursor:pointer; text-align:left; color:#1d1f20;
```
Columns:
1. glyph chip — `p.glyphStyle = chip(t)` (16×16, see §0.4), content `t.glyph`.
2. label `<span class="cond">` — `font-size:14px; font-weight:500; letter-spacing:0.05em; text-transform:uppercase;`
3. count `<span class="cond">` — `font-size:19px; font-weight:600; text-align:right; font-variant-numeric:tabular-nums;`
4. track `<span style="height:7px; background:#e7e7ea; position:relative;">` containing fill
   `p.barStyle` (S:1497) = `position:absolute; left:0; top:0; bottom:0; width:{round(n/57*100)}%; background:{t.line};`

Data `postureData` (S:1493), in this exact order (denominator 57):
| tone | label rendered | count | bar width |
|---|---|---|---|
| healthy | `Healthy` | 41 | 72% |
| progressing | `Progressing` | 6 | 11% |
| degraded | `Degraded` | 4 | 7% |
| failed | `Failed` | 2 | 4% |
| missing | `Missing` | 1 | 2% |
| unknown | `Unknown` | 3 | 5% |

### 7.2 Variant B — HEATMAP (T:183–268), shown when `postureIsHeatmap` (default)

#### 7.2.1 Heat toolbar (T:184–211)
```html
<div style="position:relative; display:flex; align-items:center; justify-content:space-between;
            gap:10px; border-bottom:1px solid rgba(29,31,32,0.10); padding:5px 10px 5px 14px;">
```
- Left: `<span class="mono" style="font-size:10px; color:#5d5d60; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ heatSummary }}</span>`
  `heatSummary` (S:1977) = `` `${hg === "none" ? "ungrouped" : "by " + hg} · ${hd === "full" ? "name + target" : hd === "name" ? "name" : "compact"}` ``
  Default renders: **`by project · name + target`**.
- Right: cog button, `title="Heatmap settings"`, `cogStyle` (S:1976):
  ```
  display:inline-flex; align-items:center; justify-content:center; width:22px; height:22px;
  border:1px solid {open ? #5980a6 : rgba(29,31,32,0.16)};
  background:{open ? #e7f0f8 : #fff};
  border-radius:2px; padding:0; cursor:pointer;
  color:{open ? #2c455d : #5d5d60};
  ```
  content = `cog` icon @12px.

#### 7.2.2 Heat-settings popover (T:187–210), when `heatSettingsOpen`
- Scrim (T:188): `<div onClick={closeHeatSettings} style="position:fixed; inset:0; z-index:75;"></div>`
- Panel (T:189):
  ```
  position:absolute; top:calc(100% + 4px); right:10px; z-index:76; width:250px;
  background:#fff; border:1px solid rgba(29,31,32,0.28);
  box-shadow:0 8px 22px rgba(29,45,61,0.18);
  ```
- Panel header (T:190–193): `display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid rgba(29,31,32,0.16); padding:7px 12px;`
  - Title `<span class="cond">Heatmap settings</span>` — `font-size:14px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase;`
  - Close `<button>✕</button>` — `border:0; background:none; padding:0; font:inherit; font-size:12px; color:#7a7a7d; cursor:pointer;`
- Panel body (T:194): `padding:10px 12px; display:flex; flex-direction:column; gap:12px;`
  - **Group section** (T:195–200):
    - Label `<div class="mono" style="font-size:9px; letter-spacing:0.14em; color:#7a7a7d; margin-bottom:5px;">GROUP BY</div>`
    - `<div class="seg" style="height:24px; display:inline-flex;">` with `heatGroupChips` (S:1577), `miniSeg(hg===k, i===0)`:
      `none → "All"`, `project → "Project"` (default), `cluster → "Cluster"`, `stage → "Stage"`.
  - **Detail section** (T:201–207):
    - Label `TILE DETAIL` (same mono style).
    - `<div class="seg" style="height:24px; display:inline-flex;">` with `heatDetailChips` (S:1579):
      `full → "Name + target"` (default), `name → "Name"`, `compact → "Compact"`.
    - Hint (T:206) `margin-top:5px; font-size:10.5px; line-height:1.45; color:#5d5d60;` verbatim:
      `Compact hides names and shows solid colour squares; hover any tile for full detail.`

#### 7.2.3 Heat body (T:212–267)
```html
<div style="padding:12px 14px; display:flex; flex-direction:column; gap:14px;">
  <sc-for list="{{ heatRows }}" as="hr"> <div> [group head] [tile grid] </div> </sc-for>
  [legend]
</div>
```

**Row derivation (S:1580–1589)**
```js
heatKeyOf(a) = hg==="project" ? a.project : hg==="cluster" ? a.cluster : hg==="stage" ? a.env : "all"
heatKeys     = hg==="none" ? ["all"]
             : hg==="stage" ? ["prod","staging","dev"]           // fixed order
             : [...new Set(APPS.map(heatKeyOf))].sort()          // alphabetical
list         = APPS filtered by key, sorted by HEALTH_RANK asc, then name asc
bad          = count of HEALTH_RANK < 3
worst        = lowest-ranked health present, seeded at "healthy"
```

**Group head** (T:215–224), only when `hr.isGroup` (i.e. `hg !== "none"`):
`hr.headStyle` (S:1588) = `display:flex; align-items:baseline; gap:8px; min-width:0; padding:0 0 6px; border-bottom:1px solid {T[worst].line};`
Children left→right:
1. kicker `<span class="mono" style="font-size:9px; letter-spacing:0.14em; color:#7a7a7d;">` — `hr.kicker = hg.toUpperCase()` → `PROJECT` / `CLUSTER` / `STAGE`.
2. label `<span class="cond" style="font-size:15px; font-weight:600; letter-spacing:0.03em; white-space:nowrap;">` — the group key itself (e.g. `payments/core`).
3. meta `<span style="font-size:11px; color:#5d5d60; flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">`
   `hr.meta` (S:1587) = `` `${n} target(s) · ${uniqueAppNames} apps` `` + (`bad ? " · N unhealthy" : " · all healthy"`).
4. mix bar `<span style="margin-left:auto; display:flex; width:60px; flex:none; height:6px; gap:1px;">` containing `mixBar(list)` segments (`flex:{count}; background:{tone.line};`, order failed→missing→degraded→progressing→unknown→healthy, empty tones dropped).

**Tile grid** (T:225): `display:flex; flex-wrap:wrap; gap:5px; padding-top:8px;` (present in both grouped and ungrouped modes).

**Tile** (T:226–239, S:1590–1615). Wrapper `<span style="position:relative; display:inline-flex;">` so the tooltip can anchor to it. Inner `<span>` with `onMouseEnter/onMouseLeave/onClick(openApp)` and `t.style`:
```js
bigTile = (hg === "none") || (list.length <= 6)

dims:
  hd === "compact" : width:22px; height:22px; padding:0; align-items:center; justify-content:center;
  hd === "name"    : width:{bigTile?96:84}px; height:30px; padding:0 7px; justify-content:center;
  hd === "full"    : width:{bigTile?108:92}px; height:{bigTile?58:50}px; padding:5px 7px; justify-content:space-between;

style = display:flex; flex-direction:column; {dims} box-sizing:border-box;
        border:1px solid {t.line};
        background:{hd==="compact" ? t.line : t.fill};
        color:{hd==="compact" ? "#fff" : t.c};
        cursor:pointer;
        + when hovered: outline:2px solid {t.line}; outline-offset:1px; box-shadow:0 4px 12px rgba(29,45,61,0.16);
```
Tile contents:
- `isCompact` (`hd==="compact"`) → single `<span style="font-size:11px; font-weight:700; line-height:1;">{{ t.glyph }}</span>` (T:229). White glyph on the solid `t.line` fill.
- `showName` (`hd !== "compact"`) → row (T:231–234) `display:flex; align-items:center; justify-content:space-between; gap:4px;`
  - name `<span class="cond" style="font-size:13px; font-weight:600; letter-spacing:0.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ t.label }}</span>` (`t.label = a.name`)
  - glyph `<span style="font-size:11px; font-weight:700; flex:none;">{{ t.glyph }}</span>`
- `showSub` (`hd === "full"`) → `<span class="mono" style="font-size:9px; opacity:.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ t.sub }}</span>` (T:237)
  `t.sub` (S:1598) = `hg === "cluster" ? a.env : a.cluster.replace("-1","")` → e.g. `prod-eu`, `prod-us`, `staging`, or `prod`/`staging`/`dev` when grouping by cluster.

**Hover tooltip / card** (T:240–255, rendered only when `t.hovered`, i.e. `state.hoverTile === key+":"+name+":"+cluster`):
`t.tipStyle` (S:1615):
```
position:absolute; z-index:70; top:calc(100% + 6px);
{hoverSide === "right" ? "right:0;" : "left:0;"}
transform:translateX({hoverShift || 0}px);
width:{hoverMaxW || 270}px;
background:#1d2d3d;           /* STEEL_9 */
color:#f2f2f3;                /* PAPER   */
border:1px solid rgba(242,242,243,0.16);
box-shadow:0 8px 22px rgba(29,45,61,0.28);
pointer-events:none;
```
Positioning maths in `enter(e)` (S:1600–1612): measures the tile rect vs. the enclosing `<section>` rect;
`maxW = clamp(180, 270, sectionWidth - 28)`; `side = "right"` when the tile centre is past the section centre, else `"left"`; then `shift` nudges the card so it stays ≥14px inside the section on that side.
`leave()` clears `hoverTile`.

Tooltip structure:
1. Head (T:242–245): `display:flex; align-items:center; justify-content:space-between; gap:10px; border-bottom:1px solid rgba(242,242,243,0.16); padding:8px 10px;`
   - name `<span class="cond" style="font-size:15px; font-weight:600; letter-spacing:0.02em;">{{ t.name }}</span>`
   - health pill `t.pillStyle` (S:1596) = `pill(t) + " background:#fff;"` — i.e. the normal pill but forced onto a **white** background (last declaration wins) so it reads on the dark card; text `{{ t.health }}` = `t.label` (`Healthy`, `Degraded`, …).
2. Detail grid (T:246–252): `padding:7px 10px; display:grid; grid-template-columns:auto 1fr; gap:3px 12px; font-size:11px;`
   Label cells `<span style="color:#94bce3;">` (accent-400); value cells `<span class="mono">`. Rows in this exact order with these verbatim labels:
   | label | value expression (S:1599) |
   |---|---|
   | `target` | `` `${a.cluster} · ${a.stage}` `` where `a.stage = "${env} · ring ${ring}"` (S:1328) → e.g. `prod-eu-1 · prod · ring 2` |
   | `project` | `a.project` |
   | `sync` | `a.sync === "synced" ? "Synced" : "Drifted · " + a.sync` → `Synced` or `Drifted · out of sync` |
   | `release` | `RELEASE[a.name] || "—"` |
   | `resources` | `{{ t.res }} managed · {{ t.cost }}/mo` (single cell, two bindings) |
3. Note strip (T:253): `border-top:1px solid rgba(242,242,243,0.16); padding:6px 10px; font-size:11px; color:#dfe6ee;` — `t.note = NOTE[a.health]`.

`RELEASE` map (S:1574): `checkout-api r241, payments-gateway r188, ledger-worker r77, fraud-scorer r132, notifications r142, auth-service r97, search-indexer r61, web-frontend r310, cms-preview r19, reporting-etl r54, warehouse-sync r88`.

`NOTE` map (S:1575), verbatim:
- `degraded` → `Health check failing; see attention queue for the reason.`
- `failed` → `Workload failing — pods restarting.`
- `missing` → `Source unreachable; last good sync retained.`
- `progressing` → `Rollout in progress; analysis running.`
- `healthy` → `All health checks passing.`
- `unknown` → `Health not yet reported.`

**Legend** (T:261–266):
```html
<div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px;
            border-top:1px solid rgba(29,31,32,0.10); padding-top:8px;">
```
- `graphLegend` (S:1793) = `["healthy","progressing","degraded","failed"]` → each `<span style="display:inline-flex; align-items:center; gap:4px; font-size:10px; color:#5d5d60;">` with a `chip(T[k])` 16×16 square then the label (`Healthy`, `Progressing`, `Degraded`, `Failed`).
- Trailing note `<span class="mono" style="font-size:9px; color:#8e8e92; margin-left:auto; white-space:nowrap; flex:none;">` verbatim: `one tile per target · hover for detail`

**Fixture data → default heatmap rows** (`APPS`, S:1311–1328; 16 targets, 11 distinct app names). With the default `heatGroup="project"`, `heatKeys` sort to:
| group key | targets | apps | bad | meta rendered | head border tone |
|---|---|---|---|---|---|
| `data/analytics` | 2 | 2 | 1 | `2 targets · 2 apps · 1 unhealthy` | missing `#aea8bd` |
| `payments/core` | 5 | 3 | 1 | `5 targets · 3 apps · 1 unhealthy` | degraded `#e0ad66` |
| `payments/risk` | 2 | 1 | 0 | `2 targets · 1 apps · all healthy` | healthy `#7fae86` |
| `platform/shared` | 4 | 3 | 1 | `4 targets · 3 apps · 1 unhealthy` | degraded `#e0ad66` |
| `web/storefront` | 3 | 2 | 0 | `3 targets · 2 apps · all healthy` | progressing `#8bb0d0` |

(All five lists are ≤6 long, so `bigTile` is true for every row at default settings → 108×58 tiles.)
Note the meta string does not singularise "apps" (`1 apps`) — it only singularises "target".

---

## 8. Board 03 — Needs attention (T:273–303)

**Header**
- Kicker `03`; title verbatim `Needs attention`.
- Meta (T:281), mono 10px `#5d5d60`, nowrap: `ranked by blast radius`
- Controls cluster carries `margin-left:auto`; [hide] + chevron only.

**Body** (T:284–300) — a bare `<div>` of clickable rows (`onClick = openApp`, S:1421 → `screen:"appDetail"`).

`a.rowStyle` (S:1511):
```
display:grid; grid-template-columns:20px 16px minmax(0,1fr) 46px 82px;
align-items:center; gap:9px;
border-bottom:1px solid rgba(29,31,32,0.10);
border-left:3px solid {t.line};
background:{i < 3 ? t.fill : "#fff"};      /* only the top 3 rows are tinted */
padding:0 14px 0 11px; height:46px; cursor:pointer;
```
Columns:
1. rank `<span class="mono" style="font-size:10px; color:#8e8e92;">` — `01`…`06`.
2. glyph `chip(t)` (16×16).
3. text stack, `min-width:0`:
   - line 1 `<span style="display:flex; align-items:baseline; gap:7px;">`
     - name `<span class="cond" style="font-size:16px; font-weight:600; letter-spacing:0.02em; white-space:nowrap;">`
     - namespace `<span class="mono" style="font-size:10px; color:#8e8e92; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">` — `a.ns = id.split("/")[0]` (S:1510)
   - line 2 reason `<span style="display:block; margin-top:1px; font-size:11.5px; color:#5d5d60; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">`
4. age `<span class="mono" style="font-size:10px; color:#7a7a7d; text-align:right;">`
5. action wrapper `<span style="text-align:right;">` containing `a.actionStyle` (S:1512):
   ```
   display:inline-flex; align-items:center; justify-content:center;
   width:100%; height:23px; border:1px solid {t.line}; background:#fff;
   border-radius:2px; font-size:10.5px; font-weight:600; letter-spacing:0.02em; color:{t.c};
   ```

Data `attentionData` (S:1500–1507) — `[rank, name, id, reason, tone, age, action]`, verbatim:
| rank | name | ns (from id) | reason | tone | age | action |
|---|---|---|---|---|---|---|
| `01` | `checkout-api` | `payments` | `p99 latency 41% over baseline — canary held at 25%` | failed | `6m` | `Review` |
| `02` | `notifications` | `platform` | `Deployment 1/3 replicas ready · CrashLoopBackOff` | degraded | `23m` | `Investigate` |
| `03` | `reporting-etl` | `data` | `s3://acme-manifests unreachable — 403 on HeadObject` | missing | `41m` | `Fix source` |
| `04` | `ledger-worker` | `payments` | `Approval gate blocked · awaiting release manager` | progressing | `1h 12m` | `Approve` |
| `05` | `web-frontend` | `web` | `3 fields drifted from rendered manifest` | degraded | `2h` | `Diff` |
| `06` | `auth-service` | `platform` | `Policy signed-images-only warned on 1 image` | unknown | `3h` | `View` |

Rows 01–03 get the tinted `t.fill` background; 04–06 are white.

---

## 9. Row 3 wrapper (T:307–308, 403–404)

```js
row3on    = boards.inflight.on || boards.triggers.on                     // S:1565
row3Style = `display:grid; grid-template-columns:${both ? "minmax(0,1.3fr) minmax(0,1fr)"
                                                        : "minmax(0,1fr)"}; gap:16px;`   // S:1567
```
Left = rollouts (04), right = source triggers (05). Gap 16px.

---

## 10. Board 04 — Rollouts (T:310–377)

**Header** (T:313–319)
- Kicker `04`; title verbatim `Rollouts`.
- Controls (`gap:10px`, no `margin-left:auto`):
  1. `<div class="seg" style="height:22px;">` with `rolloutTabs` (S:1572), `miniSeg(on, i===0)`:
     - `In flight · 3` → `rolloutTab = "inflight"` (**default**)
     - `Recent · 7d` → `rolloutTab = "recent"`
  2. `All →` link-button: `border:0; background:none; padding:0; font:inherit; font-size:11px; color:#416180; cursor:pointer; white-space:nowrap;` → `goRollout` = `go("rollout")`.
  3. hide (if customising)
  4. chevron.

### 10.1 Tab A — In flight (T:321–343), `rolloutIsInflight`

Rows rendered directly (no wrapper), `onClick = goRollout`:
```
display:grid; grid-template-columns:minmax(0,0.9fr) minmax(0,1.3fr) auto;
align-items:center; gap:14px;
border-bottom:1px solid rgba(29,31,32,0.10);
padding:11px 14px; cursor:pointer;
```
Column 1 (`min-width:0`):
- name `<div class="cond" style="font-size:15px; font-weight:600; letter-spacing:0.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">`
- meta `<div class="mono" style="margin-top:1px; font-size:10px; color:#7a7a7d;">`

Column 2 (`min-width:0`) — the step ladder:
- `<div style="display:flex; gap:2px; align-items:flex-end; height:22px;">` with one `<span title="{{ st.title }}">` per step.
  `ladderStep(w, state, h)` (S:1515–1518) = `flex:1; height:{h}px; border:1px solid {T[state].line}; background:{state === "pending" ? "transparent" : T[state].fill};`
  `title` = `` `${w}% · ${state}` ``. Note the ladder heights are authored per step (ascending), producing a staircase anchored at the bottom.
- Below (T:332): `margin-top:5px; display:flex; justify-content:space-between; gap:10px; font-size:10px; color:#5d5d60;`
  - left `<span class="mono" style="white-space:nowrap;">{{ r.stepLabel }}</span>`
  - right `<span class="mono" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ r.analysis }}</span>`

Column 3 (`text-align:right`):
- weight `<div class="cond" style="font-size:24px; font-weight:600; line-height:1; font-variant-numeric:tabular-nums;">`
- caption `<div class="mono" style="font-size:9px; letter-spacing:0.1em; color:#7a7a7d;">CANARY WEIGHT</div>` (verbatim, uppercase literal)

Data `inflight` (S:1519–1523):
| name | meta | weight | stepLabel | analysis | steps `[weight, state, height]` |
|---|---|---|---|---|---|
| `checkout-api` | `prod-eu-1 · canary` | `25%` | `STEP 3 / 6 · HELD` | `1 metric failing` | 5/healthy/8, 10/healthy/11, 25/degraded/14, 50/pending/17, 75/pending/20, 100/pending/22 |
| `web-frontend` | `prod-eu-1 · canary` | `75%` | `STEP 5 / 6 · RUNNING` | `4/4 passing` | 5/healthy/8, 10/healthy/11, 25/healthy/14, 50/healthy/17, 75/progressing/20, 100/pending/22 |
| `ledger-worker` | `staging-1 · blue/green` | `0%` | `STEP 1 / 3 · GATE` | `awaiting approval` | 0/progressing/10, 50/pending/16, 100/pending/22 |

### 10.2 Tab B — Recent · 7d (T:344–374), `rolloutIsRecent`

Wrapped in `<div style="overflow-x:auto;"><div style="min-width:520px;">` (T:345, closed T:367).

**Column header row** (T:346–352):
```
display:grid; grid-template-columns:minmax(150px,1fr) 88px 84px 44px 44px;
align-items:center; gap:8px;
border-bottom:1px solid rgba(29,31,32,0.28);
background:#e9e9ea; padding:0 14px; height:26px;
```
Header cells are `<span class="mono" style="font-size:9px; letter-spacing:0.14em; color:#5d5d60;">`; the last two add `text-align:right`. Verbatim labels in order: `ROLLOUT`, `OUTCOME`, `STEPS`, `TOOK`, `WHEN`.

**Body rows** (T:353–366), `onClick = goRollout`; `r.rowStyle` (S:1629):
```
display:grid; grid-template-columns:minmax(150px,1fr) 88px 84px 44px 44px;
align-items:center; gap:8px;
border-bottom:1px solid rgba(29,31,32,0.10);
border-left:3px solid {T[outcome].line};
background:{outcome === "healthy" ? "#fff" : T[outcome].fill};
padding:9px 14px 9px 11px; cursor:pointer;
```
Cells:
1. `<div class="cond" style="font-size:14px; font-weight:600; letter-spacing:0.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{{ r.name }} <span class="mono" style="font-size:10px; font-weight:400; color:#7a7a7d;">{{ r.release }}</span></div>` then note `<div style="margin-top:1px; font-size:11px; color:#5d5d60; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">`
2. outcome pill — `r.pillStyle = pill(T[outcome])`, text `r.outcome` = the uppercase `label`.
3. steps `<span style="display:flex; gap:2px; align-items:flex-end; height:14px;">`, each step (S:1628):
   `flex:1; width:10px; height:{6 + j*1.6}px; border:1px solid {t.line}; background:{s === 0 ? "transparent" : t.fill};`
   where `s===1 → T.healthy`, `s===2 → T.failed`, `s===0 → T.pending` and `j` is the index (staircase 6, 7.6, 9.2, 10.8, 12.4, 14 px).
4. took `<span class="mono" style="font-size:11px; text-align:right; font-variant-numeric:tabular-nums;">`
5. when `<span class="mono" style="font-size:10px; color:#7a7a7d; text-align:right;">`

Data `recentRaw` (S:1619–1626) — six rows (template hint says 5; the array has 6):
| name | release | outcome tone | pill label | note | steps | took | when |
|---|---|---|---|---|---|---|---|
| `payments-gateway` | `r188` | healthy | `COMPLETED` | `6 steps · 4/4 metrics passed at every step` | 1,1,1,1,1,1 | `24m` | `2h` |
| `auth-service` | `r97` | healthy | `COMPLETED` | `3 steps · blue/green · switched at 09:12` | 1,1,1 | `18m` | `3h` |
| `notifications` | `r142` | failed | `ABORTED` | `error rate 2.1% > 1% at 10% · auto rolled back to r141` | 1,2,0,0,0,0 | `7m` | `5h` |
| `search-indexer` | `r61` | healthy | `COMPLETED` | `6 steps · one manual approval at 50%` | 1,1,1,1,1,1 | `41m` | `1d` |
| `web-frontend` | `r309` | healthy | `COMPLETED` | `6 steps · p99 within 6% of baseline` | 1,1,1,1,1,1 | `31m` | `1d` |
| `fraud-scorer` | `r131` | degraded | `ROLLED BACK` | `operator abort at 25% · saturation alert · rolled back to r130` | 1,1,2,0,0,0 | `12m` | `2d` |

(`recentRaw` also carries an unused `target` field: `prod-us-1 · ring 3` etc.)

**Stats footer** (T:368–373):
```
display:flex; flex-wrap:wrap; gap:8px 16px; padding:8px 14px;
font-size:11px; color:#5d5d60; border-top:1px solid rgba(29,31,32,0.10);
```
Four items, each a big number in `<span class="cond" style="font-size:15px; font-weight:600; color:…">` followed by plain-text tail:
| number colour | binding | tail text (verbatim) | value (S:1630) |
|---|---|---|---|
| `#1d1f20` | `recentStats.total` | ` rollouts / 7d` | `11` |
| `#3f6b48` | `recentStats.ok` | ` completed` | `9` |
| `#9c3f39` | `recentStats.aborted` | ` auto-aborted` | `2` |
| `#1d1f20` | `recentStats.median` | ` median` | `22m` |

---

## 11. Board 05 — Source triggers (T:379–402)

**Header** (T:382–388)
- Kicker `05`; title verbatim `Source triggers`.
- Meta: `<span class="mono" style="font-size:10px; color:#5d5d60;">last 2h</span>`
- Controls: [hide] + chevron.

**Body** (T:389–399) — flat list of rows:
```
display:grid; grid-template-columns:48px minmax(0,1fr) 46px;
align-items:center; gap:10px;
border-bottom:1px solid rgba(29,31,32,0.10);
padding:9px 14px;
```
1. kind tag — `trigTag(c)` (S:1525):
   ```
   display:inline-flex; align-items:center; justify-content:center; height:17px;
   border:1px solid rgba(29,31,32,0.16); background:#f5f5f8; border-radius:2px;
   font-family:ui-monospace,monospace; font-size:9px; letter-spacing:0.06em; color:{c};
   ```
   (grid item stretches to the 48px column). Colour is `#416180` (STEEL_D) normally, `#8e372f` (OXIDE_T) for the error trigger.
2. text stack (`min-width:0`):
   - ref `<span class="mono" style="display:block; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">`
   - effect `<span style="display:block; margin-top:1px; font-size:11px; color:#5d5d60; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">`
3. age `<span class="mono" style="font-size:10px; color:#7a7a7d; text-align:right;">`

Data `triggers` (S:1526–1532), verbatim:
| kind | ref | effect | age | tag colour |
|---|---|---|---|---|
| `GIT` | `acme/checkout-api@9f3a1c2 → main` | `run #418 · build, test, deploy dev` | `34m` | `#416180` |
| `S3` | `s3://acme-manifests/web/prod.tar.gz` | `re-rendered web-frontend · 2 fields changed` | `51m` | `#416180` |
| `GIT` | `acme/platform-charts@4c81de0 → main` | `ApplicationSet fan-out · 6 applications` | `1h 08m` | `#416180` |
| `S3` | `s3://acme-manifests/etl/` | `403 HeadObject · reporting-etl source failed` | `1h 41m` | `#8e372f` |
| `OCI` | `ghcr.io/acme/auth-service:1.19.2` | `digest changed · auth-service resynced` | `2h 15m` | `#416180` |

---

## 12. Board 06 — Clusters · capacity (T:406–464)

Full-width (not inside a row wrapper).

**Header** (T:409–415)
- Kicker `06`; title verbatim `Clusters · capacity`.
- Controls (`gap:10px`, no `margin-left:auto`):
  1. `<span class="mono" style="font-size:10px; color:#5d5d60; white-space:nowrap;">ksm · node-exporter · 15s ago</span>`
  2. `Fleet map →` link-button: `border:0; background:none; padding:0; font:inherit; font-size:11px; color:#416180; cursor:pointer; white-space:nowrap;` → `goMap` = `go("map")`.
  3. hide (if customising)
  4. chevron.

**Body grid** (T:417): `display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:1px; background:rgba(29,31,32,0.16);` — same 1px-gap hairline technique as lifecycle.

**Cluster cell** (T:419): `background:#fff; padding:12px 14px;`
1. Title row (T:420–423), `onClick = goMap`: `display:flex; align-items:center; justify-content:space-between; gap:10px; cursor:pointer;`
   - name `<span class="cond" style="font-size:16px; font-weight:600; letter-spacing:0.03em;">`
   - connection pill `c.connStyle` (S:1555) = `pill(c.conn === "CONNECTED" ? T.healthy : T.degraded)`; text is the literal `CONNECTED` / `DEGRADED`.
2. meta `<div class="mono" style="margin-top:3px; font-size:10px; color:#7a7a7d;">`
3. **Mix bar** (T:425–427): `<div style="margin-top:10px; display:flex; height:8px; gap:1px;">` with `c.mix` segments produced by `mixSeg(frac, tone)` = `flex:{frac}; background:{tone};` — the tones are `T.<health>.line` values, and `frac` is an app count (proportional widths).
4. **Stat row** (T:428–433): `margin-top:6px; display:flex; gap:14px; font-size:11px; color:#5d5d60;`
   Four items, each `<span><span class="cond" style="font-size:15px; font-weight:600; color:#1d1f20;">VALUE</span> tail</span>` with tails, verbatim: ` apps`, ` nodes`, ` pods`, ` /mo`.
5. **Usage block** (T:434–451): `margin-top:12px; display:flex; flex-direction:column; gap:9px; border-top:1px solid rgba(29,31,32,0.10); padding-top:10px;`
   Per meter (`usage(label, used, req, alloc, unit)`, S:1539–1547):
   - Head row (T:437–440): `display:flex; align-items:baseline; justify-content:space-between; gap:8px;`
     - label `<span class="mono" style="font-size:9px; letter-spacing:0.14em; color:#7a7a7d;">` — `CPU` / `MEMORY`
     - text `<span class="mono" style="font-size:10px; color:#424244; text-align:right;">` — `` `${used} / ${req} / ${alloc} ${unit}` ``
   - Track `u.trackStyle`: `position:relative; height:9px; margin-top:4px; background:#e7e7ea; border:1px solid rgba(29,31,32,0.16);`
   - Used fill `u.usedStyle`: `position:absolute; left:0; top:0; bottom:0; width:{(used/alloc*100).toFixed(1)}%; background:{hot ? "#e0ad66" : "#5980a6"};`
   - Requested marker `u.reqStyle` (has `title="requested"`, T:443): `position:absolute; top:-3px; bottom:-3px; left:{(req/alloc*100).toFixed(1)}%; width:2px; background:{hot ? "#9c3f39" : "#1d1f20"};` — deliberately overshoots the track top and bottom by 3px.
   - Caption row (T:445–448): `display:flex; justify-content:space-between; margin-top:3px;`
     - left `<span class="mono" style="font-size:9px; color:#8e8e92;">used {{ u.usedPct }}</span>` (verbatim prefix `used `)
     - right `u.reqPctStyle` = `font-family:ui-monospace,monospace; font-size:9px; color:{hot ? "#9c3f39" : "#8e8e92"}; font-weight:{hot ? 700 : 400};`, text `requested {{ u.reqPct }}`
   - **`hot = (req / alloc) > 0.85`** — strictly greater. Percentages are `Math.round(x*100) + "%"`.

Data `clusters` (S:1548–1555):
| name | meta | conn | apps | nodes | pods | cost | mix (count/tone.line) | CPU used/req/alloc | MEM used/req/alloc |
|---|---|---|---|---|---|---|---|---|---|
| `prod-eu-1` | `vke · eu-west · v1.31.4` | `CONNECTED` | 24 | 18 | 412 | `$14.2k` | 20 healthy `#7fae86`, 3 degraded `#e0ad66`, 1 failed `#dd9490` | 34.6 / 61.2 / 72 cores → used 48%, requested 85%, **not hot** (0.85 is not > 0.85) | 171 / 198 / 288 GiB → 59% / 69% |
| `prod-us-1` | `eks · us-east-2 · v1.31.2` | `CONNECTED` | 22 | 22 | 488 | `$18.6k` | 18 healthy, 2 degraded, 2 missing `#aea8bd` | 41.9 / 78.1 / 88 cores → 48% / **89% HOT** | 206 / 251 / 352 GiB → 59% / 71% |
| `staging-1` | `kind · shared · v1.32.0` | `DEGRADED` | 11 | 4 | 96 | `$0.8k` | 9 healthy, 2 progressing `#8bb0d0` | 5.8 / 9.1 / 16 cores → 36% / 57% | 29 / 41 / 64 GiB → 45% / 64% |

Only `prod-us-1` CPU trips the hot styling (ochre used-bar `#e0ad66`, oxide marker `#9c3f39`, bold oxide `requested 89%` caption).

**Legend footer** (T:455–461):
```
display:flex; align-items:center; gap:14px;
border-top:1px solid rgba(29,31,32,0.16); padding:7px 14px;
font-size:10px; color:#5d5d60;
```
Three swatch items each `<span style="display:inline-flex; align-items:center; gap:5px;">`, verbatim text after the swatch:
1. swatch `width:14px; height:7px; background:#5980a6;` → `used (node-exporter)`
2. swatch `width:2px; height:11px; background:#1d1f20;` → `requested (kube-state-metrics)`
3. swatch `width:14px; height:7px; background:#e7e7ea; border:1px solid rgba(29,31,32,0.16);` → `allocatable`
Then `<span style="flex:1;"></span>` and finally
`<span class="mono" style="font-size:9px; color:#8e8e92;">requests &gt; 85% of allocatable are flagged</span>` (renders as `requests > 85% of allocatable are flagged`).

---

## 13. Cross-cutting implementation notes

1. **Nothing here uses design-system colour tokens directly** — every colour is a literal hex/rgba in an inline `style`. The only DS classes are `.blueprint`, `.corner`, `.btn`, `.btn-primary`, `.btn-secondary`, `.seg`, plus the local `.mono`/`.cond` font helpers.
2. **Two boards are conditionally paired.** Row 2 (posture + attention) and row 3 (rollouts + triggers) collapse from a 2-column grid to a single `minmax(0,1fr)` column when one of the pair is hidden; the row wrapper itself disappears when both are hidden. Lifecycle and clusters are always full-width.
3. **Board ordering is fixed** — hiding is the only layout customisation; there is no drag-reorder.
4. **Two independent collapse mechanisms**: `hiddenBoards` (customise mode, board removed entirely) and `collapsed` (chevron, header stays, body hidden). They do not interact.
5. **Numbers are hard-coded fixtures** and are internally inconsistent in places (posture totals 57 but `APPS` has 16 target rows; lifecycle header says "57 applications"; `recentStats.total` 11 vs 6 rendered rows). Real implementation should derive these.
6. **Repeated hairline weights**: board/section dividers use `rgba(29,31,32,0.16)`; in-list row dividers use `rgba(29,31,32,0.10)`; table header underline uses `rgba(29,31,32,0.28)`.
7. **Repeated control sizes**: 22×22 icon buttons (chevron, hide, cog); 22px-tall segmented controls in board headers, 24px-tall in the popover; 32px-tall page-header buttons.
8. **The `title` attribute is used as the hover affordance** on inflight ladder steps (`"25% · degraded"`), the cluster requested marker (`"requested"`), the hide buttons (`"Hide board"`) and the cog (`"Heatmap settings"`).
