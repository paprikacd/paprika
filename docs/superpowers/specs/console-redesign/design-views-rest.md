# console.dc.html — PIPELINE / ROLLOUT / SYNC & DIFF / FLEET MAP

Source: `/private/tmp/claude-501/-Users-benebsworth-projects-paprika/844ad4e2-4dd2-4687-a932-9e099bcf1f1c/scratchpad/design/console.dc.html`
Template lines read: **943–1264**. Script bindings read: **1282–1420, 1826–1975, 1985–2004**.
This is a spec of what IS in the file. Every hex/px value below is copied verbatim from the source.

---

## 0. Shared foundations (needed by all four views)

### 0.1 Fonts and page base (lines 13–25)
```
Google fonts: Barlow+Condensed wght 400;500;600;700  +  Barlow wght 400;500;600
body      : font-family "Barlow", system-ui, sans-serif; font-size 13px; background #f2f2f3; color #1d1f20; -webkit-font-smoothing:antialiased
.mono     : font-family ui-monospace, SFMono-Regular, Menlo, monospace
.cond     : font-family "Barlow Condensed", system-ui, sans-serif
a         : #416180, no underline; hover #2c455d + underline
::selection background #d6ebff
scrollbars: 9px; thumb #c4c4c8; track #e9e9ea
@keyframes blip { 0%,100%{opacity:1} 50%{opacity:.25} }
```

### 0.2 Palette constants (lines 1282–1286)
```js
PAPER  = "#f2f2f3"   INK    = "#1d1f20"   MUTED = "#5d5d60"   FAINT = "#7a7a7d"
DIV    = "rgba(29,31,32,0.16)"            DIV2  = "rgba(29,31,32,0.10)"
STEEL  = "#5980a6"   STEEL_D= "#416180"   STEEL_9 = "#1d2d3d"
OCHRE  = "#b07a2c"   OCHRE_T= "#8a5f22"   OXIDE = "#a8443b"   OXIDE_T = "#8e372f"
GREEN  = "#7fae86"   GREEN_T= "#3f6b48"
```
Additional literals used inline in these four views (not constants): `rgba(29,31,32,0.28)` (strong hairline),
`rgba(29,31,32,0.08)` (faintest row rule), `#eef6ff` (accent-100 tint), `#e9e9ea` (table head / map gutter),
`#e7e7ea` (stable traffic bar), `#8e8e92` (pending grey), `#98989b` (diff gutter number), `#597ea3` (eyebrow),
`#424244` (body prose), `#dfe6ee` (log text on dark), `#fdf2df` (ochre tint), `#1d2d3d` (log surface).

### 0.3 Status tone table `T` — `tones(palette)` (lines 1336–1350)
`T = tones(this.props.statusPalette ?? "colour")` (line 1416). Default is **"colour"**.

| key | glyph | label | `c` (text) | `line` (border) | `fill` (bg) |
|---|---|---|---|---|---|
| healthy | `✓` U+2713 | Healthy | `#3f6b48` | `#7fae86` | `#e6f2e8` |
| progressing | `↻` U+21BB | Progressing | `#2c455d` | `#8bb0d0` | `#e7f0f8` |
| degraded | `!` | Degraded | `#8a5f22` | `#e0ad66` | `#fdf2df` |
| failed | `×` U+00D7 | Failed | `#9c3f39` | `#dd9490` | `#fbe9e8` |
| missing | `∅` U+2205 | Missing | `#5b5468` | `#aea8bd` | `#efedf4` |
| unknown | `?` | Unknown | `#5d5d60` | `#c2c2c6` | `#f4f4f6` |
| pending | `·` U+00B7 | Pending | `#8e8e92` | `#d4d4d7` | `transparent` |

`palette === "quiet"` swaps **healthy only** to `{ c:#4a4a4c, line:#a8a8ab, fill:#f0f0f2 }`; all other tones are
identical in both palettes.

### 0.4 `chip()` and `pill()` (lines 1303–1309)
```js
chip(t) = "display:inline-flex; align-items:center; justify-content:center; width:16px; height:16px; flex:none;
           border:1px solid {t.line}; background:{t.fill}; color:{t.c}; font-size:10px; font-weight:700; line-height:1;"

pill(t) = "display:inline-flex; align-items:center; gap:5px; border:1px solid {t.line}; background:{t.fill};
           border-radius:2px; padding:1px 7px; font-size:10px; font-weight:600; letter-spacing:0.04em;
           text-transform:uppercase; color:{t.c};"
```
(`pill` takes a 2nd `label` arg that is never used.)

### 0.5 Design-system classes actually used in these four views (`styles.css`)
- `.blueprint` — `position:relative; border:1px solid var(--color-divider); border-radius:0;` (styles.css 73–77).
  Always given inline `background:#fff` and always followed by four `<i class="corner tl|tr|bl|br">`.
- `.corner` — `position:absolute; width:11px; height:11px; color:color-mix(in srgb, var(--color-text) 55%, transparent)`
  with `::before` (1px vertical, `left:5px; top:0; height:100%`) and `::after` (1px horizontal, `top:5px; left:0; width:100%`);
  offsets `-6px` from the matching corner (styles.css 83–95). These are registration marks drawn OUTSIDE the box.
- `.btn` — inline-flex, gap 6px, `font-family:var(--font-heading)`, `font-size:14px`, `line-height:1.2`,
  `padding: var(--space-2) calc(var(--space-3)*1.2)`, transparent bg, 1px transparent border (styles.css 140–149).
  `.btn-primary` = `background:var(--color-accent) (#5980a6); color:var(--color-bg) (#f2f2f3)`.
  `.btn-secondary` = `border-color:var(--color-divider)`. `.btn-ghost` = `color:var(--color-accent)`.
  Line 281 of styles.css forces `border-radius:0` on `.card,.btn,.tag,.seg,…`.
- `.seg` — `display:inline-flex; overflow:hidden; border:1px solid var(--color-divider); border-radius:var(--radius-md)`
  (styles.css 192–195). In these views the children are plain spans/buttons, NOT `.seg-opt`, so all inner
  padding/borders are supplied inline.
- Tokens: `--color-bg:#f2f2f3`, `--color-text:#1d1f20`, `--color-accent:#5980a6`, `--color-accent-100:#eef6ff`,
  `--color-divider: color-mix(in srgb,#1d1f20 16%,transparent)`.

