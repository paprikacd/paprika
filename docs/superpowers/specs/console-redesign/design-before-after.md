# Paprika console — BEFORE → AFTER design diff

Sources (read-only, treated as data):

- **BEFORE** = `scratchpad/design/console-current.dc.html` (896 lines) — mockup of the console *as it exists today*.
- **AFTER** = `scratchpad/design/console.dc.html` (2006 lines) — the target design. Template `9..1280`, script `1281..2004`.
- **DS** = `scratchpad/design/styles.css` (285 lines) — the "Industry" design system the target imports.

Line citations below are `before:NNN` / `after:NNN` / `ds:NNN`.

---

## 1. View inventory

### BEFORE — 5 screens

State is `{ screen, view }` (`before:714`). `screen` ∈ `overview | applications | appDetail | pipeline | rollout` (`before:877-878`).

| # | Screen | Guard | Lines |
|---|---|---|---|
| 1 | Operations overview | `isOverview` | before:92–331 |
| 2 | Applications inventory | `isApplications` | before:333–417 |
| 3 | Application detail | `isAppDetail` | before:419–562 |
| 4 | Pipeline detail | `isPipeline` | before:564–604 |
| 5 | Rollout detail | `isRollout` | before:606–644 |

Note: `presentations` (Treemap / Matrix / Table / Queue) exists as a 4-button segmented control (`before:355-357`, `before:823-830`) but **only sets `state.view`** — there is no `isTreemap`/`isMatrix`/`isQueue` branch. All four buttons render the same table.

### AFTER — 7 screens + 4 sub-presentations + 1 slide-over

State is a 20-key object (`after:1401-1403`). `screen` ∈ `overview | applications | appDetail | pipeline | rollout | diff | map` (`after:1963-1964`).

| # | Screen | Guard | Lines | Status |
|---|---|---|---|---|
| 1 | Operations overview | `isOverview` | after:97–466 | restyle + rebuilt content |
| 2 | Applications | `isApplications` | after:469–656 | restyle + expansion |
| 2a | ├ Table | `isTable` | after:507–573 | restyle |
| 2b | ├ Treemap | `isTreemap` | after:575–600 | **NEW** |
| 2c | ├ Matrix | `isMatrix` | after:602–629 | **NEW** |
| 2d | └ Queue | `isQueue` | after:631–649 | **NEW** |
| 3 | Application detail | `isAppDetail` | after:659–941 | restyle + expansion |
| 3a | └ Resource inspector slide-over | `panelOpen` | after:872–939 | **NEW** |
| 4 | Pipeline detail | `isPipeline` | after:944–1040 | restyle + expansion |
| 5 | Rollout detail | `isRollout` | after:1043–1147 | near-total rewrite |
| 6 | Sync & diff workbench | `isDiff` | after:1150–1217 | **NEW** |
| 7 | Cluster & fleet map | `isMap` | after:1220–1275 | **NEW** |

The target also exposes three canvas props (`after:1281`):

- `density` enum `compact | comfortable`, default `compact` (section "Table") → drives `rowH = 42 | 52` (`after:1418`).
- `showLifecycleStrip` boolean, default `true` (section "Table") → the 6-cell lifecycle strip column.
- `statusPalette` enum `colour | quiet`, default `colour` (section "Status") → `quiet` recolours *healthy* to greyscale `#4a4a4c / #a8a8ab / #f0f0f2` (`after:1289-1291`).

---

## 2. Chrome

### 2.1 Left navigation

| | BEFORE (`before:28-76`) | AFTER (`after:30-55`) |
|---|---|---|
| Layout | `position:fixed; top/bottom/left:0; z-index:40`, content offset by `padding-left:256px` (`before:78`) | static flex column inside `display:flex; min-height:100vh` (`after:28`) |
| Width | `256px` | `206px` |
| Background | `oklch(0.115 0.01 50)` (same as page) | `#1d2d3d` (accent-900, dark slab against light page) |
| Text | `oklch(0.93 0.012 50)` | `#f2f2f3` |
| Border | `border-right:1px solid oklch(0.24 0.012 50)` | none (colour contrast only) |
| Brand block | 64px tall row, `border-bottom`, `padding:0 20px`; 32×32 `border-radius:6px` tile `background:oklch(0.63 0.19 35)` with letter **"P"** 12px/700; then "Paprika" 14px/600 ls −0.01em; then "Control plane" JetBrains Mono 9px uppercase ls 0.14em `#mutedFg` | `padding:14px 16px 13px`, `border-bottom:1px solid rgba(242,242,243,0.16)`. **No logo tile.** Wordmark **"PAPRIKA"** Barlow Condensed 19px/700 ls 0.14em line-height 1; sub **"CONTROL PLANE · v2.4.1"** mono 9px ls 0.12em `#94bce3` |
| Nav body | `padding:20px 12px`, sections `gap:24px` | `padding:12px 0`, sections `margin-bottom:14px` |
| Section label | JetBrains Mono 10px/500 uppercase ls 0.18em `oklch(0.62 0.015 50)`, `padding:0 12px`, `margin:0 0 8px` | mono 9px ls 0.18em `rgba(242,242,243,0.42)`, `padding:0 16px 6px` |
| Item metrics | `min-height:44px; gap:12px; padding:0 12px`, Instrument Sans 14px/500, sentence case (`before:659`) | `height:29px; gap:9px; padding:0 16px`, **Barlow Condensed 14px/500 ls 0.05em `text-transform:uppercase`** (`after:1440`) |
| Item active | `background:oklch(0.21 0.012 50); color:fg; box-shadow:inset 2px 0 0 oklch(0.63 0.19 35)` (left accent bar) (`before:660`) | `background:#5980a6; color:#f2f2f3` — **solid steel fill, no accent bar** (`after:1447`) |
| Item idle | `background:none; color:oklch(0.62 0.015 50)` | `background:none; color:rgba(242,242,243,0.74)` |
| Item icon | 16px Lucide, `stroke-width:2` | 14px Lucide, `stroke-width:1.5` + round caps/joins, in a `width:14px` box at `opacity:.85` (`after:42`, `after:1397`) |
| Item badge | none | trailing mono 9px count at `opacity:.55` (`after:44`) |
| Footer | `border-top`, `padding:12px`; 32×32 **square** avatar `background:oklch(0.21 0.012 50)` with user glyph; `sre@paprika.io` 12px/600 ellipsised; `Authenticated` mono 9px uppercase ls 0.12em; **44×44 log-out icon button** (`before:66-75`) | `border-top:1px solid rgba(242,242,243,0.16); padding:10px 16px`; `sre@paprika.io` Barlow Condensed 13px ls 0.04em; `PLATFORM · ON-CALL` mono 9px ls 0.1em `rgba(242,242,243,0.5)`. **No avatar, no sign-out control.** |

**Nav items, verbatim:**

BEFORE (`before:41-62`, `before:881-885`):

- `Fleet` → **Overview**, **Applications**
- `Delivery` → **Pipelines**, **Releases** (stub — `onClick={{ goOverview }}`, `before:52`), **Rollouts**
- `System` → **Activity** *(disabled, `title="Available in a later plan"`, `opacity:.4`, `cursor:not-allowed`)*, **Admin** *(same disabled treatment)*

AFTER (`after:1423-1439`):

- `FLEET` → **Overview** (no badge), **Applications** (badge `16` = `APPS.length`), **Fleet map**
- `DELIVERY` → **Pipelines** (3), **Rollouts** (3), **Sync & diff** (8)
- `SOURCES` → **Repositories** (41, stub → `overview`), **Templates** (4, stub → `overview`), **Clusters** (3, stub → `map`)

`activeKey` maps `appDetail` → `applications` in both files (`before:882`, `after:1441`).

### 2.2 Header / scope bar

