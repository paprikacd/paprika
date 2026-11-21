#!/usr/bin/env bash
# Fast checks for the pre-push hook on non-master refs (task ci:quick).
#
# Checks only what HEAD changed relative to the merge base with origin/master:
#   Go files:        gofmt, golangci-lint and go test for the touched packages (no -race)
#   UI files:        eslint and vitest related --run, with Node 22
#   shell scripts:   shellcheck
#   hack/ci, hack/deploy, Taskfile.yml: the Taskfile contract test and the local CI self-tests
#
# The tree must be clean, because the checks read the working files. Full CI (task ci) is the
# gate for master; this is a quick filter for every other branch.
set -Eeuo pipefail

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$CI_REPO_ROOT" || ci_die "cannot enter $CI_REPO_ROOT"

failures=0
note_fail() {
  ci_log "FAIL  $*"
  failures=$((failures + 1))
}

[ -z "$(git status --porcelain)" ] || ci_die "working tree is not clean; commit first (quick checks read the files on disk)"
git rev-parse --verify --quiet origin/master >/dev/null ||
  ci_die "origin/master is not present; run: git fetch origin master"
base=$(git merge-base HEAD origin/master) || ci_die "no merge base with origin/master"
changed=$(git diff --name-only --diff-filter=ACMR "$base" HEAD)
if [ -z "$changed" ]; then
  ci_log "no changes against origin/master; nothing to check"
  exit 0
fi
ci_log "checking $(printf '%s\n' "$changed" | grep -c .) changed file(s) against ${base:0:12}"

node22=$(ci_node22_bin) || ci_die "Node ${CI_NODE_MAJOR} not found; set PAPRIKA_NODE22"

# Go: gofmt and golangci-lint on the packages that changed, then go test on the same packages.
go_files=$(printf '%s\n' "$changed" | grep -E '\.go$' || true)
if [ -n "$go_files" ]; then
  unformatted=$(printf '%s\n' "$go_files" | xargs gofmt -l 2>/dev/null || true)
  if [ -n "$unformatted" ]; then
    note_fail "gofmt: $(printf '%s' "$unformatted" | tr '\n' ' ')"
  else
    ci_log "ok    gofmt"
  fi

  golangci="$CI_REPO_ROOT/bin/golangci-lint"
  if [ ! -x "$golangci" ]; then
    make --no-print-directory golangci-lint >/dev/null || ci_die "could not install golangci-lint (make golangci-lint)"
  fi
  packages=$(printf '%s\n' "$go_files" | xargs -n1 dirname | sort -u | sed 's|^\.$|.|; s|^\([^.]\)|./\1|')
  # Packages whose files are all behind a build tag (for example test/e2e, behind //go:build e2e) have
  # nothing to build or lint by default, and go test refuses them. They are left out of both checks.
  # shellcheck disable=SC2086
  # Directories, not import paths: golangci-lint reads its arguments as paths, and go test takes both.
  buildable=$(GOTOOLCHAIN=auto go list -e -f '{{if or .GoFiles .TestGoFiles .XTestGoFiles}}{{.Dir}}{{end}}' $packages 2>/dev/null | grep . || true)
  if [ -z "$buildable" ]; then
    ci_log "skip  golangci-lint and go test: the changed packages have no buildable Go files"
  else
    # shellcheck disable=SC2086
    if "$golangci" run --timeout=10m $buildable; then
      ci_log "ok    golangci-lint"
    else
      note_fail "golangci-lint"
    fi

    # shellcheck disable=SC2086
    if GOTOOLCHAIN=auto go test -count=1 $buildable; then
      ci_log "ok    go test"
    else
      note_fail "go test"
    fi
  fi
fi

# UI: eslint and the vitest tests related to the changed files, both on Node 22.
ui_files=$(printf '%s\n' "$changed" | grep -E '^ui/.*\.(ts|tsx|js|mjs|cjs)$' | sed 's|^ui/||' || true)
if [ -n "$ui_files" ]; then
  [ -d "$CI_REPO_ROOT/ui/node_modules" ] || ci_die "ui/node_modules is missing; run: (cd ui && npm ci)"
  # shellcheck disable=SC2086
  if (cd "$CI_REPO_ROOT/ui" && PATH="$node22:$PATH" npx --no-install eslint $ui_files); then
    ci_log "ok    eslint (ui)"
  else
    note_fail "eslint (ui)"
  fi
  # shellcheck disable=SC2086
  if (cd "$CI_REPO_ROOT/ui" && PATH="$node22:$PATH" npx --no-install vitest related --run $ui_files); then
    ci_log "ok    vitest related (ui)"
  else
    note_fail "vitest related (ui)"
  fi
fi

# Shell: shellcheck on every changed script.
sh_files=$(printf '%s\n' "$changed" | grep -E '\.sh$' || true)
if [ -n "$sh_files" ]; then
  # shellcheck disable=SC2086
  if (cd "$CI_REPO_ROOT" && shellcheck $sh_files); then
    ci_log "ok    shellcheck"
  else
    note_fail "shellcheck"
  fi
fi

# Local CI and deploy scripts, and the Taskfile: their own contract tests.
if printf '%s\n' "$changed" | grep -qE '^(hack/ci/|hack/deploy/|hack/test-local-ci\.sh|hack/test-taskfile-contract\.sh|Taskfile\.yml|\.githooks/)'; then
  if bash hack/test-taskfile-contract.sh >/dev/null 2>&1; then
    ci_log "ok    hack/test-taskfile-contract.sh"
  else
    note_fail "hack/test-taskfile-contract.sh"
  fi
  if bash hack/test-local-ci.sh >/dev/null 2>&1; then
    ci_log "ok    hack/test-local-ci.sh"
  else
    note_fail "hack/test-local-ci.sh (run it directly for the output)"
  fi
fi

if [ "$failures" -ne 0 ]; then
  ci_die "$failures quick check(s) failed"
fi
ci_log "quick checks passed"