### 0.6 `icon(name, size, color)` (lines 1396–1398)
Emits a 24×24-viewBox `<svg>` with `fill:none`, `stroke` = colour arg (default `currentColor`), `strokeWidth:1.5`,
round caps/joins, `style:{display:block, flex:none}`, path data injected from the `LUCIDE` map (lines 1380–1395).
Icon keys used below: `pkg` (line 1389), `file` (1390), `flask` (1394).

### 0.7 Screen switch (lines 2003–2004 of the return block)
```js
isPipeline: s === "pipeline", isRollout: s === "rollout", isDiff: s === "diff", isMap: s === "map"
```
`s = this.state.screen`; initial state `screen:"overview"` (line 1401). Nav links `goRollout/goMap/goDiff` exist;
there is **no** `goPipeline` in the return block — pipeline is reached from the nav item list only.

### 0.8 Shared page-header band
PIPELINE, ROLLOUT and SYNC & DIFF all open with the same band:
`border-bottom:1px solid rgba(29,31,32,0.16); background:#fff; padding:16px 22px;`
FLEET MAP does **not** use this band (see §4).
H1 in all four: `class="cond"; margin:0; font-size:30px; font-weight:600; letter-spacing:0.01em; line-height:1`.

---

# 1. PIPELINE (lines 943–1042)

Wrapper: `<sc-if value="{{ isPipeline }}">` (944) → a bare `<div>` (945).

## 1.1 Header (946–959)
Band as §0.8. Inner row: `display:flex; align-items:flex-start; justify-content:space-between; gap:20px;`.

**Left column (948–954)**
1. Breadcrumb — `.mono`, `font-size:10px; color:#7a7a7d`, text: `Pipelines / payments / checkout-api-build`
2. Title row — `display:flex; align-items:center; gap:12px; margin-top:5px;`
   - `<h1 class="cond">checkout-api-build</h1>` (30px/600/ls .01em/lh 1)
   - Status badge (**static markup, not a binding**):
     `display:inline-flex; align-items:center; gap:6px; border:1px solid #5980a6; background:#eef6ff;
      border-radius:2px; padding:2px 8px; font-size:11px; font-weight:600; color:#2c455d;`
     text `↻ RUNNING` (glyph U+21BB + space + RUNNING)
3. Sub-line — `.mono`, `margin-top:7px; font-size:11px; color:#5d5d60`, verbatim:
   `run #418 · push to main by @rmoreau · 9f3a1c2 “fix idempotent capture” · started 2m 14s ago`
   (note the curly quotes U+201C/U+201D around the commit message)

**Right actions (955–958)** — `display:flex; gap:7px; flex:none;`
| # | class | inline style | label |
|---|---|---|---|
| 1 | `btn btn-secondary` | `height:30px; background:#fff; white-space:nowrap;` | `Re-run` |
| 2 | `btn btn-secondary` | `height:30px; background:#fff; white-space:nowrap; color:#9c3f39; border-color:#dd9490;` | `Cancel run` |

## 1.2 Body grid (962)
`display:grid; grid-template-columns:minmax(0,1fr) 380px; align-items:start; gap:16px; padding:18px 22px 32px;`
Left = STEP GRAPH card. Right = a `flex-direction:column; gap:14px` stack of two cards.

## 1.3 Left card — "STEP GRAPH" (963–1000)
`<section class="blueprint" style="background:#fff;">` + 4 corner marks.

**Card head (966–969)** — `display:flex; align-items:center; justify-content:space-between;
border-bottom:1px solid rgba(29,31,32,0.16); padding:8px 14px;`
- `<h2 class="cond">Step graph</h2>` — `font-size:16px; font-weight:600; letter-spacing:0.05em; text-transform:uppercase;`
- right meta `.mono 10px #5d5d60`: `in-cluster · runner pool ci-amd64 · cache hit 74%`

**Canvas (970–992)**
Outer `overflow-x:auto`. Inner:
```
position:relative; height:460px; min-width:640px;
background-image: linear-gradient(rgba(29,31,32,0.055) 1px, transparent 1px),
                  linear-gradient(90deg, rgba(29,31,32,0.055) 1px, transparent 1px);
background-size: 22px 22px;
```

**Edges (972–981)** — one `<svg viewBox="0 0 640 460" width="640" height="460" style="position:absolute; inset:0;">`.
Every path: `stroke="rgba(29,31,32,0.3)" stroke-width="1" fill="none"`. Eight paths, verbatim `d`:
```
M115,64 L115,112                        checkout  → build
M115,156 L115,208                       build     → unit-test
M115,156 C115,184 315,180 315,208       build     → lint
M115,156 C115,184 515,180 515,208       build     → sbom-scan
M115,252 C115,278 315,274 315,300       unit-test → package
M315,252 L315,300                       lint      → package
M515,252 C515,278 315,274 315,300       sbom-scan → package
M315,344 L315,392                       package   → deploy dev
```
Geometry note: x anchors are node-left + 85 (half of the 170px node): 30→115, 230→315, 430→515.
y anchors are node-top and node-top+44, i.e. **node box height is 44px**.

**Nodes — `sc-for list="{{ dagNodes }}" as="d"`, `hint-placeholder-count="7"` (982–991)**
Markup per node:
```html
<div onClick="{{ d.select }}" style="{{ d.style }}">
  <span style="{{ d.glyphStyle }}">{{ d.glyph }}</span>
  <span style="flex:1; min-width:0;">
    <span class="cond" style="display:block; font-size:14px; font-weight:600; letter-spacing:0.03em;">{{ d.name }}</span>
    <span class="mono" style="display:block; font-size:10px; color:#7a7a7d;">{{ d.meta }}</span>
  </span>
</div>
```
`d.style` built at 1881–1885 from `DAG` (lines 1361–1369):
```
position:absolute; left:{x}px; top:{y}px; width:170px; box-sizing:border-box;
display:flex; align-items:center; gap:8px;
border:1px solid {sel ? #5980a6 : rgba(29,31,32,0.28)};
border-left:3px solid {T[state].line};
outline:{sel ? "2px solid rgba(89,128,166,0.25)" : "none"};
background:#fff; padding:7px 9px; cursor:pointer;
```
`d.glyphStyle = chip(T[state])` (16×16 square). `d.select = () => {}` (no-op).

