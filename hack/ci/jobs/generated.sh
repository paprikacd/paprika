#!/usr/bin/env bash
# Local mirror of the ci.yml job "generated" (Generated code drift).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init generated
export GOTOOLCHAIN=auto # ci.yml job env

# The Insights work directory is removed on exit, pass or fail (ci_job_finish runs ci_cleanup from its EXIT trap).
ci_cleanup() {
  if [ -n "${work:-}" ]; then rm -rf -- "$work"; fi
}

# Go protobuf plugins install into a job-private GOBIN so nothing lands in the developer's GOPATH.
GOBIN="$CI_JOB_TMP/gobin"
mkdir -p -- "$GOBIN"
export GOBIN
export PATH="$GOBIN:$PATH"

# ci.yml: Checkout / Reclaim self-hosted runner disk / Set up Go -> snapshot and tools.sh.

# ci.yml: Set up Node.js -> PATH carries the pinned Node.js install (hack/ci/lib.sh).

# ci.yml: Install UI protobuf plugins
ci_npm_ci ui

# ci.yml: Install Go protobuf plugins
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.11
go install connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.20.0

# ci.yml: Verify protobuf generators
command -v protoc-gen-go
command -v protoc-gen-connect-go
command -v ui/node_modules/.bin/protoc-gen-es
command -v ui/node_modules/.bin/protoc-gen-connect-es

# ci.yml: Remove committed generated outputs
rm -rf -- internal/api/paprika ui/src/gen

# ci.yml: Regenerate protobuf clients
make generate-proto

# ci.yml: Regenerate Insights contract artifacts (the schemas, the plugin bundle and contract-reference.md)
(cd ui && npm run schema:generate)

# ci.yml: Check generated code
git diff --exit-code
git status --porcelain --untracked-files=all
test -z "$(git status --porcelain --untracked-files=all)"

# ci.yml: Lint Insights dashboard documents (error findings fail; warnings print only)
# TMPDIR is the job's private directory, so mktemp creates the work directory inside it.
export TMPDIR="$CI_JOB_TMP"
work="$(mktemp -d)"
node --experimental-strip-types demo/insights-gallery/export-documents.mjs "$work/gallery"
node --experimental-strip-types ui/e2e/fixtures/export-reference-documents.mjs "$work/reference"
go run ./cmd/paprika-insights lint --served-schema-examples ui/src/features/insights/repository-examples/catalog.json internal/insights/starters "$work/gallery" "$work/reference"