| | BEFORE (`before:79-88`) | AFTER (`after:59-92`) |
|---|---|---|
| Element | `<section>` `position:sticky; top:0; z-index:30` | `<header>` in normal flow |
| Height | `min-height:48px`, `overflow-x:auto`, `padding:0 24px` | `height:42px` fixed |
| Background | `oklch(0.155 0.014 50)` (card, dark) | `#fff` |
| Border | `border-bottom:1px solid oklch(0.24 0.012 50)` | `border-bottom:1px solid rgba(29,31,32,0.16)` |
| First cell | Label **"Fleet scope"** JetBrains Mono 10px/500 uppercase ls 0.16em, colour `oklch(0.63 0.19 35)` (primary), `border-right`, `padding-right:16px` | *removed* — scope selectors start immediately |
| Scope cells | Three **inert `<div>`s** (no `onClick`): 14px icon + 12px/500 label — **"All projects"**, **"All clusters"**, **"All stages"**, each `padding:0 16px` with `border-right` except the last | Three **`<button>` dropdowns** driven by `scopes` (`after:1457-1467`), keys `project`/`cluster`/`stage`. Each: mono 9px ls 0.12em `#7a7a7d` key label (`PROJECT`/`CLUSTER`/`STAGE`) + Barlow Condensed 14px/600 ls 0.02em value + 12px chevron; `height:100%; gap:7px; padding:0 14px; border-right:1px solid rgba(29,31,32,0.16)`. Background `#e7f0f8` when scoped, `#f5f5f8` when open, else transparent |
| Dropdown | — | `position:absolute; top:100%; left:0; z-index:80; min-width:220px; border:1px solid rgba(29,31,32,0.28); background:#fff; box-shadow:0 3px 10px rgba(43,43,45,0.16)`. Options 30px tall, 12px, `border-bottom:1px solid rgba(29,31,32,0.10)`, selected `#e7f0f8`, right-aligned mono 10px count (`after:69-73`, `after:1462-1466`) |
| Clear | — | When any scope ≠ All: `{{ scopeSummary }} · clear` at 11px `#416180` — summary format `"{n} of 16 targets in scope"` (`after:78`, `after:1472`) |
| Global search | **none in chrome** | borderless `flex:1` search input, placeholder `Search apps, resources, revisions, runs…   ⌘K`, 13px (`after:80-83`) |
| Right rail | — | `border-left`, `padding:0 14px`: 6×6px square `#5980a6` with `animation:blip 2.4s ease-in-out infinite` + mono 10px `live · 12s`; then mono 10px `#7a7a7d` `gen 4412` (`after:85-91`) |

### 2.3 Page container

- BEFORE: `<main style="min-height:calc(100vh - 48px)">`; overview/app-detail/rollout wrapped in `margin:0 auto; max-width:1280px; padding:32px 24px`, pipeline `max-width:1152px` (`before:90, 93, 420, 565, 607`).
- AFTER: `<main style="flex:1; min-width:0">`; **no max-width anywhere** — full bleed. Padding `20px 22px 32px` (overview, `after:98`), `18px 22px 32px` (app detail/rollout/pipeline/map), and `18px 22px 14px` for the Applications header (`after:471`). Body vertical gaps drop from 24–40px to 14–20px.

---

## 3. Visual language

### 3.1 Typography

| | BEFORE (`before:13-15`) | AFTER (`after:13-19`, `ds:44-46`) |
|---|---|---|
| Display / heading | **Instrument Sans** 600 | **Barlow Condensed** 600 via `.cond` (`--font-heading`) |
| Body | **Instrument Sans** 400/500/600/700 | **Barlow** 400/500/600 (`--font-body`) |
| Mono | **JetBrains Mono** 400/500 (webfont) | `ui-monospace, SFMono-Regular, Menlo, monospace` via `.mono` — **system stack, no webfont** |
| Base size | `14px` | `13px` |
| Google Fonts | `Instrument+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500` | `Barlow+Condensed:wght@400;500;600;700&family=Barlow:wght@400;500;600` |
| h1 | 30px/600 ls **−0.02em** | 30px/600 ls **+0.01em**, `line-height:1`, `.cond` |
| Board h2 | 14px/600 sentence case | 17px/600 ls 0.04em **UPPERCASE** `.cond` (overview boards); 16px/600 ls 0.05em UPPERCASE (detail cards); 14px/600 ls 0.06em UPPERCASE (side cards) |
| Kicker | JetBrains Mono 10px/600 uppercase ls 0.16–0.18em, primary or muted | mono 9px ls 0.14–0.20em, `#597ea3` (page kicker) or `#7a7a7d` (in-card) |
| Table header | JetBrains Mono 10px/600 uppercase ls 0.14em | mono 9px ls 0.14em `#5d5d60` (no explicit weight) |
| Big numerals | JetBrains Mono 20px/600 tabular | **Barlow Condensed** 34px/600 (lifecycle), 24px (canary weight), 22px (ladder), 20px (matrix cell, pipeline stat), 19px (posture count) — all `font-variant-numeric:tabular-nums` |
| Link | `oklch(0.63 0.19 35)`, hover `oklch(0.72 0.17 35)`, no underline | `#416180`, hover `#2c455d` **+ underline** |
| `::selection` | not set | `#d6ebff` |

### 3.2 Palette

BEFORE (`before:652-657`) — **dark, OKLCH**:

```
bg        oklch(0.115 0.01 50)     card      oklch(0.155 0.014 50)
border    oklch(0.24 0.012 50)     muted     oklch(0.19 0.01 50)
mutedFg   oklch(0.62 0.015 50)     fg        oklch(0.93 0.012 50)
primary   oklch(0.63 0.19 35)      accentSb  oklch(0.21 0.012 50)
success   oklch(0.53 0.12 145)     destructive oklch(0.56 0.18 25)
warning   oklch(0.68 0.14 75)
```

plus raw Tailwind-family hexes for tile tones (`before:663-668`): healthy `#10b981`, degraded `#f43f5e`, progressing `#0ea5e9`, out-of-sync `#f59e0b`; and DAG phase colours (`before:711`) `Running #3b82f6`, `Succeeded #22c55e`, `Failed #ef4444`, `Skipped #eab308`, `Cancelled #6b7280`, `Pending #94a3b8`. **Two disjoint colour systems coexist.**

AFTER (`after:1282-1301`) — **light, literal hex, one system**:

```
PAPER  #f2f2f3   INK    #1d1f20   MUTED  #5d5d60   FAINT  #7a7a7d
DIV    rgba(29,31,32,0.16)        DIV2   rgba(29,31,32,0.10)   (also 0.08 used)
surface #e9e9ea  zebra  #fbfbfc   inset  #f5f5f8
STEEL  #5980a6   STEEL_D #416180  STEEL_9 #1d2d3d
OCHRE  #b07a2c   OCHRE_T #8a5f22
OXIDE  #a8443b   OXIDE_T #8e372f
GREEN  #7fae86   GREEN_T #3f6b48
```

Status tone table `tones()` (`after:1288-1301`) — each state gets `{glyph, label, c(text), line(border), fill(background)}`:

| state | glyph | label | c | line | fill |
|---|---|---|---|---|---|
| healthy | `✓` | Healthy | `#3f6b48` | `#7fae86` | `#e6f2e8` |
| progressing | `↻` | Progressing | `#2c455d` | `#8bb0d0` | `#e7f0f8` |
| degraded | `!` | Degraded | `#8a5f22` | `#e0ad66` | `#fdf2df` |
| failed | `×` | Failed | `#9c3f39` | `#dd9490` | `#fbe9e8` |
| missing | `∅` | Missing | `#5b5468` | `#aea8bd` | `#efedf4` |
| unknown | `?` | Unknown | `#5d5d60` | `#c2c2c6` | `#f4f4f6` |
| pending | `·` | Pending | `#8e8e92` | `#d4d4d7` | `transparent` |

`statusPalette: "quiet"` swaps healthy to `{c:#4a4a4c, line:#a8a8ab, fill:#f0f0f2}` so only problems carry colour.

**The paprika-red brand accent (`oklch(0.63 0.19 35)`) is gone entirely.** The accent is now steel blue `#5980a6`. Warm/red hues appear only as *status* (ochre = degraded, oxide = failed/drift).

Scrollbars: before `width:8px; thumb oklch(0.3 0.01 50) radius 4px; track transparent` → after `width:9px; thumb #c4c4c8; track #e9e9ea; no radius` (`before:18-20`, `after:21-23`).

### 3.3 Radii & shape

| | BEFORE | AFTER |
|---|---|---|
| Big cards | `border-radius:21.6px` | **0** |
| Inner surfaces | `16.8px` | **0** |
| Medium | `12px` | **0** |
| Chips/badges | `9px` | `2px` (`--radius-sm`) |
| Pills | `9999px` | `2px` |
| Small squares | `6px` | 0 or 2px |
| DS override | — | `.card, .btn, .input, .tag, .seg, .dialog { border-radius: 0 }` (`ds:281`) |

`ds:281-285` is explicit: "components are wireframe objects — square, transparent, hairline-bordered".

### 3.4 Borders & elevation

- BEFORE: nearly every card is `background:oklch(0.155 0.014 50); box-shadow:0 0 0 1px oklch(0.93 0.012 50 / 0.1)` — a 1px *ring*, faked elevation, no real shadow. Real shadows appear once: `0 1px 2px rgba(0,0,0,0.3)` on DAG nodes (`before:759`). Some panels use `border:1px solid oklch(0.24 0.012 50)` instead of the ring — the two treatments are used inconsistently in the same view (compare `before:104` vs `before:171`).
- AFTER: uniform hairlines. `rgba(29,31,32,0.16)` for structural dividers, `0.10` for row separators, `0.08` for tight lists, `0.28` for emphasised header rules (table header bottom, popover/graph node borders). **Zero elevation on in-page surfaces.** Shadows only on genuine overlays:
  - scope dropdown `0 3px 10px rgba(43,43,45,0.16)` (`after:69`)
  - heatmap settings popover `0 8px 22px rgba(29,45,61,0.18)` (`after:189`)
  - heat tile tooltip `0 8px 22px rgba(29,45,61,0.28)` (`after:1615`)
  - hovered heat tile `0 4px 12px rgba(29,45,61,0.16)` (`after:1614`)
  - inspector slide-over `0 12px 32px rgba(43,43,45,0.22)` (`after:874`)
  - slide-over scrim `rgba(29,31,32,0.32)` (`after:873`)
