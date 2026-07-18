#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=hack/lib/fleet-admin-harness.sh
source "${ROOT_DIR}/hack/lib/fleet-admin-harness.sh"

fleet_admin_main "$@"
