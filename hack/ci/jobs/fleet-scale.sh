#!/usr/bin/env bash
# Local mirror of the ci.yml job "fleet-scale" (Controlled fleet scale gate).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../fleet-lapse.sh"
ci_job_init fleet-scale

# Upload fleet scale evidence (ci.yml) -> copied on exit.
ci_collect artifacts/fleet-scale

# ci.yml runs this gate on ubuntu-latest, which is a linux/amd64 Docker server. The gate is not skipped
# or rewritten here. A Docker server of another platform (an arm64 Docker Desktop, for example) cannot
# pass the UI half, so this job selects a remote linux/amd64 context through PAPRIKA_CI_FLEET_SCALE_DOCKER_CONTEXT.
# Only this job exports it; the other jobs keep the developer's Docker context. See docs/guides/local-ci.md.
if [ -n "${PAPRIKA_CI_FLEET_SCALE_DOCKER_CONTEXT:-}" ]; then
  export DOCKER_CONTEXT="$PAPRIKA_CI_FLEET_SCALE_DOCKER_CONTEXT"
fi
docker info >/dev/null 2>&1 || ci_die "Docker is not running (context: ${DOCKER_CONTEXT:-default})"
fleet_platform=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}' 2>/dev/null || true)

# The gate runs as ci.yml runs it, unconditionally. A native amd64 server runs the whole gate. An arm64 server runs
# the API half only, under amd64 emulation: the two variables below select that, and the gate script refuses any
# other platform. The UI half is then waived, unless this tree changes what the UI half measures (fleet-lapse.sh).
emulated=0
if [ "$fleet_platform" = linux/arm64 ]; then
  ci_log "Docker server is linux/arm64: running the API half under linux/amd64 emulation"
  export PAPRIKA_FLEET_SCALE_PARTS=api PAPRIKA_FLEET_SCALE_ALLOW_EMULATED_AMD64=1
  emulated=1
elif [ "$fleet_platform" != linux/amd64 ] && [ "$fleet_platform" != linux/x86_64 ]; then
  ci_die "fleet-scale needs a linux/amd64 Docker server; the selected server reports ${fleet_platform:-nothing}. Set PAPRIKA_CI_FLEET_SCALE_DOCKER_CONTEXT to a remote linux/amd64 Docker context (docs/guides/local-ci.md)"
fi

# The lapse decision comes first, so a tree that lapses the waiver fails before the API half runs.
if [ "$emulated" = 1 ]; then
  base_line=$(fleet_find_base) ||
    ci_die "no verified base for the fleet-scale waiver: record one with task ci:fleet-anchor -- <sha> <reason> (docs/guides/local-ci.md)"
  IFS=$'\t' read -r base base_kind anchor_reason <<<"$base_line"
  lapsing=$(fleet_lapse_list "$base" "$CI_REPO_ROOT") ||
    ci_die "could not compute the fleet-scale lapse set from base ${base:0:12}"
  if [ -n "$lapsing" ]; then
    listed=$(printf '%s\n' "$lapsing" | awk -F'\t' '{ printf "  %s (%s)\n", $2, $1 }')
    ci_die "the change touches the fleet UI half, so its waiver lapses; this run cannot pass. Changed paths:
$listed
Get a full run on a native linux/amd64 Docker server that sees the same paths: set PAPRIKA_CI_FLEET_SCALE_DOCKER_CONTEXT to that remote context (docs/guides/local-ci.md)"
  fi
  ci_log "fleet-scale waiver base ${base:0:12} ($base_kind${anchor_reason:+: $anchor_reason})"
fi

bash hack/test-fleet-scale.sh

if [ "$emulated" = 0 ]; then
  exit 0
fi

api_p95=$(sed -n 's/^FLEET_API_P95_MS=//p' artifacts/fleet-scale/api-scale.log | tail -1)
[[ "$api_p95" =~ ^[0-9]+([.][0-9]+)?$ ]] || ci_die "the API half did not report a numeric FLEET_API_P95_MS"
ci_log "FLEET_API_P95_MS=$api_p95"

# --no-renames: a rename lists its old path too (the lapse check above relies on it).
checked=$(git diff --no-renames --name-only "$base" HEAD | grep -c . || true)

# Recorded by hack/ci/run.sh as result pass-waived, with the waiver object, in the stamp.
[ -n "${PAPRIKA_CI_WAIVER_FILE:-}" ] || ci_die "run this job through hack/ci/run.sh (no waiver file)"
reason="UI scale half needs a native linux/amd64 Docker server; this host runs amd64 under emulation (measured UI p95 3978 ms vs 2000 ms on unchanged master)"
jq -n --arg reason "$reason" --arg base "$base" --arg kind "$base_kind" --arg anchor "$anchor_reason" \
  --argjson checked "$checked" --argjson api "$api_p95" \
  '{part: "ui", reason: $reason, base: $base, baseKind: $kind, checkedPaths: $checked, apiP95Ms: $api} +
   (if $kind == "anchor" then {anchorReason: $anchor} else {} end)' >"$PAPRIKA_CI_WAIVER_FILE"
ci_log "UI half waived for this tree: no fleet UI path among $checked changed paths since ${base:0:12}"
