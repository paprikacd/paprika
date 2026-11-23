#!/usr/bin/env bash
# Runs the local CI jobs (the 13 ci.yml jobs that GitHub would run) against HEAD.
#
# Usage: hack/ci/run.sh [--jobs a,b] [--parallel N] [--allow-dirty] [--rerun-failed]
#   --jobs a,b       run only these jobs (default: all 13)
#   --parallel N     jobs that run at the same time (default 3, or PAPRIKA_CI_PARALLEL)
#   --allow-dirty    snapshot the working tree (tracked changes only) for a report; writes NO stamp
#   --rerun-failed   skip jobs that already pass in this tree's stamp
#
# Every job gets its own detached worktree of the same commit, as each GitHub job gets its own
# checkout, so jobs never share generated files, node_modules or bin/. The worktrees sit at stable
# paths under the cache root (prepare_job_dir), so Go's build and test caches carry over between runs.
# Uncommitted files cannot count toward a pass. Results merge into the stamp
# <git-common-dir>/paprika-ci/<tree>.json, keyed by the git tree.
set -Eeuo pipefail

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,11p' "${BASH_SOURCE[0]}" >&2
  exit 2
}

jobs_arg=""
jobs_given=0
parallel=${PAPRIKA_CI_PARALLEL:-3}
allow_dirty=0
rerun_failed=0
while [ $# -gt 0 ]; do
  case "$1" in
    --jobs)
      [ $# -ge 2 ] || usage
      [ -n "$2" ] || ci_die "--jobs needs at least one job name (an empty value would mean all jobs)"
      jobs_arg=${2//,/ }
      jobs_given=1
      shift 2
      ;;
    --parallel)
      [ $# -ge 2 ] || usage
      parallel=$2
      shift 2
      ;;
    --allow-dirty)
      allow_dirty=1
      shift
      ;;
    --rerun-failed)
      rerun_failed=1
      shift
      ;;
    -h | --help)
      usage
      ;;
    *)
      ci_die "unknown argument: $1"
      ;;
  esac
done

case "$parallel" in
  '' | *[!0-9]*) ci_die "--parallel must be a whole number from 1 to 8" ;;
esac
[ "$parallel" -ge 1 ] && [ "$parallel" -le 8 ] || ci_die "--parallel must be from 1 to 8"

# Selected jobs, in ci.yml order.
selected=""
if [ "$jobs_given" = 0 ]; then
  selected=$CI_JOBS
