# Repo UI Map — `/Users/benebsworth/projects/paprika/ui`

Survey of the EXISTING Next.js app as of this session. All paths absolute unless noted
relative to `/Users/benebsworth/projects/paprika/ui`. Line numbers cite the files read.

**Critical repo instruction** (`ui/AGENTS.md`, aliased by `ui/CLAUDE.md`):
> "This is NOT the Next.js you know. This version has breaking changes — APIs, conventions,
> and file structure may all differ from your training data. Read the relevant guide in
> `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices."

Next.js version is **16.2.7**, React **19.2.4**, Tailwind **v4**.

---

## 1. Routing

`next.config.ts` (10 lines) constrains everything:

```ts
const basePath = process.env.PAPRIKA_BASE_PATH || "";
const nextConfig: NextConfig = {
  output: "export",      // fully static export — no server components w/ runtime data,
  trailingSlash: true,   // no route handlers, no middleware
  distDir: "out",
  basePath,
};
```

Consequences that bind every new route:
- **`output: "export"`** → static HTML export only. All data fetching is client-side
  ConnectRPC (see §7). No `generateStaticParams` dynamic segments are used at all.
- **`trailingSlash: true`** → every URL ends in `/`. Manual redirects in code write
  `"/dashboard/"`, `"/login/"` with the trailing slash (`src/app/page.tsx:11`,
  `src/app/login/page.tsx:17,42`, `src/lib/transport.ts:13,15`).
- **Detail pages use SEARCH PARAMS, not dynamic segments.** There is no `[name]` folder
  anywhere. Every detail route is a static page reading `useSearchParams()`.

### Route inventory (`src/app`)

| File | URL | Renders |
|---|---|---|
| `src/app/layout.tsx` (53) | — | Root shell: fonts, providers, `<Nav />` |
| `src/app/page.tsx` (19) | `/` | `"use client"` redirect-only. `useAuth()` → `window.location.href = user ? "/dashboard/" : "/login/"`. Returns `null`. |
| `src/app/login/page.tsx` (146) | `/login/` | Basic-auth form (`POST /auth/basic-login`) + "Sign in with Google" OIDC button |
| `src/app/auth/callback/page.tsx` (96) | `/auth/callback/` | OAuth PKCE callback; reads `?code=&state=`, validates against `sessionStorage` keys `paprika_expected_state`, `paprika_code_verifier`, `paprika_redirect_uri`, then `POST /auth/token` |
| `src/app/dashboard/layout.tsx` (7) | — | `<AppShell>{children}</AppShell>` |
| `src/app/dashboard/page.tsx` (478) | `/dashboard/` | **Operations overview.** Sections in order: `FleetStateNotice` → `FleetOverview` → `DashboardCommandCenter` (anchor `#releases`) → 7 `StatCard`s → Pipelines grid (anchor `#pipelines`) → Application Sets grid → Policies grid. Ends with `<ToastStack />`. |
| `src/app/dashboard/applications/page.tsx` (32) | `/dashboard/applications/` | Server component; `<Suspense>` + `<FleetView />`. Fallback duplicates the header eyebrow/title. |
| `src/app/dashboard/application/page.tsx` (786) | `/dashboard/application/?namespace=&name=` | **Application detail.** Largest route file. |
| `src/app/dashboard/applicationsets/page.tsx` (178) | `/dashboard/applicationsets/` | ApplicationSet card grid |
| `src/app/dashboard/applicationsets/detail/page.tsx` (176) | `/dashboard/applicationsets/detail/?namespace=&name=` | Two cards: Status, Generated Applications |
| `src/app/dashboard/pipelines/detail/page.tsx` (231) | `/dashboard/pipelines/detail/?namespace=&name=` | DAG + step-detail side panel + artifacts |
| `src/app/dashboard/rollouts/page.tsx` (293) | `/dashboard/rollouts/?namespace=` (optional filter) | 3 stat cards + rollouts table |
| `src/app/dashboard/rollouts/detail/page.tsx` (314) | `/dashboard/rollouts/detail/?namespace=&name=` | 4 stat cards + Details + `RolloutDebugPanel` + Conditions |

**Note:** there is NO `/dashboard/pipelines/` list route and NO `/dashboard/releases/` route.
The sidebar links to hash anchors `/dashboard#pipelines` and `/dashboard#releases` instead.

### Search-param / hash state in use

- **Detail identity**: `?namespace=<ns>&name=<n>` on `application`, `applicationsets/detail`,
  `pipelines/detail`, `rollouts/detail`. Always built with `encodeURIComponent`.
  Example construction: `src/app/dashboard/page.tsx:363`,
  `src/components/dashboard/dashboard-command-center.tsx:104-107`.
- **Fleet query state** (`/dashboard/applications`) — full URL-as-state, see §8.
- **Hash anchors** on `/dashboard`: `#pipelines`, `#releases`, `#applications`
  (`#applications` is auto-redirected to `/dashboard/applications` by
  `src/components/layout/sidebar.tsx:88-92`).
- **Tab state is component-local `useState`, never in the URL.** Examples:
  `viewMode: "graph" | "list"` (`application/page.tsx:136`),
  `Tab = "live"|"desired"|"diff"|"events"|"logs"` (`resource-detail-panel.tsx:15`),
  `SyncFilter` (`sync-diff-workbench.tsx:20`),
  `HealthFilter` (`dashboard-command-center.tsx:35`).

---

## 2. The shell

### `src/app/layout.tsx` (53 lines)

```tsx
const instrumentSans = Instrument_Sans({ variable: "--font-sans", subsets: ["latin"],
  weight: ["400", "500", "600", "700"] })
const jetbrainsMono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"],
  weight: ["400", "500"] })

export const metadata: Metadata = {
  title: { template: "%s | Paprika", default: "Paprika" },
  description: "Kubernetes-native application delivery platform.",
}
```

Body tree (lines 36-51):
```
<html lang="en" className="{sans} {mono} h-full antialiased dark" style={{ colorScheme: "dark" }}>
  <body className="min-h-full flex flex-col">
    <AuthProvider><ConnectionProvider><QueryProvider>
      <Nav />
      <div className="flex-1">{children}</div>
    </QueryProvider></ConnectionProvider></AuthProvider>
```

**The app is hard-locked to dark mode** — `dark` class + `colorScheme: "dark"` on `<html>`.
No theme toggle exists anywhere.

Fonts: **Instrument Sans** (body, `--font-sans`) and **JetBrains Mono** (`--font-mono`).
Mono is used pervasively for eyebrow labels, identity strings, and numbers.

### `src/app/globals.css` (206 lines) — VERBATIM token block