- AFTER adds the **`.blueprint` frame** (`ds:73-95`): `position:relative; border:1px solid var(--color-divider); border-radius:0`, with four registration corner marks emitted as `<i class="corner tl|tr|bl|br">` — 11×11px, `color: ink@55%`, drawn `-6px` **outside** the box via `::before` (1px vertical, offset `left:5px`) and `::after` (1px horizontal, offset `top:5px`). Every board and card in the target opens with the 4-corner line (e.g. `after:127`, `after:162`, `after:697`, `after:722`, `after:1245`).
- AFTER adds a **3px `border-left` status rail** in the tone's `line` colour on: attention rows (`after:1511`), recent-rollout rows (`after:1629`), queue rows (`after:1730`), drift-queue items (`after:1879`), DAG nodes (`after:1884`).
- AFTER adds **zebra striping** on inventory rows: `background: i % 2 ? "#fbfbfc" : "#fff"` (`after:1689`).

### 3.5 Density

| Element | BEFORE | AFTER |
|---|---|---|
| Nav item | 44px min | 29px |
| Header bar | 48px min | 42px |
| Table row | `padding:12px 24px` (~62px with two-line cell) | `height: 42px` compact / `52px` comfortable (`after:1418`, `after:1689`) |
| Table header | 44px min | 30px (`after:510`) |
| Sub-table header | — | 26–28px (`after:346`, `after:742`, `after:1105`) |
| Group header | — | 40px (`after:1678`) |
| Attention row | 64px min (`before:157`) | 46px (`after:1511`) |
| Posture row | 16px padding cell | 38px (`after:174`) |
| Tree row | — | 38px (`after:1778`) |
| Action pill | 44px min (`before:404`) | 21px (`after:563`) |
| Section chevron | — | 22×22 (`after:1410`); group chevron 20×20 (`after:1676`); tree expander 18×18 (`after:1774`) |
| Card padding | 16px / `16px 0` | 6–14px (`padding:6px 10px 6px 14px` header rows, `padding:12px 14px` bodies) |
| Grid gap between boards | 12/16/24/32/40px | 1px (cell grids) / 16px (board grid) |
| Body gaps | 24–40px | 14–20px |

The target uses `gap:1px` over a `background: rgba(29,31,32,0.16)` parent to draw grid rules (`after:136`, `after:417`, `after:703`, `after:855`, `after:993`, `after:1246`) — the BEFORE file used the same trick with `background:oklch(0.24 0.012 50)` (`before:109`, `before:125`), so that idiom survives.

### 3.6 Iconography

| | BEFORE | AFTER |
|---|---|---|
| Library | Lucide, inline SVG | Lucide, inline SVG (`LUCIDE` map, `after:1371-1395`) |
| Size | 16px (nav, cards), 20px (card titles), 14px (scope bar), 12px (badges) | 11–14px throughout (`icon(name, size)` defaults to 14, `after:1396-1398`) |
| Stroke | `stroke-width:2`, no linecap/linejoin | `stroke-width:1.5`, `stroke-linecap:round`, `stroke-linejoin:round` |
| Status marks | coloured **dots** — 6–14px `border-radius:50%` circles filled `#10b981 / #f43f5e / #0ea5e9 / #f59e0b` (`before:223-226`, `before:245`, `before:299`, `before:740`) | **text glyphs** `✓ ↻ ! × ∅ ? ·` inside a 16×16 square `chip()`: `border:1px solid {t.line}; background:{t.fill}; color:{t.c}; font-size:10px; font-weight:700` (`after:1303-1305`) |
| Status pills | `border-radius:9999px; height:20px; padding:0 8px; font-size:12px/500` + `box-shadow:0 0 0 1px` ring (`before:670-672`) | `pill()`: `border:1px solid {t.line}; background:{t.fill}; border-radius:2px; padding:1px 7px; font-size:10px; font-weight:600; letter-spacing:0.04em; text-transform:uppercase` (`after:1306-1308`) |
| Emoji | **yes** — resource graph nodes use 📦 🌐 🔄 📝 ◉ 🔗 🔐 (`before:691-698`) | **none** |
| Animation | `@keyframes spin` (used on the pipeline "Running" badge, `before:575`) and `@keyframes pulse` (declared, unused) | `@keyframes blip` only (opacity 1 → .25), on the header live dot and the panel-logs live dot |

Icons named in the target's `LUCIDE` map (`after:1371-1395`): `grid, boxes, map, workflow, rocket, diff, git, layers, server, search, chevron, gauge, logs, traces, book, users, coins, pkg, file, eyeOff, cog, sliders, flask`.

### 3.7 Button system

BEFORE — every button styles itself inline; no shared class. Representative: `min-height:44px; border:1px solid oklch(0.24 0.012 50); background:oklch(0.155 0.014 50); padding:0 16px; font-size:14px; font-weight:600` (`before:101`); primary CTA `background:oklch(0.63 0.19 35); border-radius:9px; color:oklch(0.115 0.01 50)` (`before:414`).

AFTER — uses DS classes `.btn / .btn-primary / .btn-secondary / .btn-ghost` (`ds:140-162`, `ds:283-285`) with only `height` overridden inline (30–32px on page headers, 26–28px in cards). `.btn` is Barlow Condensed 600 @ 14px, `border:1px solid var(--color-divider)`, `border-radius:0`, `padding: 6.8px 12.24px`. `.btn-primary` = `background:#5980a6; color:#f2f2f3; border-color:#5980a6`. Destructive is not a variant — it is `.btn-secondary` with `color:#9c3f39; border-color:#dd9490` inline (`after:958`, `after:1056`).

Segmented controls use `.seg` (`ds:192-195`, `border-radius:0`, hairline border) with inline option styles: active `background:#5980a6; color:#f2f2f3`, idle `transparent / #5d5d60`, options separated by `border-left:1px solid rgba(29,31,32,0.16)` (`after:1570`, `after:1635`, `after:1654`, `after:1785`). Heights: 22px (board sub-controls), 24px (graph/tree, heatmap settings), 26px (diff view mode), 30px (page-level Group by / View / Rows).

---

## 4. Screen-by-screen

### 4.1 Overview

**BEFORE** (`before:92-331`) — a single 1280px column, `gap:40px`, containing 6 stacked blocks:

1. Page head: kicker `Authorized fleet`, h1 `Operations overview`, CTA `Open application inventory` (`before:98-101`).
2. **Fleet health posture** card — `57 applications`, 6-cell grid: `Healthy 41`, `Progressing 6`, `Degraded 4`, `Failed 2`, `Missing 1`, `Unknown 3` (`before:104-117`).
3. Two side-by-side cards (`before:119-144`):
   - kicker `Change surface` / h3 `Active delivery changes` — `Active releases 7`, `Active rollouts 3`, `Blocked gates 2`; footnote *"8 highest-impact applications loaded; blocked-gate count reflects this window."*
   - kicker `Dependency posture` / h3 `Connection failures` — `Repository failures 1`, `Cluster failures 0`, `Observability failures 0`; footnote *"8 highest-impact applications loaded; connection counts reflect this window. Observability sources that are not configured are absent, not failed."*
4. **Highest impact attention** (kicker `Server-ranked impact`, action `Open full queue`) — 5 rows, rank `01`–`05`, name + `payments/checkout-api · 3 blocked gates`-style sub, health word right-aligned (`before:146-168`, data `before:770-776`).
5. **Cluster command center** (`before:171-261`) — the big rounded panel:
   - h2 `Cluster command center`, copy *"Search applications, releases, rollouts, pipelines, and policies from one control surface, then drill into app health."*, badges `5 healthy` / `3 needs attention`.
   - Left pane: 56px search input, placeholder `Search apps, releases, rollouts, pipelines, policies...`; `Latest searches` / `No recent searches`; `Search results` header with `0/24` counter; dashed empty state *"Start with a name, namespace, or status"* / *"Results can open app drilldowns, rollout detail, pipeline detail, and policy anchors."*
   - Right pane: **Application health map** — *"Filter by status, then open an app tile for the full debug view."*, `8/57 apps loaded`, filter chips `All 8` / `Healthy 5` / `Degraded 2` / `Progressing 1` / `Out of sync 0`, then namespace groups (`data`, `payments`, `platform`, `search`, `web`) each with a 2-col tile grid.
