#!/usr/bin/env bash
# Shared helpers for the local CI runner (hack/ci). Sourced, never executed.
# Bash 3.2 compatible: macOS ships /bin/bash 3.2, so no mapfile, no `wait -n`
# and no associative arrays.

CI_LIB_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
CI_REPO_ROOT=$(cd "$CI_LIB_DIR/../.." && pwd -P)

# Git exports GIT_DIR, GIT_INDEX_FILE and the other repository variables to hooks. A git command that
# inherits them acts on the hook's repository, not the one in its working directory: under a hook,
# `git init --bare <dir>` re-initialises the developer's repository as bare. Everything that sources
# this file runs with them cleared, so git finds its repository from the working directory.
ci_clear_git_env() {
  local var
  for var in $(git rev-parse --local-env-vars 2>/dev/null) GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE \
    GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_PREFIX; do
    unset "$var"
  done
}
ci_clear_git_env

# Pinned versions. ci_check_pins compares them with .github/workflows/ci.yml so
# that they cannot drift silently. Tools are resolved per run by tools.sh.
CI_GO_VERSION=1.27.4
CI_NODE_MAJOR=22
CI_HELM_VERSION=v3.21.2
CI_KIND_VERSION=v0.32.0
CI_TERRAFORM_VERSION=1.14.6
CI_TASK_VERSION=3.52.0
CI_GORELEASER_VERSION=v2.16.0
CI_KIND_LINUX_AMD64_SHA256=50030de23cf40a18505f20426f6a8506bedf13c6e509244bd1fa9463721b0f54

# The pinned tool versions as one compact JSON object (stored in stamps and compared by status.sh).
ci_pins_json() {
  jq -cn --arg go "$CI_GO_VERSION" --arg node "$CI_NODE_MAJOR" --arg helm "$CI_HELM_VERSION" \
    --arg kind "$CI_KIND_VERSION" --arg terraform "$CI_TERRAFORM_VERSION" \
    --arg task "$CI_TASK_VERSION" --arg goreleaser "$CI_GORELEASER_VERSION" \
    '{go: $go, node: $node, helm: $helm, kind: $kind, terraform: $terraform, task: $task, goreleaser: $goreleaser}'
}

# The 13 ci.yml jobs that run locally. publish and deploy-vke are not CI jobs
# here: the deploy path is hack/deploy/vke.sh (a later change).
CI_JOBS="terraform go-test go-lint ui mcp-console generated chart release-contract distribution-contracts fleet-ui-smoke application-records fleet-scale cluster-integration"
# Docker-heavy jobs never run at the same time as each other (read by run.sh).
# shellcheck disable=SC2034
CI_DOCKER_JOBS="application-records fleet-scale cluster-integration"
# CPU-heavy jobs never run at the same time as each other either (read by run.sh): the full -race go test, vitest
# and the browser smoke each fill a laptop's cores, and two of them together push timing-sensitive tests past their
# limits. On GitHub each job had a runner of its own. Lighter jobs still run beside them.
# shellcheck disable=SC2034
CI_HEAVY_JOBS="go-test ui fleet-ui-smoke"

ci_log() {
  printf '[ci %s] %s\n' "$(date -u +%H:%M:%S)" "$*" >&2
}

ci_die() {
  ci_log "error: $*"
  exit 1
}

ci_sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

ci_sha256_stdin() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    shasum -a 256 | awk '{print $1}'
  fi
}

# Prints the ci.yml job keys under `jobs:`, one per line.
ci_ci_yml_jobs() {
  awk '
    /^jobs:/ { in_jobs = 1; next }
    /^[^ #]/ { in_jobs = 0 }
    in_jobs && /^  [A-Za-z0-9_-]+:$/ { name = $0; sub(/^  /, "", name); sub(/:$/, "", name); print name }
  ' "$1"
}

# Prints the job-level timeout-minutes of one job in a ci.yml file.
ci_job_timeout_minutes() {
  local file=$1 job=$2
  awk -v job="$job" '
    $0 == "  " job ":" { in_job = 1; next }
    in_job && /^  [A-Za-z0-9_-]+:$/ { exit }
    in_job && /^    timeout-minutes:/ { print $2; exit }
  ' "$file"
}

# Fails when ci.yml gains or loses a job that hack/ci does not mirror.
ci_check_job_names() {
  local file=$1 listed job
  listed=$(ci_ci_yml_jobs "$file" | grep -vxE 'publish|deploy-vke' || true)
  for job in $listed; do
    case " $CI_JOBS " in
      *" $job "*) ;;
      *) ci_die "ci.yml defines job '$job' with no entry in hack/ci (add hack/ci/jobs/$job.sh and list it in CI_JOBS)" ;;
    esac
  done
  for job in $CI_JOBS; do
    grep -qxF -- "$job" <<<"$listed" || ci_die "hack/ci lists job '$job' that ci.yml does not define"
  done
}