```css
@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@plugin "@tailwindcss/typography";

@custom-variant dark (&:is(.dark *));

/* ── Easing tokens ─────────────────────────────────────────────────── */
:root {
  --ease-out-quart: cubic-bezier(0.25, 1, 0.5, 1);
  --ease-out-quint: cubic-bezier(0.22, 1, 0.36, 1);
  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
}

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar: var(--sidebar);
  --color-chart-5: var(--chart-5);
  --color-chart-4: var(--chart-4);
  --color-chart-3: var(--chart-3);
  --color-chart-2: var(--chart-2);
  --color-chart-1: var(--chart-1);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-destructive: var(--destructive);
  --color-accent-foreground: var(--accent-foreground);
  --color-accent: var(--accent);
  --color-muted-foreground: var(--muted-foreground);
  --color-muted: var(--muted);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-secondary: var(--secondary);
  --color-primary-foreground: var(--primary-foreground);
  --color-primary: var(--primary);
  --color-popover-foreground: var(--popover-foreground);
  --color-popover: var(--popover);
  --color-card-foreground: var(--card-foreground);
  --color-card: var(--card);
  --color-success: var(--success);
  --color-success-foreground: var(--success-foreground);
  --color-warning: var(--warning);
  --color-warning-foreground: var(--warning-foreground);
  --radius-sm: calc(var(--radius) * 0.5);
  --radius-md: calc(var(--radius) * 0.75);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
  --radius-2xl: calc(var(--radius) * 1.8);
  --radius-3xl: calc(var(--radius) * 2.2);
  --radius-4xl: calc(var(--radius) * 2.6);
}

/* ── Dark color palette ────────────────────────────────────────────── */
/* Warm-tinted neutrals (hue 50 = warm amber/orange cast)               */
/* Primary: paprika orange oklch(0.63 0.19 35)                         */
/* Surface hierarchy: darker bg → lighter elevated surfaces             */
/* ──────────────────────────────────────────────────────────────────── */
:root.dark {
  --background: oklch(0.115 0.01 50);
  --foreground: oklch(0.93 0.012 50);
  --card: oklch(0.155 0.014 50);
  --card-foreground: oklch(0.93 0.012 50);
  --popover: oklch(0.155 0.014 50);
  --popover-foreground: oklch(0.93 0.012 50);
  --primary: oklch(0.63 0.19 35);
  --primary-foreground: oklch(0.98 0.005 50);
  --secondary: oklch(0.21 0.012 50);
  --secondary-foreground: oklch(0.93 0.012 50);
  --muted: oklch(0.19 0.01 50);
  --muted-foreground: oklch(0.62 0.015 50);
  --accent: oklch(0.68 0.14 75);
  --accent-foreground: oklch(0.98 0.005 50);
  --destructive: oklch(0.56 0.18 25);
  --success: oklch(0.53 0.12 145);
  --success-foreground: oklch(0.98 0.005 50);
  --warning: oklch(0.68 0.14 75);
  --warning-foreground: oklch(0.13 0.012 50);
  --border: oklch(0.24 0.012 50);
  --input: oklch(0.24 0.012 50);
  --ring: oklch(0.63 0.19 35 / 0.4);
  --radius: 0.75rem;
  --chart-1: oklch(0.63 0.19 35);
  --chart-2: oklch(0.53 0.12 145);
  --chart-3: oklch(0.68 0.14 75);
  --chart-4: oklch(0.53 0.14 280);
  --chart-5: oklch(0.63 0.14 200);
  --sidebar: oklch(0.115 0.01 50);
  --sidebar-foreground: oklch(0.93 0.012 50);
  --sidebar-primary: oklch(0.63 0.19 35);
  --sidebar-primary-foreground: oklch(0.98 0.005 50);
  --sidebar-accent: oklch(0.21 0.012 50);
  --sidebar-accent-foreground: oklch(0.93 0.012 50);
  --sidebar-border: oklch(0.24 0.012 50);
  --sidebar-ring: oklch(0.63 0.19 35 / 0.4);
}

/* ── Light palette (prepared but unused for now) ───────────────────── */
:root {
  --background: oklch(0.98 0.005 50);
  --foreground: oklch(0.13 0.012 50);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.13 0.012 50);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.13 0.012 50);
  --primary: oklch(0.55 0.18 35);
  --primary-foreground: oklch(0.98 0.005 50);
  --secondary: oklch(0.92 0.008 50);
  --secondary-foreground: oklch(0.13 0.012 50);
  --muted: oklch(0.92 0.008 50);
  --muted-foreground: oklch(0.52 0.015 50);
  --accent: oklch(0.65 0.14 75);
  --accent-foreground: oklch(0.13 0.012 50);
  --destructive: oklch(0.55 0.18 25);
  --success: oklch(0.5 0.12 145);
  --success-foreground: oklch(0.98 0.005 50);
  --warning: oklch(0.65 0.14 75);
  --warning-foreground: oklch(0.13 0.012 50);
  --border: oklch(0.87 0.008 50);
  --input: oklch(0.87 0.008 50);
  --ring: oklch(0.55 0.18 35 / 0.4);
  --radius: 0.75rem;
  --chart-1: oklch(0.55 0.18 35);
  --chart-2: oklch(0.5 0.12 145);
  --chart-3: oklch(0.65 0.14 75);
  --chart-4: oklch(0.55 0.14 280);
  --chart-5: oklch(0.63 0.14 200);
  --sidebar: oklch(0.98 0.005 50);
  --sidebar-foreground: oklch(0.13 0.012 50);
  --sidebar-primary: oklch(0.55 0.18 35);
  --sidebar-primary-foreground: oklch(0.98 0.005 50);
  --sidebar-accent: oklch(0.92 0.008 50);
  --sidebar-accent-foreground: oklch(0.13 0.012 50);
  --sidebar-border: oklch(0.87 0.008 50);
  --sidebar-ring: oklch(0.55 0.18 35 / 0.4);
}

/* ── Base layer ────────────────────────────────────────────────────── */
@layer base {
  * { @apply border-border outline-ring/50; }
  body { @apply bg-background text-foreground; }
  html {
    @apply font-sans antialiased;
    -moz-osx-font-smoothing: grayscale;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  h1, h2, h3, h4, h5, h6 { text-wrap: balance; }
  p, li, figcaption { text-wrap: pretty; }
  img { outline: 1px solid rgba(0, 0, 0, 0.1); outline-offset: -1px; }
  :where(.dark) img { outline: 1px solid rgba(255, 255, 255, 0.06); outline-offset: -1px; }

  /* Subtle focus ring for keyboard nav */
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }

  /* Scrollbar styling for dark mode */
  .dark ::-webkit-scrollbar { width: 8px; height: 8px; }
  .dark ::-webkit-scrollbar-track { background: transparent; }
  .dark ::-webkit-scrollbar-thumb { background: oklch(0.3 0.01 50); border-radius: 4px; }
  .dark ::-webkit-scrollbar-thumb:hover { background: oklch(0.4 0.01 50); }
}

/* ── Reduced motion ────────────────────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

**Key colour facts for design translation:**
- Palette is **oklch, warm hue 50**, not hex. The design's literal hexes will need mapping.
- App background `oklch(0.115 0.01 50)` ≈ `#1c1817`. Card `oklch(0.155 0.014 50)` ≈ `#252020`.
- Primary "paprika orange" `oklch(0.63 0.19 35)` ≈ `#e5623c`.
- Border/input `oklch(0.24 0.012 50)` ≈ `#3b3533`.
- `--radius: 0.75rem` (12px) drives `--radius-sm` 6px / `-md` 9px / `-lg` 12px /
  `-xl` 16.8px / `-2xl` 21.6px / `-3xl` 26.4px / `-4xl` 31.2px.
- Semantic extras beyond stock shadcn: `--success`, `--success-foreground`, `--warning`,
  `--warning-foreground` (usable as `bg-success`, `text-warning`, etc.).
- `--ease-out-quart|quint|expo` exist as raw CSS vars but are only referenced through
  literal framer-motion arrays in practice, e.g. `ease: [0.22, 1, 0.36, 1]`
  (`src/app/dashboard/page.tsx:271,288,304,340,401`).

### `src/app/dashboard/layout.tsx` (7 lines)
```tsx
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <AppShell>{children}</AppShell>
}
```
Server component (no `"use client"`).

### `src/components/layout/app-shell.tsx` (29 lines) — server component

```
<div className="min-h-dvh bg-background">
  <a href="#dashboard-main" data-dashboard-skip-link
     className="sr-only fixed left-4 top-4 z-[100] bg-primary px-4 py-3 text-sm font-semibold
                text-background focus:not-sr-only">Skip to fleet content</a>
  <Sidebar />
  <div data-dashboard-shell-content className="lg:pl-64">
    <ScopeBar />
    <main id="dashboard-main" tabIndex={-1}
          className="min-h-[calc(100dvh-6.5rem)] outline-none lg:min-h-[calc(100dvh-3rem)]">
      {children}
    </main>
  </div>
</div>
```
Sidebar reserve is **`lg:pl-64` = 16rem / 256px**. Mobile header is 3.5rem (h-14),
scope bar min 3rem — hence the `6.5rem` subtraction on small screens.

### `src/components/layout/nav.tsx` (49 lines) — `"use client"`

Top marketing/auth nav. **Returns `null` when `pathname.startsWith("/dashboard")`** (line 12),
so it never appears inside the console. Sticky, `h-12`, `max-w-7xl`, brand mark = a
`size-7 rounded-sm bg-primary` square with a bold `P`, then `Paprika` at
`text-sm font-semibold tracking-tight`. Right side: user name link + sign-out icon button.

### `src/components/layout/sidebar.tsx` (442 lines) — `"use client"` — LARGE

Desktop `<aside>` is `fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r
border-sidebar-border bg-sidebar lg:flex` (line 197). Mobile is a `h-14` sticky header
(line 178) plus a full focus-trapped drawer dialog (lines 204-238) at
`w-[min(20rem,calc(100vw-3rem))]`, `z-[60]`, backdrop `bg-background/80`,
`animate-in slide-in-from-left duration-300`.

**Navigation model (lines 36-59) — verbatim:**

| Section | Item | `href` | Icon | Notes |
|---|---|---|---|---|
| `Fleet` | `Overview` | `/dashboard` | `LayoutDashboard` | |
| `Fleet` | `Applications` | `/dashboard/applications` | `Rocket` | |
| `Delivery` | `Pipelines` | `/dashboard#pipelines` | `GitBranch` | hash anchor |
| `Delivery` | `Releases` | `/dashboard#releases` | `Package` | hash anchor |
| `Delivery` | `Rollouts` | `/dashboard/rollouts` | `Boxes` | |
| `System` | `Activity` | — | `Activity` | `disabled: true` |
| `System` | `Admin` | — | `Settings` | `disabled: true` |

