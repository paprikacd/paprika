# Insights dev loop

The commands for changing Insights dashboards, widgets and renderers locally, in the order you need them. The
contracts these checks enforce are indexed in [docs/design/insights/README.md](../design/insights/README.md).

## Playground and live review

- `cd ui && npm run insights:lab` starts the hot-reloading playground on synthetic fixtures. Its options, the
  Playwright review playground and the gallery stack are in [the local dashboard loop](local-dashboard-polish.md).
- The [widget lab](widget-lab.md) renders the same renderers on concept data. Check a renderer change there too.
- `render_dashboard` through Observe needs `PAPRIKA_OBSERVE_RENDER_URL` and `PAPRIKA_OBSERVE_RENDER_SECRET`; see
  [the browser renderer](observe-browser-renderer.md).

## Unit tests and types

From `ui/`, with Node 22 on `PATH` (newer Node breaks jsdom storage):

```sh
npx vitest run src/features/insights
npx tsc --noEmit -p .
```

Service changes: `go test ./internal/insights/... ./internal/observabilitygateway/... ./docs/...`. The
`docs/design/insights` directory is a Go package that embeds `dashboard.schema.json`, `saved-query.schema.json`
and `widget-plugins.json`, so those files stay where they are.

## Lint dashboard documents

```sh
go run ./cmd/paprika-insights lint --served-schema-examples ui/src/features/insights/repository-examples/catalog.json internal/insights/starters
```

CI also lints the gallery export and the reference fixtures.

## Browser suites

Every Insights browser suite is listed once in `ui/e2e/insights-suites.json`, with its tags, the prerequisites it needs and a timeout. Run from `ui/`:

```sh
node e2e/run-insights.mjs --list --tag smoke   # print the selection; starts nothing
node e2e/run-insights.mjs --tag smoke --retries 1   # the CI smoke set; a suite that passes on retry is reported as flaky
node e2e/run-insights.mjs                      # the "full" tag (the no-argument default)
node e2e/run-insights.mjs --tag perf          # performance suites, against the static export in ui/out
node e2e/run-insights.mjs e2e/insights-x.e2e.mjs   # named suites, listed or not
```

Suites run in sequence. A failing suite does not stop the rest; the run prints a summary and exits non-zero. Each suite gets its timeout from the manifest. Without `INSIGHTS_E2E_URL`, `dev` suites use a `next dev` server and `perf` suites use a static server over `ui/out`, so run `npm run build` first. Set `INSIGHTS_E2E_URL` to use one server for every suite.

Browser suites need Playwright Chromium and the Go toolchain (each binary is built with `go build`). Suites marked `gallery` need the gallery Docker stack at `PAPRIKA_GALLERY_BASE_URL` and are run directly with `node e2e/<suite>`, not through the runner. `postgres`, `uptime` and `credentials` suites need the environment named in their file. The CI smoke step runs `--tag smoke --retries 1`. On a pull request (and in the local `task ci` job, against the merge base with master) it skips only when every changed file matches the manifest's `smokeSkipPaths`: Markdown, images under `docs/`, `.agents/` and `landing/`. Other files under `docs/` count as code, because `docs/design/insights` is a Go package that embeds the schemas into the service. Pushes to master, renames out of a code path, empty diffs and any git error run the suites (`e2e/insights-relevance.mjs`).

`node --test e2e/insights-suites.test.mjs` checks that the manifest lists every `insights*.e2e.mjs` file once and that the smoke tag matches the CI set.

## Visual matrix and responsive checks

`ui/e2e/insights-visual-matrix-linux.sh` runs the visual matrix in Docker (`--update` records the baseline).
Every changed surface must work at 1512, 1024, 768 and 390 px, light and dark, and in narrow tiles (w=2 to 4 at
1512, and the phone stack). Use a scripted Playwright check for overflow and clipping, and open the screenshots.

## Where evidence goes

Screenshots and reports are written under `artifacts/insights/` (gitignored). A dated record of a review or a
deployment goes in [docs/design/insights/receipts/](../design/insights/receipts/), never into a contract, a
guide or a skill. The review protocol is in the
[design skill's validation reference](../../.agents/skills/paprika-dashboard-design/references/validation.md).