# Fails when a pinned version in lib.sh no longer matches ci.yml.
ci_check_pins() {
  local file=$1 want
  for want in \
    "go-version: '$CI_GO_VERSION'" \
    "node-version: \"$CI_NODE_MAJOR\"" \
    "version: $CI_HELM_VERSION" \
    "version: $CI_TASK_VERSION" \
    "version: $CI_GORELEASER_VERSION" \
    "terraform_version: \"$CI_TERRAFORM_VERSION\"" \
    "dl/$CI_KIND_VERSION/" \
    "KIND_SHA256: $CI_KIND_LINUX_AMD64_SHA256"; do
    grep -qF -- "$want" "$file" || ci_die "ci.yml no longer contains the pinned '$want'; update the pins in hack/ci/lib.sh"
  done
}

# Directory with the pinned tools (gitignored under bin/). A snapshot run gets
# the developer checkout's path through PAPRIKA_CI_TOOL_BIN.
CI_TOOL_BIN=${PAPRIKA_CI_TOOL_BIN:-$CI_REPO_ROOT/bin/ci-tools}

# Prints the bin directory of the newest Node 22 install. PAPRIKA_NODE22 wins.
ci_node22_bin() {
  local dir version
  if [ -n "${PAPRIKA_NODE22:-}" ]; then
    printf '%s\n' "$PAPRIKA_NODE22"
    return 0
  fi
  dir=$(
    for candidate in "$HOME/.nvm/versions/node/v$CI_NODE_MAJOR".*/bin; do
      [ -d "$candidate" ] && printf '%s\n' "$candidate"
    done | sort -V | tail -1
  )
  [ -n "$dir" ] && [ -x "$dir/node" ] || return 1
  version=$("$dir/node" --version)
  case "$version" in
    v${CI_NODE_MAJOR}.*) printf '%s\n' "$dir" ;;
    *) return 1 ;;
  esac
}

# Stops a process and all of its descendants. The parent goes first, so that a shell waiting on a child
# runs its TERM trap at once (its cleanup, then its exit) instead of continuing after the child dies. The
# child list is read before the parent is stopped, because the children are re-parented once it is gone.
# gtimeout puts its child in a new process group, so a group signal would miss it.
ci_kill_tree() { # pid [signal, TERM by default]
  local child children sig=${2:-TERM}
  children=$(pgrep -P "$1" 2>/dev/null || true)
  kill -"$sig" "$1" 2>/dev/null || true
  for child in $children; do
    ci_kill_tree "$child" "$sig"
  done
}

