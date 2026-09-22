# Target design — persistent app chrome spec

Source of truth: `/private/tmp/claude-501/-Users-benebsworth-projects-paprika/844ad4e2-4dd2-4687-a932-9e099bcf1f1c/scratchpad/design/console.dc.html`
Design-system stylesheet: `/private/tmp/claude-501/-Users-benebsworth-projects-paprika/844ad4e2-4dd2-4687-a932-9e099bcf1f1c/scratchpad/design/styles.css` (285 lines, read in full)
Before-state mockup: `/private/tmp/claude-501/-Users-benebsworth-projects-paprika/844ad4e2-4dd2-4687-a932-9e099bcf1f1c/scratchpad/design/console-current.dc.html`
Target codebase: `/Users/benebsworth/projects/paprika/ui`

Line numbers below are **console.dc.html line numbers** unless prefixed `styles.css:`.

---

## 0. Headline: this is a full theme inversion

| | current (`console-current.dc.html` L14–22) | target (`console.dc.html` L11–24) |
|---|---|---|
| Theme | **dark** — `background: oklch(0.115 0.01 50)` | **light** — `background:#f2f2f3` |
| Body text | `oklch(0.93 0.012 50)` | `#1d1f20` |
| Body font | `"Instrument Sans", system-ui, sans-serif` | `"Barlow", system-ui, sans-serif` |
| Mono font | `'JetBrains Mono', monospace` | `ui-monospace, SFMono-Regular, Menlo, monospace` (system mono, **not** a webfont) |
| Display font | none (Instrument Sans everywhere) | `"Barlow Condensed"` via `.cond` |
| Body font-size | `14px` (set on the page wrapper) | **`13px`** on `body` |
| Accent / link | `oklch(0.63 0.19 35)` (orange-red) | `#416180` (steel blue) |
| Radii | `4px`/`6px` everywhere | **0** almost everywhere; `2px` on a few chips/buttons |
| Sidebar | `256px` fixed, `position:fixed`, same bg as page | **`206px`**, in normal flex flow, `#1d2d3d` navy |
| Header | `64px` tall | **`42px`** tall |
| Header content | brand lockup + nav | **scope bar** (PROJECT / CLUSTER / STAGE dropdowns) + search + live ticker |

Density is the whole point of the redesign: 42px header, 29px nav rows, 9–14px type, hairline `rgba(29,31,32,0.16)` rules, zero radius.

---

## 1. `<helmet>` — global head (L10–26)

```html
<helmet>
  <link rel="stylesheet" href="_ds/industry-f4e0e93d-8f3e-491c-a7fc-fb900a914973/styles.css">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700&family=Barlow:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    body { margin:0; background:#f2f2f3; color:#1d1f20; font-family:"Barlow", system-ui, sans-serif; font-size:13px; -webkit-font-smoothing:antialiased; }
    a { color:#416180; text-decoration:none; }
    a:hover { color:#2c455d; text-decoration:underline; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .cond { font-family:"Barlow Condensed", system-ui, sans-serif; }
    ::selection { background:#d6ebff; }
    *::-webkit-scrollbar { width:9px; height:9px; }
    *::-webkit-scrollbar-thumb { background:#c4c4c8; }
    *::-webkit-scrollbar-track { background:#e9e9ea; }
    @keyframes blip { 0%,100% { opacity:1 } 50% { opacity:.25 } }
  </style>
</helmet>
```

Notes for implementation:

* **Fonts loaded (L13):** Google Fonts, one request, two families:
  * `Barlow` weights **400, 500, 600**
  * `Barlow Condensed` weights **400, 500, 600, 700**
  * `display=swap`. `preconnect` to `fonts.gstatic.com` with `crossorigin`.
  * `styles.css:2` *also* `@import`s Google Fonts, but a **different weight set**: `Barlow:wght@400;500;700` + `Barlow+Condensed:wght@400;600`. The helmet's set is the superset that actually matters (it adds Barlow 600 and Barlow Condensed 500 + 700). **Load the helmet's weight list.**
  * No mono webfont — `.mono` uses the OS mono stack.
* **`.mono`** — `ui-monospace, SFMono-Regular, Menlo, monospace`. Applied to: nav kicker/version line, nav section labels, nav item badges, user role line, scope field labels, scope option counts, live ticker, gen counter, and hundreds of data cells in the body.
* **`.cond`** — `"Barlow Condensed", system-ui, sans-serif`. Applied to: the PAPRIKA wordmark, the user email, scope *values*, and (in the body) nav item labels via inline `font-family:'Barlow Condensed',sans-serif` in `navBase`.
* **Scrollbars are styled** — 9×9px, thumb `#c4c4c8`, track `#e9e9ea`. WebKit only, applied to `*`.
* **`::selection` `#d6ebff`** — this is `--color-accent-200` hardcoded. It **overrides** `styles.css:131` (`color-mix(in srgb, var(--color-accent) 30%, transparent)`).
* **`@keyframes blip`** — `0%,100% { opacity:1 } 50% { opacity:.25 }`. Used exactly once in the chrome: the live-status dot in the header (L87, `animation:blip 2.4s ease-in-out infinite`). Grep the rest of the file before assuming it is unused elsewhere.
* `body { margin:0 }` and `font-size:13px` override `styles.css:108` (`font-size: 15px; line-height: 1.55`). **The design's base size is 13px, not 15px.**

### Canvas props (L1281, `data-props`, decoded)

```json
{
  "$preview": { "width": 1440, "height": 1000 },
  "density":            { "editor":"enum",    "options":["compact","comfortable"], "default":"compact",  "tsType":"\"compact\" | \"comfortable\"", "section":"Table" },
  "showLifecycleStrip": { "editor":"boolean", "default": true,                                            "tsType":"boolean",                     "section":"Table" },
  "statusPalette":      { "editor":"enum",    "options":["colour","quiet"],        "default":"colour",   "tsType":"\"colour\" | \"quiet\"",       "section":"Status" }
}
```
Design viewport is **1440×1000**. `density` drives `rowH = dense ? 42 : 52` (L1417–1418). `statusPalette:"quiet"` desaturates only the `healthy` tone (L1289–1291).

---

## 2. Page shell (L28, L57)