6. **7-tile stat strip** (`before:263-275`, data `before:797-805`): `Pipelines 3`, `Running 1`, `Succeeded 1`, `Failed 1`, `Applications 57`, `Rollouts 3/5`, `App Sets 2`.
7. **Pipelines** section (`3 total`) — 3 cards with phase badge, progress bar, `N/M steps completed`, and per-step dots with image tags (`git:2.45`, `kaniko:1.23`, `test-runner:3.2`, `node:22`, `helm:3.16`) (`before:277-310`, data `before:807-821`).
8. **Policies** section (`2 total`) — `require-resource-limits` *"Every container must declare CPU and memory limits"* tags `critical` `enforce`; `signed-images-only` *"Reject unsigned OCI artifacts at promotion"* tags `warning` `warn` (`before:312-329`).

**AFTER** (`after:97-466`) — six numbered, individually collapsible, individually hideable **boards** laid out in three rows.

Page head (`after:100-109`): kicker `FLEET · ALL PROJECTS`, h1 `Operations overview`, buttons `Customise` (label flips to `Done`, `after:1969`) and `Open inventory`.

**Customise mode** (`after:111-123`) — dashed `1px dashed #5980a6` strip on `#e7f0f8`, `padding:10px 14px`: label `BOARDS`, six toggle chips prefixed with their number, copy *"Click a board to show or hide it. Hidden boards keep their settings. Layout is saved per user."*, and `Reset to default`. Hidden chips render `text-decoration:line-through` on white; visible chips are solid steel (`after:1563`). Each board header also grows an inline `eyeOff` hide button (22×22, `border:1px solid #dd9490; background:#fbe9e8; color:#9c3f39`) while customising.

Boards (all `<section class="blueprint" style="background:#fff">` + 4 corner marks; header row `padding:6px 10px 6px 14px`, `border-bottom:1px solid rgba(29,31,32,0.16)`; number kicker mono 10px ls 0.14em `#597ea3`; h2 `.cond` 17px/600 ls 0.04em UPPERCASE; right side holds sub-controls + a 22×22 collapse chevron that rotates −90°):

| # | Title (verbatim) | Right meta (verbatim) | Body |
|---|---|---|---|
| 01 | `Application lifecycle — one control plane` | `57 applications · 3 clusters · 12 changes today` | 6-cell grid `Source 12 / Build 3 / Test 2 / Render 4 / Deploy 7 / Verify 3`, each cell tinted with its state `fill`, index mono 9px, label `.cond` 15px/600 ls 0.08em uppercase, value `.cond` **34px/600** tabular, sub-copy 11px, and a 4-segment 5px mix bar. Footer rule: *"CI, CD, traffic and verification are one reconciliation loop — not four operators stitched together. Every stage below links to the same Application record."* (`after:125-155`, data `after:1477-1491`) |
| 02 | `Health posture` | seg `Bars` / `Heatmap` (default **Heatmap**) | **Bars**: 6 rows, 38px each, `grid-template-columns:20px 96px 44px minmax(0,1fr)` — chip glyph, `.cond` 14px uppercase label, `.cond` 19px count, 7px track `#e7e7ea` with tone-coloured fill. Data `[healthy 41, progressing 6, degraded 4, failed 2, missing 1, unknown 3]` (`after:1493-1498`). **Heatmap**: grouped tile field, see §4.1a |
| 03 | `Needs attention` | `ranked by blast radius` | 6 rows, 46px, `grid:20px 16px minmax(0,1fr) 46px 82px`, 3px tone rail on the left, top-3 rows tinted with the tone fill. Columns: rank, chip, name `.cond` 16px + ns mono 10px + reason 11.5px, age, action button. Data `after:1500-1507` |
| 04 | `Rollouts` | seg `In flight · 3` / `Recent · 7d`, link `All →` | **In flight**: 3 rows, `grid:minmax(0,0.9fr) minmax(0,1.3fr) auto` — name, a 6-step ascending bar ladder (heights 8/11/14/17/20/22px, `title="{w}% · {state}"`), `STEP 3 / 6 · HELD` + `1 metric failing`, and `.cond` **24px** canary weight with `CANARY WEIGHT` mono caption. **Recent**: 5-col table `ROLLOUT / OUTCOME / STEPS / TOOK / WHEN` + a stats footer `11 rollouts / 7d · 9 completed · 2 auto-aborted · 22m median` (`after:1619-1630`) |
| 05 | `Source triggers` | `last 2h` | 5 rows `grid:48px minmax(0,1fr) 46px` — a 17px mono `GIT`/`S3`/`OCI` tag, ref line, effect line, age. Data `after:1526-1532` |
| 06 | `Clusters · capacity` | `ksm · node-exporter · 15s ago`, link `Fleet map →` | 3 cards: name `.cond` 16px + `CONNECTED`/`DEGRADED` pill, meta `vke · eu-west · v1.31.4`, an 8px health mix bar, counters `24 apps / 18 nodes / 412 pods / $14.2k /mo`, then CPU and MEMORY meters (9px track `#e7e7ea` + steel used-fill + a 2px ink *requested* tick that turns `#e0ad66`/`#9c3f39` when requests > 85% of allocatable). Legend row: `used (node-exporter)` / `requested (kube-state-metrics)` / `allocatable` / *"requests > 85% of allocatable are flagged"* (`after:406-461`, `after:1539-1555`) |

Row layout is reactive: `row2Style` gives `minmax(0,1.05fr) minmax(0,1.25fr)` when both 02 and 03 are visible, else a single column; `row3Style` gives `minmax(0,1.3fr) minmax(0,1fr)` for 04 + 05 (`after:1566-1567`).

#### 4.1a Health-posture heatmap (NEW)

- Summary line + a 22×22 cog button; cog opens a 250px popover *"Heatmap settings"* with two segmented groups (`after:184-211`):
  - `GROUP BY` — `All` / `Project` / `Cluster` / `Stage`
  - `TILE DETAIL` — `Name + target` / `Name` / `Compact`, with helper *"Compact hides names and shows solid colour squares; hover any tile for full detail."*
- Group heads: mono kicker (`PROJECT`/`CLUSTER`/`STAGE`), `.cond` 15px label, meta `"{n} targets · {m} apps · {k} unhealthy | · all healthy"`, `border-bottom` in the worst state's `line` colour, and a 60×6px mix bar.
- Tiles (`after:1590-1616`): compact `22×22` solid `t.line` with white glyph; name `84–96 × 30px`; full `92–108 × 50–58px` with name row + mono sub. Border `1px solid t.line`, background `t.fill`. Hover adds `outline:2px solid t.line; outline-offset:1px` and the shadow above.
- Hover tooltip: a **dark** card `background:#1d2d3d; color:#f2f2f3; border:1px solid rgba(242,242,243,0.16)`, 180–270px wide, edge-aware (flips left/right, shifts to stay 14px inside the section). Rows: `target`, `project`, `sync`, `release`, `resources` (`{n} managed · {cost}/mo`), plus a note line.
- Legend footer reuses `graphLegend` (Healthy / Progressing / Degraded / Failed chips) + *"one tile per target · hover for detail"*.

### 4.2 Applications

**BEFORE** (`before:333-417`):

- Header: kicker `Fleet inventory`, h1 `Applications`, right paragraph *"Filter, compare, and troubleshoot every authorized deployment from one indexed snapshot."*
- Control bar: labelled `Search fleet` (`<label>`) with search input placeholder `Application, project, cluster, revision…` (44px, `border-radius:9px`); `<fieldset>`/`<legend>` **Presentation** with the 4-button seg `Treemap / Matrix / Table / Queue` (each `min-height:44px; min-width:5.5rem`).
- `<details>` **Filter dimensions** (`+` affordance) → a 5-column grid of `<fieldset>`s, each with `<legend>` and a scrollable (`max-height:13rem`) checkbox list, `accent-color: oklch(0.63 0.19 35)`, 44px rows, mono right-aligned counts:
  - `Project` — payments/core 18, platform/shared 21, web/storefront 12, data/analytics 6
  - `Cluster` — fleet/prod-eu-1 24, fleet/prod-us-1 22, fleet/staging-1 11
  - `Stage` — dev 14, staging 18, prod 25
  - `Health` — Healthy 41, Progressing 6, Degraded 4, Failed 2, Missing 1, Unknown 3
  - `Sync` — Synced 49, Out of sync 8
- Table viewport: `height:min(62vh,42rem); min-height:20rem; overflow:auto`, `min-width:58rem`, **sticky header** (`position:sticky; top:0; z-index:10`). Columns: `Application | Target | Health | Sync | Resources | Authorized actions`, `grid-template-columns: minmax(15rem,1.5fr) minmax(9rem,1fr) 8rem 8rem 7rem minmax(10rem,1fr)`.
- Footer: `8 loaded / 57 indexed` + primary `Load next 100`.

