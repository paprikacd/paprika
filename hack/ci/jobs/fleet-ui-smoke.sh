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
ci_npm_ci ui

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

# ci.yml: Decide whether the Insights browser checks are affected. The rule is in ui/e2e/insights-suites.json
# (smokeSkipPaths): the checks are skipped only when every file changed since the merge base with master is in
# that list. A missing master, an unknown base, a git error or a failed check runs them: only an exact
# relevant=false skips. On master itself the merge base is HEAD, so the empty diff runs them.
insights_base=$(git -C "$CI_REPO_ROOT" merge-base HEAD master 2>/dev/null || true)
insights_verdict=relevant=true
if [ -n "$insights_base" ]; then
  insights_verdict=$(cd ui && node e2e/run-insights.mjs --relevance "$insights_base") || insights_verdict=relevant=true
fi
insights_relevant=true
if [ "$insights_verdict" = relevant=false ]; then insights_relevant=false; fi

# ci.yml: Run Insights MCP and dashboard browser smoke (timeout-minutes: 20)
if [ "$insights_relevant" = true ]; then
  (
    cd ui
    export INSIGHTS_POLISH_OUTPUT="$CI_REPO_ROOT/artifacts/insights/dashboard-polish"
    export INSIGHTS_PRESENTATION_OUTPUT="$CI_REPO_ROOT/artifacts/insights/presentation"
    export INSIGHTS_QUERY_INSPECTOR_OUTPUT="$CI_REPO_ROOT/artifacts/insights/query-inspector"
    ci_with_timeout 1200 node e2e/run-insights.mjs --tag smoke --retries 1
  )
else
  ci_log "Insights browser smoke: skipped (see the relevance check above)"
fi

if [ "$insights_relevant" = true ]; then
  # ci.yml: Generate reference dashboards and check keyboard shortcuts through the UI (timeout-minutes: 10)
  (
    cd ui
    export INSIGHTS_BUILDER_KEYBOARD_ONLY=1
    ci_with_timeout 600 node e2e/run-insights.mjs e2e/insights-reference-dashboards.e2e.mjs e2e/insights-builder.e2e.mjs
  )

  # ci.yml: Check Insights visual structure baseline (timeout-minutes: 10)
  (cd ui && ci_with_timeout 600 node --experimental-strip-types e2e/insights-visual-matrix.e2e.mjs)
else
  ci_log "Insights reference dashboards and visual matrix: skipped (no relevant changes)"
fi