```html
<div style="display:flex; min-height:100vh; background:#f2f2f3;">
  <nav …/>                                                  <!-- 206px sidebar -->
  <div style="flex:1; min-width:0; display:flex; flex-direction:column;">
    <header …/>                                             <!-- 42px -->
    <main style="flex:1; min-width:0;"> … </main>            <!-- L94 -->
  </div>
</div>
```

* Root is a **two-column flex row**, `min-height:100vh`, page bg `#f2f2f3`.
* The sidebar is **NOT fixed/absolute** — it is a flex child (`flex:none; width:206px`) that itself scrolls internally.
* Right column is `flex:1; min-width:0; display:flex; flex-direction:column`. `min-width:0` is load-bearing — the body contains wide tables/treemaps.
* `<main>` (L94) carries **only** `flex:1; min-width:0`. **No padding, no max-width, no background.** Every screen inside supplies its own padding.

---

## 3. Left nav (L30–55)

```html
<nav style="width:206px; flex:none; display:flex; flex-direction:column;
            background:#1d2d3d; color:#f2f2f3;">
```

* **Width `206px`, `flex:none`.** Full-height column, no border-right — it separates from the page by colour alone.
* Background **`#1d2d3d`** (= `--color-accent-900`, hardcoded as `STEEL_9` in the script, L1284). Foreground **`#f2f2f3`** (`PAPER`).

### 3.1 Brand lockup (L31–34)

```html
<div style="padding:14px 16px 13px; border-bottom:1px solid rgba(242,242,243,0.16);">
  <div class="cond" style="font-size:19px; font-weight:700; letter-spacing:0.14em; line-height:1;">PAPRIKA</div>
  <div class="mono" style="margin-top:5px; font-size:9px; letter-spacing:0.12em; color:#94bce3;">CONTROL PLANE · v2.4.1</div>
</div>
```

* Container padding **`14px 16px 13px`** (asymmetric, deliberate), bottom hairline `1px solid rgba(242,242,243,0.16)` (= paper @ 16% — the dark-surface analogue of `--color-divider`).
* Wordmark: **Barlow Condensed 700 / 19px / letter-spacing 0.14em / line-height 1**, literal text **`PAPRIKA`** (all caps in the source, not text-transform).
* Sub-line: **mono 9px / letter-spacing 0.12em / colour `#94bce3`** (= `--color-accent-400`), `margin-top:5px`, literal text **`CONTROL PLANE · v2.4.1`** (middle dot U+00B7 with a space each side).
* **No logo mark / no avatar square.** The current design has a 32px rounded orange `P` tile — the target drops it entirely.

### 3.2 Scroll region + section loop (L36–49)

```html
<div style="flex:1; overflow-y:auto; padding:12px 0;">
  <sc-for list="{{ navSections }}" as="sec">
    <div style="margin-bottom:14px;">
      <div class="mono" style="padding:0 16px 6px; font-size:9px; letter-spacing:0.18em; color:rgba(242,242,243,0.42);">{{ sec.label }}</div>
      <sc-for list="{{ sec.items }}" as="item">
        <button type="button" onClick="{{ item.go }}" style="{{ item.style }}">
          <span style="width:14px; flex:none; display:flex; opacity:.85;">{{ item.glyph }}</span>
          <span style="flex:1; text-align:left;">{{ item.label }}</span>
          <span class="mono" style="font-size:9px; opacity:.55;">{{ item.badge }}</span>
        </button>
      </sc-for>
    </div>
  </sc-for>
</div>
```

