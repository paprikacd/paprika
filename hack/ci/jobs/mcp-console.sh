#!/usr/bin/env bash
# Local mirror of the ci.yml job "mcp-console" (MCP console and plugin).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init mcp-console

# ci.yml: Set up Node.js -> PATH carries the pinned Node.js install (hack/ci/lib.sh).

# ci.yml: Install dependencies
ci_npm_ci internal/api/mcp/ui

# ci.yml: Check types
(cd internal/api/mcp/ui && npm run check)

# ci.yml: Test console and plugin contracts
(cd internal/api/mcp/ui && npm test)

# ci.yml: Build embedded console
(cd internal/api/mcp/ui && npm run build)

# ci.yml: Check committed console bundle
git diff --exit-code -- internal/api/mcp/ui/dist/console.html
