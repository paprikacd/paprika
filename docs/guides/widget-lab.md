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

The export includes source assets and historical screenshots so the design decisions and verification reports remain reviewable. Site-specific hosting metadata, installed dependencies and build output are excluded. [`labs/widget-lab-export.json`](../../labs/widget-lab-export.json) records the source commit and the SHA-256, byte length and Git mode of every exported file.

## Canonical integration boundary

The evaluation app renders through Paprika's `WidgetVisualization`, `Widget` / `QueryResult` contracts, shared timestamp cursor and trusted widget registry. It imports production's `ui/src/features/insights` directly through `@insights/*`, with no copy of that renderer: every built-in and plugin chart family, the time-series and bar renderers, the tooltip owner and the widget registry come from production. The lab adds only the wrappers listed in `labs/widget-lab/src/renderer-extensions/README.md`, each with the production gap it covers. The upstream license and component provenance files are kept in `labs/widget-lab/attribution/`.

The lab's remaining extensions are wrappers over production APIs, and one renderer production does not bundle: the zoomable connection map. Promoting one of them means adding the missing option or owner to `ui/`, then removing the wrapper. The zoomable map needs a product decision first, because production's connection map has no zoom or pan. Exact UTC start and end entry for lab window controls needs a series adapter for production's Compare window, which the lab does not yet supply.

To promote these capabilities into the production console:

1. Relocate the reusable owners into `ui/src/features/insights/` and resolve their imports against canonical modules. Retain their semantic tests and exact missing-value behavior.
2. Extend the canonical strict schemas and registry together, register the new families on the normal editor/explorer paths, and connect field binding to the actual loaded source schema.
3. Connect saved widget configuration through the existing authenticated document and provider contracts. Keep synthetic fixtures confined to evaluation or tests.
4. Verify the existing UI test suite, the relevant production host routes and browser behavior before merging that integration.

The branch does not change a deployed cluster or merge into `master`. The self-contained lab and reproducible owner delta make the complete work available for review and subsequent production integration.

## Refresh the export

The initial `labs/widget-lab-export.json` is an import snapshot of source commit `29b22f4c919e7f821f18d64b96baa71b0966ca42`. Further extensions to this PR are maintained directly in `labs/widget-lab` and tracked by Git. That snapshot remains historical provenance; it is not a current-file integrity manifest after downstream edits. The exporter intentionally refuses to overwrite those independent edits. The Paprika renderer is no longer copied: the lab imports production, and the wrappers that remain are listed in `labs/widget-lab/src/renderer-extensions/README.md`. The former per-file manifest and regenerated patch were retired with the vendored tree; they remain in git history at commit `af11b6c3`.

After committing the separate Widget Lab source, run from the Paprika repository root:

```sh
python3 hack/sync-widget-lab.py --source /absolute/path/to/paprika-widget-lab
python3 hack/sync-widget-lab.py --source /absolute/path/to/paprika-widget-lab --check
```

Current status: this manifest is stale relative to later in-repo edits. It records only the initial import from `29b22f4c`. Edited files such as `src/App.tsx` no longer match their recorded hashes, and files added since then, such as `src/components/lab/WidgetLoading.tsx`, are not listed. The separate checkout that produced `29b22f4c` is not in this repository, so the manifest cannot be regenerated here, and `--check` cannot pass against the current manifest. Use Git history at `af11b6c3` for the retired per-file manifest, and the renderer-extensions README for the current wrappers.

The exporter copies Git-tracked files, retains executable modes, records content hashes and refuses to overwrite independent edits in the exported copy. A dirty source is rejected by default. `--allow-dirty` is available for an explicitly uncommitted preparation checkpoint; the final branch should record `source_dirty: false`.