**AFTER** (`after:469-656`):

- Header: kicker `FLEET INVENTORY`, h1 `Applications`, then two 30px segmented controls labelled by mono 9px captions: `GROUP BY` → `None / Project / Cluster / Stage`, and `VIEW` → `Treemap / Matrix / Table / Queue`.
- Filter bar (`after:496-505`): 40px white strip, `padding:0 22px` — 14px search glyph + a **280px borderless** input `name, project, cluster, revision…`, a 1×20px divider, then 6 flat facet chips (`border-radius:2px; padding:3px 9px; font-size:11px`; active = `border:1px solid #5980a6; background:#eef6ff; color:#2c455d`): **`Degraded 4`** (on), **`Out of sync 8`** (on), `Failed 2`, `prod 25`, `Helm 33`, `Blocked gate 2`. Right: mono `{n} targets · {m} apps in scope`.
- **Table** (`after:507-573`): `min-width:1220px`, `overflow-x:auto`, header 30px on `#e9e9ea` with `border-bottom:1px solid rgba(29,31,32,0.28)`. Columns and track sizes:

  `APPLICATION minmax(190px,1.3fr) | PROJECT 120px | TARGET minmax(120px,1fr) | HEALTH 92px | SYNC 88px | LIFECYCLE 150px | RES 74px (right) | COST/MO 78px (right) | ACTIONS 118px`

  Row: chip glyph + `.cond` 15px name over mono 10px `ns/name` (indented 19px); mono project; `.cond` 14px cluster over mono 10px `prod · ring 2`; health pill; sync pill (`Synced` / `Drifted`); a **6-cell lifecycle strip** of 20×16px tone squares titled `source|build|test|render|deploy|verify · {label}`; tabular resource count; tabular cost; then 21px outline action pills.
- **Group headers** (`after:524-535`, `after:1666-1681`): 40px, `background: worst-state fill`, `border-top`+`border-bottom` hairline, `padding:0 22px` — 20×20 chevron, worst-state chip, mono kicker, `.cond` 17px label, meta `"{n} targets · {m} apps · {k} unhealthy · {d} drifted"`, and a **160×8px** mix bar. Clicking toggles the group.
- **Treemap** (`after:575-600`): one blueprint section per group; tiles are `flex:{res} 1 {max(150, res*9)}px; min-height:66px`, filled with the health tone, showing `{glyph} {name}` `.cond` 14px, mono sub `{cluster} · {stage}`, and `{n} res`. Caption: *"Tiles are sized by managed resource count; the fill is the target's health. Switch Group by to re-partition by project, cluster or stage."*
- **Matrix** (`after:602-629`): rows follow Group by (project, or stage when grouping by cluster/stage), columns are always clusters. Corner cell reads `{ROWLABEL} ↓ · CLUSTER →`. Each cell: `.cond` 20px count + mono `{k} apps` + per-state pills `{glyph} {n}`. Empty intersections shaded `#f5f5f8`. Caption: *"Rows follow Group by (project, or stage when grouping by cluster/stage); columns are always clusters. Empty intersections are shaded."*
- **Queue** (`after:631-649`): only unhealthy-or-drifted targets. Columns `# | (chip) | APPLICATION | TARGET | PROJECT | WHY`, tracks `28px 16px minmax(0,1.2fr) minmax(0,1fr) 140px minmax(0,1fr)`; 3px left tone rail; top-3 tinted. Reason strings are derived (`workload failing` / `source unreachable` / `degraded · drifted` / `degraded` / `rollout in progress` / `drifted`, `after:1728`).
- Footer (`after:651-654`): `{n} targets · {m} apps in scope · facets are self-excluding` + secondary `Load next 100`.

**Data-model change:** BEFORE has 8 rows, one per app (`before:679-688`). AFTER has **16 rows** = app × cluster targets over 11 distinct apps (`after:1311-1328`) — `checkout-api` appears twice (prod-eu-1, staging-1), `payments-gateway` twice, `auth-service` twice, etc. Every count string in the target distinguishes **targets** from **apps**. The BEFORE file's "57 indexed" fiction is dropped.

### 4.3 Application detail