Disabled items render as `<button disabled aria-disabled="true"
aria-label="{label}. Available in a later plan" title="Available in a later plan"`
with `cursor-not-allowed opacity-40` (lines 323-337).

Active detection is a hand-written `switch` on `item.label` (lines 352-370), combining
`pathname` + `window.location.hash` (hash tracked via a `hashchange` listener, lines 78-86).
Active style: `bg-sidebar-accent text-sidebar-accent-foreground` plus a left rail
`before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:bg-sidebar-primary`
(line 319). Icon gets `text-primary` when active (line 346).

Item base class (line 317): `relative flex min-h-11 w-full items-center gap-3 px-3 text-sm
font-medium transition-colors duration-150`. **`min-h-11` (44px) tap targets are used
everywhere in this codebase** — a deliberate a11y convention.

Section headings (lines 283-288): `mb-2 px-3 font-mono text-[0.625rem] font-medium
uppercase tracking-[0.18em] text-muted-foreground`, `<h2>` with
`id={"nav-" + section.label.toLowerCase()}`; `<nav aria-label="Fleet sections">`.

Brand block (lines 372-386): `h-16`, `border-b border-sidebar-border`, `px-5`;
`BrandMark` = `size-8 rounded-sm bg-primary text-xs font-bold text-primary-foreground` "P";
title `Paprika` (`text-sm font-semibold tracking-tight`) over subtitle
`Control plane` (`font-mono text-[0.5625rem] uppercase tracking-[0.14em] text-muted-foreground`).

Footnote (lines 405-441): when signed in, avatar square + display name +
`Authenticated` label + sign-out button. When signed out, `Operations console`
in `font-mono text-[0.5625rem] uppercase tracking-[0.14em]`.

Accessibility machinery worth preserving: `makeElementsInert()` (lines 248-267) toggles the
`inert` attribute on `[data-dashboard-skip-link]`, `[data-dashboard-shell-content]`, the
mobile header, and the desktop sidebar while the drawer is open; Tab-cycling and Escape
handled manually (lines 118-152); focus returns to the trigger on close (line 161).

### `src/components/layout/scope-bar.tsx` (34 lines) — server component

Entirely **static / hard-coded placeholder** (lines 3-7):
```ts
const scopeSegments = [
  { label: "Projects", value: "All projects", icon: Layers },
  { label: "Clusters", value: "All clusters", icon: Boxes },
  { label: "Stages",   value: "All stages",   icon: Rocket },
]
```
Container: `sticky top-14 z-30 border-b border-border bg-card lg:top-0`, inner
`flex min-h-12 items-stretch overflow-x-auto px-4 sm:px-6`.
Leading label: `Fleet scope` in `font-mono text-[0.625rem] font-medium uppercase
tracking-[0.16em] text-primary` inside a `border-r border-border pr-4` block.
Each segment: icon `size-3.5 text-muted-foreground`, `<span className="sr-only">{label}: </span>`,
value at `text-xs font-medium text-foreground`, `border-r border-border px-4 last:border-r-0`.

**It is NOT wired to the fleet query state.** No click handlers, no props, no reads of
`FleetQueryState`. This is the obvious hook point for a real scope picker.

---

## 3. UI primitives — `src/components/ui/*.tsx`

Provenance: **shadcn/ui with `"style": "base-nova"`** (`components.json:3`) on top of
**`@base-ui/react`** (not Radix). `components.json` also sets `"iconLibrary": "lucide"`,
`"baseColor": "neutral"`, `"cssVariables": true`, `"rsc": true`, `"menuColor": "default"`,
`"menuAccent": "subtle"`, aliases `@/components`, `@/lib/utils`, `@/components/ui`,
`@/lib`, `@/hooks`.

`src/lib/utils.ts` (6 lines) — the only class helper:
```ts
import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }
```

### `button.tsx` (58) — CVA, `@base-ui/react/button`, no `"use client"`

Base (line 7):
```
group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent
bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none
focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50
active:not-aria-[haspopup]:scale-[0.96] active:not-aria-[haspopup]:translate-y-px
disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive
aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50
dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0
[&_svg:not([class*='size-'])]:size-4
```

`variant` (default = `"default"`):
- `default` — `bg-primary text-primary-foreground hover:bg-primary/80`
- `outline` — `border-border bg-background hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50`
- `secondary` — `bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:…`
- `ghost` — `hover:bg-muted hover:text-foreground aria-expanded:… dark:hover:bg-muted/50`
- `destructive` — `bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40` (**tinted, not solid**)
- `link` — `text-primary underline-offset-4 hover:underline`

`size` (default = `"default"`): `default` `h-8 gap-1.5 px-2.5` · `xs` `h-6 gap-1 px-2 text-xs`
(radius `min(var(--radius-md),10px)`, svg `size-3`) · `sm` `h-7 gap-1 px-2.5 text-[0.8rem]`
(radius `min(var(--radius-md),12px)`, svg `size-3.5`) · `lg` `h-9 gap-1.5 px-2.5` ·
`icon` `size-8` · `icon-xs` `size-6` · `icon-sm` `size-7` · `icon-lg` `size-9`.
Sizes react to `has-data-[icon=inline-end]` / `has-data-[icon=inline-start]` for asymmetric
padding, and to `in-data-[slot=button-group]` for radius.

Exports `{ Button, buttonVariants }`. Renders `data-slot="button"`.

### `card.tsx` (103) — plain `div`s + `cn`, no CVA, no `"use client"`

`Card` (line 15) is driven by a CSS var `--card-spacing`:
```
group/card flex flex-col gap-(--card-spacing) overflow-hidden rounded-2xl bg-card
py-(--card-spacing) text-sm text-card-foreground ring-1 ring-foreground/10
[--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0
data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0
*:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl
```
Prop `size?: "default" | "sm"` → `data-size`. **Cards use `ring-1 ring-foreground/10`, not
`border`** — this is the house surface treatment, repeated on ad-hoc divs across the app.

Sub-parts: `CardHeader` (grid, `@container/card-header`, `gap-1`, `px-(--card-spacing)`,
`has-data-[slot=card-action]:grid-cols-[1fr_auto]`), `CardTitle`
(`font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm`),
`CardDescription` (`text-sm text-muted-foreground`), `CardAction`
(`col-start-2 row-span-2 row-start-1 self-start justify-self-end`),
`CardContent` (`px-(--card-spacing)`),
`CardFooter` (`flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)`).

Note `CardTitle` uses `font-heading`, a token **not defined in globals.css** — it silently
falls back to the inherited sans.

### `badge.tsx` (52) — CVA + `useRender`/`mergeProps` from `@base-ui/react`

Base (line 8): `group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1
overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium
whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px]
focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5
aria-invalid:… [&>svg]:pointer-events-none [&>svg]:size-3!`

Fixed **`h-5` (20px), `rounded-4xl` (≈31px → pill)**.
Variants: `default` (`bg-primary text-primary-foreground`), `secondary`, `destructive`
(`bg-destructive/10 text-destructive`), `outline` (`border-border text-foreground`),
`ghost`, `link`. Polymorphic via a `render` prop (`useRender`), state `{ slot: "badge", variant }`.

### `separator.tsx` (25) — `"use client"`, `@base-ui/react/separator`
`shrink-0 bg-border data-horizontal:h-px data-horizontal:w-full data-vertical:w-px
data-vertical:self-stretch`.

### `status-badge.tsx` (89) — the app's status vocabulary. No CVA; a `Record` lookup + `Badge`.

`statusConfig` (lines 17-70) — **exact keys, icons, classes:**

| status | icon | className |
|---|---|---|
| `Running` | `Loader2` | `bg-primary/10 text-primary border-primary/20 [&_svg]:animate-spin` |
| `Succeeded` | `CheckCircle2` | `bg-success/10 text-success border-success/20` |
| `Failed` | `XCircle` | `bg-destructive/10 text-destructive border-destructive/20` |
| `Pending` | `Clock` | `bg-warning/10 text-warning border-warning/20` |
| `Promoting` | `ArrowUpFromLine` | `bg-primary/10 text-primary border-primary/20` |
| `Verifying` | `ShieldCheck` | `bg-blue-500/10 text-blue-400 border-blue-500/20` |
| `Complete` | `CheckCheck` | `bg-success/10 text-success border-success/20` |
| `RolledBack` | `RotateCcw` | `bg-orange-500/10 text-orange-400 border-orange-500/20` |
| `Progressing` | `Activity` | `bg-primary/10 text-primary border-primary/20 [&_svg]:animate-pulse` |
| `AwaitingApproval` | `PauseCircle` | `bg-warning/10 text-warning border-warning/20` |
| `Paused` | `PauseCircle` | `bg-warning/10 text-warning border-warning/20` |
| `Healthy` | `HeartPulse` | `bg-success/10 text-success border-success/20` |
| `Degraded` | `AlertOctagon` | `bg-orange-500/10 text-orange-400 border-orange-500/20` |

