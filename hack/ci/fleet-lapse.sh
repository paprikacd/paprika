#!/usr/bin/env bash
# The fleet-scale UI-half waiver: the base it is measured from, and the change set that lapses it.
# Sourced by hack/ci/jobs/fleet-scale.sh, hack/ci/fleet-anchor.sh and hack/test-local-ci.sh; keep the lapse rules here only.
#
# The owner's rule: the waiver lapses when the change touches the fleet UI or the gate itself. A change lapses it when
# it can change what the UI half measures, in any of these groups (fleet_lapse_group names the group of each path):
#   UI closure         the files the fleet UI imports, traced from the app shell, from every route that
#                      ui/e2e/fleet-scale.spec.ts visits and from the Next.js convention files (error, loading, ...)
#                      of each segment on the way (hack/ci/fleet-ui-closure.mjs, which also lists empty slots). The closure is taken at both
#                      ends of the diff, so a rename out of it lapses too.
#   UI build input     the packages and their patches, the build and test configuration, the public assets and app
#                      icons, and the spec the UI half runs.
#   Fixture Go package every non-test file directly in a repository package that the fixture server is built from
#                      (go list -deps ./test/fleetconsole ./internal/fleet, computed at HEAD), plus go.mod and go.sum.
#   gate               the fleet-scale scripts and the tracer.
#   ci.yml             the fleet-scale job block of .github/workflows/ci.yml, only when that block's text changes.
# A change elsewhere, including Insights-only changes under ui/src/features/insights, keeps the waiver.
#
# The base is the nearest verified ancestor (fleet_find_base): a first-parent commit whose stamp shows fleet-scale passing
# (in full or waived), or that is listed in the anchors file. The anchors file is written only by hack/ci/fleet-anchor.sh.

FLEET_LAPSE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck disable=SC1091
declare -F ci_log >/dev/null 2>&1 || source "$FLEET_LAPSE_DIR/lib.sh"

