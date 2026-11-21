#!/usr/bin/env bash
# Local mirror of the ci.yml job "chart" (Helm chart).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init chart

# ci.yml uses RUNNER_TEMP for scratch files; the job's private temp directory plays that role.
export RUNNER_TEMP="$CI_JOB_TMP"

# ci.yml: Checkout / Reclaim self-hosted runner disk -> snapshot; disk reclaim not mirrored.
# ci.yml: Set up Helm (v3.21.2) -> pinned by hack/ci/tools.sh (never the host Helm 4).
# ci.yml: Set up Task -> the host task is verified at 3.52.0 by hack/ci/tools.sh.

# ci.yml: Verify OIDC Secret rendering
bash hack/test-oidc-secret-rendering.sh

# ci.yml: Verify OIDC deployment migration
bash hack/test-oidc-deployment-migration.sh

# ci.yml: Verify release chart comparison
bash hack/compare-helm-chart.sh --self-test

# ci.yml: Verify satellite chart credential and RBAC boundaries
bash hack/test-satellite-chart-rendering.sh

# ci.yml: Verify observability gateway boundaries
bash hack/test-observability-chart-rendering.sh
bash hack/test-observability-addon-rendering.sh

# ci.yml: Lint chart
helm lint charts/chart/

# ci.yml: Render chart
helm template paprika charts/chart/

# ci.yml: Render VKE configuration
helm template paprika charts/chart/ --values deploy/test-values.yaml

# ci.yml: Reject OIDC without clientID
# Regression guard: an empty client ID used to render --auth-oidc-client-id= and crash-loop the api-server at startup.
if helm template paprika charts/chart/ \
  --set auth.oidc.enabled=true --set auth.oidc.clientID= \
  2> "${RUNNER_TEMP}/oidc-render-err.txt"; then
  echo "expected render failure for oidc.enabled without clientID" >&2
  exit 1
fi
grep -q "auth.oidc.clientID is required" "${RUNNER_TEMP}/oidc-render-err.txt"

# ci.yml: Validate rendered args across value matrices
task chart:validate