Unknown status → `<Badge className="bg-muted text-muted-foreground border-border/50">{status}</Badge>`.
Known → `<Badge className={"gap-1.5 " + config.className}><Icon className="size-3" />{status}</Badge>`.
**Note it composes via a template literal, not `cn()`** (line 84) — the only primitive that
does. Also note `Verifying`/`RolledBack`/`Degraded` reach outside the token palette into raw
Tailwind `blue-500` / `orange-500`.

### `table.tsx` (116) — `"use client"`, plain elements + `cn`

`Table` wraps in `<div data-slot="table-container" className="relative w-full overflow-x-auto">`;
`table` is `w-full caption-bottom text-sm`.
`TableHeader` `[&_tr]:border-b` · `TableBody` `[&_tr:last-child]:border-0` ·
`TableFooter` `border-t bg-muted/50 font-medium [&>tr]:last:border-b-0` ·
`TableRow` `border-b transition-colors hover:bg-muted/50 has-aria-expanded:bg-muted/50
data-[state=selected]:bg-muted` ·
`TableHead` `h-10 px-2 text-left align-middle font-medium whitespace-nowrap text-foreground` ·
`TableCell` `p-2 align-middle whitespace-nowrap` ·
`TableCaption` `mt-4 text-sm text-muted-foreground`.

**There is no `input`, `select`, `dialog`, `tabs`, `tooltip`, `dropdown`, `checkbox`, or
`skeleton` primitive.** Every one of those is hand-rolled inline where needed (see §4/§6).

---

## 4. Feature components

### `src/components/dashboard/*` (16 components)

| File | Lines | What it renders |
|---|---|---|
| `dashboard-command-center.tsx` | **668** ⚠ | Big rounded-2xl panel "Cluster command center": left = search box + recent searches + result list; right = "Application health map" with health filter pills and namespace-grouped heatmap tiles. |
| `application-card.tsx` | **567** ⚠ | Rich per-application card (phase timeline, source info, health checks, resource sync/health lists, sync button, stage pills, approval gate button, analysis + policy summaries). **UNUSED — no importers.** |
| `resource-detail-panel.tsx` | **553** ⚠ | Right-hand slide-over (`max-w-2xl`) for one K8s resource: header chips + 5 tabs (Diff/Live/Desired/Events/Logs), streaming logs with reconnect, opens `InvestigationPanel`. |
| `investigation-triage.tsx` | **361** ⚠ | Card "Investigation Triage" — ranked degraded resources with auto-run investigation, per-row run results, "Additional signals" grid. |
| `investigation-panel.tsx` | **313** ⚠ | Modal/panel showing one investigation's findings. |
| `resource-list-table.tsx` | 272 | TanStack Table tree of managed resources (expander, Kind, Name, Namespace, Sync, Health, Ready). Also exports `buildTree`, `mergeResourcesFromApplication`, `MergedResource`, `FlatTreeNode`. |
| `sync-diff-view.tsx` | 269 | Unified-diff parser + renderer (`summarizeUnifiedDiff`, `parseUnifiedDiff`, `SyncDiffView`, `DiffLineRow`, `DiffStat`). |
| `sync-diff-workbench.tsx` | 237 | Card "Sync Diff": 4 metrics + 6 filter pills + a 4-column drift table. |
| `application-release-history.tsx` | 193 | Card "Release History" — paginated `Table` of releases + rollback buttons. |
| `resource-graph.tsx` | 180 | `@xyflow/react` node-graph of the resource tree. |
| `release-table.tsx` | 157 | `ReleaseGrid` of release cards + `PolicySummary`. **UNUSED.** |
| `rollout-debug-panel.tsx` | 142 | "Strategy Plan" step list + "Routing And Analysis" panel for a Rollout. |
| `pipeline-card.tsx` | 123 | Pipeline summary `Card`: name/ns/duration, progress bar, per-step icon list. |
| `artifact-card.tsx` | 122 | Artifact chip card (digest truncation, phase class, copy-ref). |
| `step-detail-panel.tsx` | 111 | Right column of pipeline detail: step name, status, logs, Retry/Skip, artifacts. |
| `pipeline-dag.tsx` | 96 | Dagre-laid-out `ReactFlow` DAG of pipeline steps. |
| `pipeline-dag-node.tsx` | 55 | `memo`'d custom node for the DAG (imported by `pipeline-dag.tsx` via relative `"./pipeline-dag-node"`). |

### `src/components/fleet/*` (10 components + 2 pure modules)

| File | Lines | What it renders |
|---|---|---|
| `fleet-filters.tsx` | **786** ⚠ | The whole fleet query control surface: search input, 4-way Presentation toggle, canvas controls, active-filter chips, `<details>` "Filter dimensions" with 9 facet groups. |
| `fleet-treemap.tsx` | **454** ⚠ | Canvas-rendered treemap with keyboard navigation, tooltip, zoom, reduced-motion handling. |
| `fleet-view.tsx` | **391** ⚠ | Orchestrator for `/dashboard/applications`: URL↔state reconciliation, focus coordinator, header, and presentation switch. |
| `application-table.tsx` | 372 | Virtualized 6-column ARIA grid of applications + shared exports `ApplicationCapabilityActions`, `FleetLoadMore`, `useApplicationFocusAdapter`, `applicationKey`, `identityKey`, `releaseFocusOwnership`, `observeMeasuredElementRect`. |
| `fleet-overview.tsx` | **344** ⚠ | The `/dashboard` hero: health posture strip, change surface, dependency posture, top-5 attention list. |
| `attention-queue.tsx` | 156 | Virtualized ranked `<ol>` queue (rank number, identity, Health/Drift/Blocked mini-grid, actions). |
| `fleet-matrix.tsx` | 129 | Sparse row×column comparison table with health chips. |
| `fleet-states.tsx` | 91 | `FleetStateNotice` — the 7 empty/loading/error states. |
| `treemap-layout.ts` | 165 | Pure squarified-treemap layout + hit-testing + motion resolution. |
| `treemap-navigation.ts` | 68 | Pure arrow-key navigation over treemap rectangles. |

### `src/components/notifications/*`

| File | Lines | What it renders |
|---|---|---|
| `notification-center.tsx` | 169 | Bell button + unread badge + 320px dropdown of last 20 parsed events. **UNUSED — no importers.** |
| `toast-stack.tsx` | 53 | Fixed bottom-right stack of up to 5 toasts, 8s auto-dismiss, fires on `Failed`/`Degraded`/`RolledBack`/`Complete` phases. Used only by `/dashboard` (`page.tsx:26,442`). |

### `src/components/landing/*` — 6 files (`hero` 98, `features` 141, `comparison` 129,
`cta` 63, `how-it-works` 154, `pipeline-visualization` 135). **ALL UNUSED** — nothing imports
`components/landing`. Dead marketing code.

### Files >300 lines (flagged)

```
786  src/components/fleet/fleet-filters.tsx
786  src/app/dashboard/application/page.tsx
668  src/components/dashboard/dashboard-command-center.tsx
567  src/components/dashboard/application-card.tsx      (unused)
553  src/components/dashboard/resource-detail-panel.tsx
478  src/app/dashboard/page.tsx
454  src/components/fleet/fleet-treemap.tsx
442  src/components/layout/sidebar.tsx
391  src/components/fleet/fleet-view.tsx
372  src/components/fleet/application-table.tsx
361  src/components/dashboard/investigation-triage.tsx
344  src/components/fleet/fleet-overview.tsx
314  src/app/dashboard/rollouts/detail/page.tsx
313  src/components/dashboard/investigation-panel.tsx
```

---

## 5. Config / conventions that constrain new code