# Runs a command with a hard time limit. Exit 124 means the limit was hit.
ci_with_timeout() {
  local secs=$1
  shift
  # A stopped job gets this long to finish its EXIT trap (diagnostics, cluster and container cleanup)
  # before gtimeout sends KILL. It is generous on purpose: a job killed mid-cleanup can leave its cluster behind.
  local kill_after=${PAPRIKA_CI_KILL_AFTER:-120}
  # The command runs in the background and is waited for. A shell that waits on a foreground command runs its
  # TERM trap only after that command exits; a shell in `wait` runs it at once, so a stop reaches the children
  # (ci_stop_children) without waiting for the time limit.
  if command -v gtimeout >/dev/null 2>&1 || command -v timeout >/dev/null 2>&1; then
    local rc=0 pid
    if command -v gtimeout >/dev/null 2>&1; then
      gtimeout --kill-after="$kill_after" "$secs" "$@" &
    else
      timeout --kill-after="$kill_after" "$secs" "$@" &
    fi
    pid=$!
    # Recorded before the wait: a stop that reaches this shell (or a subshell that dies first) finds the step.
    ci_register_child "$pid"
    wait "$pid" || rc=$?
    ci_unregister_child "$pid"
    return "$rc"
  else
    local flag pid watcher rc
    flag=$(mktemp "${TMPDIR:-/tmp}/paprika-ci-timeout.XXXXXX")
    "$@" &
    pid=$!
    ci_register_child "$pid"
    ( sleep "$secs"; echo expired >"$flag"; kill -TERM "$pid" 2>/dev/null ) &
    watcher=$!
    rc=0
    wait "$pid" || rc=$?
    ci_unregister_child "$pid"
    ci_kill_tree "$watcher"
    wait "$watcher" 2>/dev/null || true
    if [ -s "$flag" ]; then
      rc=124
    fi
    rm -f -- "$flag"
    return "$rc"
  fi
}

# Environment shared by every job. It is an allowlist, not the developer's shell: every exported
# variable that is not listed below is removed, so a stale or planted setting (GOFLAGS, NODE_OPTIONS,
# GOARCH, CGO_ENABLED, npm_config_*, AWS_*, CLOUDSDK_*, DOCKER_HOST, KUBECONFIG, GH_TOKEN, ...) never
# reaches a job. The variables that ci.yml sets for one job or step are exported by that job's script.
# hack/test-local-ci.sh plants these names and checks that they are absent.
# ci_env_allowed <name>: true for a variable a job may inherit. run.sh starts each job with exactly these
# (env -i), and ci_export_job_env removes every other exported variable.
ci_env_allowed() {
  case "$1" in
    PAPRIKA_CI_SELFTEST_*) ci_selftest && return 0 || return 1 ;;
    HOME | USER | LOGNAME | SHELL | LANG | LC_* | TERM | TMPDIR | PATH | SSH_AUTH_SOCK) return 0 ;;
    PAPRIKA_CI_* | PAPRIKA_NODE22) return 0 ;;
    GOCACHE | GOMODCACHE | GOPATH | DOCKER_CONFIG) return 0 ;;
  esac
  return 1
}

# The self-test gate. Only hack/test-local-ci.sh sets PAPRIKA_CI_SELFTEST=1. Under the gate, the PAPRIKA_CI_SELFTEST_*
# knobs are honoured and stamps go to a separate directory, so a self-test run can never write or read a real stamp,
# and a knob set in a developer's shell does nothing.
ci_selftest() {
  [ "${PAPRIKA_CI_SELFTEST:-0}" = 1 ]
}

# The stamp directory under the git common dir: paprika-ci, or paprika-ci-selftest under the gate.
ci_stamp_subdir() {
  if ci_selftest; then printf 'paprika-ci-selftest\n'; else printf 'paprika-ci\n'; fi
}

# ci_cache_root: the cache directory of the local CI runner. PAPRIKA_CI_CACHE_ROOT wins; otherwise the user's cache
# directory (~/Library/Caches on macOS, $XDG_CACHE_HOME or ~/.cache elsewhere). Everything the runner keeps between runs
# (the Go build cache, the stable job worktrees and the run lock) lives under paprika-ci/ below it.
ci_cache_root() {
  if [ -n "${PAPRIKA_CI_CACHE_ROOT:-}" ]; then
    printf '%s\n' "$PAPRIKA_CI_CACHE_ROOT"
  elif [ "$(uname -s)" = Darwin ]; then
    printf '%s/Library/Caches\n' "$HOME"
  else
    printf '%s\n' "${XDG_CACHE_HOME:-$HOME/.cache}"
  fi
}

# ci_go_cache_dir: the Go build cache local CI jobs use (PAPRIKA_CI_GOCACHE, or paprika-ci/go-build under the cache
# root). It is kept between runs, like the cache setup-go restores in ci.yml.
ci_go_cache_dir() {
  if [ -n "${PAPRIKA_CI_GOCACHE:-}" ]; then
    printf '%s\n' "$PAPRIKA_CI_GOCACHE"
  else
    printf '%s/paprika-ci/go-build\n' "$(ci_cache_root)"
  fi
}

