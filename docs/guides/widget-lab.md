# Paprika Widget Lab

The complete dashboard and chart evaluation application lives in [`labs/widget-lab`](../../labs/widget-lab/README.md). It includes the chart catalogue, domain studies, configuration editor, Edge Watch and Reliability Room, synthetic fixtures, automated tests, design contracts, source references and rendered review evidence.

This contribution preserves the implementation as an independently runnable application in the Paprika repository. Its Vite entry point and dependency manifest are separate from the production Next.js console in `ui/`. The production provider clients, authentication, saved dashboard documents, deployment configuration and widget registration have not been connected to this evaluation application.

## Run and verify

Use Node.js 22.12 or later. From the repository root:

```sh
cd labs/widget-lab
npm ci
npm run dev
```

Open the local URL printed by Vite. `#edge` opens Edge Watch, `#reliability` opens Reliability Room, and `#charts` opens the reusable chart catalogue. The visible dashboard selector exposes the other studies.

The dev server listens on `127.0.0.1` only and keeps Vite's default host-header check, which accepts `localhost` and IP-address hosts and rejects other DNS names. To reach it from another device on your network, opt in explicitly with `WIDGET_LAB_HOST=0.0.0.0 npm run dev`. `PORT` selects the port (default 3000). Adding a DNS name requires an explicit `server.allowedHosts` entry in `labs/widget-lab/vite.config.ts`.

```sh
npm test -- --maxWorkers=2   # default Vitest concurrency caused fixture timeouts here
npm run typecheck
npm run build
```

The build writes `labs/widget-lab/dist/`, which is ignored by Git. All displayed records are explicitly synthetic. Configuration changes apply to the current evaluation session; they do not execute provider queries or persist a production dashboard.

## Included work

| Area | Source and evidence |
| --- | --- |
| Chart renderers and typed adapters | [`src/charts`](../../labs/widget-lab/src/charts/), [`tests`](../../labs/widget-lab/tests/) |
| Dashboard composition and linking | [`src/lenses`](../../labs/widget-lab/src/lenses/), [`src/reference`](../../labs/widget-lab/src/reference/) |
| Guided configuration, fields and JSON editing | [`src/editor`](../../labs/widget-lab/src/editor/) |
| Domain widgets and authoring verification | [Iteration 10 report](../../labs/widget-lab/docs/iteration-10-authoring-and-domain-widgets.md) |
| Responsive Edge Watch and Reliability Room, viewport evidence and 575-test verification | [Iteration 11 report](../../labs/widget-lab/docs/iteration-11-responsive-reference-dashboards.md), [browser measurements](../../labs/widget-lab/docs/qa/iteration-11-browser-evidence.json) |
| Design and interaction contracts | [`DESIGN.md`](../../labs/widget-lab/DESIGN.md), [`UX-CONTRACT.md`](../../labs/widget-lab/UX-CONTRACT.md) |
| Attribution and renderer ownership | [`attribution/`](../../labs/widget-lab/attribution/) (upstream license and Gamma attribution at `bb52aed8`), [lab-only wrappers and the production gap each covers](../../labs/widget-lab/src/renderer-extensions/README.md) |

Import provenance: the initial import is source commit `29b22f4c919e7f821f18d64b96baa71b0966ca42`. The retired per-file manifest and regenerated patch are at commit `af11b6c3` (git history). The lab keeps no export manifest or sync script; Git tracks the current files.

## Canonical integration boundary

The evaluation app renders through Paprika's `WidgetVisualization`, `Widget` / `QueryResult` contracts, shared timestamp cursor and trusted widget registry. It imports production's `ui/src/features/insights` directly through `@insights/*`, with no copy of that renderer: every built-in and plugin chart family, the time-series and bar renderers, the tooltip owner and the widget registry come from production. The lab adds only the wrappers listed in `labs/widget-lab/src/renderer-extensions/README.md`, each with the production gap it covers. The upstream license and component provenance files are kept in `labs/widget-lab/attribution/`.

The lab's remaining extensions are wrappers over production APIs, and one renderer production does not bundle: the zoomable connection map. Promoting one of them means adding the missing option or owner to `ui/`, then removing the wrapper. The zoomable map needs a product decision first, because production's connection map has no zoom or pan. Exact UTC start and end entry for lab window controls needs a series adapter for production's Compare window, which the lab does not yet supply.

Promotion is decided family by family; the decision below records the current answer.

## Boundary

The lab renders production's `ui/src/features/insights` through `@insights/*`. The wrappers that remain are listed, with the production gap each covers, in [`labs/widget-lab/src/renderer-extensions/README.md`](../../labs/widget-lab/src/renderer-extensions/README.md). The lab keeps no copy of the renderer.

## Decision (2026-11-24)

The four Kubernetes families (placement, resource bars, CPU throttle and resource trend) are promoted to product metrics plugins in `ui/src/features/insights/plugins/`. Every other lab family is a concept study: the chart library marks it "Concept" and it is not in the product. The Insights maintainer owns both. This replaces the four-step promotion path that used to be listed here.