### `components.json`
```json
{ "$schema": "https://ui.shadcn.com/schema.json", "style": "base-nova", "rsc": true,
  "tsx": true,
  "tailwind": { "config": "", "css": "src/app/globals.css", "baseColor": "neutral",
                "cssVariables": true, "prefix": "" },
  "iconLibrary": "lucide", "rtl": false,
  "aliases": { "components": "@/components", "utils": "@/lib/utils", "ui": "@/components/ui",
               "lib": "@/lib", "hooks": "@/hooks" },
  "menuColor": "default", "menuAccent": "subtle", "registries": {} }
```
- `"config": ""` → **there is no `tailwind.config.*`.** All theming is CSS-first via
  `@theme inline` in `globals.css`. New tokens go there.
- `"rsc": true` — new shadcn components arrive without `"use client"` unless needed.
- `@/hooks` alias is declared but **`src/hooks/` does not exist**.

### `next.config.ts` — see §1. `output: "export"`, `trailingSlash: true`, `distDir: "out"`,
`basePath` from `PAPRIKA_BASE_PATH` (GH Pages build uses `/paprika`).

### `postcss.config.mjs`
```js
const config = { plugins: { "@tailwindcss/postcss": {} } }
```
Tailwind v4 only. No autoprefixer entry.

### `eslint.config.mjs`
Flat config: `eslint-config-next/core-web-vitals` + `eslint-config-next/typescript`,
with `globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts"])`.
Note the `react-hooks/set-state-in-effect` rule is active — the codebase disables it inline
in 4 places (`applicationsets/page.tsx:62`, `applicationsets/detail/page.tsx:67`,
`pipelines/detail/page.tsx:66`, `fleet-view.tsx:118`).

### `tsconfig.json`
`target: ES2017`, `strict: true`, `noEmit`, `module: esnext`, `moduleResolution: bundler`,
`isolatedModules`, `jsx: react-jsx`, plugin `next`, path alias `"@/*" → "./src/*"`.
Includes `**/*.ts`, `**/*.tsx`, `**/*.mts`, `.next/types`, `out/types`. Excludes `node_modules`.

### `package.json` scripts
`dev` `next dev` · `build` `next build` · `build:gh-pages` `PAPRIKA_BASE_PATH=/paprika next build` ·
`start` · `lint` `eslint` · `test` `vitest run` · `test:e2e` `playwright test` ·
`test:watch` `vitest` · `generate` `cd .. && buf generate`.

Dependency notes relevant to new UI: `@base-ui/react ^1.5.0`, `class-variance-authority ^0.7.1`,
`clsx`, `tailwind-merge ^3.6.0`, `tw-animate-css ^1.4.0`, `lucide-react ^1.17.0`,
`framer-motion ^12.40.0`, `@tanstack/react-query|react-table|react-virtual`,
`@xyflow/react`, `@dagrejs/dagre`, `d3-hierarchy`, `shadcn ^4.10.0`.

### `vitest.config.mts`
`include: ["src/**/*.{test,spec}.{ts,tsx}"]`, `environment: "happy-dom"`,
`setupFiles: ["./src/test-setup.ts"]`, `globals: true`, `css: false`, alias `@ → ./src`.
`src/test-setup.ts` is one line: `import "@testing-library/jest-dom/vitest"`.

### `playwright.config.ts`
`testDir: "./e2e"`, `timeout 45s`, `baseURL http://127.0.0.1:3100`, desktop viewport
1920×1080, webServer runs `./bin/fleet-console-fixture --listen 127.0.0.1:3100
--assets ui/out --applications 250` (skippable with `PLAYWRIGHT_NO_WEBSERVER=1`),
health-checked at `${baseURL}/readyz`. Projects include a
`chromium-reduced-motion` and a `chromium-keyboard-only` profile.

E2E asserts on **accessible names**, so labels are contractual. Sampling
`e2e/fleet-console.spec.ts`: `heading level 1 "Applications"`,
`navigation "Fleet sections"`, `table "Applications"`, `table "Fleet matrix"`,
`summary` containing `"Filter dimensions"`, `checkbox "Project <ns/name>"`,
`searchbox "Search applications"`, `application "Fleet treemap"`,
`button "Show Matrix view"` / `"Show Table view"`, `button "Load 100 more applications"`,
`region "Highest impact attention"`, and on the detail page `text "Current Phase"`.

---

## 6. House code style

**Quoting / semicolons — the codebase is split into two dialects:**
- **Majority dialect (no semicolons, double quotes).** Everything under
  `src/components/**`, `src/lib/**`, `src/app/layout.tsx`, `src/app/page.tsx`,
  `src/app/login/page.tsx`, `src/app/auth/callback/page.tsx`, `src/app/dashboard/page.tsx`,
  `src/app/dashboard/applications/page.tsx`, `src/app/dashboard/pipelines/detail/page.tsx`.
- **Minority dialect (semicolons).** Exactly 5 files, all older route pages:
  `src/app/dashboard/application/page.tsx`, `rollouts/page.tsx`, `rollouts/detail/page.tsx`,
  `applicationsets/page.tsx`, `applicationsets/detail/page.tsx`.

Double quotes for strings everywhere; trailing commas in multi-line literals; 2-space indent.
**Prefer the no-semicolon dialect for new code** — it is what all components use.

**`"use client"`** — 49 files carry it, as the first line, double-quoted, followed by a blank
line. Server components (no directive): `app-shell.tsx`, `scope-bar.tsx`, `dashboard/layout.tsx`,
`dashboard/applications/page.tsx`, and the pure-presentational
`ui/badge|button|card|status-badge`, `dashboard/application-card|pipeline-card|release-table`,
`fleet/fleet-matrix|fleet-overview|fleet-states`.

**className composition — mixed, and this matters:**
- `cn()` from `@/lib/utils` is imported by only **9 files**: all 5 `ui/*` primitives that need it
  (`badge`, `button`, `card`, `separator`, `table`) plus `layout/sidebar.tsx`,
  `fleet/application-table.tsx`, `fleet/fleet-filters.tsx`, `fleet/fleet-matrix.tsx`,
  `dashboard/artifact-card.tsx`.
- Everywhere else uses **template literals** for conditional classes, e.g.
  `` className={`... ${isActive ? "border-b-2 border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`} `` (`resource-detail-panel.tsx:157-159`),
  `` `mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}` `` (every Refresh button).
- New code should prefer `cn()`; both are accepted precedent.

**Other recurring idioms:**
- Tap targets: `min-h-11` / `size-11` on interactive elements throughout the fleet + layout code.
- Eyebrow labels: `font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em]`
  (or `tracking-[0.18em]` / `tracking-[0.14em]`), coloured `text-primary` or `text-muted-foreground`.
- Numbers: `tabular-nums`, often with `font-mono`.
- Surfaces: `rounded-xl`/`rounded-2xl bg-card ring-1 ring-foreground/10` for elevated cards on
  `/dashboard`; **flat `border border-border bg-card` with square corners** in the fleet views
  (`fleet-overview.tsx`, `fleet-filters.tsx`, `application-table.tsx`) — the two areas have
  visibly different visual languages today.
- Error banner pattern (repeated verbatim in 5 route files):
  `className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive"`.
- Skeleton pattern: locally-defined `function SkeletonCard()` in each route file (5 near-duplicates),
  built from `bg-muted animate-pulse` blocks.
- `role="status" aria-live="polite"` on loading/notice regions; `role="alert"` +
  `aria-live="assertive"` for errors (`fleet-states.tsx:70-72`).
- Motion: `framer-motion` `motion.div/section` with `initial={{ opacity: 0, y: 8 }}`,
  `animate={{ opacity: 1, y: 0 }}`, `transition={{ duration: 0.3, delay: 0.04…0.3,
  ease: [0.22, 1, 0.36, 1] }}` — only on `/dashboard`.
- `data-testid` used sparingly: `navigation-backdrop`, `fleet-load-more-sentinel`,
  `sync-diff-workbench`, `investigation-triage`, `resource-list-table`, `open-investigation`.
- Data attributes as shell contracts: `data-dashboard-skip-link`,
  `data-dashboard-shell-content`, `data-dashboard-mobile-header`,
  `data-dashboard-desktop-sidebar`, `data-fleet-ready`, `data-preserve-fleet-focus`.

**Test file placement / naming — two conventions coexist:**
1. **Co-located** `<component>.test.tsx` next to the source. This is the dominant one
   (all 13 `src/components/dashboard/*.test.tsx`, all 7 `src/components/fleet/*`,
   `src/components/layout/app-shell.test.tsx`, all 9 `src/lib/*.test.ts(x)`,
   and `src/app/dashboard/application/page.test.tsx`).
2. **`__tests__/` folders** for route-level tests:
   `src/app/dashboard/__tests__/{dashboard-refresh,pipeline-dag,pipeline-refresh,step-detail-panel}.test.tsx`
   and `src/app/dashboard/pipelines/detail/__tests__/page.test.tsx`.