* Scroll container: `flex:1; overflow-y:auto; padding:12px 0` (no horizontal padding — items are full-bleed so the active highlight runs edge to edge).
* **Section gap:** each section wrapper has `margin-bottom:14px`.
* **Section label:** `.mono`, `padding:0 16px 6px`, **9px**, **letter-spacing 0.18em**, colour **`rgba(242,242,243,0.42)`**. Labels are literal uppercase strings in the data (`FLEET`, `DELIVERY`, `SOURCES`), *not* `text-transform`.
* **Item row internals:** glyph slot is a fixed `width:14px; flex:none; display:flex; opacity:.85`; label `flex:1; text-align:left`; badge `.mono`, `font-size:9px`, `opacity:.55` (badge inherits the row's colour, so it dims with the row).

### 3.3 Nav item styling — `navBase` (L1440) + active/inactive (L1446–1448)

```js
const navBase = "display:flex; align-items:center; gap:9px; width:100%; height:29px; border:0; padding:0 16px; font-family:'Barlow Condensed',sans-serif; font-size:14px; font-weight:500; letter-spacing:0.05em; text-transform:uppercase; cursor:pointer; text-align:left;";
```

| property | value |
|---|---|
| layout | `display:flex; align-items:center; gap:9px; width:100%` |
| height | **29px** (fixed; no vertical padding) |
| padding | `0 16px` |
| border | `0` |
| font | **Barlow Condensed, 14px, weight 500, letter-spacing 0.05em, `text-transform:uppercase`** |
| align | `text-align:left`, `cursor:pointer` |

State:

* **Active** — `background:#5980a6; color:#f2f2f3;` (`STEEL` on `PAPER`). Full-bleed solid block, **square corners, no left rail, no border**.
* **Inactive** — `background:none; color:rgba(242,242,243,0.74);`
* **No hover style is defined anywhere.** Buttons have no `:hover` rule and inline styles can't express one. If you add hover in React, that is a *new* decision — flag it.
* Active key resolution (L1441): `const activeKey = s === "appDetail" ? "applications" : s;` — the **App Detail screen keeps "Applications" highlighted**. Matching is on `item.id`, navigation dispatches `item.key` (they differ for the SOURCES group).

### 3.4 Nav data — `navDef` (L1423–1439), verbatim

| section | label | glyph (lucide key) | `key` (target screen) | `id` (active match) | badge |
|---|---|---|---|---|---|
| `FLEET` | **Overview** | `grid` | `overview` | `overview` | `""` |
| `FLEET` | **Applications** | `boxes` | `applications` | `applications` | `String(APPS.length)` → **`"30"`** |
| `FLEET` | **Fleet map** | `map` | `map` | `map` | `""` |
| `DELIVERY` | **Pipelines** | `workflow` | `pipeline` | `pipeline` | `"3"` |
| `DELIVERY` | **Rollouts** | `rocket` | `rollout` | `rollout` | `"3"` |
| `DELIVERY` | **Sync & diff** | `diff` | `diff` | `diff` | `"8"` |
| `SOURCES` | **Repositories** | `git` | `overview` | `repos` | `"41"` |
| `SOURCES` | **Templates** | `layers` | `overview` | `templates` | `"4"` |
| `SOURCES` | **Clusters** | `server` | `map` | `clusters` | `"3"` |

* Note the SOURCES rows are **mock stubs**: Repositories and Templates both route to `overview`, Clusters routes to `map`. Their `id`s never equal `activeKey`, so **they can never render active**. That is in the design as-is.
* `APPS` is defined L1311–1342 → **30 entries** (grid of app×cluster targets).
* Icons are inline Lucide path data in the `LUCIDE` map (L1371–1395). Available keys: `grid boxes map workflow rocket diff git layers server search chevron gauge logs traces book users coins pkg file eyeOff cog sliders flask`.
* `icon(name, size, color)` (L1396–1398) renders an `<svg>` with `width/height = size||14`, `viewBox="0 0 24 24"`, `fill:none`, `stroke: color || "currentColor"`, `strokeWidth:1.5`, `strokeLinecap/Linejoin:"round"`, `style:{display:"block", flex:"none"}`. Nav calls `icon(it.glyph, 14)` → **14px, currentColor, stroke-width 1.5**.

### 3.5 Nav footer (L51–54)

```html
<div style="border-top:1px solid rgba(242,242,243,0.16); padding:10px 16px;">
  <div class="cond" style="font-size:13px; letter-spacing:0.04em;">sre@paprika.io</div>
  <div class="mono" style="margin-top:2px; font-size:9px; letter-spacing:0.1em; color:rgba(242,242,243,0.5);">PLATFORM · ON-CALL</div>
</div>
```

* Sits outside the scroll region (sibling after it), so it is **pinned to the bottom** of the sidebar.
* Top hairline `1px solid rgba(242,242,243,0.16)`, padding `10px 16px`.
* Line 1: `.cond`, **13px**, letter-spacing `0.04em`, inherits `#f2f2f3`. Literal text **`sre@paprika.io`**.
* Line 2: `.mono`, **9px**, letter-spacing `0.1em`, colour **`rgba(242,242,243,0.5)`**, `margin-top:2px`. Literal text **`PLATFORM · ON-CALL`**.
* **Not a button, no avatar, no menu affordance, no sign-out.** Static identity block only.

---

## 4. Top header (L59–92)

```html
<header style="display:flex; align-items:stretch; height:42px;
               border-bottom:1px solid rgba(29,31,32,0.16); background:#fff;">
```

* **Height exactly `42px`**, `align-items:stretch` so every child fills full height and vertical dividers run edge to edge.
* Background **`#fff`** — note: pure white, **not** `--color-bg` (`#f2f2f3`) and **not** `--color-surface` (`#e9e9ea`). The header floats above the `#f2f2f3` page.
* Bottom border `1px solid rgba(29,31,32,0.16)` (= `DIV`, the `--color-divider` value hardcoded).

Header is two regions: **left group** `flex:1; min-width:0` (scopes + clear + search, L60–84) and **right group** (live ticker + gen, L85–91).

### 4.1 Scope bar — `scopes` loop (L61–76)

Each scope is `<div style="position:relative; height:100%; display:flex;">` wrapping a trigger button and a conditional dropdown.

**Trigger (L63–67):**

```html
<button type="button" onClick="{{ sc.toggle }}" style="{{ sc.btnStyle }}">
  <span class="mono" style="font-size:9px; letter-spacing:0.12em; color:#7a7a7d;">{{ sc.label }}</span>
  <span class="cond" style="font-size:14px; font-weight:600; letter-spacing:0.02em; white-space:nowrap;">{{ sc.value }}</span>
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#7a7a7d" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
</button>
```

* Label: `.mono` **9px**, letter-spacing `0.12em`, colour **`#7a7a7d`** (`FAINT`). Text is `k.toUpperCase()` → literal **`PROJECT`**, **`CLUSTER`**, **`STAGE`**.
* Value: `.cond` **14px, weight 600**, letter-spacing `0.02em`, `white-space:nowrap`, inherits `#1d1f20`. Default value for all three is the string **`"All"`**.
* Chevron: **12×12** inline SVG, `stroke="#7a7a7d"`, `stroke-width 1.5`, path `m6 9 6 6 6-6` (lucide chevron-down). **It does not rotate when open.**

**`sc.btnStyle` (L1461):**

```
display:flex; align-items:center; gap:7px; height:100%; border:0;
border-right:1px solid rgba(29,31,32,0.16);
background:<state>;
padding:0 14px; font:inherit; cursor:pointer; color:#1d1f20; position:relative;
```

Background is a 3-way state expression:

| state | background |
|---|---|
| **filtered** (`scope[k] !== "All"`) | **`#e7f0f8`** (pale steel wash) — wins over open |
| **open** (`openScope === k`, value still `All`) | **`#f5f5f8`** (= `--color-neutral-100`) |
| default | `none` (transparent → white header) |

Every scope button carries `border-right:1px solid rgba(29,31,32,0.16)`, so the three fields read as an unbroken segmented strip of hairline cells, full 42px tall, **no radius, no outer border, no gap**.

**Dropdown (L68–74)** — rendered inside `<sc-if value="{{ sc.isOpen }}">`:

```html
<div style="position:absolute; top:100%; left:0; z-index:80; min-width:220px;
            border:1px solid rgba(29,31,32,0.28); background:#fff;
            box-shadow:0 3px 10px rgba(43,43,45,0.16);">
```

* Anchored to the trigger wrapper, `top:100%; left:0`, **z-index 80**, **min-width 220px**.
* Border is the **heavier** `rgba(29,31,32,0.28)` (not the 0.16 divider). Background `#fff`.
* Shadow `0 3px 10px rgba(43,43,45,0.16)` — this is literally `--shadow-md` (`0 3px 10px color-mix(in srgb, #2b2b2d 16%, transparent)`) resolved by hand. Note `#2b2b2d` = `rgb(43,43,45)`.
* **Square corners** (no `border-radius`).

**Option row (L71), `o.style` (L1465):**

```
display:flex; align-items:center; justify-content:space-between; gap:14px;
width:100%; border:0; border-bottom:1px solid rgba(29,31,32,0.10);
background:<#e7f0f8 if selected else #fff>;
padding:0 12px; height:30px; font:inherit; font-size:12px;
text-align:left; cursor:pointer; color:#1d1f20; white-space:nowrap;
```

* **Row height 30px**, 12px text, separator is the *light* divider `DIV2 = rgba(29,31,32,0.10)`. Selected row background **`#e7f0f8`** (same wash as the filtered trigger).
* Left: `<span>{{ o.label }}</span>`. Right: `<span class="mono" style="font-size:10px; color:#7a7a7d;">{{ o.count }}</span>` — a **mono 10px `#7a7a7d` count of matching targets**.
* Options come from `scopeVals` (L1452–1456):
  * `project` → `["All", ...unique APPS project]`
  * `cluster` → `["All", ...unique APPS cluster]`
  * `stage` → **hardcoded `["All", "prod", "staging", "dev"]`**
  * count (L1463): `v === "All" ? APPS.length : APPS.filter(a => (k === "stage" ? a.env : a[k]) === v).length` — note `stage` reads the `env` field.
* Only one dropdown open at a time: `openScope` is a single nullable key; `toggle` flips it (L1460); selecting an option sets the value **and** closes (`openScope: null`, L1464).

### 4.2 Clear affordance (L77–79)

```html
<sc-if value="{{ scopeActive }}">
  <button type="button" onClick="{{ clearScope }}"
    style="display:flex; align-items:center; gap:6px; height:100%; border:0;
           border-right:1px solid rgba(29,31,32,0.16); background:none;
           padding:0 12px; font:inherit; font-size:11px; color:#416180;
           cursor:pointer; white-space:nowrap;">{{ scopeSummary }} · clear</button>
</sc-if>
```

* Only rendered when `scopeActive` (L1474): `Object.values(this.state.scope).some(v => v !== "All")`.
* Style: full height, **transparent**, `border-right` hairline (continues the segmented strip), padding `0 12px`, **font-size 11px**, colour **`#416180`** (`STEEL_D`, the link colour) — reads as a link but is a `<button>`.
* Content: `{{ scopeSummary }}` then the literal suffix **` · clear`** (space, U+00B7, space, `clear` lowercase).
* `scopeSummary` (L1472): `` `${scopedApps.length} of ${APPS.length} targets in scope` `` → e.g. **`"6 of 30 targets in scope · clear"`**.
* `clearScope` (L1473) resets all three scopes to `"All"` **and** closes the dropdown.
* `scopedApps` (L1468–1471) filters APPS by all three axes (`stage` compares against `a.env`).
* `closeScope` exists in the returned bindings (L1996) but is **never referenced in the template** — there is no click-outside handler wired up in the design.

### 4.3 Search (L80–83)

```html
<div style="flex:1; min-width:0; display:flex; align-items:center; gap:8px; padding:0 14px;">
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7a7a7d" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
  <input type="search" placeholder="Search apps, resources, revisions, runs…   ⌘K"
    style="flex:1; min-width:0; border:0; background:none; font:inherit; font-size:13px; color:#1d1f20; outline:none;">
</div>
```

* Takes all remaining width (`flex:1; min-width:0`), padding `0 14px`, `gap:8px`.
* Magnifier: **14×14**, `stroke="#7a7a7d"`, stroke-width 1.5, lucide `search` geometry.
* Input is **completely chromeless** — `border:0; background:none; outline:none`. No box, no radius, no focus ring. Sits directly on the white header.
* **Verbatim placeholder** (note the ellipsis char U+2026 and **three literal spaces** before ⌘K):
  `Search apps, resources, revisions, runs…   ⌘K`
* Font 13px, colour `#1d1f20`. `type="search"`.
* No `onChange`/`onKeyDown` binding in the design — the ⌘K hint is decorative here; **no command palette exists in the template** (see §5).

### 4.4 Right side — status cluster (L85–91)

```html
<div style="display:flex; align-items:center; gap:12px; border-left:1px solid rgba(29,31,32,0.16); padding:0 14px;">
  <span style="display:inline-flex; align-items:center; gap:6px;">
    <span style="width:6px; height:6px; background:#5980a6; animation:blip 2.4s ease-in-out infinite;"></span>
    <span class="mono" style="font-size:10px; color:#5d5d60;">live · 12s</span>
  </span>
  <span class="mono" style="font-size:10px; color:#7a7a7d;">gen 4412</span>
</div>
```

* `border-left:1px solid rgba(29,31,32,0.16)`, padding `0 14px`, `gap:12px`.
* Live dot: **6×6 px SQUARE** (no `border-radius` — it is a square pip, not a circle), background **`#5980a6`** (`STEEL`), `animation:blip 2.4s ease-in-out infinite`.
* Live label: `.mono` **10px**, colour **`#5d5d60`** (`MUTED`), literal text **`live · 12s`** (lowercase).
* Gen counter: `.mono` **10px**, colour **`#7a7a7d`** (`FAINT`, one step lighter than the live label), literal text **`gen 4412`**.
* **That is the entire right side.** No avatar, no settings cog, no notifications bell, no theme switch, no help.

---

## 5. Everything after `</main>` (L1265–1280)

```
1276    </main>
1277  </div>
1278 </div>
1279
1280 </x-dc>
```

**There is nothing.** No dialogs, no drawers, no toasts, no command palette, no global footer, no backdrop, no portal root.

* L1274–1275 close the last overview board (`<p>` caption + `</div>` + `</sc-if>`).
* The only overlay-like things in the whole document are **inline and locally positioned**:
  * the scope dropdown (L69, `position:absolute; z-index:80`),
  * a heatmap hover card (L1615) — `position:absolute; z-index:70; background:#1d2d3d; color:#f2f2f3; border:1px solid rgba(242,242,243,0.16); box-shadow:0 8px 22px rgba(29,45,61,0.28); pointer-events:none;`,
  * a heatmap settings popover (L187–210),
  * an in-page detail panel (the `panel` / `panelTab` state) rendered inside `<main>`.
* `styles.css` ships `.dialog-backdrop` / `.dialog` (styles.css:261–277) but **the design never uses them.**

Implication for the Next.js port: the chrome needs **no portal layer / no global overlay slot** to match this design. Any modal you add is a new decision.

---

## 6. `styles.css` in full (285 lines)

### 6.1 Tokens — `:root` (styles.css:4–64), complete

**Core roles**
| token | value |
|---|---|
| `--color-bg` | `#f2f2f3` |
| `--color-surface` | `#e9e9ea` |
| `--color-text` | `#1d1f20` |
| `--color-accent` | `#5980a6` |
| `--color-accent-2` | `#728fab` |
| `--color-divider` | `color-mix(in srgb, #1d1f20 16%, transparent)` → **`rgba(29,31,32,0.16)`** |

**Neutral ramp** (comment styles.css:12–13: "generated in OKLCH on one shared lightness scale, so the same step of any role matches the others in visual value")
| token | value |
|---|---|
| `--color-neutral-100` | `#f5f5f8` |
| `--color-neutral-200` | `#e7e7ea` |
| `--color-neutral-300` | `#d4d4d7` |
| `--color-neutral-400` | `#b7b7ba` |
| `--color-neutral-500` | `#98989b` |
| `--color-neutral-600` | `#7a7a7d` |
| `--color-neutral-700` | `#5d5d60` |
| `--color-neutral-800` | `#424244` |
| `--color-neutral-900` | `#2b2b2d` |

**Accent ramp (steel blue)**
| token | value |
|---|---|
| `--color-accent-100` | `#eef6ff` |
| `--color-accent-200` | `#d6ebff` |
| `--color-accent-300` | `#b5d9fd` |
| `--color-accent-400` | `#94bce3` |
| `--color-accent-500` | `#749dc4` |
| `--color-accent-600` | `#597ea3` |
| `--color-accent-700` | `#416180` |
| `--color-accent-800` | `#2c455d` |
| `--color-accent-900` | `#1d2d3d` |

**Accent-2 ramp (dusty blue)** — used by `.tag-accent-2` only; the console never touches it
| token | value |
|---|---|
| `--color-accent-2-100` | `#eef6ff` |
| `--color-accent-2-200` | `#d6ebff` |
| `--color-accent-2-300` | `#bdd8f2` |
| `--color-accent-2-400` | `#9ebbd8` |
| `--color-accent-2-500` | `#7e9cb8` |
| `--color-accent-2-600` | `#627d98` |
| `--color-accent-2-700` | `#486077` |
| `--color-accent-2-800` | `#314457` |
| `--color-accent-2-900` | `#1f2d3a` |

**Type**
| token | value |
|---|---|
| `--font-heading` | `"Barlow Condensed", system-ui, sans-serif` |
| `--font-heading-weight` | `600` |
| `--font-body` | `"Barlow", system-ui, sans-serif` |

**Space** (an irregular 3.4px scale)
| token | value |
|---|---|
| `--space-1` | `3.4px` |
| `--space-2` | `6.8px` |
| `--space-3` | `10.2px` |
| `--space-4` | `13.6px` |
| `--space-6` | `20.4px` |
| `--space-8` | `27.2px` |

**Radius**
| token | value |
|---|---|
| `--radius-sm` | `2px` |
| `--radius-md` | `4px` |
| `--radius-lg` | `7px` |

**Elevation** (styles.css:59–63, "soft ink-tinted shadows on a light theme, a hairline edge + ambient darkness on a dark one")
| token | value | resolved |
|---|---|---|
| `--shadow-sm` | `0 1px 2px color-mix(in srgb, #2b2b2d 14%, transparent)` | `0 1px 2px rgba(43,43,45,0.14)` |
| `--shadow-md` | `0 3px 10px color-mix(in srgb, #2b2b2d 16%, transparent)` | `0 3px 10px rgba(43,43,45,0.16)` |
| `--shadow-lg` | `0 12px 32px color-mix(in srgb, #2b2b2d 22%, transparent)` | `0 12px 32px rgba(43,43,45,0.22)` |

### 6.2 Base / element rules

```css
body { background: var(--color-bg); color: var(--color-text); font-family: var(--font-body); }   /* :66-70 */
h1,h2,h3,h4 { font-family: var(--font-heading); font-weight: var(--font-heading-weight); }        /* :71 */

*, *::before, *::after { box-sizing: border-box; }                                                 /* :107 */
body { margin: 0; font-size: 15px; line-height: 1.55; font-weight: 400; }                          /* :108 — OVERRIDDEN to 13px by the helmet */
h1,h2,h3,h4,h5,h6 { font-family: var(--font-heading); font-weight: var(--font-heading-weight);
                    line-height: 1.12; letter-spacing: -0.015em; margin: 0 0 var(--space-2); }     /* :109-112 */
h1 { font-size: 42px; }  h2 { 32px; }  h3 { 25px; }  h4 { 20px; }  h5 { 16px; }  h6 { 13px; }      /* :113-118 */
h6 { letter-spacing: 0.08em; text-transform: uppercase; }                                          /* :119 */
p { margin: 0 0 var(--space-3); }                                                                  /* :120 */
a { color: var(--color-accent); text-underline-offset: 3px; }                                      /* :121 — OVERRIDDEN to #416180 by the helmet */
img { display: block; max-width: 100%; }                                                           /* :122 */
figure { margin: 0; }                                                                              /* :123 */
figcaption { font-size: 11px; margin-top: var(--space-1);
             color: color-mix(in srgb, var(--color-text) 55%, transparent); }                      /* :124-127 */
.text-muted { color: color-mix(in srgb, var(--color-text) 55%, transparent); }                     /* :128 */
:focus { outline: none; }                                                                          /* :129 */
:focus-visible { outline: 2px solid var(--color-accent); outline-offset: 2px; }                    /* :130 */
::selection { background: color-mix(in srgb, var(--color-accent) 30%, transparent); }              /* :131 — OVERRIDDEN to #d6ebff */
.hr { height: 1px; border: 0; margin: var(--space-4) 0; background: var(--color-divider); }        /* :134-137 */
```

> **Accessibility note:** `:focus { outline: none }` globally kills focus rings; only `:focus-visible` restores one (`2px solid #5980a6`, offset 2px). The console's inline-styled buttons/inputs additionally set `outline:none` (search input, L82) — so the search field has **no visible focus state at all** in the design.

### 6.3 `.blueprint` / `.corner` (styles.css:73–95)

```css
.blueprint { position: relative; border: 1px solid var(--color-divider); border-radius: 0; }
.blueprint.halftone, .blueprint.plate, .blueprint.duotone { overflow: visible; }
.blueprint > .corner { position: absolute; width: 11px; height: 11px;
                       color: color-mix(in srgb, var(--color-text) 55%, transparent); }
.blueprint > .corner::before, .blueprint > .corner::after { content: ""; position: absolute; background: currentColor; }
.blueprint > .corner::before { left: 5px; top: 0; width: 1px; height: 100%; }   /* vertical tick */
.blueprint > .corner::after  { top: 5px; left: 0; width: 100%; height: 1px; }   /* horizontal tick */
.blueprint > .corner.tl { top: -6px; left: -6px; }
.blueprint > .corner.tr { top: -6px; right: -6px; }
.blueprint > .corner.bl { bottom: -6px; left: -6px; }
.blueprint > .corner.br { bottom: -6px; right: -6px; }
```
Registration/crop marks: an 11×11 crosshair, offset −6px so it straddles the box corner, ink @ 55%.
Comment styles.css:78–81 explains the `overflow: visible` exception.

### 6.4 `.duotone` (styles.css:97–99)

```css
.duotone { position: relative; overflow: hidden; }
.duotone::after { content:""; position:absolute; inset:0; pointer-events:none;
                  background: var(--color-accent); mix-blend-mode: color; }
```

### 6.5 Buttons (styles.css:139–162)

```css
.btn { display:inline-flex; align-items:center; justify-content:center; gap:6px;
       cursor:pointer; text-decoration:none;
       font-family: var(--font-heading); font-weight: var(--font-heading-weight);
       font-size:14px; line-height:1.2; color: var(--color-text);
       background: transparent; border: 1px solid transparent;
       padding: var(--space-2) calc(var(--space-3) * 1.2);   /* 6.8px 12.24px */
       border-radius: var(--radius-md); }
.btn svg { display:block; }
.btn:disabled { opacity:0.45; cursor:not-allowed; }
.btn-primary { background: var(--color-accent); color: var(--color-bg); }
.btn-primary:hover  { background: var(--color-accent-600); }   /* #597ea3 */
.btn-primary:active { background: var(--color-accent-700); }   /* #416180 */
.btn-secondary { border-color: var(--color-divider); }
.btn-secondary:hover  { background: color-mix(in srgb, var(--color-text) 7%, transparent); }
.btn-secondary:active { background: color-mix(in srgb, var(--color-text) 14%, transparent); }
.btn-ghost { color: var(--color-accent); padding-inline: var(--space-1); }
.btn-ghost:hover  { background: color-mix(in srgb, var(--color-accent) 10%, transparent); }
.btn-ghost:active { background: color-mix(in srgb, var(--color-accent) 18%, transparent); }
.btn-icon { width:36px; height:36px; padding:0; }
.btn-block { width:100%; margin-top: var(--space-2); }
```
Comment styles.css:144–145: the 14px size "matches the `.input`'s 14px — the pair sits side by side in sign-up rows".

### 6.6 Forms (styles.css:164–203)

```css
.field > label { display:block; font-size:12px; margin-bottom:5px;
                 color: color-mix(in srgb, var(--color-text) 70%, transparent); }
.input { width:100%; min-height:36px; padding:6px 10px; font:inherit; font-size:14px;
         color: var(--color-text); caret-color: var(--color-accent);
         background: var(--color-surface);
         border: 1px solid var(--color-divider); border-radius: var(--radius-md); }
.input:hover { border-color: color-mix(in srgb, var(--color-text) 45%, transparent); }
.input:focus-visible { border-color: var(--color-accent); outline-offset: 0; }
textarea.input { min-height:90px; resize:vertical; }

.radio { display:inline-flex; align-items:center; gap:8px; cursor:pointer; font-size:14px; }
.radio input, .seg-opt input { position:absolute; opacity:0; width:0; height:0; pointer-events:none; }
.radio .dot { width:16px; height:16px; flex:none; border-radius:50%;
              border:1.5px solid var(--color-divider); }
.radio:hover .dot { border-color: var(--color-accent); }
.radio input:checked + .dot { border-color: var(--color-accent); background: var(--color-accent);
                              box-shadow: inset 0 0 0 4px var(--color-bg); }
.radio input:focus-visible + .dot { outline: 2px solid var(--color-accent); outline-offset: 2px; }

.seg { display:inline-flex; overflow:hidden;
       border: 1px solid var(--color-divider); border-radius: var(--radius-md); }
.seg-opt { display:inline-flex; align-items:center; gap:6px; padding:7px 12px; font-size:13px; cursor:pointer; }
.seg-opt + .seg-opt { border-left: 1px solid var(--color-divider); }
.seg-opt:has(input:checked) { background: var(--color-accent); color: var(--color-bg); }
.seg-opt:not(:has(input:checked)):hover { background: color-mix(in srgb, var(--color-text) 7%, transparent); }
.seg-opt:has(input:focus-visible) { outline: 2px solid var(--color-accent); outline-offset: -2px; }
```
The `.radio` "dot" is the only intentionally **round** thing in the system (it survives the §6.11 squaring override).

### 6.7 Cards + elevation (styles.css:205–222)

```css
.card { display:flex; flex-direction:column; gap: var(--space-2);
        padding: var(--space-3); border-radius: var(--radius-md); background: var(--color-surface); }
.card-kicker { font-size:10px; letter-spacing:0.1em; text-transform:uppercase; color: var(--color-accent); }
.card-title { font-family: var(--font-heading); font-weight: var(--font-heading-weight);
              font-size:17px; line-height:1.2; }
.card-body { margin:0; font-size:13px; opacity:0.8; flex:1; }
.card-meta { display:flex; align-items:center; gap:6px; font-size:11px;
             color: color-mix(in srgb, var(--color-text) 50%, transparent); }
.elev-sm { box-shadow: var(--shadow-sm); }
.elev-md { box-shadow: var(--shadow-md); }
.elev-lg { box-shadow: var(--shadow-lg); }
```

### 6.8 Tags (styles.css:224–233)

```css
.tag { display:inline-flex; align-items:center; font-size:11px; letter-spacing:0.02em;
       padding:3px 10px; border-radius: calc(var(--radius-md) * 0.75); }   /* 3px */
.tag-accent   { background: var(--color-accent-100);   color: var(--color-accent-800); }    /* #eef6ff / #2c455d */
.tag-accent-2 { background: var(--color-accent-2-100); color: var(--color-accent-2-800); }  /* #eef6ff / #314457 */
.tag-neutral  { background: var(--color-neutral-100);  color: var(--color-neutral-800); }   /* #f5f5f8 / #424244 */
.tag-outline  { border: 1px solid var(--color-accent); color: var(--color-accent); }
```

### 6.9 Nav classes (styles.css:235–246) — **NOT used by the console**

```css
.nav { display:flex; align-items:center; gap: var(--space-4); padding: var(--space-3) var(--space-4); border-bottom: none; }
.nav-brand { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size:18px; margin-right:auto; }
.nav a { color: inherit; text-decoration:none; font-size:14px; }
.nav a:hover, .nav a[aria-current='page'] { color: var(--color-accent); }
```
This is a horizontal marketing nav. The console builds its **own** vertical sidebar entirely inline (§3) and never applies `.nav`/`.nav-brand`.

### 6.10 Table (styles.css:248–259)

```css
.table { width:100%; border-collapse: collapse; font-size:14px; }
.table th { text-align:left; font-size:11px; letter-spacing:0.08em; text-transform:uppercase;
            color: color-mix(in srgb, var(--color-text) 60%, transparent);
            padding: var(--space-2); border-bottom: 1px solid var(--color-divider); }
.table td { padding: var(--space-2);
            border-bottom: 1px solid color-mix(in srgb, var(--color-text) 8%, transparent); }
.table tbody tr:hover { background: color-mix(in srgb, var(--color-text) 4%, transparent); }
```
Note the 8% row rule vs the 16% header rule — the console mirrors this idea with `DIV2` (10%) / `DIV` (16%).

### 6.11 Dialog (styles.css:261–277) — **NOT used by the console**

```css
.dialog-backdrop { position:fixed; inset:0; display:grid; place-items:center; padding: var(--space-4);
                   background: color-mix(in srgb, var(--color-neutral-900) 50%, transparent); }
.dialog { width: min(440px, 100%); display:flex; flex-direction:column; gap: var(--space-3);
          padding: var(--space-4); border-radius: var(--radius-lg);
          background: var(--color-surface); box-shadow: var(--shadow-lg); }
.dialog-title { font-family: var(--font-heading); font-weight: var(--font-heading-weight); font-size:20px; }
.dialog-body { font-size:14px; opacity:0.85; }
.dialog-actions { display:flex; justify-content:flex-end; gap: var(--space-2); margin-top: var(--space-2); }
```

### 6.12 ⚑ The blueprint-frame override block (styles.css:279–285) — **the most important 6 lines in the file**

```css
/* — blueprint frame: components are wireframe objects (see .blueprint
     and .corner above) — square, transparent, hairline-bordered — */
.card, .btn, .input, .tag, .seg, .dialog { border-radius: 0; }
.card, .dialog { background: transparent; border: 1px solid var(--color-divider); }
.btn { border: 1px solid var(--color-divider); }
.btn-primary { border-color: var(--color-accent); }
.btn-ghost   { border-color: transparent; }
```

This is a **late cascade override that undoes the token-driven look above it**:

1. **Every radius goes to 0.** `--radius-sm/md/lg` are still declared but effectively dead for `.card .btn .input .tag .seg .dialog`. Surviving curves: `.radio .dot` (`border-radius:50%`) and anything a consumer sets inline.
2. **Cards and dialogs lose their fill** — `background: var(--color-surface)` becomes `transparent`, and they gain a hairline `1px solid var(--color-divider)` border instead. Cards are *frames*, not *tiles*.
3. **Every `.btn` gets a hairline border**, including `.btn-primary` (accent-coloured border) and `.btn-ghost` (transparent border, so it still occupies the same box).

**Implementation consequence:** in the Next.js port, `border-radius: 0` and "surface = transparent + 1px divider" are the default, not an exception. Any Tailwind `rounded-*` or `bg-card` you carry over from an existing design system will read as wrong. The console honours this: **there is not a single `border-radius` in the entire chrome** except a handful of `border-radius:2px` micro-chips in the body (e.g. the hide-board eye buttons L133, facet chips L1638).

---

## 7. Tokens vs. hardcoded hex — the honest accounting

**The design almost never uses `var(--…)`.** Grep the template: the only place `styles.css` reaches the console at all is via the class names `.mono`/`.cond` (defined in the helmet, not the DS), plus a couple of DS classes used in the body (`.seg` at L168/L318, `.mono`). Every colour, size, gap and border in the chrome is a **literal hex/rgba string written inline in the HTML or interpolated from a JS `const`.**

So: **`styles.css` is a *reference palette*, not a runtime dependency for the chrome.** The design re-states its values by hand. Almost every hardcoded colour in the console is *exactly* a `styles.css` token value — the design just chose to freeze them rather than reference them.

### 7.1 Script colour constants (L1282–1286) — the actual palette

```js
const PAPER = "#f2f2f3", INK = "#1d1f20", MUTED = "#5d5d60", FAINT = "#7a7a7d";
const DIV = "rgba(29,31,32,0.16)", DIV2 = "rgba(29,31,32,0.10)";
const STEEL = "#5980a6", STEEL_D = "#416180", STEEL_9 = "#1d2d3d";
const OCHRE = "#b07a2c", OCHRE_T = "#8a5f22", OXIDE = "#a8443b", OXIDE_T = "#8e372f";
const GREEN = "#7fae86", GREEN_T = "#3f6b48";
```

| const | hex | `styles.css` equivalent | semantic meaning in this design |
|---|---|---|---|
| `PAPER` | `#f2f2f3` | `--color-bg` | page background; **also** the foreground colour on the navy sidebar and on any steel-filled control |
| `INK` | `#1d1f20` | `--color-text` | primary text |
| `MUTED` | `#5d5d60` | `--color-neutral-700` | secondary text — captions, ticker labels, board meta |
| `FAINT` | `#7a7a7d` | `--color-neutral-600` | tertiary text — field labels, counts, icon strokes, `gen` |
| `DIV` | `rgba(29,31,32,0.16)` | `--color-divider` | **the** hairline — header bottom, all vertical header cell borders, board frames |
| `DIV2` | `rgba(29,31,32,0.10)` | (≈ half `--color-divider`) | lighter hairline — inside lists/rows (dropdown options, table body rows) |
| `STEEL` | `#5980a6` | `--color-accent` | **selection / active fill.** Active nav item bg, selected segmented-control bg, live pip, progress bars |
| `STEEL_D` | `#416180` | `--color-accent-700` | **link / interactive text.** `a`, clear-scope button, "All →"/"Fleet →" links, small action buttons, entity icons |
| `STEEL_9` | `#1d2d3d` | `--color-accent-900` | **sidebar / inverted surface.** Nav background, hover-card background |
| — | `#94bce3` | `--color-accent-400` | brand sub-line on the navy sidebar (the only bright accent on dark) |
| — | `#2c455d` | `--color-accent-800` | link hover; text on `#eef6ff` selected chips |
| — | `#e7f0f8` | (not a token — bespoke) | **"this filter is engaged" wash** — active scope trigger, selected dropdown option |
| — | `#eef6ff` | `--color-accent-100` | selected chip / facet background |
| — | `#d6ebff` | `--color-accent-200` | `::selection` |
| — | `#f5f5f8` | `--color-neutral-100` | **"this menu is open" wash** on the scope trigger |
| — | `#fff` | (not a token) | header background, dropdown/panel/board backgrounds. The DS has no white token — `--color-surface` is `#e9e9ea`, which the design never uses |
| — | `rgba(242,242,243,0.16)` | (paper @16%) | divider **on the navy sidebar** — the dark-surface mirror of `DIV` |
| — | `rgba(242,242,243,0.74)` | | inactive nav item label |
| — | `rgba(242,242,243,0.5)` | | sidebar footer role line |
| — | `rgba(242,242,243,0.42)` | | sidebar section kicker |
| — | `rgba(29,31,32,0.28)` | | **heavier** border, used only for floating surfaces (dropdown, map nodes) |
| — | `rgba(43,43,45,0.16)` | `--shadow-md` resolved | dropdown shadow |

### 7.2 Status palette (L1288–1301, `tones()`), semantic

Each status is `{ glyph, label, c (text), line (border/rule), fill (background) }`.

| status | glyph | label | `c` text | `line` | `fill` |
|---|---|---|---|---|---|
| `healthy` (colour) | `✓` U+2713 | `Healthy` | `#3f6b48` (`GREEN_T`) | `#7fae86` (`GREEN`) | `#e6f2e8` |
| `healthy` (quiet) | `✓` | `Healthy` | `#4a4a4c` | `#a8a8ab` | `#f0f0f2` |
| `progressing` | `↻` U+21BB | `Progressing` | `#2c455d` | `#8bb0d0` | `#e7f0f8` |
| `degraded` | `!` | `Degraded` | `#8a5f22` (`OCHRE_T`) | `#e0ad66` | `#fdf2df` |
| `failed` | `×` U+00D7 | `Failed` | `#9c3f39` | `#dd9490` | `#fbe9e8` |
| `missing` | `∅` U+2205 | `Missing` | `#5b5468` | `#aea8bd` | `#efedf4` |
| `unknown` | `?` | `Unknown` | `#5d5d60` (`MUTED`) | `#c2c2c6` | `#f4f4f6` |
| `pending` | `·` U+00B7 | `Pending` | `#8e8e92` | `#d4d4d7` (`--color-neutral-300`) | `transparent` |

Related script constants not in `tones()`: `OCHRE #b07a2c` and `OXIDE #a8443b` (mid-tone warn/error, used for bars and borders), `OXIDE_T #8e372f` (error text in metric cells, L1913).

**None of these status colours exist in `styles.css`.** The DS has no semantic status ramp at all — this is entirely the design's own invention and must be ported as a first-class token set.

### 7.3 What genuinely comes from `styles.css` at runtime

* `.seg` (styles.css:192–195 + the `border-radius:0` override) — used at L168 and L318 with an inline `height:22px`; the buttons inside get fully inline styles (L1635, L1785).
* `*,*::before,*::after { box-sizing:border-box }` (styles.css:107) — relied on everywhere.
* `:focus-visible` ring (styles.css:130).
* Element defaults for `h1–h6` / `p` where the design doesn't override them inline (it usually does).

Everything else is inline.

---

## 8. Porting checklist / gotchas

1. **Base font-size is 13px**, not 16 or 15. All the px numbers below assume that.
2. **No border-radius anywhere in the chrome.** Set it to 0 by default.
3. **Sidebar 206px, header 42px, nav row 29px.** These are the three numbers to get exactly right.
4. Two webfonts only: **Barlow (400/500/600)** and **Barlow Condensed (400/500/600/700)**. Mono is the **system stack**, not a webfont — do not swap in JetBrains Mono.
5. **`.mono` and `.cond` are used as utility classes ~everywhere.** Recreate them as real global classes (or Tailwind `font-mono`/`font-cond` utilities mapped to the exact stacks).
6. The `@keyframes blip` animation must be global (used by an inline `animation:` string).
7. `#fff` and `#e7f0f8` and `#f5f5f8` are **three distinct header-cell backgrounds** with three distinct meanings (idle / filtered / open). Don't collapse them.
8. **No hover states are defined for nav items, scope triggers, or dropdown options.** Adding them is a design decision, not a port.
9. **Nothing renders after `</main>`.** No modal root needed to reproduce this design.
10. `closeScope` (L1996) is exported but unwired — there is **no click-outside-to-close** for the scope dropdowns. Real app almost certainly wants one; call it out as an addition.
11. The `SOURCES` nav group (Repositories / Templates / Clusters) routes to already-existing screens and can never show as active — decide whether to fix or reproduce.
12. Scope `stage` filters on the app's `env` field, not a `stage` field (L1463, L1471).
