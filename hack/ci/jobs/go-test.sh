#!/usr/bin/env bash
# Local mirror of the ci.yml job "go-test" (Go race tests).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init go-test
export GOTOOLCHAIN=auto # ci.yml job env

# ci.yml: Checkout / Reclaim self-hosted runner disk -> snapshot checkout; disk reclaim not mirrored.
# ci.yml: Set up Go (1.27.4) -> the host go is verified by hack/ci/tools.sh.

# ci.yml: Run race tests
make test-race
# go test prints "ok  <package>  (cached)" for a package whose result was reused. Its output is in this job's log, which
# run.sh writes to the artifact directory, so the packages are counted there.
cached=0
if [ -n "${PAPRIKA_CI_ARTIFACT_DIR:-}" ] && [ -f "$PAPRIKA_CI_ARTIFACT_DIR/go-test.log" ]; then
  cached=$(grep -cE '^ok[[:space:]].*\(cached\)$' "$PAPRIKA_CI_ARTIFACT_DIR/go-test.log" || true)
fi
ci_log "go-test: $cached package(s) reused cached results; run task ci FRESH=1 to rerun all"

# ci.yml: Test deployment helpers
bash hack/test-dashboard-renderer.sh
bash hack/test-check-vke-pod-conditions.sh
bash hack/test-github-actions-oidc-token.sh
bash hack/test-github-actions-vke-token.sh