else
  for job in $jobs_arg; do
    case " $CI_JOBS " in
      *" $job "*) ;;
      *) ci_die "unknown job '$job'; valid jobs: $CI_JOBS" ;;
    esac
  done
  for job in $CI_JOBS; do
    case " $jobs_arg " in
      *" $job "*) selected="$selected $job" ;;
    esac
  done
  selected=${selected# }
fi

# Which commit runs. A dirty tree is refused unless --allow-dirty (report only).
commit=$(git -C "$CI_REPO_ROOT" rev-parse --verify "HEAD^{commit}")
snapshot_src=$commit
if [ -n "$(git -C "$CI_REPO_ROOT" status --porcelain)" ]; then
  [ "$allow_dirty" = 1 ] || ci_die "working tree is dirty; commit or stash first, or pass --allow-dirty (report only, writes no stamp)"
  ci_log "warning: --allow-dirty snapshots tracked changes only (git stash create); untracked files are not included"
  stash_commit=$(git -C "$CI_REPO_ROOT" stash create || true)
  if [ -n "$stash_commit" ]; then
    snapshot_src=$stash_commit
  fi
fi
tree=$(git -C "$CI_REPO_ROOT" rev-parse "$snapshot_src^{tree}")
tree12=${tree:0:12}
common_dir=$(git -C "$CI_REPO_ROOT" rev-parse --path-format=absolute --git-common-dir)
stamp_dir="$common_dir/$(ci_stamp_subdir)"
stamp="$stamp_dir/$tree.json"
artifact_dir="$CI_REPO_ROOT/artifacts/ci/$tree12"
work=$(mktemp -d "${PAPRIKA_CI_TMPDIR:-${TMPDIR:-/tmp}}/paprika-ci-run.XXXXXX")
results_dir="$work/results"
ci_yml_file="$work/ci.yml"
mkdir -p -- "$results_dir" "$artifact_dir"

# Set before the cleanup trap: stable_jobs=1 once this run holds the run lock, which makes it the owner of the stable job
# worktrees. repo_common_dir is the physical git common directory, to which a registered job worktree must belong.
stable_jobs=0
jobs_root=$(ci_cache_root)/paprika-ci/jobs
run_lock=$jobs_root/.run.lock
repo_common_dir=$(cd "$common_dir" && pwd -P)

job_dir() { # job -> the job's own worktree: stable under the cache root, or per run
  if [ "$stable_jobs" = 1 ]; then
    printf '%s/%s' "$jobs_root" "$1"
  else
    printf '%s/job-%s' "$work" "$1"
  fi
}

cleanup() {
  local d
  # Stable job worktrees stay for the next run. Per-run worktrees (the fallback) are removed.
  if [ "$stable_jobs" = 0 ]; then
    for d in "$work"/job-*; do
      [ -e "$d" ] || continue
      git -C "$CI_REPO_ROOT" worktree remove --force "$d" >/dev/null 2>&1 || rm -rf -- "$d"
    done
  fi
  rm -rf -- "$work"
  git -C "$CI_REPO_ROOT" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

# One file per running job, named <job>.<pid> (written by ci_job_init, removed after its cleanup).
pids_dir="$work/pids"
mkdir -p -- "$pids_dir"
# Prints the pids of job processes that are still alive.
running_job_pids() {
  local f pid
  for f in "$pids_dir"/*; do
    [ -e "$f" ] || continue
    pid=${f##*.}
    if kill -0 "$pid" 2>/dev/null; then printf '%s\n' "$pid"; fi
  done
}

# Ctrl-C reaches run.sh, but the jobs run in their own process groups (gtimeout) or ignore SIGINT
# as background jobs of a non-interactive shell. So the whole process tree of every job is stopped,
# then run.sh polls until every job has exited (each job's EXIT trap, docker rm and kind delete, runs
# inside that wait) and only then removes the worktrees. The wait is bounded; a job still running
# after it is killed outright.
on_signal() {
  trap '' INT TERM HUP
  ci_log "interrupted; stopping jobs and their children"
  local pid deadline
  for pid in $(jobs -p); do
    ci_kill_tree "$pid"
  done
  # The wait is on the job processes themselves (see PAPRIKA_CI_PIDS_DIR in ci_job_init), not on this
  # shell's job table, which forgets a job as soon as its wrapper has stopped.
  deadline=$((SECONDS + ${PAPRIKA_CI_INTERRUPT_WAIT:-180}))
  while [ -n "$(running_job_pids)" ] && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 1
  done
  for pid in $(running_job_pids); do
    ci_log "job process $pid is still running after the wait; killing it"
    kill -KILL "$pid" 2>/dev/null || true
  done
  exit 130
}
trap on_signal INT TERM HUP

# The stable job worktrees are shared by every run that uses this cache root, so one run at a time owns them. The owner
# holds an advisory lock (flock) on $jobs_root/.run.lock: run.sh keeps that file open on fd 9, and every job inherits
# fd 9. The kernel releases the lock when the last of those processes exits, so a crash never leaves it held and no pid
# is kept. A run that finds the lock held uses per-run job worktrees instead, which are removed at its end, so its
# caches are not reused.
acquire_job_lock() {
  local rc=0
  mkdir -p -- "$jobs_root"
  # The directory lock of an earlier version of this runner, which no run creates any more.
  rm -rf -- "$jobs_root/.lock"
  # The physical path: git reports worktree paths physically, and prepare_job_dir compares them with this one.
  jobs_root=$(cd "$jobs_root" && pwd -P)
  run_lock=$jobs_root/.run.lock
  exec 9>>"$run_lock"
  perl -MFcntl=:flock -e 'open(my $f, ">&=", 9) or exit 2; flock($f, LOCK_EX | LOCK_NB) or exit 1' || rc=$?
  case "$rc" in
    0) stable_jobs=1 ;;
    1) ci_log "another local CI run holds the job worktree lock ($run_lock): this run uses per-run job worktrees, and its caches are not reused for this run" ;;
    *) ci_die "cannot take the job worktree lock $run_lock (perl exit $rc)" ;;
  esac
}
acquire_job_lock
if [ "$stable_jobs" = 1 ]; then
  # The Go build cache is trimmed by the lock holder only, once per run and before any job starts.
  ci_trim_go_cache
else
  ci_log "go build cache trim skipped: another run holds the job lock"
fi

# ci_clean_worktree <dir> [git clean options]: removes the untracked and ignored files of a job worktree. The Next.js
# cache and the envtest assets are kept, unless ci_fresh (task ci FRESH=1), which removes everything.
ci_clean_worktree() {
  local dir=$1
  shift
  if ci_fresh; then
    git -C "$dir" clean -ffdx "$@"
  else
    git -C "$dir" clean -ffdx "$@" -e ui/.next/cache -e bin/k8s
  fi
}

# job_is_ours <dir>: the directory is a worktree that this repository has registered, and its common git directory is
# this repository's (compared physically, so a symlinked path does not look like another repository).
job_is_ours() {
  local dir=$1 registered theirs
  [ -d "$dir" ] || return 1
  registered=$(git -C "$CI_REPO_ROOT" worktree list --porcelain) || return 1
  grep -qxF -- "worktree $dir" <<<"$registered" || return 1
  theirs=$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  theirs=$(cd "$theirs" 2>/dev/null && pwd -P) || return 1
  [ "$theirs" = "$repo_common_dir" ]
}

# job_reset <dir>: checks the worktree out at the snapshot and removes what the reset does not keep. Fails when git cannot
# do either (for example, an assume-unchanged file blocks checkout), and the caller then rebuilds the worktree.
job_reset() {
  git -C "$1" checkout --force --detach --quiet "$snapshot_src" && ci_clean_worktree "$1" -q
}

# job_flags_clean <dir>: no file of the worktree carries an index flag (skip-worktree or assume-unchanged, as
# git ls-files -v shows them). Such a file keeps its content through checkout --force while git status shows nothing for
# it, so a worktree with a flag is rebuilt.
job_flags_clean() {
  local flagged
  flagged=$(git -C "$1" ls-files -v | grep -v '^H ' || true)
  if [ -z "$flagged" ]; then return 0; fi
  ci_log "job worktree $1 keeps index flags (skip-worktree or assume-unchanged) on: $(cut -c3- <<<"$flagged" | tr '\n' ' ')"
  return 1
}

# job_rebuild <dir>: replaces the directory with a new worktree of the snapshot, at the same path.
job_rebuild() {
  rm -rf -- "$1"
  git -C "$CI_REPO_ROOT" worktree prune
  git -C "$CI_REPO_ROOT" worktree add --detach --force --quiet "$1" "$snapshot_src"
}

# Stable mode keeps a job's worktree at the same path between runs, because Go reuses build and test results only at
# the same path. Each run resets the worktree to the snapshot (ci_clean_worktree), then checks it: no index flags, and
# nothing left that a clean would remove (what is left is checked with a dry run). A worktree that cannot be reset, or
# that carries index flags, is rebuilt. Per-run mode creates a new one.
prepare_job_dir() { # job
  local job=$1 dir leftover
  dir=$(job_dir "$job")
  if [ "$stable_jobs" != 1 ]; then
    git -C "$CI_REPO_ROOT" worktree add --detach --quiet "$dir" "$snapshot_src"
    return 0
  fi
  if ! job_is_ours "$dir" || ! job_reset "$dir" || ! job_flags_clean "$dir"; then
    if [ -e "$dir" ]; then ci_log "job worktree $dir cannot be reused: rebuilding it"; fi
    job_rebuild "$dir"
  fi
  # What is left: tracked changes, and untracked or ignored files that a clean would still remove.
  leftover=$(git -C "$dir" status --porcelain --untracked-files=no)
  leftover="$leftover$(ci_clean_worktree "$dir" -n)"
  [ -z "$leftover" ] || ci_die "job worktree $dir is not clean after the reset; remove it and run again: $leftover"
}

# The ci.yml file of the commit (pins, job names, timeouts). Jobs read their own worktree's copy.
git -C "$CI_REPO_ROOT" show "$snapshot_src:.github/workflows/ci.yml" >"$ci_yml_file" ||
  ci_die "ci.yml is missing from $snapshot_src"
ci_check_pins "$ci_yml_file"
ci_check_job_names "$ci_yml_file"
ci_yml_sha=$(ci_sha256_file "$ci_yml_file")

ci_log "ensuring pinned tools"
bash "$CI_LIB_DIR/tools.sh" ensure
tools_json=$(bash "$CI_LIB_DIR/tools.sh" json 2>/dev/null)
node22=$(ci_node22_bin) || ci_die "Node ${CI_NODE_MAJOR} not found; set PAPRIKA_NODE22"
# The developer's default Docker context, resolved once. DOCKER_CONTEXT and DOCKER_HOST from the shell do not
# choose it: every job gets this context name and no other Docker setting (see ci_export_job_env).
docker_context=default
if command -v docker >/dev/null 2>&1; then
  docker_context=$(env -u DOCKER_CONTEXT -u DOCKER_HOST docker context show 2>/dev/null || printf default)
fi

# The stamp is loaded only when it matches this tree's ci.yml and the tool pins; otherwise it is reset.
persist=$((1 - allow_dirty))
if [ "$persist" = 1 ]; then
  mkdir -p -- "$stamp_dir"
  if [ -f "$stamp" ] && jq -e --arg sha "$ci_yml_sha" --argjson tools "$tools_json" --arg tree "$tree" \
    '.schema == 1 and .tree == $tree and .ciYmlSha256 == $sha and .tools == $tools' "$stamp" >/dev/null 2>&1; then
    :
  else
    jq -n --arg tree "$tree" --arg commit "$commit" --arg sha "$ci_yml_sha" --argjson tools "$tools_json" \
      '{schema: 1, tree: $tree, commit: $commit, ciYmlSha256: $sha, tools: $tools, jobs: {}}' >"$stamp.tmp.$$"
    mv -- "$stamp.tmp.$$" "$stamp"
  fi
fi

record_result() { # job result seconds finishedAt [waiver-json]
  [ "$persist" = 1 ] || return 0
  local tmp="$stamp.tmp.$$" waiver=${5:-null}
  jq --arg job "$1" --arg result "$2" --argjson seconds "$3" --arg at "$4" \
    --arg commit "$commit" --arg log "artifacts/ci/$tree12/$1.log" --argjson waiver "$waiver" \
    '.commit = $commit | .jobs[$job] = ({result: $result, seconds: $seconds, log: $log, finishedAt: $at} + (if $waiver == null then {} else {waiver: $waiver} end))' \
    "$stamp" >"$tmp"
  mv -- "$tmp" "$stamp"
}

already_passing() { # job
  [ "$persist" = 1 ] && [ -f "$stamp" ] &&
    jq -e --arg j "$1" '.jobs[$j].result == "pass"' "$stamp" >/dev/null 2>&1
}

run_one() { # job
  local job=$1 mins secs start rc=0 seconds result finished dir var
  local -a job_env
  dir=$(job_dir "$job")
  mins=$(ci_job_timeout_minutes "$ci_yml_file" "$job")
  [ -n "$mins" ] || ci_die "ci.yml has no timeout-minutes for $job"
  secs=$((mins * 60))
  ci_log "$job: time limit $secs s (ci.yml timeout-minutes $mins)"
  # Test hook: the timeout self-test uses a few seconds instead of the ci.yml limit.
  if ci_selftest && [ -n "${PAPRIKA_CI_SELFTEST_TIMEOUT_SECS:-}" ]; then
    secs=$PAPRIKA_CI_SELFTEST_TIMEOUT_SECS
    ci_log "$job: test override, stopping after $secs s"
  fi
  start=$(date +%s)
  # A job may record a waiver for part of its gate (only fleet-scale does; see status.sh). The file is written by the
  # job itself, so a job that passes without one is a plain pass.
  waiver_file="$work/waiver-$job.json"
  (
    cd "$dir"
    export PAPRIKA_CI_WAIVER_FILE="$waiver_file"
    export PAPRIKA_CI_SNAPSHOT="$dir"
    export PAPRIKA_CI_TREE="$tree" PAPRIKA_CI_TREE12="$tree12" PAPRIKA_CI_COMMIT="$commit"
    # The jobs use the directory that tools.sh verified above, which PAPRIKA_CI_TOOL_BIN may override.
    export PAPRIKA_CI_TOOL_BIN="$CI_TOOL_BIN" PAPRIKA_NODE22="$node22"
    export PAPRIKA_CI_ARTIFACT_DIR="$artifact_dir" PAPRIKA_CI_TMPDIR="$work" PAPRIKA_CI_PIDS_DIR="$pids_dir"
    export PAPRIKA_CI_DOCKER_CONTEXT="$docker_context"
    # The job starts from an environment holding only the allowlisted names (ci_env_allowed), so a BASH_ENV file, an
    # exported function or a developer setting is never read by the job's shell. Values are copied as they are.
    job_env=()
    while IFS= read -r var; do
      if ci_env_allowed "$var"; then job_env+=("$var=${!var}"); fi
    done < <(compgen -e)
    ci_with_timeout "$secs" env -i "${job_env[@]}" bash "$dir/hack/ci/jobs/$job.sh"
  ) >"$artifact_dir/$job.log" 2>&1 || rc=$?
  seconds=$(($(date +%s) - start))
  case "$rc" in
    0)
      result=pass
      if [ -e "$waiver_file" ]; then
        if [ "$job" = fleet-scale ] && jq -e 'type == "object"' "$waiver_file" >/dev/null 2>&1; then
          result=pass-waived
          cp -- "$waiver_file" "$results_dir/$job.waiver"
        else
          ci_log "$job: a waiver is only accepted for fleet-scale, as a JSON object; this job fails"
          result=fail
        fi
      fi
      ;;
    124) result=timeout ;;
    *) result=fail ;;
  esac
  finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '%s %s %s\n' "$result" "$seconds" "$finished" >"$results_dir/$job"
}

merge_result() { # job
  local job=$1 result seconds finished waiver=null
  if [ ! -f "$results_dir/$job" ]; then
    record_result "$job" fail 0 "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 0
  fi
  read -r result seconds finished <"$results_dir/$job"
  if [ -f "$results_dir/$job.waiver" ]; then waiver=$(cat "$results_dir/$job.waiver"); fi
  record_result "$job" "$result" "$seconds" "$finished" "$waiver"
}

parallel_list=""
heavy_list=""
light_list=""
docker_list=""
for job in $selected; do
  if [ "$rerun_failed" = 1 ] && already_passing "$job"; then
    ci_log "skipping $job: already passing for tree $tree12"
    continue
  fi
  case " $CI_DOCKER_JOBS " in
    *" $job "*) docker_list="$docker_list $job" ;;
    *)
      parallel_list="$parallel_list $job"
      case " $CI_HEAVY_JOBS " in
        *" $job "*) heavy_list="${heavy_list:+$heavy_list }$job" ;;
        *) light_list="${light_list:+$light_list }$job" ;;
      esac
      ;;
  esac
done

# One detached worktree per job, prepared before any job starts (serially, so git's admin directory is
# never written by two processes at once).
for job in $parallel_list $docker_list; do
  prepare_job_dir "$job"
done

# A rerun of the same tree writes to the same log paths, so each selected job's previous log and diagnostics move to
# previous/<run id>/ first. Jobs this run does not select keep their logs where the stamp points. The newest
# PAPRIKA_CI_KEEP_PREVIOUS_RUNS (default 5) previous runs are kept for each tree.
archive_previous_logs() {
  local run_id dest job path moved=0 keep dir
  run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  dest="$artifact_dir/previous/$run_id"
  for job in "$@"; do
    for path in "$artifact_dir/$job.log" "$artifact_dir/$job"; do
      [ -e "$path" ] || continue
      mkdir -p -- "$dest"
      mv -- "$path" "$dest/"
      moved=1
    done
  done
  [ "$moved" = 1 ] && ci_log "previous logs for the rerun jobs moved to ${dest#"$CI_REPO_ROOT"/}"
  keep="${PAPRIKA_CI_KEEP_PREVIOUS_RUNS:-5}"
  [[ "$keep" =~ ^[0-9]+$ ]] || ci_die "PAPRIKA_CI_KEEP_PREVIOUS_RUNS must be a whole number, not '$keep'"
  [ -d "$artifact_dir/previous" ] || return 0
  # Run ids sort by time, so everything before the newest $keep entries goes.
  while IFS= read -r dir; do
    rm -rf -- "$dir"
  done < <(find "$artifact_dir/previous" -mindepth 1 -maxdepth 1 -type d | sort -r | tail -n +"$((keep + 1))")
}
# shellcheck disable=SC2086 # the job lists are space-separated job names
archive_previous_logs $parallel_list $docker_list

ci_log "running jobs for tree $tree12 (commit ${commit:0:12}); logs in ${artifact_dir#"$CI_REPO_ROOT"/}"

# Phase 1: portable jobs, at most $parallel at once, and at most one CPU-heavy job (CI_HEAVY_JOBS) at a time. A free
# slot goes to the next heavy job when none is running, otherwise to the next light job.
heavy_pid=""
while [ -n "$heavy_list$light_list" ]; do
  if [ -n "$heavy_pid" ] && ! jobs -rp | grep -qx "$heavy_pid"; then
    heavy_pid=""
  fi
  if [ "$(jobs -rp | wc -l | tr -d ' ')" -lt "$parallel" ]; then
    if [ -z "$heavy_pid" ] && [ -n "$heavy_list" ]; then
      job=${heavy_list%% *}
      heavy_list=${heavy_list#"$job"}
      heavy_list=${heavy_list# }
      run_one "$job" &
      heavy_pid=$!
      continue
    fi
    if [ -n "$light_list" ]; then
      job=${light_list%% *}
      light_list=${light_list#"$job"}
      light_list=${light_list# }
      run_one "$job" &
      continue
    fi
  fi
  sleep 2
done
wait || true
for job in $parallel_list; do
  merge_result "$job"
done

# Phase 2: Docker-heavy jobs, one at a time, so two of them never share the Docker server. Each runs
# in the background and is waited for, so an interrupt is handled while the job is still running.
for job in $docker_list; do
  run_one "$job" &
  wait "$!" || true
  merge_result "$job"
done

failed=0
printf '\n%-24s %-8s %8s  %s\n' job result seconds log
for job in $selected; do
  if [ ! -f "$results_dir/$job" ]; then
    if already_passing "$job"; then
      printf '%-24s %-8s %8s  %s\n' "$job" pass "-" "(kept from stamp)"
    fi
    continue
  fi
  read -r result seconds _ <"$results_dir/$job"
  printf '%-24s %-8s %8s  %s\n' "$job" "$result" "$seconds" "artifacts/ci/$tree12/$job.log"
  case "$result" in
    pass | pass-waived) ;;
    *) failed=$((failed + 1)) ;;
  esac
done
printf '\n'

if [ "$persist" = 1 ]; then
  ci_log "stamp: $stamp"
else
  ci_log "report only (--allow-dirty): no stamp was written"
fi

if [ "$failed" -ne 0 ]; then
  ci_die "$failed job(s) did not pass; see the logs above"
fi
ci_log "all selected jobs passed"
