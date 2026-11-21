#!/usr/bin/env bash
# Records a commit as a verified base for the fleet-scale UI-half waiver (see hack/ci/fleet-lapse.sh).
#
# Usage: hack/ci/fleet-anchor.sh add <rev> <reason...>     (task ci:fleet-anchor -- <rev> <reason>)
#        hack/ci/fleet-anchor.sh list
#
# The anchors file is "<git common dir>/<stamp directory>/fleet-scale-anchors", one "<full sha> <reason>" line per
# anchor. Use it only for a commit whose full fleet-scale run was seen to pass (a native linux/amd64 run, or a
# waiver that was recorded for that tree). The self-test gate writes to its own stamp directory.
set -Eeuo pipefail

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/fleet-lapse.sh"

file=$(fleet_anchors_file)
usage() {
  ci_log "usage: hack/ci/fleet-anchor.sh add <rev> <reason...> | list"
  exit 2
}

case "${1:-}" in
  add)
    [ "$#" -ge 3 ] || usage
    rev=$2
    shift 2
    reason="$*"
    sha=$(git -C "$CI_REPO_ROOT" rev-parse --verify --quiet "$rev^{commit}") || ci_die "not a commit: $rev"
    [ -n "${reason//[[:space:]]/}" ] || ci_die "the reason must not be empty"
    case "$reason" in
      *$'\n'* | *$'\t'*) ci_die "the reason must be a single line without tabs" ;;
    esac
    mkdir -p -- "$(dirname "$file")"
    printf '%s %s\n' "$sha" "$reason" >>"$file"
    ci_log "recorded fleet-scale anchor ${sha} in $file: $reason"
    ;;
  list)
    if [ -f "$file" ]; then
      cat -- "$file"
    else
      ci_log "no anchors recorded ($file)"
    fi
    ;;
  *)
    usage
    ;;
esac