`DAG` data (1361–1369), in render order:
| name | meta | x | y | state | sel | resolved left-border | glyph |
|---|---|---|---|---|---|---|---|
| `checkout` | `git · 4s` | 30 | 20 | healthy | – | `#7fae86` | ✓ |
| `build` | `kaniko · 48s` | 30 | 112 | healthy | – | `#7fae86` | ✓ |
| `unit-test` | `running · 1m06s` | 30 | 208 | progressing | **true** | `#8bb0d0` + steel border + steel outline | ↻ |
| `lint` | `golangci · 12s` | 230 | 208 | healthy | – | `#7fae86` | ✓ |
| `sbom-scan` | `trivy · 19s` | 430 | 208 | healthy | – | `#7fae86` | ✓ |
| `package` | `queued` | 230 | 300 | pending | – | `#d4d4d7`, chip fill transparent | · |
| `deploy dev` | `queued` | 230 | 392 | pending | – | `#d4d4d7` | · |

**Stats strip (993–1000)** — 1px hairline grid trick:
`display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1px; border-top:1px solid rgba(29,31,32,0.16); background:rgba(29,31,32,0.16);`
Each cell `background:#fff; padding:9px 14px;`
- label `.mono 9px; letter-spacing:0.14em; color:#7a7a7d`
- value `.cond; margin-top:2px; font-size:20px; font-weight:600; font-variant-numeric:tabular-nums`

`pipelineStats` (1886–1889), in order: `ELAPSED 2m 14s` · `CACHE HIT 74%` · `STEPS 3/7` · `CPU-MIN 9.4`.

## 1.4 Right card 1 — selected step "unit-test" (1003–1021)
`.blueprint` + corners.

**Head (1005–1011)** — `border-bottom:1px solid rgba(29,31,32,0.16); padding:9px 12px;`
- Row: `display:flex; align-items:center; justify-content:space-between;`
  - `<h3 class="cond">unit-test</h3>` — `font-size:16px; font-weight:600; letter-spacing:0.04em` (NOT uppercase)
  - badge (static): `border:1px solid #5980a6; background:#eef6ff; border-radius:2px; padding:1px 7px;
    font-size:10px; font-weight:600; color:#2c455d; gap:5px` → `↻ RUNNING`
- meta `.mono; margin-top:3px; font-size:10px; color:#7a7a7d`:
  `ghcr.io/acme/test-runner:3.2 · 4 CPU / 8 GiB · 1m 06s`

**Log surface (1013–1015)**
`div: border-bottom:1px solid rgba(29,31,32,0.16); background:#1d2d3d;`
`pre.mono: margin:0; max-height:280px; overflow:auto; padding:11px; font-size:11px; line-height:1.7;
 color:#dfe6ee; white-space:pre-wrap;` content `{{ pipelineLogs }}`.

`pipelineLogs` (line 1994) — one string, `\n`-separated, whitespace is column-aligned and significant:
```
09:39:41  ==> go test ./... -count=1 -race
09:39:44  ok      checkout/cart        0.42s
09:39:47  ok      checkout/pricing     1.10s
09:39:52  ok      checkout/tax         0.88s
09:40:01  --- FAIL: TestIdempotentCapture (0.31s)
09:40:01      capture_test.go:118: want 1 charge, got 2
09:40:02  ==> retrying 1 failed test (flake policy: 1 retry)
09:40:04  ok      checkout/capture     0.29s
09:40:09  ok      checkout/webhooks    2.31s
09:40:14  ==> 214 passed, 0 failed, 1 retried
```
There is **no per-line syntax colouring here** — the whole `<pre>` is a single `#dfe6ee` string.

**Footer buttons (1016–1020)** — `display:flex; gap:6px; padding:9px 12px;`
| class | style | label |
|---|---|---|
| `btn btn-secondary` | `height:26px; font-size:11px; background:#fff;` | `Retry step` |
| `btn btn-secondary` | `height:26px; font-size:11px; background:#fff;` | `Skip` |
| `btn btn-ghost` | `height:26px; font-size:11px;` | `Full logs ↗` (U+2197) |

## 1.5 Right card 2 — "ARTIFACTS" (1023–1036)
`.blueprint` + corners.
Head: `border-bottom:1px solid rgba(29,31,32,0.16); padding:8px 12px;` with
`<h3 class="cond">Artifacts</h3>` — `font-size:14px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase;`

Rows — `sc-for list="{{ artifacts }}" as="a"`, `hint-placeholder-count="3"`:
```
row: display:flex; align-items:center; gap:9px; border-bottom:1px solid rgba(29,31,32,0.10); padding:8px 12px;
[0] <span style="width:14px; display:flex;">{{ a.glyph }}</span>          ← lucide SVG
[1] <span style="flex:1; min-width:0;">
      name  .mono; display:block; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
      meta  display:block; font-size:10px; color:#7a7a7d;
    </span>
[2] <span style="{{ a.badgeStyle }}">{{ a.badge }}</span>                 ← pill(T[st])
```
`artifacts` (1890–1894):
| icon | name | meta | badge | st → pill colours |
|---|---|---|---|---|
| `icon("pkg",14,#416180)` | `ghcr.io/acme/checkout-api:9f3a1c2` | `oci image · 84 MB · sha256:4a1f…` | `SIGNED` | healthy → 1px `#7fae86` / bg `#e6f2e8` / text `#3f6b48` |
| `icon("file",14,#416180)` | `sbom.cyclonedx.json` | `412 components · 0 critical` | `CLEAN` | healthy |
| `icon("flask",14,#416180)` | `junit-report.xml` | `214 tests · 1 flake retried` | `1 FLAKE` | degraded → 1px `#e0ad66` / bg `#fdf2df` / text `#8a5f22` |

Note the last row also carries a `border-bottom` (no `:last-child` reset in the design).

---

# 2. ROLLOUT (lines 1043–1148)

Wrapper: `<sc-if value="{{ isRollout }}">` (1043) → bare `<div>` (1044).

## 2.1 Header (1045–1061)
Band as §0.8; same flex row (`align-items:flex-start; justify-content:space-between; gap:20px`).

**Left**
1. Breadcrumb `.mono 10px #7a7a7d`: `Rollouts / payments / checkout-api`
2. Title row (`gap:12px; margin-top:5px`):
   - `<h1 class="cond">checkout-api</h1>`
   - Badge (static, **ochre** not steel):
     `display:inline-flex; align-items:center; gap:6px; border:1px solid #b07a2c;
      background:rgba(176,122,44,0.10); border-radius:2px; padding:2px 8px;
      font-size:11px; font-weight:600; color:#8a5f22;` → `‖ PAUSED AT STEP 3` (U+2016 double vertical line)
3. Sub-line `.mono; margin-top:7px; font-size:11px; color:#5d5d60`:
   `canary · Deployment/checkout-api · prod-eu-1 · held 6m 12s pending analysis`

