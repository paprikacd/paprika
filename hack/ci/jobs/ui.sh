#!/usr/bin/env bash
# Local mirror of the ci.yml job "ui" (UI).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init ui

# ci.yml: Set up Node.js (22) -> PATH carries the Node 22 install (hack/ci/lib.sh).
# ci.yml: Reclaim self-hosted runner disk -> not mirrored.

# ci.yml: Install dependencies
ci_npm_ci ui

# ci.yml: Install widget lab dependencies
ci_npm_ci labs/widget-lab

# ci.yml: Test
(cd ui && npm test)

# ci.yml: Widget lab tests
(cd labs/widget-lab && npm test -- --maxWorkers=2)

# ci.yml: Browser-render worker and visual probe tests
(cd ui && node --test render-worker.test.mjs dashboard-probe.test.mjs e2e/fixtures/visual-matrix-diff.test.mjs)

# ci.yml: Lint
(cd ui && npm run lint)

# ci.yml: Build
(cd ui && npm run build)

# ci.yml: Check Insights first-view size budget
(cd ui && node scripts/check-insights-budget.mjs)