E2E lives in `/e2e/*.spec.ts` (`fleet-console.spec.ts`, `fleet-scale.spec.ts`).

---

## 7. Data layer (context for anything new)

- `src/lib/transport.ts` (35) — `"use client"`. `createTransport()` returns a
  `createConnectTransport({ baseUrl: "" })` whose `fetch` injects
  `Authorization: Bearer <localStorage["paprika_id_token"]>` and, on HTTP 401, clears
  `paprika_id_token` + `paprika_auth_user` and hard-redirects to `/login/`.
- Route pages instantiate **module-scope** clients:
  ```ts
  const transport = createTransport()
  const client = createPromiseClient(PaprikaService, transport)
  ```
  from `@/gen/paprika/v1/api_connect` + `@/gen/paprika/v1/api_pb`
  (generated JS/d.ts, produced by `npm run generate` → `buf generate`; not TS source).
- `src/lib/query-provider.tsx` (42) — TanStack Query client with `staleTime: 30_000`,
  `gcTime: 600_000`, `retry: 2`, `refetchOnWindowFocus: false`, `refetchOnReconnect: true`,
  mutations `retry: false`; singleton `getBrowserQueryClient()`.
  **Despite being mounted in the root layout, almost no feature code uses `useQuery`** — the
  pages fetch with `useState` + `useCallback` + the refresh hooks below.
- `src/lib/fleet-refresh.ts` (169) — `FLEET_REFRESH_INTERVAL_MS = 60_000`,
  `FOCUSED_REFRESH_INTERVAL_MS = 15_000`, `MAX_REFRESH_INTERVAL_MS = 120_000`;
  exports `useBoundedRefresh`, `useFleetRefresh`, `useFocusedRefresh`, `useSingleFlightRefresh`
  (backoff + visibility/focus aware).
- `src/lib/connection-context.tsx` (67) — `useConnection()` gives
  `{ connected, online, lastRequestSucceeded, reportRequestOutcome, setConnected (deprecated),
  events (deprecated, always `EMPTY_EVENTS`) }`. **Push events are disabled**, so
  `ToastStack` and `NotificationCenter` currently render nothing.
- `src/lib/use-fleet-data.ts` (595), `fleet-client.ts` (720), `fleet-pages.ts` (74),
  `fleet-focus.ts` (212) — fleet indexing, pagination, and focus-management layer.
- `src/lib/auth-context.tsx` (154) — `useAuth()` → `{ user, isLoading, login, logout }`,
  plus exported `persistAuth`, `consumeReturnTo`.

---

## 8. Fleet URL-state contract (`src/lib/fleet-query.ts`, 500 lines)

This is the only place in the app where UI state lives in the URL, and it is thoroughly
specified — any redesign of `/dashboard/applications` must keep it.

**Query parameter names** (repeatable ones append; scalars use `set`, and are omitted when
equal to the default):

| Param | Kind | Values |
|---|---|---|
| `project` | repeatable | `namespace/name` |
| `cluster` | repeatable | `namespace/name` |
| `stage` | repeatable | free string (canonicalized) |
| `namespace` | repeatable | free string |
| `health` | repeatable | `healthy` `progressing` `degraded` `failed` `unknown` `missing` |
| `sync` | repeatable | `synced` `out_of_sync` `unknown` |
| `release` | repeatable | `pending` `promoting` `canarying` `verifying` `complete` `failed` `rolled_back` `superseded` `awaiting_approval` |
| `rollout` | repeatable | `pending` `progressing` `paused` `healthy` `degraded` `failed` `rolled_back` `aborted` |
| `source` | repeatable | `git` `helm` `kustomize` `s3` `oci` `inline` |
| `q` | scalar | free text (default `""`) |
| `sort` | scalar | `name`(def) `project` `cluster` `stage` `health` `sync` `release` `rollout` `resource_count` `last_transition` `impact` `relevance` |
| `direction` | scalar | `asc`(def) `desc` |
| `view` | scalar | `treemap`(def) `matrix` `table` `queue` |
| `group` | scalar | `project`(def) `cluster` `stage` `health` |
| `rows` | scalar | `project`(def) … |
| `columns` | scalar | `cluster`(def) … |
| `size` | scalar | `resource_count`(def) `request_rate` |
| `zoom` | scalar | free string (default `""`) |
| `selected` | scalar | `namespace/name` |
| `range` | scalar | `15m` `30m` `1h` `2h`(def) `6h` `12h` `24h` `3d` `7d` |

`parseFleetQuery` → `{ state, notices }`; `serializeFleetQuery` → `URLSearchParams`;
`mergeFleetQuery(current, patch)`; `reconcileFleetQuery(state, availability)` drops values the
server's facets no longer offer. Notice copy (with curly quotes) is verbatim:
`Dropped invalid ${field} value “${value || "(empty)"}”.` and
`Removed unavailable ${field} value “${value}”.`
`FleetView` writes canonical URLs with `router.replace(..., { scroll: false })`
(`fleet-view.tsx:70-76,124-134`).

Presentation toggle labels/tooltips (`fleet-filters.tsx:53-58`) — verbatim:
`Treemap` / "Relative fleet footprint"; `Matrix` / "Cross-scope comparison";
`Table` / "Sortable inventory"; `Queue` / "Highest impact first".
Selecting `table` also patches `sort: "name", direction: "asc"`; selecting `queue` patches
`sort: "impact", direction: "desc"` (lines 133-142).
Group/size select labels: `Group treemap by`, `Matrix rows`, `Matrix columns`,
`Size applications by`; option labels `Project`/`Cluster`/`Stage`/`Health` and
`Resource count`/`Request rate`.
Filter group legends, in DOM order: `Project`, `Cluster`, `Stage`, `Namespace`, `Health`,
`Sync`, `Release`, `Rollout`, `Source`.
Search field: label `Search fleet`, `aria-label="Search applications"`, `type="search"`,
placeholder `Application, project, cluster, revision…`, 250 ms debounce (line 91).

---

## 9. Verbatim label/column inventory (for diffing against the new design)

### `/dashboard` — `src/app/dashboard/page.tsx`
- `<h1 className="sr-only">Dashboard</h1>` (line 250).
- StatCards, in order (lines 290-296): `Pipelines`, `Running`, `Succeeded`, `Failed`,
  `Applications`, `Rollouts` (rendered `{active}/{total}`), `App Sets`.
  Grid: `grid gap-3 sm:grid-cols-3 lg:grid-cols-7`.
  Tile: `rounded-xl bg-card p-4 ring-1 ring-foreground/10`, icon chip
  `size-9 rounded-lg bg-primary/8 text-primary`, label
  `text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70`,
  value `text-xl font-semibold tracking-tight tabular-nums`.
- Section headings `Pipelines` / `Application Sets` / `Policies` at `text-sm font-semibold`,
  each with a `{n} total` counter in `text-xs text-muted-foreground tabular-nums`.
- Empty states: `No pipelines yet` / "Create a Pipeline resource in any namespace to get
  started"; `No application sets yet` / "Create an ApplicationSet resource to generate
  Applications from templates"; `No policies yet` / "Create a Policy resource to guard
  applies with CEL rules".
- Error boundary copy: `Something went wrong` / "An unexpected error occurred. Try
  refreshing the page." Suspense fallback: `Loading operations overview…`.
- `DASHBOARD_RELEASE_SEARCH_LIMIT = 100` (line 41).

### `FleetOverview` — `src/components/fleet/fleet-overview.tsx`
Eyebrow `Authorized fleet` → `<h2>Operations overview</h2>` (`text-2xl … sm:text-3xl`);
CTA `Open application inventory`.
Panels: `Fleet health posture` (+ `{total} applications`), 6 cells in
`healthOrder = healthy, progressing, degraded, failed, missing, unknown`, grid
`grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-px bg-border`.
`Change surface` / `Active delivery changes` → `Active releases`, `Active rollouts`,
`Blocked gates`.
`Dependency posture` / `Connection failures` → `Repository failures`, `Cluster failures`,
`Observability failures`.
`Server-ranked impact` / `Highest impact attention` (max 5) + link `Open full queue`;
empty copy `No applications currently require attention.`
Footnotes: "{n} highest-impact applications loaded; blocked-gate count reflects this window."
and "…connection counts reflect this window. Observability sources that are not configured
are absent, not failed."