**Right actions (1055–1059)** — `display:flex; gap:7px; flex:none;` — three buttons, **destructive first**:
| # | class | style | label |
|---|---|---|---|
| 1 | `btn btn-secondary` | `height:30px; background:#fff; white-space:nowrap; color:#9c3f39; border-color:#dd9490;` | `Abort & roll back` (`&amp;` in source) |
| 2 | `btn btn-secondary` | `height:30px; background:#fff; white-space:nowrap;` | `Hold` |
| 3 | `btn btn-primary`   | `height:30px; white-space:nowrap;` | `Promote to 50%` |

## 2.2 Body (1063)
`padding:18px 22px 32px; display:flex; flex-direction:column; gap:16px;`
Stack = [Traffic ladder card] then [2-col grid: Analysis card | Rollout log card].

## 2.3 Card A — "TRAFFIC LADDER" (1064–1095)
`.blueprint` + corners.

**Head (1066–1069)** — `display:flex; align-items:baseline; justify-content:space-between;
border-bottom:1px solid rgba(29,31,32,0.16); padding:8px 14px;`
- `<h2 class="cond">Traffic ladder</h2>` — 16px/600/ls .05em/uppercase
- right `.mono 10px #5d5d60`: `istio VirtualService · checkout-api.payments.svc`

**Ladder body (1070–1084)** — `padding:18px 14px 14px;` around
`display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:8px;`
Per column (`sc-for list="{{ ladder }}" as="s"`, `hint-placeholder-count="6"`):
```
1. bar rail:  height:104px; display:flex; align-items:flex-end;   → inner div style={{ s.barStyle }}
2. row:       margin-top:9px; display:flex; align-items:center; justify-content:space-between; gap:6px;
                 <span class="cond" style="{{ s.weightStyle }}">{{ s.weight }}</span>
                 <span style="{{ s.glyphStyle }}">{{ s.glyph }}</span>        ← chip(), 16×16
3. step:      .mono; margin-top:3px; font-size:10px; letter-spacing:0.1em; color:#8e8e92;  → "STEP {{ s.n }}"
4. note:      margin-top:2px; font-size:11px; color:#5d5d60;
```
Derived styles (1896–1906):
```
barStyle    = width:100%; height:{h}px; border:1px solid {T[st].line};
              pending ? "border-style:dashed; background:transparent;" : "background:{T[st].fill};"
weightStyle = font-size:22px; font-weight:600; font-variant-numeric:tabular-nums;
              color: pending ? #8e8e92 : T[st].c
```
`ladder` data:
| n | weight | note | st | h (px) | bar border | bar fill | weight colour | glyph |
|---|---|---|---|---|---|---|---|---|
| 1 | `5%` | `passed 4/4` | healthy | 26 | `#7fae86` solid | `#e6f2e8` | `#3f6b48` | ✓ |
| 2 | `10%` | `passed 4/4` | healthy | 38 | `#7fae86` solid | `#e6f2e8` | `#3f6b48` | ✓ |
| 3 | `25%` | `held · latency` | degraded | 52 | `#e0ad66` solid | `#fdf2df` | `#8a5f22` | ! |
| 4 | `50%` | `queued` | pending | 68 | `#d4d4d7` **dashed** | transparent | `#8e8e92` | · |
| 5 | `75%` | `queued` | pending | 84 | `#d4d4d7` dashed | transparent | `#8e8e92` | · |
| 6 | `100%` | `queued` | pending | 100 | `#d4d4d7` dashed | transparent | `#8e8e92` | · |
Bars are bottom-aligned in a 104px rail, so the 100% bar nearly fills it.

**Traffic split footer (1085–1094)** — `border-top:1px solid rgba(29,31,32,0.16); padding:12px 14px;`
- Row `display:flex; align-items:center; gap:12px;`
  - label `.mono; font-size:10px; letter-spacing:0.12em; color:#7a7a7d; width:56px;` → `TRAFFIC`
  - bar `flex:1; display:flex; height:26px; border:1px solid rgba(29,31,32,0.28);` containing exactly two divs:
    - `width:75%; background:#e7e7ea; display:flex; align-items:center; padding-left:9px;`
      inner `.cond 13px/600/ls .05em` → `STABLE 75% · checkout-api-6b9c · 6 pods`
    - `width:25%; background:#5980a6; display:flex; align-items:center; padding-left:9px;`
      inner `.cond 13px/600/ls .05em; color:#f2f2f3` → `CANARY 25%`
- Caption row `margin-top:6px; padding-left:68px;` class `mono`, inner span `font-size:10px; color:#7a7a7d`:
  `canary · checkout-api-7d4f · 2 pods · image ghcr.io/acme/checkout-api:9f3a1c2`
  (68px = 56px label + 12px gap, so it aligns under the bar.)
These percentages are **hard-coded literals**, not bindings.

## 2.4 Two-column grid (1097)
`display:grid; grid-template-columns:minmax(0,1.35fr) minmax(0,1fr); gap:16px;`

## 2.5 Card B — "ANALYSIS — WHY IT PAUSED" (1098–1133)
`.blueprint` + corners.

**Head (1100–1103)** — `display:flex; align-items:baseline; justify-content:space-between;
border-bottom:1px solid rgba(29,31,32,0.16); padding:8px 14px;`
- `<h2 class="cond">Analysis — why it paused</h2>` — 16px/600/ls .05em/uppercase. Note the **em dash U+2014**.
- right `.mono; font-size:10px; color:#a8443b;` → `1 of 4 metrics failing`

**Table** — wrapped in `<div style="overflow-x:auto;"><div style="min-width:560px;">` (1104).
Shared grid template for head and rows:
`grid-template-columns: minmax(0,1.2fr) 78px 78px 84px 70px; align-items:center; gap:10px;`

Header row (1105–1111): `border-bottom:1px solid rgba(29,31,32,0.28); background:#e9e9ea; padding:0 14px; height:28px;`
Each header cell `.mono; font-size:9px; letter-spacing:0.14em; color:#5d5d60;`, cols 2–5 add `text-align:right`.
Column labels in order: `METRIC` · `BASELINE` · `CANARY` · `THRESHOLD` · `RESULT`.

Body rows (1112–1123): `border-bottom:1px solid rgba(29,31,32,0.10); padding:9px 14px;`
- col 1: wrapper `min-width:0` with
  name `.cond; display:block; font-size:14px; font-weight:600; letter-spacing:0.02em;`
  query `.mono; display:block; font-size:10px; color:#7a7a7d; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`