# ci_fresh: true when task ci FRESH=1 is set (PAPRIKA_CI_FRESH is 1, true or yes, in any case). A fresh run gives the
# go-test job no cached test results, and resets the job worktrees without keeping their caches (run.sh).
ci_fresh() {
  case "$(printf '%s' "${PAPRIKA_CI_FRESH:-}" | tr '[:upper:]' '[:lower:]')" in
    1 | true | yes) return 0 ;;
    *) return 1 ;;
  esac
}

# ci_trim_go_cache: deletes the Go build cache entry files (names ending in -a or -d) that were not modified for more
# than PAPRIKA_CI_GOCACHE_MAX_AGE_DAYS days (default 3), and logs how many. Other files in the cache directory are left
# alone. Deleting an entry only costs a rebuild. run.sh calls this only while it holds the run lock.
ci_trim_go_cache() {
  local dir max_age deleted
  dir=$(ci_go_cache_dir)
  max_age=${PAPRIKA_CI_GOCACHE_MAX_AGE_DAYS:-3}
  case "$max_age" in
    '' | *[!0-9]*) ci_die "PAPRIKA_CI_GOCACHE_MAX_AGE_DAYS must be a whole number of days, not '$max_age'" ;;
  esac
  [ -d "$dir" ] || return 0
  deleted=$(find "$dir" -type f \( -name '*-a' -o -name '*-d' \) -mtime +"$max_age" -print -delete 2>/dev/null | wc -l | tr -d ' ') || true
  ci_log "go build cache $dir: deleted ${deleted:-0} entry files not used for more than $max_age days"
}

# ci_npm_ci <dir>: installs the locked dependencies of one package directory of the snapshot. The job's npm user
# config is the job's own (ci_export_job_env), so no developer ~/.npmrc applies.
ci_npm_ci() {
  (cd "$1" && npm ci --no-audit --no-fund)
}

ci_export_job_env() {
  local var tmp=${CI_JOB_TMP:?ci_job_init sets CI_JOB_TMP first}
  while IFS= read -r var; do
    ci_env_allowed "$var" || unset "$var" 2>/dev/null || true
  done < <(compgen -e)
  # An exported function is an environment entry (BASH_FUNC_name%%) that compgen -e does not list, so it is
  # removed separately. declare -Fx prints "declare -fx NAME" for each exported function.
  while read -r _ _ var; do
    unset -f "$var" 2>/dev/null || true
  done < <(declare -Fx 2>/dev/null)

  export TZ=UTC CI=true
  # Go: no flags from the environment, the ci.yml toolchain pin unless a job sets GOTOOLCHAIN itself, and
  # an empty go env file so no developer GOENV settings apply.
  # A fresh run (ci_fresh) gives go-test -count=1, so no test result is reused from the cache.
  if ci_fresh && [ "$CI_JOB" = go-test ]; then
    export GOFLAGS=-count=1
  else
    export GOFLAGS=
  fi
  export GOTOOLCHAIN="go$CI_GO_VERSION"
  export GOENV="$tmp/goenv"
  : >"$GOENV"
  # Go build cache: one that only local CI uses, so a go clean or cache cleanup elsewhere on the machine cannot remove
  # entries while a job is compiling ("could not import bufio (open .../go-build/...-d: no such file)").
  # PAPRIKA_CI_GOCACHE moves it.
  GOCACHE=$(ci_go_cache_dir)
  export GOCACHE
  mkdir -p -- "$GOCACHE"
  # npm reads ~/.npmrc through HOME; the job gets an empty user config of its own, as it gets an empty GOENV.
  export npm_config_userconfig="$tmp/npmrc"
  : >"$npm_config_userconfig"
  # The local default Docker context (resolved by hack/ci/run.sh). DOCKER_HOST is not inherited, so a
  # job's daemon is always the context's. fleet-scale overrides this for itself only.
  export DOCKER_CONTEXT=${PAPRIKA_CI_DOCKER_CONTEXT:-default}
  # An empty kubeconfig private to the job. No cluster context reaches a job.
  export KUBECONFIG="$tmp/kubeconfig"
  : >"$KUBECONFIG"
  local node_bin
  node_bin=$(ci_node22_bin) || ci_die "Node ${CI_NODE_MAJOR} not found; set PAPRIKA_NODE22 to its bin directory"
  export PATH="$CI_TOOL_BIN:$node_bin:$PATH"
}

