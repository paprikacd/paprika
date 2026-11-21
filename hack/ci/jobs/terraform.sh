#!/usr/bin/env bash
# Local mirror of the ci.yml job "terraform" (Terraform offline plans).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init terraform

# ci.yml: Checkout -> the snapshot is already a fresh detached checkout of the commit.
# ci.yml: Reclaim self-hosted runner disk -> not mirrored (GitHub runner only).
# ci.yml: Set up Terraform (1.14.6, terraform_wrapper disabled) -> pinned by hack/ci/tools.sh.

# ci.yml: Validate and test isolated Terraform configuration
bash hack/test-terraform.sh