- col 2 baseline: `.mono; font-size:12px; text-align:right; font-variant-numeric:tabular-nums;`
- col 3 canary: `{{ m.canaryStyle }}` (1913):
  `font-family:ui-monospace,monospace; font-size:12px; text-align:right; font-variant-numeric:tabular-nums;
   color:{failed ? #8e372f : #1d1f20}; font-weight:{failed ? 700 : 400};`
- col 4 threshold: `.mono; font-size:12px; text-align:right; color:#5d5d60; font-variant-numeric:tabular-nums;`
- col 5 result: `<span style="text-align:right;"><span style="{{ m.resultStyle }}">{{ m.result }}</span></span>`
  `result = st === "failed" ? "FAIL" : "PASS"`; `resultStyle = pill(T[st])`.

`analysis` data (1907–1914):
| metric | query (mono, truncating) | baseline | canary | threshold | result | pill |
|---|---|---|---|---|---|---|
| `success rate` | `sum(rate(http_requests_total{code!~"5.."}[2m]))` | `99.94%` | `99.91%` | `≥ 99.5%` | `PASS` | healthy |
| `p99 latency` | `histogram_quantile(0.99, …)` | `412 ms` | **`581 ms`** (bold `#8e372f`) | `≤ 500 ms` | `FAIL` | failed (`#dd9490`/`#fbe9e8`/`#9c3f39`) |
| `error budget burn` | `burn_rate_1h / 14.4` | `0.3×` | `0.9×` | `≤ 2×` | `PASS` | healthy |
| `pod restarts` | `increase(kube_pod_container_status_restarts[5m])` | `0` | `0` | `= 0` | `PASS` | healthy |
Glyph characters: `≥` U+2265, `≤` U+2264, `×` U+00D7, `…` U+2026.

**Explainer callout (1125–1131)** — `padding:11px 14px; background:#fdf2df; border-top:1px solid rgba(29,31,32,0.10);`
Inner `display:flex; gap:9px;`
- bang: `<span style="color:#8a5f22; font-weight:700;">!</span>`
- prose: `font-size:12px; line-height:1.55; color:#424244;` verbatim (with `<strong>` on the metric name):
  > Paprika held the rollout automatically. **p99 latency** on the canary is 41% above baseline and breached its
  > threshold for 3 consecutive intervals. Promotion is blocked until the metric recovers or an operator overrides.

## 2.6 Card C — "ROLLOUT LOG" (1133–1143)
`.blueprint` + corners.
Head: `border-bottom:1px solid rgba(29,31,32,0.16); padding:8px 14px;`
`<h2 class="cond">Rollout log</h2>` — 16px/600/ls .05em/uppercase.

Rows — `sc-for list="{{ rolloutLog }}" as="l"`, `hint-placeholder-count="7"`:
```
display:grid; grid-template-columns:58px 14px minmax(0,1fr); align-items:baseline; gap:9px;
border-bottom:1px solid rgba(29,31,32,0.08); padding:7px 14px;
[0] time  .mono; font-size:10px; color:#7a7a7d;
[1] glyph {{ l.glyphStyle }}  ← chip(T[st]), 16×16 inside a 14px column (it overflows slightly by design)
[2] text  font-size:11px; line-height:1.5; color:#424244;
```
`rolloutLog` (1915–1923), newest first:
| at | st | glyph/tone | text |
|---|---|---|---|
| `09:41` | failed | `×` `#dd9490`/`#fbe9e8`/`#9c3f39` | `Analysis run golden-signals failed · p99 581 ms > 500 ms threshold (3 consecutive intervals)` |
| `09:38` | degraded | `!` ochre | `Rollout paused automatically at step 3. Traffic frozen at 25%.` |
| `09:35` | progressing | `↻` steel | `Weight advanced 10% → 25% · VirtualService updated` |
| `09:33` | healthy | `✓` green | `Analysis run golden-signals passed at 10% · 4/4 metrics` |
| `09:30` | progressing | `↻` steel | `Weight advanced 5% → 10%` |
| `09:28` | healthy | `✓` green | `Canary ReplicaSet checkout-api-7d4f scaled to 2 · pods ready` |
| `09:27` | progressing | `↻` steel | `Rollout started from release r241 · image 9f3a1c2` |
(`→` is U+2192.)

---

# 3. SYNC & DIFF (lines 1149–1218)

Wrapper: `<sc-if value="{{ isDiff }}">` (1150) → bare `<div>` (1151).