# Time-limited steps started by ci_with_timeout, one pid per line in CI_CHILD_LIST (set by ci_job_init, and by
# hack/deploy/vke.sh). A step inside a subshell, such as `(cd ui && ci_with_timeout ...)`, is not a child of the
# shell that stops it: the subshell dies first and the step's gtimeout is re-parented to init. The list finds it.
ci_register_child() { # pid
  [ -n "${CI_CHILD_LIST:-}" ] || return 0
  printf '%s\n' "$1" >>"$CI_CHILD_LIST"
}

ci_unregister_child() { # pid
  [ -n "${CI_CHILD_LIST:-}" ] && [ -f "$CI_CHILD_LIST" ] || return 0
  grep -vxF -- "$1" "$CI_CHILD_LIST" >"$CI_CHILD_LIST.tmp.$$" || true
  mv -- "$CI_CHILD_LIST.tmp.$$" "$CI_CHILD_LIST"
}

# Prints the registered steps that are still running.
ci_registered_alive() {
  local pid
  [ -n "${CI_CHILD_LIST:-}" ] && [ -f "$CI_CHILD_LIST" ] || return 0
  while IFS= read -r pid; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then printf '%s\n' "$pid"; fi
  done <"$CI_CHILD_LIST"
}

# Stops the children of this shell and their descendants, without stopping the shell. A job's TERM and
# INT traps call it first: a shell that waits on a foreground child runs its trap only after the child
# exits, so the children must go first. Process groups are not used, because gtimeout moves its child
# into a new group that a group signal would miss. The registered steps are stopped too, and then waited
# for (bounded by the stop limit), so the caller's cleanup never runs beside a step that is still running.
ci_stop_children() {
  local child pid deadline
  for child in $(pgrep -P $$ 2>/dev/null || true); do
    ci_kill_tree "$child"
  done
  [ -n "${CI_CHILD_LIST:-}" ] && [ -s "$CI_CHILD_LIST" ] || return 0
  while IFS= read -r pid; do
    if [ -n "$pid" ]; then ci_kill_tree "$pid"; fi
  done <"$CI_CHILD_LIST"
  deadline=$((SECONDS + ${PAPRIKA_CI_KILL_AFTER:-120} + 10))
  while [ -n "$(ci_registered_alive)" ] && [ "$SECONDS" -lt "$deadline" ]; do
    sleep 1
  done
  for pid in $(ci_registered_alive); do
    ci_kill_tree "$pid" KILL
  done
}

# ci_docker_config_for_build <dir>: writes a Docker client config into <dir> (created mode 0700) for one
# deploy. It carries the buildx builders, the CLI plugins (buildx itself) and the Docker contexts of the developer's
# config (so a builder such as desktop-linux or cuttlefish-gha-job stays usable), but none of its credentials or
# credential helpers.
# A `docker login` against that config therefore writes only into <dir>: the developer's keychain and
# config.json are never read for credentials or changed.
ci_docker_config_for_build() {
  local dir=$1 src="${DOCKER_CONFIG:-$HOME/.docker}"
  mkdir -p -- "$dir"
  chmod 0700 "$dir"
  if [ -d "$src/buildx" ]; then cp -R "$src/buildx" "$dir/buildx"; fi
  if [ -d "$src/cli-plugins" ]; then cp -R "$src/cli-plugins" "$dir/cli-plugins"; fi
  if [ -d "$src/contexts" ]; then cp -R "$src/contexts" "$dir/contexts"; fi
  if [ -f "$src/config.json" ]; then
    jq 'del(.auths, .credsStore, .credHelpers)' "$src/config.json" >"$dir/config.json" ||
      ci_die "$src/config.json is not valid JSON"
  else
    printf '{}\n' >"$dir/config.json"
  fi
  chmod 0600 "$dir/config.json"
}

