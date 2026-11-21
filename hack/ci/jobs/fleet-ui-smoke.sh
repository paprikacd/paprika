#!/usr/bin/env bash
# Local mirror of the ci.yml job "fleet-ui-smoke" (Fleet console browser smoke).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init fleet-ui-smoke
export GOTOOLCHAIN=auto # ci.yml job env

# Upload browser diagnostics (ci.yml) -> copied into artifacts/ci/<tree>/fleet-ui-smoke/ on exit.
ci_collect ui/playwright-report ui/test-results \
  artifacts/insights/dashboard-query artifacts/insights/query-inspector artifacts/insights/observe-authoring \
  artifacts/insights/render-worker artifacts/insights/tooltip-peers artifacts/insights/variable-filter \
  artifacts/insights/repository-examples/browser artifacts/insights/record-charts artifacts/insights/rich-charts \
  artifacts/insights/editor-focus artifacts/insights/chart-system artifacts/insights/edit-performance \
  artifacts/insights/tooltip-structure artifacts/insights/tooltip-motion artifacts/insights/hex-contour \
  artifacts/insights/dashboard-polish artifacts/insights/presentation artifacts/insights/reference-dashboards \
  artifacts/insights/visual-matrix

# ci.yml: Set up Go / Set up Node.js (22) -> snapshot, tools.sh and hack/ci/lib.sh.

# ci.yml: Install UI dependencies
(cd ui && npm ci)

# ci.yml: Build compiled UI
(cd ui && npm run build)

# ci.yml: Build real fleet fixture
go build -o bin/fleet-console-fixture ./test/fleetconsole

# ci.yml: Install Chromium
# ci.yml runs `--with-deps` (system packages through apt) on Linux only. On macOS the browser alone is installed.
if [ "$(uname -s)" = Linux ]; then
  (cd ui && npx playwright install --with-deps chromium)
else
  (cd ui && npx playwright install chromium)
fi

# ci.yml: Run real fleet console smoke
(cd ui && npm run test:e2e -- fleet-console.spec.ts)

# ci.yml: Run real console session browser smoke (timeout-minutes: 5)
(cd ui && export SESSION_E2E_STATIC=1 && ci_with_timeout 300 npm run test:e2e:session)

# ci.yml: Run Insights MCP and dashboard browser smoke (timeout-minutes: 20)
(
  cd ui
  export INSIGHTS_POLISH_OUTPUT="$CI_REPO_ROOT/artifacts/insights/dashboard-polish"
  export INSIGHTS_PRESENTATION_OUTPUT="$CI_REPO_ROOT/artifacts/insights/presentation"
  export INSIGHTS_QUERY_INSPECTOR_OUTPUT="$CI_REPO_ROOT/artifacts/insights/query-inspector"
  ci_with_timeout 1200 node e2e/run-insights.mjs \
    e2e/insights-query-inspector.e2e.mjs \
    e2e/insights-dashboard-query.e2e.mjs \
    e2e/insights-observe-authoring.e2e.mjs \
    e2e/insights-render-worker.e2e.mjs \
    e2e/insights-tooltip-peers.e2e.mjs \
    e2e/insights-compact-stat.e2e.mjs \
    e2e/insights-compact-stat-compare.e2e.mjs \
    e2e/insights-status-history-axis.e2e.mjs \
    e2e/insights-dashboard-polish.e2e.mjs \
    e2e/insights-presentation.e2e.mjs \
    e2e/insights-variable-filter.e2e.mjs \
    e2e/insights-repository-examples.e2e.mjs \
    e2e/insights-record-charts.e2e.mjs \
    e2e/insights-rich-charts.e2e.mjs \
    e2e/insights-chart-system.e2e.mjs \
    e2e/insights-editor-focus.e2e.mjs \
    e2e/insights-edit-performance.e2e.mjs \
    e2e/insights-tooltip-structure.e2e.mjs \
    e2e/insights-tooltip-motion.e2e.mjs \
    e2e/insights-hex-contour.e2e.mjs \
    e2e/insights-builtin-selection.e2e.mjs \
    e2e/insights-phone-shell.e2e.mjs
)

# ci.yml: Generate reference dashboards and check keyboard shortcuts through the UI (timeout-minutes: 10)
(
  cd ui
  export INSIGHTS_BUILDER_KEYBOARD_ONLY=1
  ci_with_timeout 600 node e2e/run-insights.mjs e2e/insights-reference-dashboards.e2e.mjs e2e/insights-builder.e2e.mjs
)

# ci.yml: Check Insights visual structure baseline (timeout-minutes: 10)
(cd ui && ci_with_timeout 600 node --experimental-strip-types e2e/insights-visual-matrix.e2e.mjs)