### `FleetStateNotice` — `src/components/fleet/fleet-states.tsx` (all 7 verbatim)
| status | title | detail | role |
|---|---|---|---|
| `loading` | Loading fleet data | Reading the current application index. | status |
| `empty` | No applications match this scope | Adjust a filter or search term to widen the operational view. | status |
| `unauthorized` | You do not have access to this fleet scope | The index excludes applications outside your authorized projects. | alert |
| `unavailable` | Fleet index unavailable | The deployment index is not ready. Existing application routes remain available. | alert |
| `stale` | Showing previous fleet data | The requested presentation is loading; this snapshot may be out of date. | status |
| `partial` | Some applications could not be loaded | Loaded rows remain available. Retry the next page when the service recovers. | status |
| `error` | Fleet query failed | Paprika could not complete this query. Your URL scope has been preserved. | alert |
`ready` renders `null`. `stale`/`partial` use the compact inline variant.

### `ApplicationTable` — 6 columns, `role="table"` `aria-label="Applications"`
Grid template (header line 75, rows line 127):
`minmax(15rem,1.5fr) minmax(9rem,1fr) 8rem 8rem 7rem minmax(10rem,1fr)`, `gap-3`,
scroller `h-[min(62vh,42rem)] min-h-80`, min width `58rem`, row estimate 76px.
Headers, in order: `Application`, `Target`, `Health`, `Sync`, `Resources`,
`Authorized actions`.
Fallback cell copy: `Unnamed application`, `Identity unavailable`, `No target`,
`Stage unknown`.
Capability buttons (`ApplicationCapabilityActions`, lines 184-189) — all currently
`disabled` with `title="Open the application detail to perform this authorized action"`:
`application_sync`→`Sync`, `release_rollback`→`Rollback`, `gate_approve`→`Approve`,
`pipeline_retry`→`Retry`.
`FleetLoadMore`: `{loaded} loaded / {total} indexed`, button
`Load next 100` / `Loading next 100…` (`aria-label="Load 100 more applications"`),
exhausted copy `End of authorized results`.

### `AttentionQueue`
Eyebrow `Server-ranked impact`, body "The fleet service orders this queue. Every page remains
in authoritative server order." Row grid `3rem minmax(16rem,1fr) minmax(12rem,0.8fr)
minmax(10rem,1fr)`, `gap-4`, estimate 116px; rank is `String(i+1).padStart(2, "0")` in
`font-mono text-lg font-semibold tabular-nums text-primary`; mini-grid labels
`Health`, `Drift`, `Blocked`.

### `FleetMatrix`
Eyebrow `Sparse comparison` → `<h2>Fleet matrix</h2>`; meta line
`{total} applications · {n} populated cells · generation {indexGeneration}`.
Columns: `Row`, `Column`, `Applications` (right), `Targets` (right), `Health`.
Empty: `No populated intersections` / "Adjust the fleet scope or choose different row and
column dimensions." Cell footnote `Traffic unavailable · sized by resources`.
`healthTone` map (lines 11-19) is token-based: healthy→success, progressing/degraded→warning,
failed/missing→destructive, unknown/unspecified→muted.

### `FleetTreemap` — `HEALTH_STYLE` uses **literal hex** (lines 40-51), the only such map:
```
healthy      fill #273126  border #70906a  glyph ✓  label Healthy
progressing  fill #332e22  border #b8904b  glyph ↻  label Progressing
degraded     fill #382922  border #c77752  glyph !  label Degraded
failed       fill #382324  border #bd5c5c  glyph ×  label Failed
unknown      fill #2b2926  border #827b73  glyph ?  label Unknown
missing      fill #292623  border #776f67  glyph ∅  label Missing
unspecified  fill #292724  border #716b64  glyph ·  label Unspecified
```
`DEFAULT_VIEWPORT = { width: 960, height: 520 }`; nav keys ArrowLeft/Right/Up/Down/Home/End.
Accessible name is `application "Fleet treemap"`.

### `DashboardCommandCenter`
Container `overflow-hidden rounded-2xl bg-card shadow-sm ring-1 ring-foreground/10`;
two-column body `lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)]`.
Title `Cluster command center` (`text-xl font-semibold tracking-tight`), subtitle
"Search applications, releases, rollouts, pipelines, and policies from one control surface,
then drill into app health."
Header chips: `{n} healthy` (emerald) and `{n} needs attention` (muted).
Search input: `h-14 rounded-xl border border-border bg-background pl-10 pr-4 font-mono
text-base`, placeholder `Search apps, releases, rollouts, pipelines, policies...`,
`role="searchbox"` `aria-label="Search operations"`.
`Latest searches` row; empty `No recent searches`. `localStorage` key
`paprika-dashboard-recent-searches`, `MAX_RECENT_SEARCHES = 5`, `MAX_SEARCH_RESULTS = 8`.
`Search results` heading + `{shown}/{total}` counter; idle state
`Start with a name, namespace, or status` / "Results can open app drilldowns, rollout detail,
pipeline detail, and policy anchors."; empty `No matches` / "Try an app name, namespace,
phase, rollout, or policy."
Right column: `Application health map` (icon `Workflow`), subtitle "Filter by status, then
open an app tile for the full debug view.", chip `{n} apps` or `{n}/{total} apps loaded`.
Filter pills `healthFilters = All, Healthy, Degraded, Progressing, OutOfSync, Unknown`
with labels `All/Healthy/Degraded/Progressing/Out of sync/Unknown`; selected pill is
`bg-foreground text-background`.
`healthStyles` dots: Healthy `emerald-500`, Degraded `rose-500`, Progressing `sky-500`,
OutOfSync `amber-500`, Unknown `muted-foreground`.
Tiles grouped by namespace (`font-mono text-xs font-semibold` header + `{n} app(s)`),
grid `grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2`.
Empty: `No applications in this view` / "Change the health filter to inspect another status."
`SearchKind` union: `Application | Pipeline | Release | Rollout | Application Set | Policy`.

### `/dashboard/application` — `src/app/dashboard/application/page.tsx`
Breadcrumb `Dashboard › {name}`; `<h1 className="text-3xl font-bold tracking-tight">`,
namespace subtitle, `Refresh` outline button.
4 summary cards: `Current Phase` (+ "Strategy: …"), `Current Release`
(+ target or "No active release"), `Policy Results` (+ "Failures present" / "All passed" /
"No policies evaluated"), `Release History` (+ "Releases tracked for this application").
Then `InvestigationTriage`, `SyncDiffWorkbench`, then:
- **Managed Resources** card — description "{n} resource(s) · {x} out of sync · {y} pruned";
  segmented toggle `Graph` (icon `Network`) / `List` (icon `List`) in
  `rounded-lg bg-muted/40 p-0.5 ring-1 ring-foreground/5`, active pill
  `bg-card text-foreground shadow-sm`.
- **Health Checks** card (`Stethoscope`), "CEL-based health check results."
  Columns: `Name`, `Status`, `HTTP`, `Message`, `Checked`.
- **Promotion Stages** card (`Layers`), "Per-stage ring, release, and phase breakdown."
  Stage pill shows ring number in a `size-5 rounded-full` badge.
- **Approval Gates** card (`ShieldAlert`), "Gates that must pass before promotion continues."
  Columns: `Name`, `Stage`, `Type`, `Status`, `Message`, `Actions` (right) with
  `Approve` (outline sm) / `Reject` (ghost sm) shown only when `gate.status === "Pending"`.
- `ApplicationReleaseHistory`.
- **Current Policy Results** card (`ShieldCheck`). Columns: `Policy`, `Result`
  (`pass`/`fail` Badge), `Severity`, `Action`, `Message`.
- **Source** card (`LayoutGrid`) — `DetailRow`s separated by `<Separator />`:
  `Repository URL`, `Path`, `Revision`, `Sync Policy` (fallback `Disabled`), `Strategy`.
- **Conditions** card (`Activity`) — type / status Badge / reason / message.
- **Analysis Results** card (`Activity`), "Continuous analysis checks for this application."
  Columns: `Template`, `Phase`, `Passed`, `Message`, `Checked`.
- `ResourceDetailPanel` slide-over when a resource is selected.
Not-found copy: `Application not found.`; error `Failed to load application details`.
`PolicySeverityBadge`: `critical`→destructive, `warning`→default, else secondary.
`HealthCheckBadge`: Healthy→default/emerald-500, Degraded→destructive, Progressing→
secondary/amber-500, Unknown→secondary/muted.

### `ResourceDetailPanel`
Slide-over `fixed right-0 top-0 z-50 h-full w-full max-w-2xl bg-card shadow-2xl
ring-1 ring-foreground/10`; scrim `fixed inset-0 z-50 bg-foreground/20 backdrop-blur-sm`.
Tabs (line 17-23, in order): `Diff` (`GitCompare`), `Live` (`FileText`),
`Desired` (`FileText`), `Events` (`ListChecks`), `Logs` (`Terminal`). Default `diff`,
auto-switches to `live` when there is no diff and no live manifest.
Active tab style `border-b-2 border-primary text-foreground`.
Header shows `{kind}` `/{name}`, namespace, `Sync: …`, `Health: …`, plus chips for
`apiVersion`, `resource`, `uid`, and first 3 labels (`key=value`, `bg-primary/10 text-primary`).
`Investigate` button (`Sparkles`, `data-testid="open-investigation"`).
`LOG_BUFFER_LIMIT = 5000`, `RECONNECT_BASE_MS = 1000`, `RECONNECT_MAX_MS = 30_000`.
Empty copy: `No data available.`, `No recent events.`

### `SyncDiffWorkbench`
`Card data-testid="sync-diff-workbench"`; title `Sync Diff` (`GitCompare`), description
"Application-level drift queue. Open a resource to inspect desired, live, events, logs, and diff."
Metrics: `resources`, `drifted`, `degraded`, `pruned`.
Filter pills: `All`, `Drifted`, `Missing`, `Pruned`, `Degraded`, `Synced`; selected
`bg-foreground text-background shadow-sm`.
Table grid `minmax(0,1.3fr) 8rem 8rem 7rem`, headers `Resource`, `Sync`, `Health`,
`Action` (right, hidden below `md`).
Empty: `No resources reported` / "This application has not published resource sync status
yet."; `No matching resources` / "Change the filter to inspect another sync state."

### `InvestigationTriage`
`Card data-testid="investigation-triage"`; title `Investigation Triage` (`SearchCheck`),
description "Degraded resources, failing checks, and manual investigation entry points for
this application." Header badges: phase (or `Unknown`) and `{n} out of sync`.
Sub-heading `Additional signals`. Row actions labelled
`Run investigation for {name}` and `Open resource {name}`; running copy `Investigation running`.
Auto-runs the top-ranked resource once per signature when the app is unhealthy.

### `ResourceListTable` — TanStack Table, columns in order:
expander (aria-label `Expand`/`Collapse`), `Kind`, `Name`, `Namespace`, `Sync`, `Health`,
`Ready` (`{ready}/{total}`, emerald when equal, amber when partial, destructive otherwise).
Header row `bg-muted/30 text-xs uppercase tracking-wide text-muted-foreground`,
cells `px-3 py-2`. Wrapper `overflow-hidden rounded-xl ring-1 ring-foreground/10`.
Empty: `No resources to display.` (same copy in `ResourceGraph`).

### `ApplicationReleaseHistory`
Title `Release History` (`History`); description "Prior releases and rollbacks for this
application." or "Showing {a}-{b} of {n} app-scoped releases."; chip `{n} total`.
Columns: `Name`, `Phase`, `Pipeline`, `Target`, `Created`, `Policies`, `Actions` (right).
Sub-label `rolled back to {x}`. Pager buttons `Previous releases` / `Next releases`.
Empty: `No releases found.`

### `/dashboard/rollouts`
Breadcrumb `Dashboard › Rollouts`; `<h1>Rollouts</h1>`, subtitle "Advanced deployment
strategies across namespaces". 3 stat cards: `Total Rollouts`, `Active`, `Healthy`.
Table card title `Rollouts` (`Rocket`), description "Canary, blue-green, A/B and mirror
rollouts." Columns: `Name`, `Namespace`, `Strategy`, `Phase`, `Target`, `Step / Weight`,
`Actions` (right). Actions `Promote` (`Play`, outline sm) / `Abort` (`Square`, ghost sm),
disabled when phase is `Healthy` or `RolledBack`. Empty `No rollouts found.`
Em-dash placeholder is `—` throughout.

### `/dashboard/rollouts/detail`
Breadcrumb `Dashboard › Rollouts › {name}`. 4 cards: `Strategy` (`Rocket`), `Phase`,
`Current Step`, `Current Weight`. `Details` card ("Observed state and target workload.")
with `DetailRow`s: `Target`, `Stable ReplicaSet`, `Canary ReplicaSet`, `Active Service`,
`Preview Service`, `Observed Generation`, `Message`. Then `RolloutDebugPanel`
(sections `Strategy Plan` — "No explicit canary steps." — and `Routing And Analysis`)
and `Conditions` (`AlertTriangle`). Not found: `Rollout not found.`

### `/dashboard/pipelines/detail`
Header: back `ChevronLeft` ghost icon button → `/dashboard`, `<h1 className="text-xl
font-semibold">{name}</h1>`, `ns/{namespace}`; right side `StatusBadge` + `Cancel`
(destructive sm) hidden when phase is `Succeeded`/`Failed`/`Cancelled`.
Layout `flex gap-6`: DAG in `flex-1 rounded-lg border bg-card`; side panel
`w-96 shrink-0` `h-[600px] rounded-lg border bg-card`.
Degraded-refresh banner: "Showing the last loaded pipeline state. Refresh failed: {error}"
in `border-warning/30 bg-warning/10 text-warning`.
Bottom section heading `Pipeline Artifacts`, grid `sm:grid-cols-2 lg:grid-cols-3`.
Missing-params copy: `Missing namespace or name parameters` + `Back to Dashboard`.
`getStepLogs` uses `tailLines: 100`.