# Records a file or directory (relative to the snapshot root) to copy into the
# run's artifact directory when the job finishes. Replaces upload-artifact.
ci_collect() {
  local path
  for path in "$@"; do
    printf '%s\n' "$path" >>"$CI_COLLECT_LIST"
  done
}

ci_collect_flush() {
  local path dest
  [ -n "${PAPRIKA_CI_ARTIFACT_DIR:-}" ] || return 0
  [ -s "$CI_COLLECT_LIST" ] || return 0
  while IFS= read -r path; do
    [ -e "$CI_REPO_ROOT/$path" ] || continue
    dest="$PAPRIKA_CI_ARTIFACT_DIR/$CI_JOB/$path"
    mkdir -p -- "$(dirname "$dest")"
    cp -R -- "$CI_REPO_ROOT/$path" "$dest" 2>/dev/null || ci_log "could not copy $path"
  done <"$CI_COLLECT_LIST"
}

ci_job_finish() {
  local rc=$?
  # Once cleanup starts, further signals are ignored, before anything else runs. gtimeout also signals its whole
  # process group, so a job can be sent TERM twice; a second exit here would cut the cleanup short (kind, docker
  # and the pid file). The stop limit of ci_with_timeout still applies, and KILL cannot be ignored.
  trap '' INT TERM HUP
  trap - EXIT
  # An interrupted or timed-out job skips the diagnostics and goes straight to cleanup, so the
  # cleanup is never cut short by the stop limit in ci_with_timeout.
  if [ "$rc" -ne 0 ] && [ -z "${CI_INTERRUPTED:-}" ] && declare -F ci_on_failure >/dev/null; then
    ci_on_failure || true
  fi
  if declare -F ci_cleanup >/dev/null; then
    ci_cleanup || true
  fi
  ci_collect_flush || true
  rm -rf -- "$CI_JOB_TMP"
  if [ -n "${CI_PID_FILE:-}" ]; then rm -f -- "$CI_PID_FILE"; fi
  exit "$rc"
}

# Called first by every job script. Refuses to run outside the snapshot that
# hack/ci/run.sh creates, so a job can never read the developer's working tree.
ci_job_init() {
  CI_JOB=$1
  [ -n "${PAPRIKA_CI_SNAPSHOT:-}" ] || ci_die "run jobs through hack/ci/run.sh (task ci:job JOB=$CI_JOB)"
  [ "$CI_REPO_ROOT" = "$(cd "$PAPRIKA_CI_SNAPSHOT" && pwd -P)" ] ||
    ci_die "job $CI_JOB is not running in its snapshot"
  CI_JOB_TMP=$(mktemp -d "${PAPRIKA_CI_TMPDIR:-${TMPDIR:-/tmp}}/job-$CI_JOB.XXXXXX")
  CI_COLLECT_LIST="$CI_JOB_TMP/collect.txt"
  : >"$CI_COLLECT_LIST"
  CI_CHILD_LIST="$CI_JOB_TMP/children.txt"
  : >"$CI_CHILD_LIST"
  # run.sh waits for this process on an interrupt. The file goes only after the job's cleanup, so the
  # runner cannot remove the worktrees while the job is still using them.
  if [ -n "${PAPRIKA_CI_PIDS_DIR:-}" ]; then
    CI_PID_FILE="$PAPRIKA_CI_PIDS_DIR/$CI_JOB.$$"
    : >"$CI_PID_FILE"
  fi
  trap ci_job_finish EXIT
  # A signal from hack/ci/run.sh becomes an exit, so the EXIT trap (ci_cleanup, containers, clusters) runs.
  # The children go first, so a step the job is waiting on (a nested ci_with_timeout, with its node or
  # Playwright processes) stops now rather than when the job's own stop limit expires.
  # A second signal (gtimeout signals its process group as well as its child) is ignored from the first one on.
  trap 'CI_INTERRUPTED=1; trap "" INT TERM HUP; ci_stop_children; exit 143' TERM
  trap 'CI_INTERRUPTED=1; trap "" INT TERM HUP; ci_stop_children; exit 130' INT HUP
  cd "$CI_REPO_ROOT" || ci_die "cannot enter $CI_REPO_ROOT"
  ci_export_job_env
}