# Prints the path of the TypeScript compiler the closure tracer uses. The developer checkout (the first worktree
# listed by git) holds ui/node_modules; a snapshot has none, so the job reads the checkout's copy.
fleet_typescript_path() {
  local main candidate
  main=$(git -C "$CI_REPO_ROOT" worktree list --porcelain | sed -n 's/^worktree //p' | head -1)
  for candidate in "$main/ui/node_modules/typescript/lib/typescript.js" "$CI_REPO_ROOT/ui/node_modules/typescript/lib/typescript.js"; do
    if [ -f "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# fleet_closure <root>: the UI closure of the tree at <root>, one path per line, relative to <root>.
fleet_closure() {
  local root=$1 ts node_dir
  ts=$(fleet_typescript_path) || {
    ci_log "TypeScript is not installed in the developer checkout (run npm ci in ui/): the fleet-scale UI closure needs it"
    return 1
  }
  node_dir=$(ci_node22_bin) || {
    ci_log "Node 22 is required for the fleet-scale UI closure (docs/guides/local-ci.md)"
    return 1
  }
  "$node_dir/node" "$FLEET_LAPSE_DIR/fleet-ui-closure.mjs" --root "$root" --typescript "$ts"
}

# fleet_go_dirs <root>: the repository package directories the fixture server is built from, relative to <root>. The
# packages are mapped from their import paths, so a symlinked checkout (macOS /tmp) gives the same directories.
fleet_go_dirs() {
  local root mod pkgs
  root=$1
  mod=$(cd "$root" && GOTOOLCHAIN=auto go list -m) || return 1
  [ -n "$mod" ] || return 1
  pkgs=$(cd "$root" && GOTOOLCHAIN=auto go list -deps -f '{{if .Module}}{{if .Module.Main}}{{.ImportPath}}{{end}}{{end}}' \
    ./test/fleetconsole ./internal/fleet) || return 1
  printf '%s\n' "$pkgs" | awk -v m="$mod" '
    NF == 0 { next }
    $0 == m { print "."; next }
    index($0, m "/") == 1 { print substr($0, length(m) + 2) }' | sort -u
}

# fleet_scale_block: reads ci.yml on stdin, prints the fleet-scale job block (its text decides whether the ci.yml path lapses).
fleet_scale_block() {
  awk '/^  fleet-scale:$/ { on = 1; print; next } on && /^  [A-Za-z0-9_-]+:$/ { exit } on { print }'
}

# fleet_lapse_group <path> <closure file> <Go directories file>: prints the group of a lapsing path, or nothing.
fleet_lapse_group() {
  local path=$1 closure=$2 godirs=$3 dir
  case "$path" in
    ui/src/app/globals.css | ui/e2e/fleet-scale.spec.ts | ui/package.json | ui/package-lock.json | ui/next.config.* | \
      ui/tsconfig*.json | ui/postcss.config.* | ui/tailwind.config.* | ui/playwright*.config.* | ui/.npmrc | \
      ui/patches/* | ui/public/* | ui/src/app/icon.* | ui/src/app/favicon.* | ui/src/app/apple-icon.*)
      # ui/patches is applied by the postinstall step of npm ci; ui/public and the app icons are served to the page.
      printf 'UI build input\n'
      return 0
      ;;
    hack/test-fleet-scale.sh | hack/ci/jobs/fleet-scale.sh | hack/ci/fleet-lapse.sh | hack/ci/fleet-ui-closure.mjs)
      printf 'fleet-scale gate\n'
      return 0
      ;;
    go.mod | go.sum)
      printf 'Go module file\n'
      return 0
      ;;
  esac
  if grep -Fxq -- "$path" "$closure"; then
    printf 'UI closure\n'
    return 0
  fi
  case "$path" in
    *_test.go) return 1 ;;
  esac
  dir=${path%/*}
  [ "$dir" != "$path" ] || dir=.
  if grep -Fxq -- "$dir" "$godirs"; then
    printf 'fleet fixture Go package\n'
    return 0
  fi
  return 1
}

# fleet_lapse_list <base> <root>: prints "<group><TAB><path>" for each changed path (base..HEAD, renames split) that lapses
# the waiver. Prints nothing when the waiver holds. Returns 1 when the lapse set cannot be computed.
fleet_lapse_list() {
  local base=$1 root=$2 tmp changed path group ci_lapse=0 base_block head_block closure godirs
  tmp=$(mktemp -d "${TMPDIR:-/tmp}/paprika-fleet-lapse.XXXXXX") || return 1
  if ! git -C "$root" archive "$base" ui/src ui/e2e | tar -x -C "$tmp"; then
    ci_log "could not read the UI tree of base ${base:0:12}"
    rm -rf -- "$tmp"
    return 1
  fi
  if ! fleet_closure "$tmp" >"$tmp/closure-base" || ! fleet_closure "$root" >"$tmp/closure-head"; then
    rm -rf -- "$tmp"
    return 1
  fi
  if ! fleet_go_dirs "$root" >"$tmp/godirs"; then
    ci_log "go list failed for the fleet fixture packages"
    rm -rf -- "$tmp"
    return 1
  fi
  cat "$tmp/closure-base" "$tmp/closure-head" | sort -u >"$tmp/closure"
  base_block=$(git -C "$root" show "$base:.github/workflows/ci.yml" 2>/dev/null | fleet_scale_block || true)
  head_block=$(git -C "$root" show "HEAD:.github/workflows/ci.yml" 2>/dev/null | fleet_scale_block || true)
  [ "$base_block" = "$head_block" ] || ci_lapse=1
  if ! changed=$(git -C "$root" diff --no-renames --name-only "$base" HEAD); then
    ci_log "git diff from base ${base:0:12} failed"
    rm -rf -- "$tmp"
    return 1
  fi
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if [ "$path" = .github/workflows/ci.yml ]; then
      [ "$ci_lapse" = 1 ] && printf 'ci.yml fleet-scale job\t%s\n' "$path"
      continue
    fi
    group=$(fleet_lapse_group "$path" "$tmp/closure" "$tmp/godirs") || continue
    printf '%s\t%s\n' "$group" "$path"
  done <<<"$changed"
  rm -rf -- "$tmp"
  return 0
}

# fleet_anchors_file: the anchors file of the current stamp directory (the self-test gate has its own).
fleet_anchors_file() {
  printf '%s/%s/fleet-scale-anchors\n' \
    "$(git -C "$CI_REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)" "$(ci_stamp_subdir)"
}

# fleet_find_base: prints "<full sha><TAB><baseKind><TAB><anchorReason>" for the nearest verified ancestor of HEAD on
# the first-parent path from the merge base with origin/master (from HEAD^1 when HEAD is already on origin/master).
# baseKind is stamp-pass, stamp-waived or anchor; anchorReason is set only for an anchor. Returns 1 when no verified
# base is found within 500 commits.
fleet_find_base() {
  local start commit steps stamp tree result anchors file line sha reason
  git -C "$CI_REPO_ROOT" rev-parse --verify --quiet origin/master >/dev/null || {
    ci_log "origin/master is not available; run: git fetch origin master"
    return 1
  }
  if git -C "$CI_REPO_ROOT" merge-base --is-ancestor HEAD origin/master; then
    start=$(git -C "$CI_REPO_ROOT" rev-parse --verify --quiet "HEAD^1") || {
      ci_log "HEAD is on origin/master and has no parent to search from"
      return 1
    }
  else
    start=$(git -C "$CI_REPO_ROOT" merge-base HEAD origin/master) || {
      ci_log "HEAD has no merge base with origin/master"
      return 1
    }
  fi

  # Malformed anchor lines are ignored with a warning; every other line is "<full sha> <reason>".
  anchors=""
  file=$(fleet_anchors_file)
  if [ -f "$file" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      [ -n "$line" ] || continue
      sha=${line%% *}
      reason=${line#* }
      if [[ "$sha" =~ ^[0-9a-f]{40}$ ]] && [ "$reason" != "$line" ] && [ -n "${reason//[[:space:]]/}" ]; then
        anchors="$anchors$sha"$'\t'"$reason"$'\n'
      else
        ci_log "ignored a malformed fleet-scale anchor (expected '<full sha> <reason>'): $file"
      fi
    done <"$file"
  fi

  commit=$start
  steps=0
  while [ "$steps" -lt 500 ]; do
    tree=$(git -C "$CI_REPO_ROOT" rev-parse "$commit^{tree}")
    stamp="$(git -C "$CI_REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)/$(ci_stamp_subdir)/$tree.json"
    if [ -f "$stamp" ]; then
      result=$(jq -r '.jobs["fleet-scale"].result // "missing"' "$stamp" 2>/dev/null || printf 'missing')
      case "$result" in
        pass) printf '%s\tstamp-pass\t\n' "$commit"; return 0 ;;
        pass-waived) printf '%s\tstamp-waived\t\n' "$commit"; return 0 ;;
      esac
    fi
    while IFS=$'\t' read -r sha reason; do
      if [ "$sha" = "$commit" ]; then
        printf '%s\tanchor\t%s\n' "$commit" "$reason"
        return 0
      fi
    done <<<"$anchors"
    commit=$(git -C "$CI_REPO_ROOT" rev-parse --verify --quiet "$commit^1") || {
      ci_log "no verified fleet-scale base: no stamp or anchor on the first-parent path from ${start:0:12}"
      return 1
    }
    steps=$((steps + 1))
  done
  ci_log "no verified fleet-scale base within 500 commits of ${start:0:12}"
  return 1
}