### `/dashboard/applicationsets` and `…/detail`
List: breadcrumb `Dashboard › Application Sets`, `<h1>Application Sets</h1>`, subtitle
"Templated application generators", `Refresh` button, cards with name/`ns/{namespace}`/
`StatusBadge`, an `Applications` metric block, and a `View` link (`ArrowRight`).
Empty: `No application sets yet` / "Create an ApplicationSet resource to generate
Applications from templates". Error: `Failed to load application sets`.
Detail: two cards — `Status` (`FolderTree`) with rows `Phase` and
`Applications generated`; `Generated Applications` (`Rocket`) with
"This application set has not generated any applications yet." or
"{n} application(s) managed by this set." Not found: `Application set not found.`

### `/login`
Card `rounded-2xl border border-border/50 bg-card p-8 shadow-lg`, `max-w-sm`, with an
ambient `size-[36rem] rounded-full bg-primary/3 blur-3xl` glow.
Icon chip `size-10 rounded-xl bg-primary/10 text-primary` (`LogIn`).
`<h1 className="text-xl font-semibold tracking-tight">Sign in to Paprika</h1>`,
subtitle "Manage applications and deployments".
Fields `Username` (placeholder `admin`) and `Password` (placeholder `password`), inputs
`rounded-lg border border-border/60 bg-background px-3.5 py-2 text-sm`.
Submit `Sign in` / `Signing in...`. Divider text `Or continue with`.
`Sign in with Google` button with an inline 4-path Google SVG
(`#4285F4`, `#34A853`, `#FBBC05`, `#EA4335`).
`POST /auth/basic-login` → `persistAuth(data.idToken)` → `window.location.href = "/dashboard/"`.

---

## 10. Gaps / opportunities a redesign will run into

1. **Two visual languages already coexist.** `/dashboard` uses `rounded-xl`/`rounded-2xl` +
   `ring-1 ring-foreground/10` + framer-motion entrances. `/dashboard/applications` (fleet)
   uses square `border border-border bg-card`, mono eyebrows, `gap-px bg-border` cell grids,
   and no motion. Unifying these is the largest single opportunity.
2. **`ScopeBar` is a hard-coded stub** with no state wiring — the natural place to surface
   the real fleet scope (`project`/`cluster`/`stage` params already exist in `fleet-query`).
3. **No `input` / `select` / `tabs` / `dialog` / `skeleton` primitives.** Five near-identical
   `SkeletonCard`s, three different tab implementations, three different pill/segment
   implementations, three different search inputs.
4. **`NotificationCenter` (169 lines) and `ToastStack` are inert** because
   `ConnectionProvider` always returns `EMPTY_EVENTS`.
5. **Dead code**: all 6 `components/landing/*`, `dashboard/application-card.tsx` (567),
   `dashboard/release-table.tsx` (157), `notifications/notification-center.tsx` (169).
6. **No pipelines or releases list route** despite sidebar entries pointing at hash anchors.
7. **TanStack Query is mounted but essentially unused** — pages hand-roll fetch state.
8. **Sidebar active-state is a `switch` on human-readable labels** — brittle if labels change.
9. Static export means **no server-side data, no route handlers, no middleware**; the design
   must assume client fetch + skeletons.
10. **Accessible names are contractual** (Playwright asserts on them) — see §5's e2e list
    before renaming any heading, table label, or button.