**BEFORE** (`before:419-562`) — breadcrumb `← Dashboard › checkout-api`; h1 `checkout-api` 30px/**700** + `payments`; a `Refresh` button. Then:

1. **4 KPI cards**: `Current Phase` (Degraded pill + *"Strategy: canary"*), `Current Release` (`checkout-api-r241`, *"prod-eu / ring 2"*), `Policy Results` (**4**, *"Failures present"*), `Release History` (**18**, *"Releases tracked for this application"*).
2. **Investigation Triage** — *"Degraded resources, failing checks, and manual investigation entry points for this application."*, badges `Degraded` + `3 out of sync`; 2 rows (`Deployment/checkout-api`, `Pod/checkout-api-7d4f-m4p1`) with sync/health pills, a reason string, and per-row **`Run`** and **`Open`** actions (`before:454-487`, data `before:849-852`).
3. **Managed Resources** — *"14 resources · 3 out of sync · 0 pruned"*, a `Graph` / `List` toggle, and a 500px canvas: dot-grid background, absolutely positioned 180×56px nodes with **emoji** kind icons, bezier edges `oklch(0.35 0.012 50)` 1.2px, and a **zoom control stack** bottom-left (`+`, `−`, `⤢`; three 26×26 cells) (`before:489-512`, `before:718-749`).
4. **Health Checks** — *"CEL-based health check results."*, table `Name | Status | HTTP | Message | Checked`, rows: `http-readyz` Degraded 503 *"readyz returned 503"*; `cel-replicas` Degraded `-` *"status.readyReplicas < spec.replicas"*; `http-livez` Healthy 200 `-`; all `9/9/2026, 09:41:02` (`before:514-528`, data `before:854-858`).
5. **Promotion Stages** — *"Per-stage ring, release, and phase breakdown."*, 3 ring chips: `0 dev Complete`, `1 staging Complete`, `2 prod Paused`, all `checkout-api-r241` (`before:530-545`).
6. **Source** — key/value rows `Repository URL github.com/acme/checkout-api`, `Path deploy/chart`, `Revision 9f3a1c2`, `Sync Policy Automated`, `Strategy canary`.

**AFTER** (`after:659-941`):

- Header slab on `#fff` (`after:661-692`): text breadcrumb `Applications / payments / checkout-api` (only `Applications` is a link, `#416180`); h1 `checkout-api` `.cond` 30px/**600**; two inline ochre pills `! DEGRADED` and `3 OUT OF SYNC` (`border:1px solid #b07a2c; background:rgba(176,122,44,0.10); color:#8a5f22; border-radius:2px`); a tag row `owner: payments-core`, `on-call: @rmoreau`, `tier: 1`, `helm · deploy/chart`, `prod-eu-1` (`.tag .tag-neutral`, `after:1739`); buttons `Rollback` / `Diff` / `Sync now`; then a **tab strip** `Overview` (active, `border-bottom:2px solid #5980a6`) `Resources` `Releases` `Pipelines` `Policy` `Manifest` — **the last five are inert `<span>`s**, not routed.
- **Delivery timeline · release r241** (`after:696-717`) — meta *"triggered by push to main · 9f3a1c2 · 34m ago"*; a 6-cell grid mirroring the overview lifecycle: `Source ✓ 4s` / `Build ✓ 48s` / `Test ! 1m 06s` / `Render ✓ 2s` / `Deploy ✓ 31s` / `Verify × 6m 12s`, each with a detail line and a mono `#416180` link line (`View commit ↗`, `ghcr.io/acme/checkout-api`, `Open run #418`, `View manifest`, `3 fields drifted since`, `Open rollout`). Cells 3 and 6 navigate to the pipeline and rollout screens (`after:1753`).
- **Resource graph** (`after:721-796`) — meta `14 managed · 3 drifted`; `Graph` / `Tree` seg; when Tree, extra `Expand all` / `Collapse all`; a collapse chevron.
  - **Graph**: 372px, `min-width:840px`, 22px CSS grid background (`linear-gradient(rgba(29,31,32,0.055) 1px, transparent 1px)` ×2), a `viewBox="0 0 840 372"` SVG of bezier edges `rgba(29,31,32,0.32)` 1px — **one edge is drawn `#a8443b` 1.4px `stroke-dasharray="3 2"`** to mark the failing pod path (`after:776`). 10 nodes (`after:1331-1342`) as absolutely positioned white cards with the tone chip, mono kind, `.cond` name and an optional mono badge (`r241`, `1/3`, `drift`, `CLB`). The failing pod carries `border:1px solid #a8443b; outline:2px solid rgba(168,68,59,0.25)`. Legend chip row bottom-left over `rgba(242,242,243,0.9)`.
  - **Tree** (NEW): 38px rows, columns `RESOURCE | HEALTH | SYNC`; per-row indent `depth * 22px`, an 18×18 chevron expander (rotates −90° when closed), tone chip, mono kind (82px), `.cond` name, meta, and a right-aligned child count. Hierarchy Application → Deployment → ReplicaSet → 3 Pods, plus Service → Ingress, ConfigMap, Secret (`after:1344-1359`).
  - Clicking any node or tree row opens the inspector slide-over.
- Right rail (300px):
  - **Drilldowns** (NEW, `after:799-815`) — six 33px link rows with steel icons: `Grafana — service overview / golden signals`, `Logs — Loki / app=checkout-api`, `Traces — Tempo / p99 3.4s`, `Runbook — payment capture / confluence`, `Owning team — payments-core / @rmoreau`, `Cost — 30 day / $4,120`; footer button `+ Configure links`.
  - **Gates & analysis** (NEW, `after:817-833`) — `manual-approval / ring 2 · release manager / Approve`, `conftest: resource-limits / 4 rules · all passed`, `analysis: golden-signals / 3 of 4 metrics passing / View`, `sync window / open until 18:00 UTC`.
  - **Source** (`after:835-847`) — `Repository github.com/acme/checkout-api`, `Path deploy/chart`, **`Engine Helm 3.16`** (new), `Revision 9f3a1c2`, `Sync policy auto · self-heal`, `Strategy canary 5/10/25/50/75/100`.
- **Promotion stages** (`after:851-869`) — now **4** rings: `RING 0 dev / staging-1 / r241 · synced 41m ago`, `RING 1 staging / staging-1 / r241 · synced 38m ago`, `RING 2 prod-eu / prod-eu-1 / r241 · canary held at 25%`, `RING 3 prod-us / prod-us-1 / r240 · awaiting ring 2` (state `pending`).
- **Inspector slide-over** (NEW, `after:872-939`) — scrim `rgba(29,31,32,0.32)` z-60; 560px right `aside` z-61 on `#f2f2f3`, `border-left:1px solid rgba(29,31,32,0.28)`, `box-shadow:0 12px 32px rgba(43,43,45,0.22)`. Head: mono kind, `.cond` 22px name, mono tag chips (`payments`, `sync: OutOfSync`, `health: Degraded`, `restarts: 12`), buttons `Investigate` and `✕`. Tabs `Diff | Live | Desired | Events | Logs` (active gets `border-bottom:2px solid #5980a6`). Bodies:
  - **Diff** — header `desired ↔ live · 4 changed fields` + `drift detected 12m ago` in `#a8443b`; unified diff at 11px/1.75 with 26px gutter; add rows `background:rgba(74,124,82,0.10); color:#2f5237`, del rows `background:rgba(168,68,59,0.10); color:#7d3129` (`after:1829-1833`).
  - **Events** — 4 cards (`BackOff`, `Unhealthy`, `Pulled`, `Scheduled`) with tone chips and `12 × · last 41s ago`-style timestamps.
  - **Logs** — a **dark** panel `#1d2d3d`: blip dot `#94bce3`, `live · pod/checkout-api-7d4f-m4p1 · 842 lines`, `pause`, then `<pre>` 11px/1.7 `#dfe6ee`.
  - **Live / Desired** — plain YAML `<pre>` on white.

### 4.4 Pipeline

**BEFORE** (`before:564-604`) — 1152px column. Head: back chevron, h1 `checkout-api-build` 20px/600, `ns/payments`; a `Running` pill with a **spinning** icon; `Cancel`. Body: a 600px DAG canvas (nodes `min-width:140px`, `border-radius:9px`, `border-left:4px solid {phase colour}`, selected node gets `outline:2px solid primary`) beside a fixed 384px column containing the selected step (`unit-test`, `ghcr.io/acme/test-runner:3.2`), a `Logs` `<pre>` on `oklch(0.115 0.01 50)` `border-radius:12px`, and `Retry` / `Skip`.

**AFTER** (`after:944-1040`):

- Head slab: breadcrumb `Pipelines / payments / checkout-api-build`; h1 `.cond` 30px; pill `↻ RUNNING` (steel `#5980a6` / `#eef6ff` / `#2c455d`, **static — no spin**); metadata line *"run #418 · push to main by @rmoreau · 9f3a1c2 “fix idempotent capture” · started 2m 14s ago"*; buttons `Re-run` and `Cancel run` (destructive-tinted).
- **Step graph** (`after:964-1001`) — meta *"in-cluster · runner pool ci-amd64 · cache hit 74%"*; a 460px, `min-width:640px` canvas with the same 22px CSS grid; edges are straight/bezier `rgba(29,31,32,0.3)` 1px in a `viewBox="0 0 640 460"` SVG. 7 nodes at 170px: `checkout (git · 4s)`, `build (kaniko · 48s)`, `unit-test (running · 1m06s, selected)`, `lint (golangci · 12s)`, `sbom-scan (trivy · 19s)`, `package (queued)`, `deploy dev (queued)` (`after:1361-1369`). Node = `border:1px solid rgba(29,31,32,0.28); border-left:3px solid {tone.line}`, selected adds `border-color:#5980a6; outline:2px solid rgba(89,128,166,0.25)`.
- **Pipeline stats strip** (NEW) — 4 cells `ELAPSED 2m 14s`, `CACHE HIT 74%`, `STEPS 3/7`, `CPU-MIN 9.4`.
- Right column 380px:
  - Step card: `.cond` 16px `unit-test` + `↻ RUNNING` pill; meta `ghcr.io/acme/test-runner:3.2 · 4 CPU / 8 GiB · 1m 06s`; logs `<pre>` on **`#1d2d3d`** `max-height:280px`, 11px/1.7 `#dfe6ee`; buttons `Retry step`, `Skip`, ghost `Full logs ↗`.
  - **Artifacts** (NEW, `after:1023-1036`): `ghcr.io/acme/checkout-api:9f3a1c2` — *oci image · 84 MB · sha256:4a1f…* — pill `SIGNED`; `sbom.cyclonedx.json` — *412 components · 0 critical* — `CLEAN`; `junit-report.xml` — *214 tests · 1 flake retried* — `1 FLAKE`.
- Log content itself changes: BEFORE ends `==> 213 passed, 1 failed`; AFTER adds a retry/flake policy and ends `==> 214 passed, 0 failed, 1 retried` (`before:889`, `after:1994`).

### 4.5 Rollout

**BEFORE** (`before:606-644`) — breadcrumb `← Dashboard › Rollouts › checkout-api`; h1 `checkout-api` + `payments`; `Refresh` / `Promote` / `Abort`. Four KPI cards: `Strategy Canary`, `Phase Paused`, `Current Step 3`, `Current Weight 25%`. Then a single **Details** key/value list: `Target Deployment/checkout-api`, `Stable ReplicaSet checkout-api-6b9c`, `Canary ReplicaSet checkout-api-7d4f`, `Active Service checkout-api`, `Preview Service checkout-api-preview`, `Observed Generation 37`, `Message Paused at step 3 pending analysis`.

**AFTER** (`after:1043-1147`) — essentially a different screen:

- Head: breadcrumb `Rollouts / payments / checkout-api`; h1; ochre pill `‖ PAUSED AT STEP 3`; meta *"canary · Deployment/checkout-api · prod-eu-1 · held 6m 12s pending analysis"*; buttons `Abort & roll back` (destructive), `Hold`, primary `Promote to 50%`.
- **Traffic ladder** (NEW, `after:1064-1096`) — meta *"istio VirtualService · checkout-api.payments.svc"*; 6 columns in a 104px band, each a bottom-aligned bar of height 26/38/52/68/84/100px filled with its tone (pending bars are `border-style:dashed; background:transparent`), under it `.cond` 22px weight (`5% 10% 25% 50% 75% 100%`), tone chip, `STEP n`, and a note (`passed 4/4`, `passed 4/4`, `held · latency`, `queued`…). Below, a `TRAFFIC` split bar: 26px, `border:1px solid rgba(29,31,32,0.28)`, 75% `#e7e7ea` labelled `STABLE 75% · checkout-api-6b9c · 6 pods` and 25% `#5980a6` labelled `CANARY 25%`, with a mono caption *"canary · checkout-api-7d4f · 2 pods · image ghcr.io/acme/checkout-api:9f3a1c2"*.
- **Analysis — why it paused** (NEW, `after:1098-1131`) — right-side meta `1 of 4 metrics failing` in `#a8443b`. Table `METRIC | BASELINE | CANARY | THRESHOLD | RESULT`, tracks `minmax(0,1.2fr) 78px 78px 84px 70px`. Rows carry the PromQL in a mono sub-line:
  - `success rate` — `sum(rate(http_requests_total{code!~"5.."}[2m]))` — 99.94% / 99.91% / ≥ 99.5% — PASS
  - `p99 latency` — `histogram_quantile(0.99, …)` — 412 ms / **581 ms** (bold `#8e372f`) / ≤ 500 ms — **FAIL**
  - `error budget burn` — `burn_rate_1h / 14.4` — 0.3× / 0.9× / ≤ 2× — PASS
  - `pod restarts` — `increase(kube_pod_container_status_restarts[5m])` — 0 / 0 / = 0 — PASS

  Callout on `#fdf2df`: *"Paprika held the rollout automatically. **p99 latency** on the canary is 41% above baseline and breached its threshold for 3 consecutive intervals. Promotion is blocked until the metric recovers or an operator overrides."*
- **Rollout log** (NEW, `after:1134-1143`) — 7 timestamped entries 09:27→09:41 with tone chips, grid `58px 14px minmax(0,1fr)`.

### 4.6 Sync & diff workbench — NEW (`after:1150-1217`)

- Header on `#fff`: kicker `DRIFT CONTROL`, h1 `Sync & diff workbench`; buttons `Ignore field`, `Dry run`, primary `Sync 3 selected`.
- Two-column `352px | 1fr`, `min-height:calc(100vh - 130px)`.
- Left rail: filter chips `All 14`, `Drifted 3` (active), `Missing 1`, `Degraded 2`, `Pruned 0`; then an 8-item drift queue, each `border-left:3px solid` (steel when selected, else transparent), selected `background:#eef6ff`: `DEPLOYMENT checkout-api / replicas, image, memory, probe / 4`; `CONFIGMAP checkout-api-env / 2 keys changed outside Paprika / 2`; `SERVICE notifications / annotation removed by controller / 1`; `CRONJOB reporting-etl-nightly / object missing in cluster / ∅`; `HPA web-frontend / maxReplicas drifted 12 → 20 / 1`; `INGRESS auth-service / TLS secret rotated in place / 1`; `SECRET payments-gateway-key / protected · excluded from prune / 0`; `POD checkout-api-7d4f-m4p1 / CrashLoopBackOff · 12 restarts / –`.
- Right pane: object head `DEPLOYMENT · payments` / `.cond` 20px `checkout-api`; meta `4 changed fields · 2 additions · 2 removals`; a 26px seg `Unified` (active, solid steel) / `Split` / `JSON patch`. Then the diff card (`apps/v1 Deployment · payments/checkout-api`, 11.5px/1.85, 30px gutter) and a **Why this drifted** explainer: *"The live object was last written by `kubectl-client-side-apply` 12 minutes ago, outside Paprika. The rendered manifest from `deploy/chart@9f3a1c2` still declares 3 replicas and the previous image tag. Syncing restores the declared state; ignoring the field records an exception on the Application."*

### 4.7 Cluster & fleet map — NEW (`after:1220-1275`)

- Header: kicker `TOPOLOGY`, h1 `Cluster & fleet map`; the 4-chip status legend; a 30px `ROWS` seg `Stage` / `Project`.
- A blueprint grid `124px repeat(3, 1fr)`, `gap:1px` over the divider colour. Column heads on `#e9e9ea`: `prod-eu-1 / 18 nodes · eu-west`, `prod-us-1 / 22 nodes · us-east-2`, `staging-1 / 4 nodes · shared`. Row heads on `#e9e9ea` (`.cond` 15px). Cells `min-height:106px` on `#fff`: a wrapped field of **18×18px** status squares (`border:1px solid t.line; background:t.fill; color:t.c; font-size:10px/700`, `title="{app} · {label}"`, click → app detail) plus a mono summary `"{n} targets · {k} unhealthy"` / `"… · all healthy"` / `"no targets"`.
- Caption: *"Each square is one application at one target. Size is fixed here; the treemap presentation sizes by managed resource count or request rate. Click a square to open its Application record."*

---

## 5. What the target DROPS — regression risks

Ordered roughly by severity. Each is present in BEFORE and has **no equivalent** (or a materially weaker one) in AFTER.

### Navigation & capability gaps

1. **`Releases` nav item is gone.** BEFORE `Delivery → Releases` (`before:52`, `before:884`) — already a stub routing to overview, but it establishes Releases as a first-class object. AFTER's Delivery group is `Pipelines / Rollouts / Sync & diff`. Releases survive only as opaque ids (`r241`, `r188`) and an inert `Releases` tab span on app detail (`after:687`). **The app-detail "Release History 18" tile is also gone**, so there is no release list surface at all.
2. **`Activity` nav item is gone** (`before:59`). No audit/event feed anywhere in the target. The nearest thing is the per-resource Events tab in the slide-over and the per-rollout log — neither is fleet-scoped.
3. **`Admin` nav item is gone** (`before:60`). No settings, no admin, no user/RBAC surface in the target at all.
4. **Sign-out affordance is gone.** BEFORE has a 44×44 log-out icon button in the sidebar footer (`before:73`). AFTER's footer is two lines of static text.
5. **The disabled-with-reason pattern is gone.** BEFORE marks not-yet-built items `disabled title="Available in a later plan"` with `opacity:.4; cursor:not-allowed` — honest. AFTER makes every nav item clickable, including three stubs that silently land somewhere else: `Repositories` → overview, `Templates` → overview, `Clusters` → map (`after:1435-1437`). Plus five inert app-detail tabs (`Resources / Releases / Pipelines / Policy / Manifest`, `after:686-690`) that look like tabs and do nothing. **This is a worse honesty posture than BEFORE.**

### Dropped features

6. **The Policies surface is gone entirely.** BEFORE has a `Policies` section on overview with 2 policy cards (`before:312-329`): `require-resource-limits` — *"Every container must declare CPU and memory limits"* — tags `critical` `enforce`; and `signed-images-only` — *"Reject unsigned OCI artifacts at promotion"* — tags `warning` `warn`. AFTER has **no policy list**: policy appears only as one gate row (`conftest: resource-limits · 4 rules · all passed`), one attention row (`Policy signed-images-only warned on 1 image`), one facet chip, and an inert `Policy` tab. Severity levels (`critical`/`warning`) and enforcement modes (`enforce`/`warn`) have no representation anywhere in the target.
7. **`Policy Results` KPI on app detail is gone** (`before:445-447`: value `4`, sub *"Failures present"*). No per-app policy-result count in AFTER.
8. **Health Checks table is gone** (`before:514-528`). BEFORE renders *"CEL-based health check results."* with columns `Name | Status | HTTP | Message | Checked` and rows `http-readyz / Degraded / 503 / readyz returned 503`, `cel-replicas / Degraded / - / status.readyReplicas < spec.replicas`, `http-livez / Healthy / 200 / -`, all stamped `9/9/2026, 09:41:02`. **The whole CEL health-check concept, the HTTP status-code column, and the per-check "checked at" timestamp vanish.** The AFTER resource tree shows only aggregate health/sync.
9. **Investigation Triage card is gone** (`before:454-487`). Copy: *"Degraded resources, failing checks, and manual investigation entry points for this application."* Critically it has a per-row **`Run`** action (execute an investigation/check) alongside `Open`. The AFTER app detail has no per-app triage list and **no `Run` verb anywhere**.
10. **`App Sets` (ApplicationSets) drops out as a concept.** BEFORE surfaces it as a headline stat (`App Sets 2`, `before:804`). AFTER mentions it once inside a Source-triggers effect string (`"ApplicationSet fan-out · 6 applications"`, `after:1529`) — no count, no list, no nav entry.
11. **The 7-tile overview stat strip is gone** (`before:263-275`): `Pipelines 3`, `Running 1`, `Succeeded 1`, `Failed 1`, `Applications 57`, `Rollouts 3/5`, `App Sets 2`. AFTER's lifecycle board covers Build/Test/Deploy/Verify counts but drops pipeline run outcome counts (`Running`/`Succeeded`/`Failed`) and the `3/5` rollouts ratio.
12. **The overview Pipelines board is gone** (`before:277-310`). BEFORE shows 3 pipeline cards with a phase badge, a progress bar, `N/M steps completed`, and **per-step rows with the step image tag** — `git:2.45`, `kaniko:1.23`, `test-runner:3.2`, `node:22`, `helm:3.16`. AFTER has no pipelines board on the overview; the step-image-per-step detail exists only on the single selected step in pipeline detail.
13. **`Connection failures` board is gone** (`before:132-143`): `Repository failures 1`, `Cluster failures 0`, `Observability failures 0`, with the careful footnote *"Observability sources that are not configured are absent, not failed."* AFTER's Source-triggers board shows one failing S3 trigger, and the clusters board shows a `DEGRADED` connection pill — but there is **no aggregate connection-failure posture and no repository/observability breakdown**.
14. **`Active delivery changes` board is gone** (`before:120-131`): `Active releases 7`, `Active rollouts 3`, `Blocked gates 2` + *"8 highest-impact applications loaded; blocked-gate count reflects this window."* AFTER's lifecycle board has `Deploy 7 / releases active · 2 gates blocked`, which covers releases+gates, but the explicit "active rollouts" count and the loaded-window caveat are gone.
15. **The "loaded window" honesty caveats are gone.** BEFORE repeatedly discloses that counts reflect only the loaded page — *"8 highest-impact applications loaded; …"* (×2), *"8/57 apps loaded"*, *"8 loaded / 57 indexed"*. AFTER replaces these with *"{n} targets · {m} apps in scope"* and *"facets are self-excluding"*, which describes filtering but **not pagination truncation**. If the real backend still pages, the target has no place to say so.
16. **Multi-select faceted filtering is gone.** BEFORE's `<details>` **Filter dimensions** panel (`before:361-379`) is 5 labelled `<fieldset>`s of scrollable checkboxes with per-option counts across `Project` (4 options), `Cluster` (3), `Stage` (3), `Health` (6), `Sync` (2) — 18 filter options, all countable, all combinable. AFTER replaces this with **6 hard-coded chips** (`Degraded 4`, `Out of sync 8`, `Failed 2`, `prod 25`, `Helm 33`, `Blocked gate 2`, `after:1639-1646`). Lost: `Progressing`, `Missing`, `Unknown`, `Synced`, `staging`, `dev`, all project facets, all cluster facets, any way to see the full option set, and the checkbox affordance. The header scope dropdowns partially compensate for project/cluster/stage but are **single-select** (one value or `All`, `after:1464`).
17. **The scrolling table viewport and sticky header are gone.** BEFORE wraps the inventory in `height:min(62vh,42rem); min-height:20rem; overflow:auto` with `position:sticky; top:0; z-index:10` on the header (`before:382-387`). AFTER has only `overflow-x:auto` (`after:508`) — the page grows unbounded and the column header scrolls away. For a 57+ row fleet on a table with 9 columns this is a real usability regression, and it removes the natural anchor for TanStack Virtual.
18. **`Refresh` is gone.** BEFORE has explicit `Refresh` buttons on app detail (`before:432`) and rollout (`before:621`). AFTER has no manual refresh anywhere; it asserts liveness with `live · 12s` + `gen 4412` instead.
19. **Graph zoom / pan / fit controls are gone.** BEFORE has a 3-button stack (`+`, `−`, `⤢`, three 26×26 cells, `before:505-509`) on the resource graph. AFTER's graph is a fixed-coordinate absolute layout inside `overflow-x:auto` with only a legend in that corner — **no zoom, no fit, no pan** (this matters because the app currently uses `@xyflow/react`, which provides those controls for free; the target design has no place to put them).
20. **`Graph` / `List` toggle on Managed Resources becomes `Graph` / `Tree`.** The flat **List** presentation of resources is replaced by a hierarchical tree. If a flat, sortable resource list is a real user need, it is gone.
21. **The `pruned` count is gone.** BEFORE: *"14 resources · 3 out of sync · 0 pruned"* (`before:494`). AFTER: *"14 managed · 3 drifted"* (`after:726`). `Pruned` survives only as an unused filter chip on the diff workbench (`Pruned 0`).
22. **Rollout `Details` fields are dropped.** BEFORE lists 7 fields (`before:866-874`). AFTER keeps Target (in the meta line), stable/canary ReplicaSet names (in the traffic bar caption) and the pause Message (as the callout), but **drops `Active Service` (`checkout-api`), `Preview Service` (`checkout-api-preview`) and `Observed Generation` (`37`)** — the service-swap and generation-tracking fields have no home in the target.
23. **App-detail KPI tiles are dropped wholesale** (`before:435-452`): `Current Phase` + *"Strategy: canary"*, `Current Release checkout-api-r241` + *"prod-eu / ring 2"*, `Policy Results 4`, `Release History 18`. AFTER's header pills carry health/sync, and the Source card carries `Strategy canary 5/10/25/50/75/100`, but **the current release id is not shown on the app-detail header** — only in the timeline title (`Delivery timeline · release r241`) and per-promotion-ring text.
24. **Namespace grouping on the overview health map is gone** (`before:230-257`: groups `data`, `payments`, `platform`, `search`, `web` with per-group counts). AFTER's heatmap groups by **project / cluster / stage / none** — namespace is not an option, even though every app still carries `ns` (`after:1312`) and the table shows `ns/name` as the row id.
25. **Status filter chips on the health map are gone** (`before:222-226`: `All 8`, `Healthy 5`, `Degraded 2`, `Progressing 1`, `Out of sync 0`). The AFTER heatmap has grouping and tile-detail controls but **no status filter** — you cannot narrow the tile field to just the degraded ones.
26. **The search results surface is gone.** BEFORE's Cluster command center (`before:188-208`) has: a 56px search field, `Latest searches` with a `No recent searches` empty state, a `Search results` header with an `0/24` result counter, and a dashed empty state *"Start with a name, namespace, or status"* / *"Results can open app drilldowns, rollout detail, pipeline detail, and policy anchors."* AFTER has **only a borderless input in the header bar** (`after:82`) — no recents, no result count, no result list, no empty state, and no designed dropdown. The ⌘K hint promises a palette that the design does not draw.
27. **Explicit form labelling is dropped.** BEFORE uses `<label>Search fleet</label>` (`before:346`), `<fieldset><legend>Presentation</legend>` (`before:352-353`), `<legend>` per filter dimension (`before:366`), and real `<input type="checkbox">` with `accent-color`. AFTER uses bare mono `<span>` captions (`GROUP BY`, `VIEW`, `ROWS`) with no programmatic association, and has no checkboxes at all. **Accessibility regression.**
28. **44px minimum touch targets are abandoned.** BEFORE deliberately sets `min-height:44px` on nav items, buttons, filter checkbox rows, `<summary>`, action pills and the sidebar icon button — 12 occurrences of the pattern. AFTER's controls are 18–30px: nav 29px, section chevron 22×22, group chevron 20×20, tree expander 18×18, action pill 21px, board hide button 22×22, compact heat tile 22×22, map square 18×18. **Nothing in the target meets a 44px touch target.**
29. **The spin affordance for in-progress work is gone.** BEFORE animates the pipeline `Running` badge icon with `@keyframes spin 1s linear infinite` (`before:575`, `before:21`). AFTER's `↻ RUNNING` glyph is static; the only animation in the whole file is `blip` (opacity pulse) on two live-data dots. There is **no motion vocabulary for "work in progress"**, which is notable given the app ships framer-motion.
30. **Dark theme.** BEFORE is dark-only. AFTER is light-only and there is **no dark variant, no token indirection for surfaces, and no `prefers-color-scheme` handling** in either `console.dc.html` or `styles.css`. Every colour in the target is a literal hex or `rgba()`. If the shipped product is dark today, this is a complete inversion with no migration path drawn.
31. **Back-arrow navigation is gone.** BEFORE has `← Dashboard` buttons on app detail and rollout, and a `‹` icon button on pipeline (`before:422`, `before:568`, `before:609`). AFTER uses a text path (`Applications / payments / checkout-api`) where only the first segment is a link — no back affordance, and the middle segment (`payments`) is not linked either.
32. **The paprika-red brand accent disappears.** `oklch(0.63 0.19 35)` is the product's identity colour in BEFORE — the logo tile, the active-nav bar, kickers, rank numerals, primary CTAs, and the pipeline progress bar. AFTER has no brand colour: the accent is steel blue `#5980a6` and warm hues are reserved for *status*. Worth confirming this is intentional and not an artefact of adopting the "Industry" DS wholesale.

### Smaller wording / contract changes to watch

- `Authorized fleet` → `FLEET · ALL PROJECTS`; `Fleet inventory` → `FLEET INVENTORY`; `Server-ranked impact` → `ranked by blast radius`.
- `Authorized actions` column → `ACTIONS`; the "authorized" framing (RBAC-aware action lists) disappears from every label.
- `Open application inventory` → `Open inventory`; `Open full queue` → the Queue presentation.
- `Highest impact attention` → `Needs attention`.
- `out_of_sync` / `out of sync` → `Drifted` (the sync pill now reads `Synced` / `Drifted`, `after:1687`), while the facet chip still says `Out of sync` and the app-detail header pill says `3 OUT OF SYNC` — **three spellings of one state in the target**.
- `Promote` → `Promote to 50%` (step-aware); `Abort` → `Abort & roll back`; `Cancel` → `Cancel run`; `Retry` → `Retry step`. `Hold` is new.
- Health words were lowercase in BEFORE's table (`healthLabel: a.health.toLowerCase()`, `before:842`) and are Titlecase-in-uppercase-pills in AFTER.
- BEFORE ring count on promotion stages is 3 (dev/staging/prod); AFTER is 4 (dev/staging/prod-eu/prod-us).
