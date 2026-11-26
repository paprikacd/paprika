#!/usr/bin/env bash
# Prints the local CI stamp for a revision's git tree. Exits 0 only when every ci.yml job passed
# for that tree, under the current ci.yml and the current tool pins.
#
# Usage: hack/ci/status.sh [rev]        (default: HEAD)
set -Eeuo pipefail

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

rev=${1:-HEAD}
# Under PAPRIKA_CI_SELFTEST=1 this reads the self-test stamps, which the pre-push gate and the deploy trust like real ones.
if ci_selftest; then
  ci_log "PAPRIKA_CI_SELFTEST=1 is set: reading the self-test stamps (paprika-ci-selftest), not the developer's stamps (paprika-ci)"
fi
commit=$(git -C "$CI_REPO_ROOT" rev-parse --verify --quiet "$rev^{commit}") || ci_die "unknown revision: $rev"
tree=$(git -C "$CI_REPO_ROOT" rev-parse "$commit^{tree}")
tree12=${tree:0:12}
common_dir=$(git -C "$CI_REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)
stamp="$common_dir/$(ci_stamp_subdir)/$tree.json"

# The ci.yml that defines this commit is the one that counts, not the working copy's.
ci_yml=$(mktemp "${TMPDIR:-/tmp}/paprika-ci-yml.XXXXXX")
trap 'rm -f -- "$ci_yml"' EXIT
git -C "$CI_REPO_ROOT" show "$commit:.github/workflows/ci.yml" >"$ci_yml" ||
  ci_die "$commit has no .github/workflows/ci.yml"
ci_check_pins "$ci_yml" "$commit"
ci_check_job_names "$ci_yml"
ci_yml_sha=$(ci_sha256_file "$ci_yml")
pins=$(ci_pins_json)

stamp_ok=0
if [ -f "$stamp" ]; then
  if jq -e --arg sha "$ci_yml_sha" --argjson tools "$pins" --arg tree "$tree" \
    '.schema == 1 and .tree == $tree and .ciYmlSha256 == $sha and .tools == $tools' "$stamp" >/dev/null 2>&1; then
    stamp_ok=1
  else
    ci_log "stamp $stamp does not match this commit's ci.yml or the tool pins; it does not count"
  fi
else
  ci_log "no stamp for tree $tree12 (commit ${commit:0:12}); run: task ci"
fi

passing=0
waived=0
missing=""
printf '%-24s %-11s %8s\n' job result seconds
for job in $CI_JOBS; do
  result=missing
  seconds=-
  if [ "$stamp_ok" = 1 ]; then
    result=$(jq -r --arg j "$job" '.jobs[$j].result // "missing"' "$stamp")
    seconds=$(jq -r --arg j "$job" '.jobs[$j].seconds // "-"' "$stamp")
  fi
  printf '%-24s %-11s %8s\n' "$job" "$result" "$seconds"
  case "$result" in
    pass)
      passing=$((passing + 1))
      ;;
    pass-waived)
      # Only fleet-scale may pass with a waiver, and only one for its UI half, well formed. Anything else fails.
      if [ "$job" = fleet-scale ] && jq -e --arg j "$job" '
          .jobs[$j].waiver | type == "object" and .part == "ui" and
          (.reason | type == "string" and length > 0) and
          (.base | type == "string" and test("^[0-9a-f]{40}$")) and
          (.baseKind | . == "stamp-pass" or . == "stamp-waived" or . == "anchor") and
          (if .baseKind == "anchor" then (.anchorReason | type == "string" and length > 0)
           else (has("anchorReason") | not) end) and
          (.checkedPaths | type == "number" and . >= 0 and . == floor) and
          (.apiP95Ms | type == "number")' "$stamp" >/dev/null 2>&1; then
        passing=$((passing + 1))
        waived=$((waived + 1))
        waiver_line=$(jq -r --arg j "$job" '.jobs[$j].waiver |
          "WAIVED fleet-scale ui half: \(.reason) (base \(.base[0:12]) \(.baseKind)\(if .baseKind == "anchor" then ": " + .anchorReason else "" end), \(.checkedPaths) paths checked, API p95 \(.apiP95Ms) ms)"' "$stamp")
        printf '%s\n' "$waiver_line"
      else
        ci_log "$job: pass-waived is valid only for fleet-scale with a well-formed ui waiver; this job does not count"
        missing="$missing $job"
      fi
      ;;
    *)
      missing="$missing $job"
      ;;
  esac
done

total=$(printf '%s\n' "$CI_JOBS" | tr ' ' '\n' | grep -c .)
if [ -z "$missing" ]; then
  if [ "$waived" -gt 0 ]; then
    printf 'ci:status: PASS tree %s (commit %s): all %s jobs passed (%s waived, see the WAIVED line)\n' \
      "$tree12" "${commit:0:12}" "$total" "$waived"
  else
    printf 'ci:status: PASS tree %s (commit %s): all %s jobs passed\n' "$tree12" "${commit:0:12}" "$total"
  fi
  exit 0
fi
printf 'ci:status: FAIL tree %s (commit %s): %s of %s jobs passing; not passing: %s\n' \
  "$tree12" "${commit:0:12}" "$passing" "$total" "${missing# }"
exit 1
