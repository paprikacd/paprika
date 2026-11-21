#!/usr/bin/env bash
# Local mirror of the ci.yml job "distribution-contracts" (Distribution entrypoint contracts).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init distribution-contracts

# ci.yml: Checkout / Reclaim self-hosted runner disk -> snapshot; disk reclaim not mirrored.
# ci.yml: Install Task (3.52.0) -> the host task is verified by hack/ci/tools.sh.
# ci.yml: Set up Node for plugin distribution tests (22) -> PATH carries the Node 22 install.

# ci.yml: Verify distribution entrypoints
bash hack/test-cli-install.sh
bash hack/test-taskfile-contract.sh
bash hack/test-landing-install.sh
node --test test/paprika-plugin-installer.test.mjs
