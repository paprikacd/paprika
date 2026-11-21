#!/usr/bin/env bash
# Local mirror of the ci.yml job "go-lint" (Go lint).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init go-lint
export GOTOOLCHAIN=auto # ci.yml job env

# ci.yml: Checkout / Reclaim self-hosted runner disk / Set up Go -> see go-test.sh.

# ci.yml: Verify linter configuration
make lint-config

# ci.yml: Run linter
make lint