## 3.1 Header (1152–1162)
`display:flex; align-items:flex-end; justify-content:space-between; gap:20px;` + band as §0.8
(**`align-items:flex-end` here, unlike pipeline/rollout's `flex-start`**).
- Left: eyebrow `.mono; font-size:9px; letter-spacing:0.2em; color:#597ea3;` → `DRIFT CONTROL`
  then `<h1 class="cond" style="margin:4px 0 0; …">Sync & diff workbench</h1>` (`&amp;` in source).
- Right `display:flex; gap:7px;`:
  | class | style | label |
  |---|---|---|
  | `btn btn-secondary` | `height:30px; background:#fff;` | `Ignore field` |
  | `btn btn-secondary` | `height:30px; background:#fff;` | `Dry run` |
  | `btn btn-primary` | `height:30px;` | `Sync 3 selected` |

## 3.2 Two-pane shell (1164)
`display:grid; grid-template-columns:352px minmax(0,1fr); align-items:stretch; min-height:calc(100vh - 130px);`

## 3.3 Left rail — drift queue (1165–1183)
Container: `border-right:1px solid rgba(29,31,32,0.16); background:#fff;`

**Filter chip row (1166–1170)** — `display:flex; gap:5px; border-bottom:1px solid rgba(29,31,32,0.16); padding:9px 14px;`
Per chip: `<span style="{{ f.style }}">{{ f.label }} <span class="mono" style="font-size:9px; opacity:.65;">{{ f.count }}</span></span>`
`f.style` (1866–1867) — **index 1 is hard-coded as the active chip**:
```
display:inline-flex; align-items:center; gap:5px;
border:1px solid {i===1 ? #5980a6 : rgba(29,31,32,0.16)};
background:{i===1 ? #eef6ff : #fff};
border-radius:2px; padding:3px 8px; font-size:11px;
color:{i===1 ? #2c455d : #5d5d60}; cursor:pointer;
```
`diffFilters` in order: `All 14` · **`Drifted 3` (active)** · `Missing 1` · `Degraded 2` · `Pruned 0`.
Chips have no click handler.

**Queue rows (1171–1182)** — `sc-for list="{{ driftQueue }}" as="q"`, `hint-placeholder-count="8"`.
Row markup:
```html
<div onClick="{{ q.select }}" style="{{ q.style }}">
  <div style="display:flex; align-items:center; gap:8px;">
    <span style="{{ q.glyphStyle }}">{{ q.glyph }}</span>          ← chip(T[st]) 16×16
    <span class="mono" style="font-size:10px; letter-spacing:0.06em; color:#7a7a7d;">{{ q.kind }}</span>
    <span style="flex:1;"></span>                                  ← spacer
    <span class="mono" style="font-size:10px; color:#7a7a7d;">{{ q.fields }}</span>
  </div>
  <div class="cond" style="margin-top:2px; font-size:14px; font-weight:600; letter-spacing:0.02em;
                           overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{{ q.name }}</div>
  <div style="margin-top:1px; font-size:11px; color:#5d5d60;
              overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">{{ q.reason }}</div>
</div>
```
`q.style` (1879–1880):
```
border-bottom:1px solid rgba(29,31,32,0.10);
border-left:3px solid {sel ? #5980a6 : transparent};
background:{sel ? #eef6ff : #fff};
padding:9px 13px; cursor:pointer;
```
`q.select = () => {}` (no-op).

`driftQueue` (1869–1878) — 8 rows, only row 1 has `sel:true`:
| # | kind (mono caps) | name | reason | fields | st | glyph/tone |
|---|---|---|---|---|---|---|
| 1 | `DEPLOYMENT` | `checkout-api` | `replicas, image, memory, probe` | `4` | degraded | `!` ochre — **selected** |
| 2 | `CONFIGMAP` | `checkout-api-env` | `2 keys changed outside Paprika` | `2` | degraded | `!` |
| 3 | `SERVICE` | `notifications` | `annotation removed by controller` | `1` | degraded | `!` |
| 4 | `CRONJOB` | `reporting-etl-nightly` | `object missing in cluster` | `∅` (U+2205) | missing | `∅` `#aea8bd`/`#efedf4`/`#5b5468` |
| 5 | `HPA` | `web-frontend` | `maxReplicas drifted 12 → 20` | `1` | degraded | `!` |
| 6 | `INGRESS` | `auth-service` | `TLS secret rotated in place` | `1` | unknown | `?` `#c2c2c6`/`#f4f4f6`/`#5d5d60` |
| 7 | `SECRET` | `payments-gateway-key` | `protected · excluded from prune` | `0` | healthy | `✓` green |
| 8 | `POD` | `checkout-api-7d4f-m4p1` | `CrashLoopBackOff · 12 restarts` | `–` (U+2013 en dash) | failed | `×` red |

## 3.4 Right pane (1185–1215)
Container: `display:flex; flex-direction:column; background:#f2f2f3;` (grey, unlike the white left rail).

**Sub-header (1186–1199)** — `display:flex; align-items:center; justify-content:space-between; gap:16px;
border-bottom:1px solid rgba(29,31,32,0.16); background:#fff; padding:10px 18px;`
- Left: `.mono; font-size:10px; letter-spacing:0.1em; color:#7a7a7d;` → `DEPLOYMENT · payments`
  then `.cond; margin-top:1px; font-size:20px; font-weight:600; letter-spacing:0.02em;` → `checkout-api`
- Right (`display:flex; align-items:center; gap:16px;`):
  - `.mono; font-size:10px; color:#5d5d60;` → `4 changed fields · 2 additions · 2 removals`
    (**note this disagrees with the 4 add + 4 del lines actually rendered** — copy as-is)
  - `<div class="seg" style="height:26px;">` with three plain `<span>`s (no handlers):
    - `display:inline-flex; align-items:center; padding:0 10px; font-size:11px; background:#5980a6; color:#f2f2f3;` → `Unified`
    - `… padding:0 10px; font-size:11px; border-left:1px solid rgba(29,31,32,0.16);` → `Split`
    - same as above → `JSON patch`

**Scroll body (1200–1214)** — `flex:1; overflow:auto; padding:16px 18px 28px;`

### 3.4.1 Diff card (1201–1209)
`border:1px solid rgba(29,31,32,0.16); background:#fff;`
- File header: `.mono; border-bottom:1px solid rgba(29,31,32,0.16); padding:6px 12px; font-size:10px; color:#5d5d60;`
  → `apps/v1 Deployment · payments/checkout-api`
- Code body wrapper: `class="mono"; font-size:11.5px; line-height:1.85;`
- Per line (`sc-for list="{{ diffLines }}" as="d"`, `hint-placeholder-count="16"`):
```html
<div style="{{ d.style }}">
  <span style="display:inline-block; width:30px; color:#98989b; text-align:right; margin-right:12px;">{{ d.n }}</span>{{ d.text }}
</div>
```

**Gutter**: 30px wide, right-aligned, `#98989b`, 12px right margin. It shows the **line number only** —
the `+`/`-` sign is baked into `d.text` itself, not into the gutter.

**`dl(kind, n, text)` (1829–1833)** — the syntax/diff colouring:
```js
add: background:rgba(74,124,82,0.10); color:#2f5237;
del: background:rgba(168,68,59,0.10); color:#7d3129;
ctx: color:#5d5d60;                                  // no background
// then always appended:  padding:0 10px; white-space:pre;
```
Note: the map's 2nd tuple element (`"+" / "-" / " "`) is destructured away (`const [st] = map[kind]`) and unused.
The add/del greens/reds here (`#2f5237`, `#7d3129`, `rgba(74,124,82,.10)`, `rgba(168,68,59,.10)`) are **specific to
the diff** and do not equal the `T.healthy` / `T.failed` tones.

**`diffLines` (1834–1853)** — 18 rows, numbers 18…35, text is whitespace-significant (`white-space:pre`):
| n | kind | text (verbatim, leading spaces preserved) |
|---|---|---|
| 18 | ctx | `␣␣spec:` |
| 19 | ctx | `␣␣␣␣replicas: 3` |
| 20 | del | `-␣␣␣replicas: 1` |
| 21 | add | `+␣␣␣replicas: 3` |
| 22 | ctx | `␣␣␣␣template:` |
| 23 | ctx | `␣␣␣␣␣␣spec:` |
| 24 | ctx | `␣␣␣␣␣␣␣␣containers:` |
| 25 | ctx | `␣␣␣␣␣␣␣␣- name: app` |
| 26 | del | `-␣␣␣␣␣␣␣␣␣image: ghcr.io/acme/checkout-api:8c22b90` |
| 27 | add | `+␣␣␣␣␣␣␣␣␣image: ghcr.io/acme/checkout-api:9f3a1c2` |
| 28 | ctx | `␣␣␣␣␣␣␣␣␣␣resources:` |
| 29 | ctx | `␣␣␣␣␣␣␣␣␣␣␣␣limits:` |
| 30 | del | `-␣␣␣␣␣␣␣␣␣␣␣␣␣memory: 512Mi` |
| 31 | add | `+␣␣␣␣␣␣␣␣␣␣␣␣␣memory: 1Gi` |
| 32 | ctx | `␣␣␣␣␣␣␣␣␣␣␣␣␣␣cpu: "1"` |
| 33 | ctx | `␣␣␣␣␣␣␣␣␣␣readinessProbe:` |
| 34 | del | `-␣␣␣␣␣␣␣␣␣␣␣timeoutSeconds: 1` |
| 35 | add | `+␣␣␣␣␣␣␣␣␣␣␣timeoutSeconds: 3` |
(`␣` = one literal space. `hint-placeholder-count` says 16 but the real list is 18.)
Same `diffLines` binding is reused by the App-detail panel at line 905 (`hint-placeholder-count="14"`).

### 3.4.2 "WHY THIS DRIFTED" card (1210–1213)
`margin-top:14px; border:1px solid rgba(29,31,32,0.16); background:#fff; padding:12px 14px;`
- Title `.cond; font-size:14px; font-weight:600; letter-spacing:0.06em; text-transform:uppercase;` → `Why this drifted`
- Prose `<p style="margin:6px 0 0; font-size:12px; line-height:1.6; color:#424244;">`, with two inline
  `<span class="mono">` runs. Verbatim:
  > The live object was last written by `kubectl-client-side-apply` 12 minutes ago, outside Paprika. The rendered
  > manifest from `deploy/chart@9f3a1c2` still declares 3 replicas and the previous image tag. Syncing restores the
  > declared state; ignoring the field records an exception on the Application.

---

# 4. FLEET MAP (lines 1219–1264)

Wrapper: `<sc-if value="{{ isMap }}">` (1220) → `<div style="padding:18px 22px 32px;">` (1221).
**No white header band** — the header sits directly on the `#f2f2f3` page.

## 4.1 Header (1222–1242)
`display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:16px;`

**Left (1223–1226)**
- eyebrow `.mono; font-size:9px; letter-spacing:0.2em; color:#597ea3;` → `TOPOLOGY`
- `<h1 class="cond" style="margin:4px 0 0; font-size:30px; font-weight:600; letter-spacing:0.01em;
  line-height:1; white-space:nowrap;">Cluster & fleet map</h1>` (`&amp;` in source)

**Right (1227–1241)** — `display:flex; align-items:center; gap:18px; flex-wrap:wrap; justify-content:flex-end;`

*(a) Legend* — `<span style="display:flex; align-items:center; gap:10px;">` over
`sc-for list="{{ graphLegend }}" as="l"`, `hint-placeholder-count="4"`:
```html
<span style="display:inline-flex; align-items:center; gap:5px; font-size:11px; color:#5d5d60;">
  <span style="{{ l.glyphStyle }}">{{ l.glyph }}</span>{{ l.label }}</span>
```
`graphLegend` (1793): `["healthy","progressing","degraded","failed"]` → `{ label: T[k].label, glyph: T[k].glyph,
glyphStyle: chip(T[k]) }`. Rendered, in order:
`✓ Healthy` · `↻ Progressing` · `! Degraded` · `× Failed` (16×16 chips with each tone's border/fill/text).
This same binding is reused by the overview at line 262 and app-detail at 789.

*(b) Row-grouping segmented control* — `<span style="display:flex; align-items:center; gap:8px;">`:
- caption `.mono; font-size:9px; letter-spacing:0.14em; color:#7a7a7d;` → `ROWS`
- `<div class="seg" style="height:30px;">` containing `sc-for list="{{ mapRowChips }}" as="g"` (`count 2`)
  → `<button type="button" onClick="{{ g.select }}" style="{{ g.style }}">{{ g.label }}</button>`

`mapRowChips` (1734–1737): options `[["stage","Stage"], ["project","Project"]]`.
```
display:inline-flex; align-items:center; border:0;
{k === "stage" ? "" : "border-left:1px solid rgba(29,31,32,0.16);"}
padding:0 11px; height:100%; font:inherit; font-size:11px; font-weight:600; cursor:pointer;
background:{active ? #5980a6 : transparent};
color:{active ? #f2f2f3 : #5d5d60};
select: () => this.setState({ mapRowsBy: k })
```
Default `state.mapRowsBy = "stage"` (line 1402) → **Stage** is active.

## 4.2 The grid (1244–1260)
`<section class="blueprint" style="background:#fff;">` + 4 corner marks, containing ONE grid:
```
display:grid; grid-template-columns:124px repeat(3,minmax(0,1fr)); gap:1px; background:rgba(29,31,32,0.16);
```
The `gap:1px` over a `rgba(29,31,32,0.16)` background is the hairline mechanism — cells paint their own bg.
**Column count is hard-coded to 3** (matching `mapClusters.length === 3`).

**Row 0 — column headers (1246–1252)**
- Cell (0,0): `<div style="background:#e9e9ea;"></div>` — empty corner spacer.
- Then `sc-for list="{{ mapClusters }}" as="c"` (`hint-placeholder-count="3"`), each:
  `background:#e9e9ea; padding:9px 12px;`
  - name `.cond; font-size:16px; font-weight:600; letter-spacing:0.04em;`
  - meta `.mono; margin-top:1px; font-size:10px; color:#5d5d60;`

`mapClusters` (1925–1929):
| name | meta |
|---|---|
| `prod-eu-1` | `18 nodes · eu-west` |
| `prod-us-1` | `22 nodes · us-east-2` |
| `staging-1` | `4 nodes · shared` |

**Body rows (1253–1259)** — `sc-for list="{{ mapRows }}" as="r"` (`hint-placeholder-count="3"`), and inside it a
nested `sc-for list="{{ r.cells }}" as="cell"` (`count 3`). Both loops emit siblings straight into the same grid,
so a row = 1 stub cell + 3 data cells.

- **Row stub**: `background:#e9e9ea; display:flex; align-items:center; padding:0 12px; min-width:0;` with
  `<span class="cond" style="font-size:15px; font-weight:600; letter-spacing:0.04em; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap;">{{ r.stage }}</span>`
  (The row label is rendered **verbatim lowercase** — `prod`, `staging`, `dev` — no text-transform.)

- **Data cell**: `background:#fff; padding:10px 12px; min-height:106px;`
  - squares container: `display:flex; flex-wrap:wrap; gap:3px;` over
    `sc-for list="{{ cell.apps }}" as="ap"` (`hint-placeholder-count="8"`) →
    `<span onClick="{{ ap.open }}" style="{{ ap.style }}" title="{{ ap.title }}">{{ ap.glyph }}</span>`
  - summary: `.mono; margin-top:9px; font-size:10px; color:#7a7a7d;` → `{{ cell.summary }}`

**Square style — `sq(st)` (1930)**:
```
display:inline-flex; align-items:center; justify-content:center;
width:18px; height:18px;
border:1px solid {T[st].line}; background:{T[st].fill}; color:{T[st].c};
font-size:10px; font-weight:700; cursor:pointer;
```
Glyph = `T[st].glyph`. `title` = `` `${a.name} · ${T[a.health].label}` `` (e.g. `checkout-api · Degraded`).
`open` = `openApp` (line 1421) = `this.setState({ screen:"appDetail", panel:null })`.

## 4.3 Data actually bound
There are **two** row datasets in the script; the return block (line 1997) does
`mapRows: mapRowsLive` — so the **static `mapRows` const at 1943–1959 is dead code** and must not be used.

`mapRowsLive` (1932–1941) derives from `APPS` (1311–1327):
```js
mapRowKeys = mapRowsBy === "stage" ? ["prod","staging","dev"]
                                   : [...new Set(APPS.map(a => a.project))].sort();
cells      = mapClusters.map(c => APPS.filter(a => (mapRowsBy==="stage" ? a.env : a.project) === rk
                                               && a.cluster === c.name)
                                     .sort((a,b) => HEALTH_RANK[a.health] - HEALTH_RANK[b.health]));
bad        = list.filter(a => HEALTH_RANK[a.health] < 3).length;   // failed|missing|degraded
summary    = list.length ? `${n} target${n===1?"":"s"}${bad ? ` · ${bad} unhealthy` : " · all healthy"}`
                         : "no targets";
```
`HEALTH_RANK` (1329): `failed:0, missing:1, degraded:2, progressing:3, unknown:4, healthy:5` — worst-first sort,
so bad squares always lead each cell.

**Resolved default view (`mapRowsBy = "stage"`), computed from the 16 APPS rows:**

| row | prod-eu-1 | prod-us-1 | staging-1 |
|---|---|---|---|
| `prod` | 5 squares: degraded(checkout-api) then 4 healthy (payments-gateway, auth-service, search-indexer, web-frontend) — `5 targets · 1 unhealthy` | 5 squares: degraded(notifications) then 4 healthy (payments-gateway, fraud-scorer, auth-service, warehouse-sync) — `5 targets · 1 unhealthy` | empty — `no targets` |
| `staging` | empty — `no targets` | 1 square: missing(reporting-etl) — `1 target · 1 unhealthy` | 3 squares: progressing(ledger-worker), progressing(web-frontend), healthy(checkout-api) — `3 targets · all healthy` |
| `dev` | empty — `no targets` | empty — `no targets` | 2 squares: healthy(fraud-scorer), healthy(cms-preview) — `2 targets · all healthy` |

Note `progressing` (rank 3) is **not** counted as unhealthy, which is why the staging/staging-1 cell reads
"all healthy" while showing two `↻` squares.

Switching the chip to **Project** produces 5 rows (sorted unique projects):
`data/analytics`, `payments/core`, `payments/risk`, `platform/shared`, `web/storefront`.

The dead static `mapRows` (1943–1959) used denser fake cells — prod: 12/10/0 apps
(`12 apps · 1 degraded · 1 failed`, `10 apps · 1 degraded · 1 missing`, `no prod targets`);
staging: 6/7/7; dev: 6/5/4 — recorded here only so an implementer recognises it and skips it.

## 4.4 Footer caption (1262)
`<p style="margin:12px 0 0; font-size:11px; color:#5d5d60;">` verbatim:
> Each square is one application at one target. Size is fixed here; the treemap presentation sizes by managed
> resource count or request rate. Click a square to open its Application record.

---

# 5. Cross-cutting notes for implementers

1. **Hairline system.** Three weights are used consistently: `rgba(29,31,32,0.28)` (table head underline, DAG node
   border, traffic bar frame), `rgba(29,31,32,0.16)` (card borders, card-head rules, section rules — this equals
   `--color-divider`), `rgba(29,31,32,0.10)` (list-row rules) and `rgba(29,31,32,0.08)` (rollout-log rows only).
2. **Grid-gap hairlines.** Both the pipeline stats strip and the fleet map draw their internal rules with
   `gap:1px` + a divider-coloured container background, not with borders.
3. **Every card is `.blueprint` + 4 `<i class="corner">` + inline `background:#fff`.** The corner marks render
   6px outside the box, so cards need surrounding padding/gap ≥ ~8px (the views use 14–16px).
4. **Two uppercase heading scales.** Card `h2` = `.cond 16px/600/ls .05em/uppercase`;
   sub-card `h3` = `.cond 14px/600/ls .06em/uppercase`. The unit-test step `h3` is the exception:
   `16px/600/ls .04em`, *not* uppercased.
5. **Eyebrow pattern** (diff + map only): `.mono 9px/ls .2em/#597ea3` above a 30px `.cond` H1.
6. **Numeric cells** always carry `font-variant-numeric:tabular-nums` (pipeline stats, ladder weights,
   analysis baseline/canary/threshold).
7. **Dead/inert interactions in the mock**: `dagNodes[].select`, `driftQueue[].select` are `() => {}`;
   `diffFilters` chips, the Unified/Split/JSON-patch `.seg`, and all `.btn`s in these four views have no handlers.
   The only live handlers are `mapRowChips[].select` (setState `mapRowsBy`) and the fleet-map square's
   `open` → `openApp` (navigates to `appDetail`).
8. **Status glyphs are text characters, not icons** — `✓ ↻ ! × ∅ ? ·` rendered inside a 16px (chip) or 18px (map
   square) bordered box at `font-size:10px; font-weight:700`. Only the artifacts list uses real SVG (lucide
   `pkg`/`file`/`flask` at 14px, stroke `#416180`, strokeWidth 1.5).
9. **Internal inconsistencies to preserve or fix deliberately**: diff sub-header says "2 additions · 2 removals"
   while 4 add + 4 del lines render; diff context line 19 already reads `replicas: 3` yet line 20 deletes
   `replicas: 1`; `hint-placeholder-count="16"` vs 18 real diff lines; the rollout-log glyph column is 14px wide
   for a 16px chip.
