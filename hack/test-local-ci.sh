#!/usr/bin/env bash
# Self-tests for the local CI runner, the stamp, the deploy script and the pre-push gate.
#
# Everything runs in throwaway clones under a temp directory with a local bare origin. Docker,
# kubectl, helm, gh and kind are fakes placed first on PATH, and the kubeconfig is a fake file, so
# nothing here can reach a registry or a cluster. The real ci.yml is used for the job list, the
# timeouts and the pins; the job scripts are replaced by stubs in the test clones only.
set -Eeuo pipefail
# The self-test gate: honours the PAPRIKA_CI_SELFTEST_* knobs and keeps every stamp in paprika-ci-selftest (lib.sh).
export PAPRIKA_CI_SELFTEST=1

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck disable=SC1091
source "$repo_root/hack/ci/fleet-lapse.sh"
# One self-test run at a time: the health check binds a fixed local port, and the deploy tests look for processes by path.
lock_dir=${TMPDIR:-/tmp}/paprika-test-local-ci.lock
work=""
lock_held=0
# The trap is set before the lock is taken, so an interrupt at any point removes only what this run created.
cleanup() {
  trap - EXIT
  if [ -n "${lock_holder:-}" ]; then kill "$lock_holder" 2>/dev/null || true; fi
  if [ -n "$work" ]; then rm -rf -- "$work"; fi
  if [ "$lock_held" = 1 ]; then rm -rf -- "$lock_dir"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# take_lock: the lock is a directory holding the pid of its run. A lock whose pid is gone is stale and is taken over.
take_lock() {
  local holder=""
  if mkdir "$lock_dir" 2>/dev/null; then
    lock_held=1
    printf '%s\n' "$$" >"$lock_dir/pid"
    return 0
  fi
  holder=$(cat "$lock_dir/pid" 2>/dev/null || true)
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then return 1; fi
  rm -rf -- "$lock_dir"
  if mkdir "$lock_dir" 2>/dev/null; then
    lock_held=1
    printf '%s\n' "$$" >"$lock_dir/pid"
    return 0
  fi
  return 1
}
if ! take_lock; then
  printf 'FAIL another self-test run holds %s (its pid is in %s/pid; remove the directory if no run is active)\n' \
    "$lock_dir" "$lock_dir" >&2
  exit 1
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/paprika-test-local-ci.XXXXXX")
work=$(cd "$work" && pwd -P)
mkdir -p "$work/tmp"

export GIT_AUTHOR_NAME=local-ci-test GIT_AUTHOR_EMAIL=local-ci-test@example.invalid
export GIT_COMMITTER_NAME=local-ci-test GIT_COMMITTER_EMAIL=local-ci-test@example.invalid
export TMPDIR="$work/tmp"

started=$(date +%s)
say() { printf 'ok   %s (%ss elapsed)\n' "$*" "$(($(date +%s) - started))"; }
die() {
  printf 'FAIL %s\n' "$*" >&2
  if [ -n "${last_out:-}" ]; then
    printf -- '--- output of the last command ---\n%s\n---\n' "$last_out" >&2
  fi
  exit 1
}

last_out=""
# run_cmd <expected: ok|fail> <description> <command...>: captures output, checks the exit status.
run_cmd() {
  local want=$1 desc=$2 rc=0
  shift 2
  "$@" >"$work/out.txt" 2>&1 || rc=$?
  last_out=$(cat "$work/out.txt")
  if [ "$want" = ok ] && [ "$rc" -ne 0 ]; then die "$desc: expected success, exit $rc"; fi
  if [ "$want" = fail ] && [ "$rc" -eq 0 ]; then die "$desc: expected failure, got success"; fi
  return 0
}
expect_output() { grep -Fq -- "$1" <<<"$last_out" || die "output does not contain: $1"; }
expect_no_output() { if grep -Fq -- "$1" <<<"$last_out"; then die "output unexpectedly contains: $1"; fi; }
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# ---------------------------------------------------------------------------------------------
# Static checks on the new scripts.
# ---------------------------------------------------------------------------------------------
cd "$repo_root"
command -v shellcheck >/dev/null 2>&1 || die "shellcheck is required"
run_cmd ok "shellcheck" shellcheck hack/ci/lib.sh hack/ci/tools.sh hack/ci/run.sh hack/ci/status.sh hack/ci/fleet-lapse.sh \
  hack/ci/fleet-anchor.sh \
  hack/ci/quick.sh hack/ci/jobs/*.sh hack/deploy/vke.sh hack/deploy/vke-cluster.sh hack/test-local-ci.sh \
  .githooks/pre-commit .githooks/pre-push
say "shellcheck: every new script is clean"

# P1: every command, environment assignment and tool pin in a ci.yml job is mirrored by its hack/ci/jobs script.
run_cmd ok "local CI job parity" bash -c "cd '$repo_root' && GOTOOLCHAIN=auto go test -count=1 -run TestLocalCIJobParity ./internal/cicontract/"
say "every ci.yml job command is mirrored by its hack/ci job script (internal/cicontract)"

# G1: a self-test knob set outside the gate is not passed to a job, and developer stamps stay in paprika-ci.
dev_view=$(env PAPRIKA_CI_SELFTEST=0 bash -c "source '$repo_root/hack/ci/lib.sh' && ci_env_allowed PAPRIKA_CI_SELFTEST_TIMEOUT_SECS && echo allowed || echo refused")
[ "$dev_view" = refused ] || die "a self-test knob reaches a job outside the self-test gate"
[ "$(env -u PAPRIKA_CI_SELFTEST bash -c "source '$repo_root/hack/ci/lib.sh' && ci_stamp_subdir")" = paprika-ci ] ||
  die "a developer stamp is not in paprika-ci"
say "self-test knobs reach a job and stamps move only under the self-test gate"

# G3: a hook started from a worktree gets GIT_DIR=<common dir>/worktrees/<name>. A git command that inherits
# it acts on that repository: git init -b master <dir>, as make_clone runs, re-initialises it and writes
# core.bare=true into the shared config. Anything that sources lib.sh clears git's repository variables first.
# The sentinel and its worktree stand in for the developer's repository.
sentinel=$work/hook-sentinel
git init --quiet -b master "$sentinel"
git -C "$sentinel" -c core.hooksPath=/dev/null -c user.name=t -c user.email=t@example.invalid commit --quiet --allow-empty -m s
git -C "$sentinel" worktree add --quiet -b hook-wt "$work/hook-sentinel-wt"
mkdir -p "$work/hook-scratch"
(cd "$work/hook-sentinel-wt" && env GIT_DIR="$sentinel/.git/worktrees/hook-sentinel-wt" GIT_INDEX_FILE="$sentinel/.git/index" bash -c \
  "source '$repo_root/hack/ci/lib.sh' && [ -z \"\${GIT_DIR:-}\${GIT_INDEX_FILE:-}\" ] && git init --quiet -b master '$work/hook-scratch'") ||
  die "lib.sh left git's hook variables set, or the scratch init failed"
[ "$(git -C "$sentinel" config --get core.bare)" = false ] || die "a scratch git init under hook variables made the hook's repository bare"
[ -d "$work/hook-scratch/.git" ] || die "the scratch repository was not created where it was asked for"
for hook in pre-commit pre-push; do
  # shellcheck disable=SC2016 # literal shell text, matched against the hook
  grep -Fq 'source "${REPO_ROOT}/hack/ci/lib.sh"' "$repo_root/.githooks/$hook" || die "$hook does not source lib.sh, which clears git's hook variables"
done
say "git's hook variables are cleared, so a scratch git init cannot touch the hook's repository"

# ---------------------------------------------------------------------------------------------
# Fakes. They record argv (never stdin) to $FAKE_LOG and answer just the calls the scripts make.
# ---------------------------------------------------------------------------------------------
fakebin=$work/fakebin
tools=$work/tools
mkdir -p "$fakebin" "$tools"
fake_server=$work/fake_server.py
fake_kc=$work/fake-deploy-kubeconfig
printf 'apiVersion: v1\n' >"$fake_kc"
PD=$(printf 'a%.0s' $(seq 1 64))
RD=$(printf 'b%.0s' $(seq 1 64))
ZD=$(printf '0%.0s' $(seq 1 64))

cat >"$fake_server" <<'PY'
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

# FAKE_HEALTH_CODE, when set, is the status for /readyz and /metrics (the deploy's health checks).
FAIL_CODE = int(os.environ.get("FAKE_HEALTH_CODE") or 200)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        code = 200
        if self.path in ("/readyz", "/metrics"):
            code = FAIL_CODE
        if self.path == "/":
            body, ctype = b"<!doctype html><html></html>", "text/html; charset=utf-8"
        else:
            body, ctype = b"ok", "text/plain"
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
PY

cat >"$fakebin/kubectl" <<'SH'
#!/usr/bin/env bash
# Fake kubectl. Records argv (with the KUBECONFIG it was given) and answers only the calls the scripts make.
umask 077
printf 'kubectl|%s|%s\n' "${KUBECONFIG:-unset}" "$*" >>"${FAKE_LOG:-/dev/null}"
if [ "${1:-}" = --kubeconfig ]; then shift 2; fi
args="$*"
case "$args" in
  "config current-context") echo "${FAKE_CONTEXT:-vke}" ;;
  "get nodes"*) echo "node/fake Ready" ;;
  "get namespace "*) echo "namespace/paprika-e2e" ;;
  *"get pvc"*) echo "${FAKE_PVC_PHASE:-Bound}" ;;
  *"get secret paprika-oidc"*)
    [ "${FAKE_MISSING_SECRET:-}" != paprika-oidc ] || { echo "NotFound" >&2; exit 1; }
    echo "secret/paprika-oidc" ;;
  *"get secret paprika-auth-token"*)
    [ "${FAKE_MISSING_SECRET:-}" != paprika-auth-token ] || { echo "NotFound" >&2; exit 1; }
    echo "secret/paprika-auth-token" ;;
  *"get secret paprika-e2e-dashboard-renderer -o json"*)
    printf '{"data":{"secret":"%s"}}\n' "$(printf 'x%.0s' $(seq 1 48) | base64 | tr -d '\n')" ;;
  *"get secret paprika-e2e-dashboard-renderer"*) ;;
  *"create secret generic"*"--dry-run=client"*)
    name=$(sed -n 's/.*create secret generic \([^ ]*\).*/\1/p' <<<"$args")
    # The Secret value arrives on stdin. It is kept only in the test capture (mode 0600), never in the log.
    if [ -n "${FAKE_CAPTURE_DIR:-}" ]; then cat >"$FAKE_CAPTURE_DIR/secret-$name"; else cat >/dev/null; fi
    printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n' "$name" ;;
  *"create secret generic"*)
    cat >/dev/null
    echo "secret/paprika-e2e-dashboard-renderer created" ;;
  "-n paprika-e2e apply -f -"|*"apply -f -"*)
    name=$(sed -n 's/^  name: //p' | head -1)
    # FAKE_APPLY_WARNING makes kubectl print a warning on stderr, as it does for a Secret made without apply.
    [ -z "${FAKE_APPLY_WARNING:-}" ] || echo "Warning: resource secrets/$name is missing the last-applied-configuration annotation" >&2
    echo "secret/$name configured" ;;
  *"get pods"*"-o json"*)
    ready=True
    [ -z "${FAKE_POD_NOT_READY:-}" ] || ready=False
    jq -n --arg p "ghcr.io/paprikacd/paprika@sha256:${FAKE_PAPRIKA_DIGEST}" \
      --arg r "ghcr.io/paprikacd/paprika-render-worker@sha256:${FAKE_RENDER_DIGEST}" \
      --arg norender "${FAKE_NO_RENDERER:-}" --arg ready "$ready" \
      --arg bad "${FAKE_IMAGEID_MISMATCH:+sha256:$(printf '0%.0s' $(seq 1 64))}" \
      --arg containerd "${FAKE_CONTAINERD_STATUS:-}" '
      # FAKE_CONTAINERD_STATUS reports status as containerd does: .image is the bare config ID and imageID has no scheme.
      def pod(comp; img; id): {metadata: {name: comp}, status: {phase: "Running",
        conditions: [{type: "Ready", status: $ready}],
        containerStatuses: [if $containerd != ""
          then {name: comp, image: "sha256:59715411901e81f6f42c6ec7403765a48ddef36fb7a681aa96d1f65133cb8d9d", imageID: id}
          else {name: comp, image: img, imageID: ("docker-pullable://" + id)} end]}};
      {items: [
        pod("controller-manager"; $p; (if $bad != "" then "ghcr.io/paprikacd/paprika@" + $bad else $p end)),
        pod("api-server"; $p; $p),
        pod("repo-server"; $p; $p),
        pod("webhook-receiver"; $p; $p),
        (if $norender != "" then empty else pod("dashboard-renderer"; $r; $r) end)
      ]}' ;;
  *"get pods"*) echo "NAME READY STATUS" ;;
  *"wait "*)
    [ -z "${FAKE_WAIT_SLEEP:-}" ] || sleep "$FAKE_WAIT_SLEEP"
    [ "${FAKE_WAIT_FAIL:-}" != 1 ] || { echo "timed out waiting for the condition" >&2; exit 1; }
    echo "pod condition met" ;;
  *"logs "*) ;;
  *"port-forward"*)
    local_port="" remote_port=""
    for arg in "$@"; do
      case "$arg" in [0-9]*:[0-9]*) local_port=${arg%%:*}; remote_port=${arg#*:}; break ;; esac
    done
    echo "Forwarding from 127.0.0.1:${local_port} -> ${remote_port}"
    exec python3 -I "$FAKE_SERVER" "$local_port" ;;
  *) ;;
esac
SH

cat >"$fakebin/docker" <<'SH'
#!/usr/bin/env bash
# Fake docker. Never pushes. login writes into the Docker config it is given, as the real client does, and
# buildx writes a --metadata-file whose digest is chosen by the Dockerfile argument.
printf 'docker|%s\n' "$*" >>"${FAKE_LOG:-/dev/null}"
case "$1" in
  login)
    printf 'docker-config|%s\n' "${DOCKER_CONFIG:-unset}" >>"${FAKE_LOG:-/dev/null}"
    cat >/dev/null
    if [ -n "${DOCKER_CONFIG:-}" ]; then
      cfg=$DOCKER_CONFIG/config.json
      [ -f "$cfg" ] || printf '{}\n' >"$cfg"
      jq '.auths["ghcr.io"] = {auth: "ZmFrZQ=="}' "$cfg" >"$cfg.tmp" && mv "$cfg.tmp" "$cfg"
    fi
    echo "Login Succeeded" ;;
  context)
    [ "${2:-}" = show ] && printf '%s\n' "${FAKE_DOCKER_CONTEXT:-default}" ;;
  info)
    case "$*" in *MemTotal*) echo 17179869184 ;; esac ;;
  version)
    # The Docker server platform. A job's environment is an allowlist, so the test sets it through a file under TMPDIR.
    cat "${TMPDIR:-/tmp}/fake-docker-platform" 2>/dev/null || echo linux/amd64 ;;
  buildx)
    meta="" render=0 prev=""
    for arg in "$@"; do
      [ "$prev" = --metadata-file ] && meta=$arg
      case "$arg" in */ui/Dockerfile.render-worker) render=1 ;; esac
      prev=$arg
    done
    digest=$FAKE_PAPRIKA_DIGEST
    [ "$render" = 1 ] && digest=$FAKE_RENDER_DIGEST
    [ "$render" = 0 ] && [ -n "${FAKE_BAD_DIGEST:-}" ] && digest=NOT-A-DIGEST
    # FAKE_BUILDX_SLEEP stalls the manager build and FAKE_RENDER_BUILDX_SLEEP the renderer build, to test their limits.
    if [ "$render" = 1 ]; then
      [ -z "${FAKE_RENDER_BUILDX_SLEEP:-}" ] || sleep "$FAKE_RENDER_BUILDX_SLEEP"
    else
      [ -z "${FAKE_BUILDX_SLEEP:-}" ] || sleep "$FAKE_BUILDX_SLEEP"
    fi
    [ -z "$meta" ] || printf '{"containerimage.digest":"sha256:%s"}\n' "$digest" >"$meta" ;;
  *) ;;
esac
SH

cat >"$fakebin/gh" <<'SH'
#!/usr/bin/env bash
printf 'gh|%s\n' "$*" >>"${FAKE_LOG:-/dev/null}"
case "$*" in
  "api user -q .login") echo "fake-user" ;;
  "auth token") echo "FAKE-GH-TOKEN-VALUE" ;;
esac
SH

cat >"$tools/helm" <<'SH'
#!/usr/bin/env bash
# Fake pinned Helm. Records argv only. The auth values file is copied into the test capture (mode 0600).
umask 077
printf 'helm|%s|%s\n' "${KUBECONFIG:-unset}" "$*" >>"${FAKE_LOG:-/dev/null}"
if [ "${1:-}" = --kubeconfig ]; then shift 2; fi
case "$1" in
  version) echo "v3.21.2" ;;
  upgrade)
    for arg in "$@"; do
      case "$arg" in
        *auth-values.json) [ -z "${FAKE_CAPTURE_DIR:-}" ] || cp "$arg" "$FAKE_CAPTURE_DIR/auth-values.json" ;;
      esac
    done
    echo "Release \"paprika-e2e\" has been upgraded." ;;
  status) echo "STATUS: deployed" ;;
  get)
    [ -z "${FAKE_NO_RELEASE:-}" ] || { echo "release not found" >&2; exit 1; }
    printf '{"auth":{"oidc":{"clientID":"%s"},"basic":{"passwordHash":"%s"}}}\n' \
      "${FAKE_LIVE_CID:-}" "${FAKE_LIVE_HASH:-}" ;;
  history) echo "[{\"revision\":7,\"status\":\"${FAKE_HELM_STATUS:-deployed}\"}]" ;;
esac
SH

cat >"$tools/kind" <<'SH'
#!/usr/bin/env bash
echo "kind v0.32.0 go1.25.0 darwin/arm64"
SH

cat >"$tools/terraform" <<'SH'
#!/usr/bin/env bash
printf 'Terraform v1.14.6\non darwin_arm64\n'
SH
chmod +x "$fakebin"/* "$tools"/*

# ---------------------------------------------------------------------------------------------
# Clones and stamps.
# ---------------------------------------------------------------------------------------------
# make_clone <name>: a minimal repository holding the files the local CI scripts read (ci.yml, the
# Taskfile, .gitignore, the hooks and hack/), on master, pushed to a local bare origin (never GitHub).
# It is built fresh rather than cloned, because cloning the full history is slow.
make_clone() {
  local dir=$work/$1 bare=$work/$1-origin.git
  mkdir -p "$dir/.github/workflows"
  cp "$repo_root/.github/workflows/ci.yml" "$dir/.github/workflows/ci.yml"
  cp "$repo_root/Taskfile.yml" "$repo_root/.gitignore" "$repo_root/.nvmrc" "$dir/"
  # ui/.gitignore ignores ui/.next, as in the real repository; R22a keeps ui/.next/cache across runs.
  mkdir -p "$dir/ui" && cp "$repo_root/ui/.gitignore" "$dir/ui/"
  cp -R "$repo_root/.githooks" "$repo_root/hack" "$dir/"
  git init --quiet -b master "$dir"
  git -C "$dir" add -A
  git -C "$dir" -c core.hooksPath=/dev/null commit --quiet -m "test snapshot"
  git init --quiet --bare "$bare"
  git -C "$dir" remote add origin "$bare"
  git -C "$dir" -c core.hooksPath=/dev/null push --quiet origin master
  git -C "$dir" fetch --quiet origin
}

# stamp_path <clone> <tree>
stamp_path() { printf '%s/paprika-ci-selftest/%s.json\n' "$(git -C "$1" rev-parse --path-format=absolute --git-common-dir)" "$2"; }

# write_passing_stamp <clone>: a stamp for HEAD's tree in which every ci.yml job passed.
write_passing_stamp() {
  local dir=$1 tree commit sha pins jobs stamp
  tree=$(git -C "$dir" rev-parse 'HEAD^{tree}')
  commit=$(git -C "$dir" rev-parse HEAD)
  sha=$(shasum -a 256 "$dir/.github/workflows/ci.yml" | awk '{print $1}')
  pins=$(bash -c "source '$dir/hack/ci/lib.sh' && ci_pins_json")
  jobs=$(bash -c "source '$dir/hack/ci/lib.sh' && printf '%s\n' \$CI_JOBS")
  stamp=$(stamp_path "$dir" "$tree")
  mkdir -p "$(dirname "$stamp")"
  jq -n --arg tree "$tree" --arg commit "$commit" --arg sha "$sha" --argjson tools "$pins" --arg jobs "$jobs" '
    {schema: 1, tree: $tree, commit: $commit, ciYmlSha256: $sha, tools: $tools,
     jobs: ($jobs | split("\n") | map(select(length > 0))
       | map({key: ., value: {result: "pass", seconds: 1, log: "artifacts/ci/x.log", finishedAt: "2026-01-01T00:00:00Z"}})
       | from_entries)}' >"$stamp"
}

# make_fleet_clone <name>: make_clone plus what the fleet-scale lapse reads: the UI closure and the spec, the Go packages
# the fixture is built from, and a link to the developer checkout's node_modules (the TypeScript compiler). Committed and
# pushed to the bare origin. The lists come from the real tree, so the clone's closure and package set match the repo.
make_fleet_clone() {
  local name=$1 dir rel ts
  dir=$work/$name
  if [ ! -s "$work/fleet-closure-real.txt" ]; then
    fleet_closure "$repo_root" >"$work/fleet-closure-real.txt" || die "the real UI closure cannot be traced"
    fleet_go_dirs "$repo_root" >"$work/fleet-godirs-real.txt" || die "the real fixture packages cannot be listed"
  fi
  make_clone "$name"
  while IFS= read -r rel; do
    # The closure also lists empty Next.js convention-file slots; only existing files are copied.
    [ -f "$repo_root/$rel" ] || continue
    mkdir -p "$dir/$(dirname "$rel")"
    cp "$repo_root/$rel" "$dir/$rel"
  done <"$work/fleet-closure-real.txt"
  mkdir -p "$dir/ui/e2e"
  cp "$repo_root/ui/e2e/fleet-scale.spec.ts" "$dir/ui/e2e/"
  cp "$repo_root/go.mod" "$repo_root/go.sum" "$dir/"
  while IFS= read -r rel; do
    mkdir -p "$dir/$rel"
    cp -R "$repo_root/$rel/." "$dir/$rel/"
  done <"$work/fleet-godirs-real.txt"
  ts=$(bash -c "source '$repo_root/hack/ci/fleet-lapse.sh' && fleet_typescript_path") ||
    die "the developer checkout has no TypeScript compiler (ui/node_modules)"
  ln -s "${ts%/typescript/lib/typescript.js}" "$dir/ui/node_modules"
  git -C "$dir" add -A
  git -C "$dir" -c core.hooksPath=/dev/null commit --quiet -m "fleet-scale sources"
  git -C "$dir" -c core.hooksPath=/dev/null push --quiet origin master
  git -C "$dir" fetch --quiet origin
}

# ---------------------------------------------------------------------------------------------
# Runner clone: stub job scripts so the runner logic runs without the heavy jobs.
# ---------------------------------------------------------------------------------------------
make_clone runner
runner=$work/runner
for job in $(bash -c "source '$runner/hack/ci/lib.sh' && printf '%s\n' \$CI_JOBS"); do
  cat >"$runner/hack/ci/jobs/$job.sh" <<'STUB'
#!/usr/bin/env bash
# Test stub: the real job is replaced in this throwaway clone only.
set -Eeuo pipefail
# The environment the job's shell received, before ci_job_init runs (so a BASH_ENV effect is visible), and the one
# the job has once ci_job_init has set its allowlist.
if [ -n "${PAPRIKA_CI_SELFTEST_ENVDUMP:-}" ]; then env | sort >"$PAPRIKA_CI_SELFTEST_ENVDUMP.start"; fi
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init "$(basename "$0" .sh)"
if [ -n "${PAPRIKA_CI_SELFTEST_ENVDUMP:-}" ]; then env | sort >"$PAPRIKA_CI_SELFTEST_ENVDUMP"; fi
# Records what the job's cleanup saw (the interrupt test checks it before the worktrees go). A real cleanup
# takes time (kind delete, docker rm), so this one sleeps; the job's worktree must still exist when it ends.
# Defined before the job blocks below, because a TERM during the wait runs the EXIT trap straight away.
ci_cleanup() {
  if [ -n "${PAPRIKA_CI_SELFTEST_PIDS:-}" ]; then
    sleep 4
    present=missing
    if [ -d "$CI_REPO_ROOT" ]; then present=present; fi
    printf '%s\n' "$present" >"$PAPRIKA_CI_SELFTEST_PIDS/$CI_JOB.cleaned"
  fi
}
case " ${PAPRIKA_CI_SELFTEST_FAIL_JOBS:-} " in
  *" $CI_JOB "*) ci_log "stub $CI_JOB failing on purpose"; exit 1 ;;
esac
if [ -n "${PAPRIKA_CI_SELFTEST_ROOTS:-}" ]; then
  printf '%s\n' "$CI_REPO_ROOT" >"$PAPRIKA_CI_SELFTEST_ROOTS/$CI_JOB"
  sleep 1
fi
if [ -n "${PAPRIKA_CI_SELFTEST_TIMES:-}" ]; then
  date +%s >"$PAPRIKA_CI_SELFTEST_TIMES/$CI_JOB.start"
  sleep 2
  date +%s >"$PAPRIKA_CI_SELFTEST_TIMES/$CI_JOB.end"
fi
if [ -n "${PAPRIKA_CI_SELFTEST_NESTED:-}" ]; then
  # A time-limited step inside a subshell of the job, as the Playwright steps of fleet-ui-smoke are. Its process
  # must not outlive the job, whether the job hits its limit or is interrupted.
  (cd "$CI_REPO_ROOT" && ci_with_timeout 300 sh -c 'echo $$ >"$1"; exec sleep 300' sh "$PAPRIKA_CI_SELFTEST_NESTED")
fi
if [ -n "${PAPRIKA_CI_SELFTEST_PIDS:-}" ]; then
  printf '%s\n' "$$" >"$PAPRIKA_CI_SELFTEST_PIDS/$CI_JOB.pid"
  # Waited for in the background so that a TERM runs the job's trap at once, as a real job's would.
  sleep 120 &
  wait "$!"
fi
if [ -n "${PAPRIKA_CI_SELFTEST_WAIVE:-}" ]; then
  printf '{"part":"ui","reason":"test waiver","base":"%s","checkedPaths":0,"apiP95Ms":1}\n' "$(git rev-parse HEAD)" >"$PAPRIKA_CI_WAIVER_FILE"
fi
ci_log "stub $CI_JOB passed"
STUB
done
git -C "$runner" add -A
git -C "$runner" -c core.hooksPath=/dev/null commit --quiet -m "test stub jobs"

export PAPRIKA_CI_TOOL_BIN=$tools
export PAPRIKA_CI_TMPDIR=$work/tmp
# Every cache the runner keeps (the Go build cache, the stable job worktrees and the run lock) lives under this test's
# directory, never under the developer's ~/Library/Caches or ~/.cache.
export PAPRIKA_CI_CACHE_ROOT=$work/cache
jobs_root=$work/cache/paprika-ci/jobs

# R1: unknown job names are refused before anything runs.
run_cmd fail "unknown job" bash -c "cd '$runner' && bash hack/ci/run.sh --jobs bogus"
expect_output "unknown job 'bogus'"
say "runner refuses an unknown job"

# R2: a dirty tree is refused unless --allow-dirty.
echo scratch >"$runner/untracked-scratch.txt"
run_cmd fail "dirty tree" bash -c "cd '$runner' && bash hack/ci/run.sh --jobs terraform"
expect_output "working tree is dirty"
rm -f "$runner/untracked-scratch.txt"
say "runner refuses a dirty tree"

# R3: a failing job fails the run and is recorded in the stamp; the passing job is recorded too.
run_cmd fail "failing job" bash -c "cd '$runner' && PAPRIKA_CI_SELFTEST_FAIL_JOBS=ui bash hack/ci/run.sh --jobs terraform,ui"
expect_output "1 job(s) did not pass"
tree=$(git -C "$runner" rev-parse 'HEAD^{tree}')
stamp=$(stamp_path "$runner" "$tree")
[ "$(jq -r '.jobs.ui.result' "$stamp")" = fail ] || die "ui was not recorded as fail"
[ "$(jq -r '.jobs.terraform.result' "$stamp")" = pass ] || die "terraform was not recorded as pass"
say "runner records a failing job and a passing job in the stamp"

# R4: --rerun-failed reruns only the job that did not pass and merges the results.
run_cmd ok "rerun failed" bash -c "cd '$runner' && bash hack/ci/run.sh --jobs terraform,ui --rerun-failed"
expect_output "skipping terraform: already passing"
[ "$(jq -r '.jobs.ui.result' "$stamp")" = pass ] || die "rerun did not record ui as pass"
[ "$(jq -r '.jobs.terraform.result' "$stamp")" = pass ] || die "rerun dropped terraform"
say "runner --rerun-failed skips passing jobs and merges results"

# R5: a full run, with one job failing, leaves a stamp that status.sh rejects and names.
run_cmd fail "full run with one failure" bash -c "cd '$runner' && PAPRIKA_CI_SELFTEST_FAIL_JOBS=go-lint bash hack/ci/run.sh"
run_cmd fail "status with one failing job" bash -c "cd '$runner' && bash hack/ci/status.sh HEAD"
expect_output "ci:status: FAIL"
expect_output "not passing: go-lint"
say "status.sh exits nonzero and names the failing job"

# R6: a rerun of the failed job completes the stamp, and status passes.
run_cmd ok "rerun go-lint" bash -c "cd '$runner' && bash hack/ci/run.sh --rerun-failed"
run_cmd ok "status all pass" bash -c "cd '$runner' && bash hack/ci/status.sh HEAD"
expect_output "ci:status: PASS"
say "status.sh passes once every ci.yml job has a passing result"

# R7: a stamp with only some jobs lists every missing job.
partial=$(mktemp "$work/partial.XXXXXX")
jq '.jobs = {terraform: .jobs.terraform}' "$stamp" >"$partial"
cp "$partial" "$stamp"
run_cmd fail "partial stamp" bash -c "cd '$runner' && bash hack/ci/status.sh HEAD"
grep -Eq 'ci:status: FAIL tree .* 1 of 13 jobs passing; not passing: ' <<<"$last_out" ||
  die "partial stamp summary is wrong"
grep -Eq "not passing: .*\bui\b" <<<"$last_out" || die "status does not list ui as not passing"
grep -Eq "not passing: .*\bgo-lint\b" <<<"$last_out" || die "status does not list go-lint as not passing"
say "status.sh rejects a partial stamp and lists the missing jobs"

# Restore a complete stamp for the tests that follow.
run_cmd ok "restore" bash -c "cd '$runner' && bash hack/ci/run.sh --rerun-failed"

# R8: the stamp is keyed by tree: a commit with the same tree shares the result.
same_tree=$(git -C "$runner" commit-tree "HEAD^{tree}" -p HEAD -m "same tree, new message")
run_cmd ok "same tree status" bash -c "cd '$runner' && bash hack/ci/status.sh '$same_tree'"
expect_output "ci:status: PASS"
say "a commit with the same tree shares the stamp"

# R9: a stamp whose tool pins differ does not count.
cp "$stamp" "$stamp.bak"
jq '.tools.helm = "v3.0.0"' "$stamp.bak" >"$stamp"
run_cmd fail "tool pin mismatch" bash -c "cd '$runner' && bash hack/ci/status.sh HEAD"
expect_output "does not match this commit's ci.yml or the tool pins"
cp "$stamp.bak" "$stamp"
say "a stamp with different tool pins does not count"

# R10: a stamp for a different ci.yml does not count.
jq '.ciYmlSha256 = "0000"' "$stamp.bak" >"$stamp"
run_cmd fail "ci.yml digest mismatch" bash -c "cd '$runner' && bash hack/ci/status.sh HEAD"
expect_output "does not match this commit's ci.yml or the tool pins"
cp "$stamp.bak" "$stamp"
say "a stamp for a different ci.yml does not count"

# R11: a run with --allow-dirty reports only and writes no stamp.
before=$(find "$(dirname "$stamp")" -type f | wc -l | tr -d ' ')
echo "# local edit" >>"$runner/Taskfile.yml"
run_cmd ok "allow-dirty report" bash -c "cd '$runner' && bash hack/ci/run.sh --allow-dirty --jobs terraform"
expect_output "no stamp was written"
git -C "$runner" checkout --quiet -- Taskfile.yml
after=$(find "$(dirname "$stamp")" -type f | wc -l | tr -d ' ')
[ "$before" = "$after" ] || die "--allow-dirty wrote a stamp"
say "--allow-dirty writes no stamp"

# R12: a commit that changes ci.yml has a new tree, so the old stamp does not apply.
echo "# comment-only change" >>"$runner/.github/workflows/ci.yml"
git -C "$runner" -c core.hooksPath=/dev/null commit --quiet -am "comment-only ci.yml change"
run_cmd fail "new ci.yml tree has no stamp" bash -c "cd '$runner' && bash hack/ci/status.sh HEAD"
expect_output "no stamp for tree"
say "a ci.yml change gets a new tree and no inherited pass"

# R13: a pinned version that drifts from ci.yml stops the runner before any job runs.
sed -i.bak "s/go-version: '1.27.4'/go-version: '1.27.3'/" "$runner/.github/workflows/ci.yml"
rm -f "$runner/.github/workflows/ci.yml.bak"
git -C "$runner" -c core.hooksPath=/dev/null commit --quiet -am "drift pin"
run_cmd fail "pin drift" bash -c "cd '$runner' && bash hack/ci/status.sh HEAD"
expect_output "ci.yml no longer contains the pinned"
say "a pin that drifts from ci.yml is refused"

# R14: a job that exceeds its time limit exits 124 through the portable helper.
rc=0
bash -c "source '$runner/hack/ci/lib.sh' && ci_with_timeout 1 sleep 5" >/dev/null 2>&1 || rc=$?
[ "$rc" = 124 ] || die "ci_with_timeout returned $rc, expected 124"
say "a job over its time limit is stopped (exit 124)"

# R15: job environments are an allowlist. Planted settings that a job must never inherit are removed, and the
# settings the runner owns (Go flags and toolchain, Docker context, an empty kubeconfig, UTC) are set.
jt=$work/jt
mkdir -p "$jt"
planted=(GOFLAGS=-run=PLANTED-NOTHING NODE_OPTIONS=--require=PLANTED GOARCH=PLANTED CGO_ENABLED=PLANTED
  GOEXPERIMENT=PLANTED GOPROXY=PLANTED GOENV=PLANTED GOCACHE=/PLANTED/go-build npm_config_ignore_scripts=PLANTED AWS_ACCESS_KEY_ID=PLANTED
  CLOUDSDK_CORE_PROJECT=PLANTED DOCKER_HOST=PLANTED DOCKER_CONTEXT=PLANTED KUBECONFIG=PLANTED KUBECONTEXT=PLANTED
  HELM_KUBECONTEXT=PLANTED GH_TOKEN=PLANTED GITHUB_TOKEN=PLANTED VKE_OIDC_CLIENT_SECRET=PLANTED
  PAPRIKA_DEPLOY_KUBECONFIG=PLANTED TZ=Asia/Tokyo PAPRIKA_CI_KEEP=kept
  'BASH_FUNC_plantedgo%%=() { echo PLANTED; }' "BASH_ENV=$jt/planted-bash-env")
printf 'export BASH_ENV_MARK=PLANTED\n' >"$jt/planted-bash-env"
job_env=$jt/job-env.txt
planted_node=$(bash -c "source '$runner/hack/ci/lib.sh' && ci_node_bin")
env "${planted[@]}" CI_JOB_TMP="$jt" PAPRIKA_NODE_BIN="$planted_node" PAPRIKA_CI_GOCACHE="$jt/go-build" \
  bash -c "source '$runner/hack/ci/lib.sh' && ci_export_job_env && env | sort" >"$job_env" ||
  die "ci_export_job_env failed"
if grep -q PLANTED "$job_env"; then
  die "a planted setting reached a job: $(grep PLANTED "$job_env" | head -3 | tr '\n' ' ')"
fi
if grep -q BASH_ENV_MARK "$job_env" || grep -q '^go()' "$job_env"; then die "BASH_ENV or an exported function reached a job"; fi
for expected in GOFLAGS= TZ=UTC DOCKER_CONTEXT=default PAPRIKA_CI_KEEP=kept GOTOOLCHAIN=go1.27.4 CI=true \
  "KUBECONFIG=$jt/kubeconfig" "GOENV=$jt/goenv" "GOCACHE=$jt/go-build" "npm_config_userconfig=$jt/npmrc"; do
  grep -qxF -- "$expected" "$job_env" || die "the job env lacks $expected"
done
grep -q "^PATH=$tools:" "$job_env" || die "the pinned tools are not first on PATH"
grep -q '^HOME=' "$job_env" || die "HOME was removed from the job env"
[ -d "$jt/go-build" ] || die "the job's Go build cache directory was not created"
case "$(uname -s)" in Darwin) want_cache=/h/Library/Caches/paprika-ci/go-build ;; *) want_cache=/h/.cache/paprika-ci/go-build ;; esac
[ "$(env -u PAPRIKA_CI_GOCACHE -u PAPRIKA_CI_CACHE_ROOT -u XDG_CACHE_HOME HOME=/h GOCACHE=/PLANTED/go-build bash -c "source '$runner/hack/ci/lib.sh' && ci_go_cache_dir")" = "$want_cache" ] ||
  die "the job Go cache is not the dedicated local CI cache when the developer sets GOCACHE"
say "job environments are an allowlist: planted Go, Node, cloud, Docker, cluster and token settings never reach a job"

# R16: every job gets its own worktree, so two jobs running at once never share a directory.
# R13 left a drifted pin in the runner clone; restore it so the runner starts.
sed -i.bak "s/go-version: '1.27.3'/go-version: '1.27.4'/" "$runner/.github/workflows/ci.yml"
rm -f "$runner/.github/workflows/ci.yml.bak"
git -C "$runner" -c core.hooksPath=/dev/null commit --quiet -am "restore pin for the isolation tests"
roots=$work/roots
mkdir -p "$roots"
run_cmd ok "isolated jobs" bash -c "cd '$runner' && PAPRIKA_CI_SELFTEST_ROOTS='$roots' bash hack/ci/run.sh --jobs terraform,ui --parallel 2"
root_terraform=$(cat "$roots/terraform")
root_ui=$(cat "$roots/ui")
[ -n "$root_terraform" ] && [ -n "$root_ui" ] || die "a job did not record its root"
[ "$root_terraform" != "$root_ui" ] || die "two concurrent jobs share $root_ui"
[ "$root_terraform" != "$runner" ] && [ "$root_ui" != "$runner" ] || die "a job ran in the developer checkout"
say "concurrent jobs run in separate worktrees, never in the developer checkout"

# R15b: the allowlist holds through run.sh itself. The runner's environment carries a planted exported function,
# a BASH_ENV file, and Go, cluster, Docker and cloud settings; the job must see none of them, and must see the
# Docker context that the runner resolved from the developer's Docker (never the planted DOCKER_CONTEXT).
benv=$work/planted-bash-env-run
benv_ran=$work/bash-env-ran
# The planted file writes a sentinel only inside a job's shell (PAPRIKA_CI_SNAPSHOT is set there and nowhere else),
# so a job that sources BASH_ENV is caught even though run.sh's own shell may source it.
cat >"$benv" <<EOF
if [ -n "\${PAPRIKA_CI_SNAPSHOT:-}" ]; then : >"$benv_ran"; fi
export BASH_ENV_MARK=PLANTED
EOF
envdump=$work/job-envdump.txt
run_cmd ok "run.sh job environment" env 'BASH_FUNC_plantedgo%%=() { echo PLANTED; }' BASH_ENV="$benv" \
  GOFLAGS=-run=PLANTED DOCKER_CONTEXT=PLANTED KUBECONFIG=PLANTED NODE_OPTIONS=--require=PLANTED GOARCH=PLANTED \
  CGO_ENABLED=PLANTED AWS_ACCESS_KEY_ID=PLANTED GOENV=PLANTED PATH="$fakebin:$PATH" FAKE_DOCKER_CONTEXT=fake-ctx \
  PAPRIKA_CI_SELFTEST_ENVDUMP="$envdump" bash -c "cd '$runner' && bash hack/ci/run.sh --jobs terraform"
[ -s "$envdump" ] && [ -s "$envdump.start" ] || die "the job did not write its environment"
[ ! -e "$benv_ran" ] || die "a BASH_ENV file ran inside a job's shell"
if grep -q PLANTED "$envdump.start" || grep -q BASH_ENV_MARK "$envdump.start"; then
  die "a planted setting reached the job's shell before its allowlist: $(grep -e PLANTED -e BASH_ENV_MARK "$envdump.start" | head -3 | tr '\n' ' ')"
fi
if grep -q PLANTED "$envdump" || grep -q BASH_ENV_MARK "$envdump"; then
  die "a planted setting reached a job run by run.sh: $(grep -e PLANTED -e BASH_ENV_MARK "$envdump" | head -3 | tr '\n' ' ')"
fi
for expected in GOFLAGS= TZ=UTC CI=true GOTOOLCHAIN=go1.27.4 DOCKER_CONTEXT=fake-ctx; do
  grep -qxF -- "$expected" "$envdump" || die "the job environment lacks $expected"
done
grep -Eq '^npm_config_userconfig=.*/job-terraform[.][A-Za-z0-9]+/npmrc$' "$envdump" ||
  die "the job's npm user config is not private to the job: $(grep npm_config_userconfig "$envdump")"
say "run.sh starts each job from the allowlist: a planted function, BASH_ENV and cloud, Go and Docker settings never reach it"

# R17: the run directory is removed when the run ends. The job worktrees stay under the cache root for the next run (R22).
[ -z "$(find "$work/tmp" -maxdepth 1 -name 'paprika-ci-run.*' -print -quit)" ] || die "the run directory was left behind"
[ -d "$jobs_root/terraform" ] || die "the stable job worktree was removed when the run ended"
say "the run directory is removed after the run; the stable job worktrees stay for the next run"

lock_free() { perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or exit 2; flock($f, LOCK_EX | LOCK_NB) or exit 1' "$jobs_root/.run.lock"; }

# R18: an interrupt stops the running jobs and their children, then cleans up. The test sends TERM:
# a shell started in the background ignores SIGINT on entry, and bash cannot trap an ignored signal.
# A foreground Ctrl-C reaches the INT trap the same way.
pids=$work/pids
mkdir -p "$pids"
( cd "$runner" && PAPRIKA_CI_SELFTEST_PIDS="$pids" exec bash hack/ci/run.sh --jobs terraform,ui --parallel 2 ) >"$work/int.log" 2>&1 &
runner_pid=$!
for _ in $(seq 1 60); do
  [ -f "$pids/terraform.pid" ] && [ -f "$pids/ui.pid" ] && break
  sleep 1
done
[ -f "$pids/terraform.pid" ] && [ -f "$pids/ui.pid" ] || die "the stub jobs did not start"
kill -TERM "$runner_pid"
# run.sh must exit on its own within a bound: the stubs sleep for 120 s, so a runner that waits for
# them without stopping them is caught here rather than by a test that simply takes longer.
deadline=$(($(date +%s) + 30))
while kill -0 "$runner_pid" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    kill -KILL "$runner_pid" 2>/dev/null || true
    die "run.sh did not exit within 30 s of TERM"
  fi
  sleep 1
done
wait "$runner_pid" 2>/dev/null || true
for job in terraform ui; do
  stub_pid=$(cat "$pids/$job.pid")
  if kill -0 "$stub_pid" 2>/dev/null; then die "$job is still running after an interrupt"; fi
  if [ ! -f "$pids/$job.cleaned" ]; then
    tree12=$(git -C "$runner" rev-parse 'HEAD^{tree}' | cut -c1-12)
    last_out="$(cat "$work/int.log")
$(cat "$runner/artifacts/ci/$tree12/$job.log" 2>/dev/null)"
    die "$job did not run its cleanup before run.sh exited"
  fi
  [ "$(cat "$pids/$job.cleaned")" = present ] || die "$job cleaned up after its worktree was removed"
done
[ -z "$(find "$work/tmp" -maxdepth 1 -name 'paprika-ci-run.*' -print -quit)" ] || die "an interrupted run left its directory behind"
lock_free || die "an interrupted run left the run lock held"
say "an interrupt stops every job and its children, removes the run's directory and releases the job lock"

# R18b: an interrupt also stops a time-limited step that runs in a subshell of the job (the browser smoke shape).
# The subshell dies on the signal, so only the job's list of registered steps can reach the step's process.
nested_int=$work/nested-int.pid
( cd "$runner" && PAPRIKA_CI_SELFTEST_NESTED="$nested_int" exec bash hack/ci/run.sh --jobs terraform ) >"$work/int-nested.log" 2>&1 &
runner_pid=$!
for _ in $(seq 1 60); do
  [ -s "$nested_int" ] && break
  sleep 1
done
[ -s "$nested_int" ] || die "the nested step did not start"
nested_pid=$(cat "$nested_int")
kill -TERM "$runner_pid"
deadline=$(($(date +%s) + 60))
while kill -0 "$runner_pid" 2>/dev/null; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    kill -KILL "$runner_pid" 2>/dev/null || true
    die "run.sh did not exit within 60 s of TERM with a nested step running"
  fi
  sleep 1
done
wait "$runner_pid" 2>/dev/null || true
if kill -0 "$nested_pid" 2>/dev/null; then
  kill -KILL "$nested_pid" 2>/dev/null || true
  die "a step nested in a job's subshell survived an interrupt"
fi
say "an interrupt stops a time-limited step nested in a subshell of the job"

# R22a: a job keeps its worktree at a stable path between runs. Run 2 is for a later commit: a tracked file changed and
# another was deleted. The reset brings the worktree to that commit, an untracked file planted in between is gone, and the
# kept envtest and Next.js cache paths survive.
printf 'v1\n' >"$runner/tracked-changed.txt"
printf 'v1\n' >"$runner/tracked-assumed.txt"
printf 'to be deleted\n' >"$runner/tracked-deleted.txt"
git -C "$runner" add tracked-changed.txt tracked-assumed.txt tracked-deleted.txt
git -C "$runner" -c core.hooksPath=/dev/null commit --quiet -m "stable test: first commit"
stable_roots=$work/stable-roots
mkdir -p "$stable_roots/1" "$stable_roots/2"
run_cmd ok "stable job worktree, run 1" bash -c "cd '$runner' && PAPRIKA_CI_SELFTEST_ROOTS='$stable_roots/1' bash hack/ci/run.sh --jobs terraform"
expect_output "go build cache"
expect_output "entry files"
jobdir1=$(cat "$stable_roots/1/terraform")
[ "$jobdir1" = "$jobs_root/terraform" ] || die "the job ran in $jobdir1, not in its stable worktree $jobs_root/terraform"
echo planted >"$jobdir1/planted-untracked.txt"
mkdir -p "$jobdir1/ui/.next/cache" "$jobdir1/bin/k8s/1.36.2-linux-amd64"
echo kept >"$jobdir1/ui/.next/cache/kept.bin"
echo kept >"$jobdir1/bin/k8s/1.36.2-linux-amd64/kept.bin"
echo not-kept >"$jobdir1/bin/controller-gen"
printf 'v2\n' >"$runner/tracked-changed.txt"
git -C "$runner" rm --quiet tracked-deleted.txt
git -C "$runner" add tracked-changed.txt
git -C "$runner" -c core.hooksPath=/dev/null commit --quiet -m "stable test: second commit"
run_cmd ok "stable job worktree, run 2" bash -c "cd '$runner' && PAPRIKA_CI_SELFTEST_ROOTS='$stable_roots/2' bash hack/ci/run.sh --jobs terraform"
[ "$(cat "$stable_roots/2/terraform")" = "$jobdir1" ] || die "the second run did not use the same job directory"
[ ! -e "$jobdir1/planted-untracked.txt" ] || die "an untracked file from the first run survived the reset"
[ ! -e "$jobdir1/bin/controller-gen" ] || die "a bin/ file outside the kept envtest path survived the reset"
[ -f "$jobdir1/ui/.next/cache/kept.bin" ] || die "the Next.js cache was removed by the reset"
[ -f "$jobdir1/bin/k8s/1.36.2-linux-amd64/kept.bin" ] || die "the envtest assets were removed by the reset"
[ "$(cat "$jobdir1/tracked-changed.txt")" = v2 ] || die "the job worktree does not hold the changed tracked file of the second commit"
[ ! -e "$jobdir1/tracked-deleted.txt" ] || die "a file deleted by the second commit is still in the job worktree"
[ "$(git -C "$jobdir1" rev-parse HEAD)" = "$(git -C "$runner" rev-parse HEAD)" ] || die "the reset job worktree is not at the snapshot"
[ -z "$(git -C "$jobdir1" status --porcelain)" ] || die "the reset job worktree has tracked or untracked changes"
extra=$(git -C "$jobdir1" status --porcelain --ignored=matching --untracked-files=all | grep -vE '^!! (ui/\.next/|ui/\.next/cache/|bin/k8s/)$' || true)
[ -z "$extra" ] || die "ignored files other than the kept caches remain: $extra"
say "a second run for a later commit reuses the job worktree at the same path, at that commit, keeping only the envtest and Next.js caches"

# R22j: a rerun of the same tree keeps the previous run's job log under previous/<run id>/ instead of overwriting it,
# and only the newest PAPRIKA_CI_KEEP_PREVIOUS_RUNS previous runs are kept.
logs_tree12=$(git -C "$runner" rev-parse 'HEAD^{tree}' | cut -c1-12)
logs_dir="$runner/artifacts/ci/$logs_tree12"
echo "marker from the earlier run" >>"$logs_dir/terraform.log"
run_cmd ok "rerun keeps the previous log" bash -c "cd '$runner' && bash hack/ci/run.sh --jobs terraform"
expect_output "previous logs for the rerun jobs moved to"
grep -Fq "marker from the earlier run" "$logs_dir/terraform.log" && die "the rerun log still holds the earlier run's content"
grep -lF "marker from the earlier run" "$logs_dir"/previous/*/terraform.log >/dev/null 2>&1 ||
  die "the earlier run's log was not kept under previous/"
for n in 1 2; do
  run_cmd ok "rerun $n with two previous runs kept" bash -c "cd '$runner' && PAPRIKA_CI_KEEP_PREVIOUS_RUNS=2 bash hack/ci/run.sh --jobs terraform"
done
[ "$(find "$logs_dir/previous" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" = 2 ] ||
  die "previous/ does not hold exactly the two newest runs: $(ls "$logs_dir/previous")"
say "a rerun of the same tree keeps the previous job log under previous/ and prunes to the newest kept runs"

# R22b: a stable job directory that is not a registered worktree (a plain directory) is replaced, and the run passes.
mkdir -p "$jobs_root/chart" && printf 'stale\n' >"$jobs_root/chart/stale.txt"
mkdir -p "$stable_roots/5"
run_cmd ok "run over a plain directory at a job's path" bash -c "cd '$runner' && PAPRIKA_CI_SELFTEST_ROOTS='$stable_roots/5' bash hack/ci/run.sh --jobs chart"
[ ! -e "$jobs_root/chart/stale.txt" ] || die "the plain directory at the job path was kept"
git -C "$runner" worktree list --porcelain | grep -qxF "worktree $jobs_root/chart" || die "the replaced job directory is not a registered worktree"
say "a plain directory at a job's stable path is replaced by a worktree, and the run passes"

# R22c: index flags left by an earlier run do not survive the reset. A skip-worktree file keeps its stale content through
# checkout --force, and status shows nothing for it, so the run rebuilds the worktree instead.
jobdir=$jobs_root/terraform
printf 'tampered\n' >"$jobdir/tracked-changed.txt"
git -C "$jobdir" update-index --skip-worktree tracked-changed.txt
printf 'tampered\n' >"$jobdir/tracked-assumed.txt"
git -C "$jobdir" update-index --assume-unchanged tracked-assumed.txt
run_cmd ok "run over index flags left in the job worktree" bash -c "cd '$runner' && bash hack/ci/run.sh --jobs terraform"
expect_output "index flags"
[ "$(cat "$jobdir/tracked-changed.txt")" = v2 ] || die "a skip-worktree file kept its tampered content through the reset"
[ "$(cat "$jobdir/tracked-assumed.txt")" = v1 ] || die "an assume-unchanged file kept its tampered content through the reset"
[ -z "$(git -C "$jobdir" ls-files -v | grep -v '^H ' || true)" ] || die "the rebuilt job worktree still has index flags"
say "a skip-worktree or assume-unchanged bit in a job worktree does not survive the run: the worktree is rebuilt"

# R22d: a cache root reached through a symlink still reuses the job worktree: the job directory is resolved physically.
jobdir=$jobs_root/terraform
mkdir -p "$jobdir/ui/.next/cache" && echo kept >"$jobdir/ui/.next/cache/symlink-kept.bin"
ln -s "$work/cache" "$work/cache-link"
mkdir -p "$stable_roots/6"
run_cmd ok "stable job worktree through a symlinked cache root" env PAPRIKA_CI_CACHE_ROOT="$work/cache-link" \
  bash -c "cd '$runner' && PAPRIKA_CI_SELFTEST_ROOTS='$stable_roots/6' bash hack/ci/run.sh --jobs terraform"
[ "$(cat "$stable_roots/6/terraform")" = "$jobs_root/terraform" ] || die "a symlinked cache root gave the job $(cat "$stable_roots/6/terraform"), not $jobs_root/terraform"
[ -f "$jobdir/ui/.next/cache/symlink-kept.bin" ] || die "a symlinked cache root defeated the reuse: the job worktree was rebuilt"
say "a cache root reached through a symlink still reuses the stable job worktree"

# R22e: while another process holds the run lock, this run uses per-run worktrees, logs it, skips the trim, and leaves the
# lock alone.
holder_ready=$work/holder-ready
rm -f "$holder_ready"
perl -MFcntl=:flock -e 'open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; open(my $m, ">", $ARGV[1]) or die; close $m; sleep 600' \
  "$jobs_root/.run.lock" "$holder_ready" &
lock_holder=$!
for _ in $(seq 1 30); do
  [ -f "$holder_ready" ] && break
  sleep 1
done
if [ ! -f "$holder_ready" ]; then
  die "the test process did not take the run lock"
fi
if lock_free; then die "the run lock is free while the test process holds it"; fi
mkdir -p "$stable_roots/3"
run_cmd ok "run while the run lock is held" bash -c "cd '$runner' && PAPRIKA_CI_SELFTEST_ROOTS='$stable_roots/3' bash hack/ci/run.sh --jobs terraform"
expect_output "per-run job worktrees"
expect_output "caches are not reused for this run"
expect_output "trim skipped"
jobdir3=$(cat "$stable_roots/3/terraform")
[ "$jobdir3" != "$jobs_root/terraform" ] || die "a run with the lock held used the stable job worktree"
[ ! -e "$jobdir3" ] || die "the per-run job worktree was left behind"
if lock_free; then die "the run released a lock that another process holds"; fi
kill "$lock_holder" 2>/dev/null || true
wait "$lock_holder" 2>/dev/null || true
lock_holder=""
say "a run that finds the lock held by another process uses per-run worktrees, logs it, skips the trim, and leaves the lock alone"

# R22f: a leftover run lock file with no holder does not block the run: the file itself is not a lock.
printf '99999\n' >"$jobs_root/.run.lock"
mkdir -p "$stable_roots/4"
run_cmd ok "run over a leftover lock file" bash -c "cd '$runner' && PAPRIKA_CI_SELFTEST_ROOTS='$stable_roots/4' bash hack/ci/run.sh --jobs terraform"
expect_no_output "per-run job worktrees"
[ "$(cat "$stable_roots/4/terraform")" = "$jobs_root/terraform" ] || die "a run over a leftover lock file did not use the stable job worktree"
say "a leftover run lock file with no holder does not block the run"

# R22g: the run holds the lock only while it runs: once it has ended, a new probe takes the lock.
lock_free || die "the run did not release the run lock when it ended"
say "the run lock is released when the run ends"

# R22h: the trim deletes only Go cache entry files (names ending in -a or -d) not modified for more than the maximum age.
# Other files in the cache directory are kept, and the age is configurable.
trim=$work/trim-cache
mkdir -p "$trim/xx"
: >"$trim/xx/abc-d"
touch -t 200001010000 "$trim/xx/abc-d"
: >"$trim/xx/abc-a"
touch -t 200001010000 "$trim/xx/abc-a"
: >"$trim/xx/recent-d"
: >"$trim/testexpire.txt"
touch -t 200001010000 "$trim/testexpire.txt"
run_cmd ok "cache trim" bash -c "source '$repo_root/hack/ci/lib.sh' && PAPRIKA_CI_GOCACHE='$trim' ci_trim_go_cache"
expect_output "deleted 2 entry files"
[ ! -e "$trim/xx/abc-d" ] || die "an old cache entry (-d) was kept"
[ ! -e "$trim/xx/abc-a" ] || die "an old cache entry (-a) was kept"
[ -e "$trim/xx/recent-d" ] || die "a recent cache entry was deleted"
[ -e "$trim/testexpire.txt" ] || die "a file that is not a cache entry was deleted"
: >"$trim/xx/abc-d"
touch -t 200001010000 "$trim/xx/abc-d"
run_cmd ok "cache trim with a longer maximum age" bash -c "source '$repo_root/hack/ci/lib.sh' && PAPRIKA_CI_GOCACHE='$trim' PAPRIKA_CI_GOCACHE_MAX_AGE_DAYS=36500 ci_trim_go_cache"
expect_output "deleted 0 entry files"
[ -e "$trim/xx/abc-d" ] || die "PAPRIKA_CI_GOCACHE_MAX_AGE_DAYS does not change the maximum age"
run_cmd fail "non-numeric maximum age" bash -c "source '$repo_root/hack/ci/lib.sh' && PAPRIKA_CI_GOCACHE='$trim' PAPRIKA_CI_GOCACHE_MAX_AGE_DAYS=three ci_trim_go_cache"
say "the Go build cache trim deletes only old cache entry files, keeps other files, and its age is configurable"

# R22i: PAPRIKA_CI_FRESH (1, true or yes, in any case) runs go-test with -count=1 and resets the job worktrees without
# keeping their caches. Without it the go-test job gets no flag and the kept caches survive the reset.
fresh_dump=$work/fresh-go-test.env
run_cmd ok "FRESH run of go-test" env PAPRIKA_CI_FRESH=1 PAPRIKA_CI_SELFTEST_ENVDUMP="$fresh_dump" \
  bash -c "cd '$runner' && bash hack/ci/run.sh --jobs go-test"
grep -qxF 'GOFLAGS=-count=1' "$fresh_dump" || die "PAPRIKA_CI_FRESH=1 did not reach go-test as -count=1: $(grep GOFLAGS "$fresh_dump")"
mkdir -p "$jobs_root/go-test/ui/.next/cache" && echo kept >"$jobs_root/go-test/ui/.next/cache/fresh-kept.bin"
plain_dump=$work/plain-go-test.env
run_cmd ok "go-test run without FRESH" env PAPRIKA_CI_SELFTEST_ENVDUMP="$plain_dump" \
  bash -c "cd '$runner' && bash hack/ci/run.sh --jobs go-test"
grep -qxF 'GOFLAGS=' "$plain_dump" || die "a run without PAPRIKA_CI_FRESH passes GOFLAGS to go-test: $(grep GOFLAGS "$plain_dump")"
[ -f "$jobs_root/go-test/ui/.next/cache/fresh-kept.bin" ] || die "a run without PAPRIKA_CI_FRESH removed the Next.js cache"
true_dump=$work/true-go-test.env
run_cmd ok "FRESH=true run of go-test" env PAPRIKA_CI_FRESH=true PAPRIKA_CI_SELFTEST_ENVDUMP="$true_dump" \
  bash -c "cd '$runner' && bash hack/ci/run.sh --jobs go-test"
grep -qxF 'GOFLAGS=-count=1' "$true_dump" || die "PAPRIKA_CI_FRESH=true did not reach go-test as -count=1: $(grep GOFLAGS "$true_dump")"
[ ! -e "$jobs_root/go-test/ui/.next/cache/fresh-kept.bin" ] || die "PAPRIKA_CI_FRESH=true kept the Next.js cache of the job worktree"
say "PAPRIKA_CI_FRESH reaches go-test as -count=1 and clears the kept caches; without it neither happens"

# R22: a time limit stops a nested ci_with_timeout and its process, not only the job's own shell.
nest=$work/nest.pid
run_cmd fail "job over its limit with a nested step" bash -c \
  "cd '$runner' && PAPRIKA_CI_SELFTEST_NESTED='$nest' PAPRIKA_CI_SELFTEST_TIMEOUT_SECS=3 bash hack/ci/run.sh --jobs terraform"
expect_output "1 job(s) did not pass"
[ -f "$nest" ] || die "the nested step did not start"
nested_pid=$(cat "$nest")
if kill -0 "$nested_pid" 2>/dev/null; then
  kill -KILL "$nested_pid" 2>/dev/null || true
  die "a nested step survived its job's time limit"
fi
say "a job stopped at its time limit takes its nested steps with it"

# R23: the Docker-heavy jobs never overlap, even when the runner allows more than one job at a time.
times=$work/times
mkdir -p "$times"
run_cmd ok "Docker-heavy jobs with a parallel limit" bash -c \
  "cd '$runner' && PAPRIKA_CI_SELFTEST_TIMES='$times' bash hack/ci/run.sh --jobs application-records,fleet-scale --parallel 2"
a_start=$(cat "$times/application-records.start")
a_end=$(cat "$times/application-records.end")
f_start=$(cat "$times/fleet-scale.start")
f_end=$(cat "$times/fleet-scale.end")
if [ "$a_start" -lt "$f_end" ] && [ "$f_start" -lt "$a_end" ]; then
  die "two Docker-heavy jobs ran at the same time ($a_start-$a_end and $f_start-$f_end)"
fi
say "Docker-heavy jobs run one after another, even with --parallel 2"

# R23b: the CPU-heavy jobs (CI_HEAVY_JOBS) never overlap each other, while a light job still runs beside one of them.
heavy_times=$work/heavy-times
mkdir -p "$heavy_times"
run_cmd ok "CPU-heavy jobs with a parallel limit" bash -c \
  "cd '$runner' && PAPRIKA_CI_SELFTEST_TIMES='$heavy_times' bash hack/ci/run.sh --jobs go-test,ui,terraform --parallel 3"
g_start=$(cat "$heavy_times/go-test.start")
g_end=$(cat "$heavy_times/go-test.end")
u_start=$(cat "$heavy_times/ui.start")
u_end=$(cat "$heavy_times/ui.end")
t_start=$(cat "$heavy_times/terraform.start")
if [ "$g_start" -lt "$u_end" ] && [ "$u_start" -lt "$g_end" ]; then
  die "two CPU-heavy jobs ran at the same time (go-test $g_start-$g_end, ui $u_start-$u_end)"
fi
[ "$t_start" -lt "$g_end" ] || die "the light job waited for the heavy jobs instead of running beside them"
say "CPU-heavy jobs run one after another, and a light job runs beside them"

# R24: status.sh refuses a ci.yml that defines a job hack/ci does not mirror.
cat >>"$runner/.github/workflows/ci.yml" <<'YML'

  extra-job:
    name: Unmirrored job for a self-test
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo unmirrored
YML
git -C "$runner" -c core.hooksPath=/dev/null commit --quiet -am "add a job that hack/ci does not mirror"
run_cmd fail "status with an unmirrored job" bash -c "cd '$runner' && bash hack/ci/status.sh HEAD"
expect_output "ci.yml defines job 'extra-job' with no entry in hack/ci"
git -C "$runner" -c core.hooksPath=/dev/null reset --quiet --hard HEAD~1
say "status.sh refuses a ci.yml with a job that hack/ci does not mirror"

# R25: a download whose SHA-256 does not match is refused and leaves no file in place.
tdir=$work/fetch
mkdir -p "$tdir"
printf 'pinned payload\n' >"$tdir/payload"
good_sha=$(shasum -a 256 "$tdir/payload" | awk '{print $1}')
payload_url="file://$tdir/payload"
run_cmd fail "fetch with a wrong checksum" bash -c \
  "source '$runner/hack/ci/lib.sh'; source '$runner/hack/ci/tools.sh'; fetch '$payload_url' 0000000000000000000000000000000000000000000000000000000000000000 '$tdir/refused'"
expect_output "checksum mismatch"
if [ -e "$tdir/refused" ] || [ -e "$tdir/refused.part" ]; then die "a download with a wrong checksum was left in place"; fi
run_cmd ok "fetch with the pinned checksum" bash -c \
  "source '$runner/hack/ci/lib.sh'; source '$runner/hack/ci/tools.sh'; fetch '$payload_url' '$good_sha' '$tdir/accepted'"
[ -f "$tdir/accepted" ] || die "a verified download was not put in place"
say "a download with a wrong SHA-256 is refused, and a verified one is kept"

# R26: task ci:quick runs go test on the changed Go packages, and fails when a test fails.
make_clone quick
quick=$work/quick
printf 'module example.invalid/quick\n\ngo 1.22\n' >"$quick/go.mod"
git -C "$quick" add go.mod
git -C "$quick" -c core.hooksPath=/dev/null commit --quiet -m "module"
git -C "$quick" -c core.hooksPath=/dev/null push --quiet origin master
mkdir -p "$quick/bin"
printf '#!/usr/bin/env bash\nexit 0\n' >"$quick/bin/golangci-lint"
chmod +x "$quick/bin/golangci-lint"
git -C "$quick" checkout --quiet -b feature-quick
mkdir -p "$quick/pkg/bad"
printf 'package bad\n\nfunc Bad() int { return 1 }\n' >"$quick/pkg/bad/bad.go"
printf 'package bad\n\nimport "testing"\n\nfunc TestBad(t *testing.T) {\n\tif Bad() != 2 {\n\t\tt.Fatal("Bad must return 2")\n\t}\n}\n' >"$quick/pkg/bad/bad_test.go"
git -C "$quick" add pkg
git -C "$quick" -c core.hooksPath=/dev/null commit --quiet -m "add a package with a failing test"
run_cmd fail "quick checks with a failing Go test" bash -c "cd '$quick' && bash hack/ci/quick.sh"
expect_output "FAIL  go test"
printf 'package bad\n\nfunc Bad() int { return 2 }\n' >"$quick/pkg/bad/bad.go"
git -C "$quick" -c core.hooksPath=/dev/null commit --quiet -am "make Bad return 2"
run_cmd ok "quick checks once the test passes" bash -c "cd '$quick' && bash hack/ci/quick.sh"
expect_output "ok    go test"
say "quick checks run go test on the changed packages and fail on a failing test"

# ---------------------------------------------------------------------------------------------
# Deploy: the clone is on master, pushed, with a passing stamp. Every cluster and registry call
# is a fake, and the kubeconfig is a fake file.
# ---------------------------------------------------------------------------------------------
make_clone deploy
deploy=$work/deploy
write_passing_stamp "$deploy"

# An empty Docker config, so the registry login state is the test's own, never the developer's.
docker_config=$work/docker-config
mkdir -p "$docker_config"
printf '{}\n' >"$docker_config/config.json"

deploy_run() { # extra VAR=value arguments come last, so they override the defaults
  mkdir -p "$work/capture"
  chmod 700 "$work/capture"
  (
    cd "$deploy" &&
      env -i HOME="$HOME" TMPDIR="$work/tmp" PATH="$fakebin:$PATH" DOCKER_CONFIG="$docker_config" PAPRIKA_CI_SELFTEST=1 \
        PAPRIKA_CI_TOOL_BIN="$tools" PAPRIKA_DEPLOY_KUBECONFIG="$fake_kc" \
        FAKE_SERVER="$fake_server" FAKE_PAPRIKA_DIGEST="$PD" FAKE_RENDER_DIGEST="$RD" \
        FAKE_LIVE_CID=live-cid-value FAKE_LIVE_HASH=live-hash-value FAKE_LOG="$FAKE_LOG_FILE" \
        FAKE_CAPTURE_DIR="$work/capture" \
        "$@" bash hack/deploy/vke.sh
  )
}
run_deploy() { # logfile, then env overrides
  local logf=$1
  shift
  FAKE_LOG_FILE=$logf
  run_cmd fail "deploy" deploy_run "$@"
}
run_deploy_ok() {
  local logf=$1
  shift
  FAKE_LOG_FILE=$logf
  run_cmd ok "deploy" deploy_run "$@"
}
cluster_calls() { [ ! -s "$1" ] || grep -E '^(kubectl|helm|docker)\|' "$1" || true; }

# D1: refusals happen before the cluster, the registry and the kubeconfig are touched.
log=$work/d1.log
git -C "$deploy" checkout --quiet -b feature-check
run_deploy "$log"
expect_output "run from branch master (current: feature-check)"
[ -z "$(cluster_calls "$log")" ] || die "branch refusal reached the cluster"
git -C "$deploy" checkout --quiet master
say "deploy refuses a branch other than master before any cluster call"

log=$work/d2.log
git -C "$deploy" -c core.hooksPath=/dev/null commit --quiet --allow-empty -m "local only"
run_deploy "$log"
expect_output "is not origin/master"
[ -z "$(cluster_calls "$log")" ] || die "HEAD != origin refusal reached the cluster"
git -C "$deploy" reset --quiet --hard origin/master
say "deploy refuses HEAD that differs from origin/master"

log=$work/d3.log
echo scratch >"$deploy/dirty-scratch.txt"
run_deploy "$log"
expect_output "working tree is not clean"
rm -f "$deploy/dirty-scratch.txt"
say "deploy refuses a dirty tree"

log=$work/d4.log
stamp_real=$(stamp_path "$deploy" "$(git -C "$deploy" rev-parse 'HEAD^{tree}')")
mv "$stamp_real" "$stamp_real.hidden"
run_deploy "$log"
expect_output "local CI does not pass for this commit"
mv "$stamp_real.hidden" "$stamp_real"
say "deploy refuses without a passing local CI stamp"

log=$work/d5.log
run_deploy "$log" PAPRIKA_DEPLOY_KUBECONFIG=
expect_output "PAPRIKA_DEPLOY_KUBECONFIG is required"
say "deploy refuses without a kubeconfig variable"

log=$work/d6.log
printf 'apiVersion: v1\n' >"$deploy/inside-repo-kubeconfig"
run_deploy "$log" PAPRIKA_DEPLOY_KUBECONFIG="$deploy/inside-repo-kubeconfig"
rm -f "$deploy/inside-repo-kubeconfig"
expect_output "the kubeconfig must live outside the repository"
[ -z "$(cluster_calls "$log")" ] || die "in-repo kubeconfig refusal reached the cluster"
say "deploy refuses a kubeconfig inside the repository"

log=$work/d7.log
lock=$(git -C "$deploy" rev-parse --path-format=absolute --git-common-dir)/paprika-deploy.lock
mkdir "$lock"
run_deploy "$log"
rmdir "$lock"
expect_output "another deploy holds"
say "deploy refuses while another deploy holds the lock"

# D8: happy path. Planted secret values must never appear in output, argv, reports or logs. The only place they
# may appear is the test capture: the Secret stdin and the auth values file, both mode 0600.
log=$work/d8.log
PLANT_OIDC=PLANT-oidc-secret-7731
PLANT_AUTH=PLANT-auth-secret-7731
PLANT_CID=PLANT-client-id-7731
PLANT_HASH=PLANT-password-hash-7731
rm -rf -- "$work/capture"
docker_before=$(cksum <"$docker_config/config.json")
run_deploy_ok "$log" VKE_OIDC_CLIENT_SECRET="$PLANT_OIDC" VKE_AUTH_TOKEN_SECRET="$PLANT_AUTH" \
  VKE_OIDC_CLIENT_ID="$PLANT_CID" VKE_BASIC_PASSWORD_HASH="$PLANT_HASH"
for planted in "$PLANT_OIDC" "$PLANT_AUTH" "$PLANT_CID" "$PLANT_HASH" FAKE-GH-TOKEN-VALUE; do
  expect_no_output "$planted"
  if grep -Fq -- "$planted" "$log"; then die "a planted value reached the fake command log: $planted"; fi
done
capture=$work/capture
[ "$(cat "$capture/secret-paprika-oidc" 2>/dev/null)" = "$PLANT_OIDC" ] ||
  die "the paprika-oidc Secret did not receive the client secret on stdin"
[ "$(cat "$capture/secret-paprika-auth-token" 2>/dev/null)" = "$PLANT_AUTH" ] ||
  die "the paprika-auth-token Secret did not receive its token on stdin"
[ "$(jq -r '.auth.oidc.clientID' "$capture/auth-values.json" 2>/dev/null)" = "$PLANT_CID" ] ||
  die "the auth values file does not carry the client ID"
[ "$(jq -r '.auth.basic.passwordHash' "$capture/auth-values.json" 2>/dev/null)" = "$PLANT_HASH" ] ||
  die "the auth values file does not carry the password hash"
for f in "$capture"/*; do
  [ "$(file_mode "$f")" = 600 ] || die "a test capture file is not mode 0600: $f"
done
# The clone holds a copy of this test, which contains the planted strings, so the scan covers only what the
# deploy writes: the fake command log and output, the deploy report and the deploy's temporary Docker configs.
found_outside=$(grep -rlF -e "$PLANT_OIDC" -e "$PLANT_AUTH" -e "$PLANT_CID" -e "$PLANT_HASH" \
  "$work"/d*.log "$work/out.txt" "$deploy/artifacts" "$work/docker-config" "$work/docker-config-preexisting" 2>/dev/null || true)
[ -z "$found_outside" ] || die "planted values were written outside the test capture: $found_outside"
expect_output "deploy: Secret paprika-oidc: configured"
expect_output "deployed ghcr.io/paprikacd/paprika@sha256:$PD to paprika-e2e (revision 7)"
expect_output "health checks: 4 passed, 0 failed"
expect_output "image digests: 5 running container(s) report the pushed digest"
report=$deploy/artifacts/deploy/$(git -C "$deploy" rev-parse HEAD | cut -c1-12).json
[ -f "$report" ] || die "no deploy report at $report"
[ "$(jq -r '.helm.revision' "$report")" = 7 ] || die "report has the wrong Helm revision"
[ "$(jq -r '.images.renderWorker' "$report")" = "ghcr.io/paprikacd/paprika-render-worker@sha256:$RD" ] ||
  die "report has the wrong renderer image"
if grep -Eq 'PLANT-|FAKE-GH|live-hash|live-cid' "$report"; then die "the deploy report contains a secret value"; fi
[ "$(jq -c '.waiver' "$report")" = null ] || die "a deploy of a full fleet-scale pass records a waiver"
grep -q "^kubectl|$fake_kc|" "$log" || die "kubectl did not receive the deploy kubeconfig"
grep -q "^helm|$fake_kc|" "$log" || die "helm did not receive the deploy kubeconfig"
# Every kubectl and helm call names the deploy kubeconfig on its own argv (the log field after the environment one).
bad_kubectl=$(grep '^kubectl|' "$log" | grep -vF "|--kubeconfig $fake_kc " || true)
[ -z "$bad_kubectl" ] || die "a kubectl call does not name --kubeconfig on argv: $bad_kubectl"
# helm version is the pinned-tool check (hack/ci/tools.sh); it does not reach a cluster and needs no kubeconfig.
bad_helm=$(grep '^helm|' "$log" | grep -vF "|version " | grep -vF "|--kubeconfig $fake_kc " || true)
[ -z "$bad_helm" ] || die "a helm call does not name --kubeconfig on argv: $bad_helm"
# The helm argv must match deploy-vke.yml: the three values files in order, then the renderer and
# auth values, the five image overrides, the OIDC Secret reference, and the wait and timeout flags.
pimg="ghcr.io/paprikacd/paprika@sha256:$PD"
helm_line=$(grep -F 'upgrade --install paprika-e2e' "$log" | head -1)
helm_want="helm|$fake_kc|--kubeconfig $fake_kc upgrade --install paprika-e2e charts/chart --namespace paprika-e2e"
helm_want="$helm_want --values deploy/test-values.yaml --values deploy/omega-values.yaml --values deploy/insights-omega-values.yaml"
helm_want="$helm_want --values *renderer-values.json --values *auth-values.json"
helm_want="$helm_want --set-string manager.image.repository=$pimg --set-string apiServer.image.repository=$pimg"
helm_want="$helm_want --set-string repoServer.image.repository=$pimg --set-string webhookReceiver.image.repository=$pimg"
helm_want="$helm_want --set-string observabilityGateway.image.repository=$pimg"
helm_want="$helm_want --set-string auth.oidc.existingSecretName=paprika-oidc --set-string auth.oidc.existingSecretKey=client-secret"
helm_want="$helm_want --wait --timeout 5m --create-namespace"
# The right-hand side is a pattern on purpose: the renderer and auth values files are in a temp directory.
# shellcheck disable=SC2053
[[ "$helm_line" == $helm_want ]] || die "helm upgrade argv differs from deploy-vke.yml: $helm_line"
grep -Fq 'wait --for=condition=Ready pods -l app.kubernetes.io/instance=paprika-e2e --field-selector=status.phase!=Succeeded,status.phase!=Failed -n paprika-e2e --timeout=180s' "$log" ||
  die "the pod readiness wait does not use the deploy-vke.yml selectors"
if grep -q 'auth.basic.passwordHash' "$log"; then die "the password hash was passed on helm argv"; fi
grep -Eq '^docker\|buildx .*/src$' "$log" || die "images were not built from a worktree of the commit"
if grep -Eq "^docker\|buildx .* $deploy\$" "$log"; then die "images were built from the developer checkout"; fi
grep -Eq '^docker\|buildx .* -f [^ ]+/src/Dockerfile ' "$log" || die "the manager image was not built with the worktree's Dockerfile"
grep -Eq '^docker\|buildx .* -f [^ ]+/src/ui/Dockerfile\.render-worker ' "$log" ||
  die "the renderer image was not built with the worktree's Dockerfile"
if grep -Fq -- ' -f ui/Dockerfile.render-worker ' "$log"; then die "the renderer Dockerfile was resolved in the developer checkout"; fi
grep -Fq "docker-config|$work/tmp/paprika-deploy." "$log" || die "the registry login did not use a Docker config private to the deploy"
[ "$(cksum <"$docker_config/config.json")" = "$docker_before" ] || die "the developer's Docker config was changed by the deploy"
if [ -n "$(find "$work/tmp" -maxdepth 1 -name 'paprika-deploy.*' -print -quit)" ]; then
  die "the deploy work directory (with its registry login) was left behind"
fi
if pgrep -f -- "$fake_server" >/dev/null 2>&1; then die "a port-forward server outlived the deploy"; fi
say "deploy happy path: secrets on stdin only, argv mirrors deploy-vke.yml, private Docker config, no leftovers"

# D8b: the developer's own ghcr.io login is neither used nor removed. The deploy logs in to its private config.
log=$work/d8b.log
preexisting_config=$work/docker-config-preexisting
mkdir -p "$preexisting_config"
printf '{"auths":{"ghcr.io":{"auth":"ZGV2ZWxvcGVy"}}}\n' >"$preexisting_config/config.json"
run_deploy_ok "$log" DOCKER_CONFIG="$preexisting_config"
grep -q '^docker|login ghcr.io' "$log" || die "the registry login did not run"
jq -e '.auths["ghcr.io"].auth == "ZGV2ZWxvcGVy"' "$preexisting_config/config.json" >/dev/null ||
  die "the developer's ghcr.io login was changed"
grep -Fq "docker-config|$work/tmp/paprika-deploy." "$log" || die "the login did not use the private config"
say "deploy leaves the developer's ghcr.io login in place and logs in to a private config"

# D8c: a containerd node reports .image as the bare config ID; the digest check reads the repository from imageID.
log=$work/d8c.log
run_deploy_ok "$log" FAKE_CONTAINERD_STATUS=1
expect_output "image digests: 5 running container(s) report the pushed digest"
log=$work/d8d.log
run_deploy "$log" FAKE_CONTAINERD_STATUS=1 FAKE_IMAGEID_MISMATCH=1
expect_output "do not report the pushed digest"
say "deploy checks image digests when the runtime reports .image as a config ID"

# D9 to D15: each cluster-side refusal names its reason.
log=$work/d9.log
run_deploy "$log" FAKE_CONTEXT=other
expect_output "current context must be vke"
say "deploy refuses a kubeconfig whose context is not vke"

log=$work/d10.log
run_deploy "$log" FAKE_MISSING_SECRET=paprika-oidc
expect_output "Secret paprika-oidc does not exist"
say "deploy refuses when the paprika-oidc Secret is missing"

log=$work/d11.log
run_deploy "$log" FAKE_NO_RELEASE=1 VKE_OIDC_CLIENT_ID=explicit-cid VKE_BASIC_PASSWORD_HASH=
expect_output "auth.basic.passwordHash is unknown"
say "deploy refuses when the password hash is unknown"

log=$work/d12.log
run_deploy "$log" FAKE_IMAGEID_MISMATCH=1
expect_output "do not report the pushed digest"
say "deploy refuses when a running container reports another digest"

log=$work/d13.log
run_deploy "$log" FAKE_HELM_STATUS=failed
expect_output "Helm reports status failed for revision 7"
say "deploy refuses when Helm does not report the new revision as deployed"

log=$work/d14.log
run_deploy "$log" FAKE_PVC_PHASE=Pending
expect_output "retained paprika-e2e-insights PVC to be Bound (found: Pending)"
[ -z "$(grep -E '^helm\|' "$log" | grep 'upgrade --install' || true)" ] || die "a Pending PVC still reached helm upgrade"
say "deploy refuses before any release change when the Insights PVC is not Bound"

log=$work/d15.log
run_deploy "$log" FAKE_NO_RENDERER=1
expect_output "the dashboard renderer is enabled but no running render-worker container was found"
say "deploy refuses when the enabled dashboard renderer is not running"

log=$work/d16.log
run_deploy "$log" FAKE_HEALTH_CODE=503
expect_output "FAIL readiness endpoint"
expect_output "health checks failed"
say "deploy refuses when a health check fails"

# D17 to D20: the cluster-side waits and checks refuse, and so does a malformed digest or an extra argument.
log=$work/d17.log
run_deploy "$log" FAKE_WAIT_FAIL=1
expect_output "pods were not Ready within 180s"
say "deploy refuses when the pods are not Ready within 180 s"

log=$work/d18.log
run_deploy "$log" FAKE_POD_NOT_READY=1
expect_output "pod conditions check failed"
say "deploy refuses when a component's pods report not Ready"

log=$work/d19.log
run_deploy "$log" FAKE_BAD_DIGEST=1
expect_output "manager build reported no valid sha256 digest"
[ -z "$(grep -E '^helm\|' "$log" | grep 'upgrade --install' || true)" ] || die "a malformed digest still reached helm upgrade"
say "deploy refuses a malformed image digest before any release change"

log=$work/d20.log
FAKE_LOG_FILE=$log
run_cmd fail "deploy with an argument" env PATH="$fakebin:$PATH" PAPRIKA_CI_TOOL_BIN="$tools" \
  PAPRIKA_DEPLOY_KUBECONFIG="$fake_kc" FAKE_LOG="$log" bash -c "cd '$deploy' && bash hack/deploy/vke.sh --force"
expect_output "takes no arguments (got: --force)"
[ -z "$(cluster_calls "$log")" ] || die "an argument refusal reached the cluster"
say "deploy takes no arguments"

# D22: the cluster phase has a time limit, and a phase over it is stopped, reported and cleaned up. The limit is
# shortened by the test hook; the default is checked against deploy-vke.yml below.
log=$work/d22.log
run_deploy "$log" PAPRIKA_CI_SELFTEST_CLUSTER_PHASE_SECS=3 FAKE_WAIT_SLEEP=30
expect_output "the cluster phase did not finish within 3 s"
if pgrep -f -- "$work/.*hack/deploy/vke-cluster[.]sh" >/dev/null 2>&1; then die "the cluster phase outlived its time limit"; fi
[ -z "$(find "$work/tmp" -maxdepth 1 -name 'paprika-deploy.*' -print -quit)" ] || die "the timed-out deploy left its work directory"
say "deploy stops the cluster phase at its time limit, reports it and cleans up"

# D22b: both image builds run under the ci.yml publish limit. The test hook shortens it; a build that runs over it is
# stopped and the deploy makes no cluster call after it (the preflight's read-only helm version and kubectl
# current-context calls come before the build). The manager build and the renderer build are each checked.
log=$work/d22b.log
run_deploy "$log" PAPRIKA_CI_SELFTEST_PUBLISH_SECS=2 FAKE_BUILDX_SLEEP=30
expect_output "manager image build failed (limit 2 s or an error)"
[ -z "$(sed -n '/^docker|buildx/,$p' "$log" | grep -E '^(kubectl|helm)\|' || true)" ] || die "a timed-out manager build reached the cluster"
log=$work/d22c.log
run_deploy "$log" PAPRIKA_CI_SELFTEST_PUBLISH_SECS=2 FAKE_RENDER_BUILDX_SLEEP=30
expect_output "dashboard renderer build failed (limit 2 s or an error)"
[ -z "$(sed -n '/^docker|buildx/,$p' "$log" | grep -E '^(kubectl|helm)\|' || true)" ] || die "a timed-out renderer build reached the cluster"
say "both image builds stop at the publish limit and the deploy fails before the cluster"

# D23: the time limits are the ones deploy-vke.yml sets: the job (timeout-minutes 20) bounds the cluster phase, and
# the renderer health check (the step's timeout-minutes 2) is bounded by ci_with_timeout in vke-cluster.sh.
deploy_yml=$repo_root/.github/workflows/deploy-vke.yml
job_mins=$(bash -c "source '$repo_root/hack/ci/lib.sh' && ci_job_timeout_minutes '$deploy_yml' deploy")
[ -n "$job_mins" ] || die "deploy-vke.yml has no job timeout-minutes"
renderer_mins=$(awk '/- name: Verify dashboard renderer/ { found = 1; next } found && /timeout-minutes:/ { print $2; exit }' "$deploy_yml")
[ -n "$renderer_mins" ] || die "deploy-vke.yml has no timeout-minutes on the renderer check"
grep -Fq "CLUSTER_PHASE_SECS=\$(($job_mins * 60))" "$repo_root/hack/deploy/vke.sh" ||
  die "the cluster phase limit in hack/deploy/vke.sh is not deploy-vke.yml timeout-minutes $job_mins"
grep -Fq "ci_with_timeout $((renderer_mins * 60)) bash hack/check-dashboard-renderer-health.sh" "$repo_root/hack/deploy/vke-cluster.sh" ||
  die "the renderer health check is not bounded by deploy-vke.yml timeout-minutes $renderer_mins"
say "deploy time limits match deploy-vke.yml (job $job_mins minutes, renderer check $renderer_mins minutes)"

# D24: a kubectl warning on stderr does not fail a Secret apply: only stdout is the result, as in deploy-vke.yml.
log=$work/d24.log
run_deploy_ok "$log" VKE_OIDC_CLIENT_SECRET=warned-secret FAKE_APPLY_WARNING=1 \
  VKE_OIDC_CLIENT_ID="$PLANT_CID" VKE_BASIC_PASSWORD_HASH="$PLANT_HASH"
expect_output "Secret paprika-oidc: configured"
say "a kubectl warning on stderr does not fail a Secret apply"

# D25: a deploy whose stamp waives the fleet-scale UI half prints the waiver and records it in the deploy report.
log=$work/d25.log
deploy_stamp=$(stamp_path "$deploy" "$(git -C "$deploy" rev-parse 'HEAD^{tree}')")
cp "$deploy_stamp" "$work/deploy-stamp-full.json"
jq --arg base "$(git -C "$deploy" rev-parse origin/master)" '.jobs["fleet-scale"] = {result: "pass-waived", seconds: 1,
  log: "x", finishedAt: "2026-01-01T00:00:00Z",
  waiver: {part: "ui", reason: "test waiver", base: $base, baseKind: "stamp-pass", checkedPaths: 1, apiP95Ms: 117.448}}' \
  "$work/deploy-stamp-full.json" >"$deploy_stamp"
run_deploy_ok "$log" VKE_OIDC_CLIENT_ID="$PLANT_CID" VKE_BASIC_PASSWORD_HASH="$PLANT_HASH"
cp "$work/deploy-stamp-full.json" "$deploy_stamp"
expect_output "WAIVED fleet-scale ui half: test waiver"
waived_report=$deploy/artifacts/deploy/$(git -C "$deploy" rev-parse HEAD | cut -c1-12).json
[ "$(jq -r '.waiver.part' "$waived_report")" = ui ] || die "the deploy report does not carry the fleet-scale waiver"
say "a deploy prints the fleet-scale waiver and records it in the deploy report"

# D21: Ctrl-C during the cluster phase stops the cluster phase before the deploy releases its lock and work
# directory. The signal goes to the deploy's whole process group, as a terminal's Ctrl-C does. The cluster phase
# runs under its own process group (gtimeout), so only the deploy's trap can reach it.
log=$work/d21.log
lock=$(git -C "$deploy" rev-parse --path-format=absolute --git-common-dir)/paprika-deploy.lock
# A background job of a shell without a terminal can start with SIGINT ignored, and a signal to it would do nothing. So
# the deploy is started by a small wrapper that puts SIGINT back to its default and makes its own process group. The
# wrapper runs the same environment as deploy_run, and its pid is the deploy's pid after exec.
d21_run=$work/d21-run.sh
cat >"$d21_run" <<DEPLOY
#!/usr/bin/env bash
cd "$deploy" && exec env -i HOME="$HOME" TMPDIR="$work/tmp" PATH="$fakebin:$PATH" DOCKER_CONFIG="$docker_config" \
  PAPRIKA_CI_SELFTEST=1 PAPRIKA_CI_TOOL_BIN="$tools" PAPRIKA_DEPLOY_KUBECONFIG="$fake_kc" \
  FAKE_SERVER="$fake_server" FAKE_PAPRIKA_DIGEST="$PD" FAKE_RENDER_DIGEST="$RD" \
  FAKE_LIVE_CID=live-cid-value FAKE_LIVE_HASH=live-hash-value FAKE_LOG="$log" \
  FAKE_CAPTURE_DIR="$work/capture" FAKE_WAIT_SLEEP=30 bash hack/deploy/vke.sh
DEPLOY
chmod +x "$d21_run"
mkdir -p "$work/capture"
python3 -c '
import os, signal, sys
signal.signal(signal.SIGINT, signal.SIG_DFL)
os.setpgid(0, 0)
os.execv(sys.argv[1], sys.argv[1:])
' "$d21_run" >"$work/d21.out" 2>&1 &
deploy_pid=$!
for _ in $(seq 1 240); do
  grep -q 'wait --for=condition=Ready' "$log" 2>/dev/null && break
  sleep 0.5
done
grep -q 'wait --for=condition=Ready' "$log" 2>/dev/null || die "the cluster phase did not reach its kubectl wait"
kill -INT -- "-$deploy_pid" 2>/dev/null || die "could not signal the deploy's process group"
# The interrupted deploy must exit nonzero and must not report a deployment. A deploy that exits 0 means the signal did not
# reach it, so the self-test fails rather than passing unchecked.
deploy_rc=0
wait "$deploy_pid" 2>/dev/null || deploy_rc=$?
[ "$deploy_rc" -ne 0 ] || die "the interrupted deploy exited 0: the interrupt did not reach it"
if grep -q 'deployed ' "$work/d21.out"; then die "the interrupted deploy reported a deployment"; fi
if pgrep -f -- "$work/.*hack/deploy/vke-cluster[.]sh" >/dev/null 2>&1; then die "the cluster phase outlived the interrupted deploy"; fi
if pgrep -f -- "$fakebin/kubectl" >/dev/null 2>&1; then die "a kubectl call outlived the interrupted deploy"; fi
calls_at_exit=$(wc -l <"$log")
sleep 3
[ "$(wc -l <"$log")" = "$calls_at_exit" ] || die "the cluster phase made calls after the interrupted deploy exited"
[ ! -d "$lock" ] || die "the deploy lock is still held after the interrupted deploy exited"
[ -z "$(find "$work/tmp" -maxdepth 1 -name 'paprika-deploy.*' -print -quit)" ] || die "the interrupted deploy left its work directory"
say "an interrupt during the cluster phase stops the cluster phase before the deploy cleans up"

# ---------------------------------------------------------------------------------------------
# Hooks: the master gate and the quick-check skip, run against the deploy clone's stamp.
# ---------------------------------------------------------------------------------------------
deploy_head=$(git -C "$deploy" rev-parse HEAD)
hook_ref() { printf 'refs/heads/%s %s refs/heads/%s %s\n' "$1" "$2" "$1" "$ZD"; }

run_cmd ok "pre-push master gate passes with a stamp" bash -c \
  "cd '$deploy' && printf '%s\n' '$(hook_ref master "$deploy_head")' | bash .githooks/pre-push"
expect_output "pre-push: master gate for ${deploy_head:0:12}"
say "pre-push passes a master push whose commit has a passing stamp"

stamp_real=$(stamp_path "$deploy" "$(git -C "$deploy" rev-parse 'HEAD^{tree}')")
mv "$stamp_real" "$stamp_real.hidden"
run_cmd fail "pre-push master gate without stamp" bash -c \
  "cd '$deploy' && printf '%s\n' '$(hook_ref master "$deploy_head")' | PAPRIKA_SKIP_PREPUSH=1 bash .githooks/pre-push"
expect_output "local CI does not pass"
mv "$stamp_real.hidden" "$stamp_real"
say "pre-push refuses a master push without a stamp, even with PAPRIKA_SKIP_PREPUSH=1"

run_cmd ok "pre-push skip for a feature branch" bash -c \
  "cd '$deploy' && printf '%s\n' '$(hook_ref feature-x "$deploy_head")' | PAPRIKA_SKIP_PREPUSH=1 bash .githooks/pre-push"
expect_output "skipped task ci:quick (PAPRIKA_SKIP_PREPUSH=1)"
say "pre-push honours PAPRIKA_SKIP_PREPUSH for non-master refs only, and says so"

run_cmd ok "pre-push ignores ref deletions" bash -c \
  "cd '$deploy' && printf 'refs/heads/gone 0000000000000000000000000000000000000000 refs/heads/gone $ZD\n' | bash .githooks/pre-push"
say "pre-push ignores ref deletions"

# A non-master ref must name HEAD, whichever ref it is; the skip flag does not cover this check.
other_sha=$(git -C "$deploy" commit-tree "HEAD^{tree}" -p HEAD -m "other commit")
run_cmd fail "pre-push refuses a branch that is not HEAD" bash -c \
  "cd '$deploy' && printf '%s\n' '$(hook_ref feature-y "$other_sha")' | PAPRIKA_SKIP_PREPUSH=1 bash .githooks/pre-push"
expect_output "check out ${other_sha:0:12} before pushing refs/heads/feature-y"
say "pre-push refuses a non-master ref that is not HEAD, even with PAPRIKA_SKIP_PREPUSH=1"

# An annotated tag is peeled to its commit, so a tag of HEAD is accepted.
git -C "$deploy" tag -a local-ci-test-tag -m "test tag" "$deploy_head"
tag_obj=$(git -C "$deploy" rev-parse refs/tags/local-ci-test-tag)
run_cmd ok "pre-push accepts an annotated tag of HEAD" bash -c \
  "cd '$deploy' && printf 'refs/tags/local-ci-test-tag $tag_obj refs/tags/local-ci-test-tag $ZD\n' | PAPRIKA_SKIP_PREPUSH=1 bash .githooks/pre-push"
expect_output "skipped task ci:quick (PAPRIKA_SKIP_PREPUSH=1)"
say "pre-push peels an annotated tag to its commit"

# ---------------------------------------------------------------------------------------------
# Fleet-scale split on an arm64 Docker server: the API half under emulation, the UI half waived per tree.
# The gate script itself is replaced in a throwaway clone by a stub that checks the environment the job
# passes and writes the API log, so the job's own logic (base, changed paths, waiver) runs for real.
# ---------------------------------------------------------------------------------------------
fake_platform_file=$work/tmp/fake-docker-platform
printf 'linux/arm64\n' >"$fake_platform_file"
make_fleet_clone fleet
fleet=$work/fleet
cat >"$fleet/hack/test-fleet-scale.sh" <<'STUB'
#!/usr/bin/env bash
# Test stub: the gate is replaced in this throwaway clone only.
set -Eeuo pipefail
[ "${PAPRIKA_FLEET_SCALE_PARTS:-}" = api ] || { echo "stub: PAPRIKA_FLEET_SCALE_PARTS is not api" >&2; exit 1; }
[ "${PAPRIKA_FLEET_SCALE_ALLOW_EMULATED_AMD64:-}" = 1 ] || { echo "stub: emulation is not allowed" >&2; exit 1; }
mkdir -p artifacts/fleet-scale
printf 'FLEET_GOARCH=amd64\nFLEET_HEAP_BYTES=0\nFLEET_API_P95_MS=117.448\n' >artifacts/fleet-scale/api-scale.log
STUB
# The stub also records that the API half ran, so a lapse can be shown to stop the job before it.
fleet_api_marker=$work/tmp/fleet-api-ran
printf ': >>%q\n' "$fleet_api_marker" >>"$fleet/hack/test-fleet-scale.sh"
git -C "$fleet" add -A
git -C "$fleet" -c core.hooksPath=/dev/null commit --quiet -m "test stub for the fleet gate"
git -C "$fleet" -c core.hooksPath=/dev/null push --quiet origin master
git -C "$fleet" fetch --quiet origin
echo "note" >"$fleet/docs-note.md"
git -C "$fleet" add -A
git -C "$fleet" -c core.hooksPath=/dev/null commit --quiet -m "docs note"
fleet_base=$(git -C "$fleet" rev-parse origin/master)
# The base search needs a verified commit. The self-test anchors file lives in the self-test stamp directory.
bash "$fleet/hack/ci/fleet-anchor.sh" add "$fleet_base" "self-test base" >/dev/null

# full_stamp <clone>: every ci.yml job passes in the HEAD tree's stamp, and fleet-scale keeps its own entry.
full_stamp() {
  local dir=$1 stamp jobs
  stamp=$(stamp_path "$dir" "$(git -C "$dir" rev-parse 'HEAD^{tree}')")
  jobs=$(bash -c "source '$dir/hack/ci/lib.sh' && printf '%s\n' \$CI_JOBS")
  jq --arg jobs "$jobs" '. as $s | .jobs = ($jobs | split("\n") | map(select(length > 0))
    | map({key: ., value: ($s.jobs[.] // {result: "pass", seconds: 1, log: "artifacts/ci/x.log", finishedAt: "2026-01-01T00:00:00Z"})})
    | from_entries)' "$stamp" >"$stamp.full.tmp" && mv -- "$stamp.full.tmp" "$stamp"
}

# F0: the lapse groups (hack/ci/fleet-lapse.sh), checked against the real tree: the traced closure, the UI build inputs,
# the fixture's Go packages and the gate. Nothing under features/insights is in the closure, so an Insights-only change
# keeps the waiver. The closure and package lists are the ones the fleet clones were built from.
closure_real=$work/fleet-closure-real.txt
godirs_real=$work/fleet-godirs-real.txt
group_of() { fleet_lapse_group "$1" "$closure_real" "$godirs_real"; }
for p in ui/src/components/fleet/fleet-view.tsx ui/src/lib/transport.ts ui/src/components/layout/app-shell.tsx \
  ui/src/gen/paprika/v1/api_pb.js ui/src/app/dashboard/error.tsx ui/src/app/dashboard/loading.tsx \
  ui/src/app/dashboard/applications/template.tsx ui/src/app/not-found.tsx; do
  [ "$(group_of "$p")" = "UI closure" ] || die "$p is not in the traced UI closure"
done
[ ! -e "$repo_root/ui/src/app/dashboard/loading.tsx" ] || die "the empty-slot sample ui/src/app/dashboard/loading.tsx exists; pick another"
for p in ui/patches/next+16.0.0.patch ui/public/logo.svg ui/src/app/icon.png ui/src/app/favicon.ico; do
  [ "$(group_of "$p")" = "UI build input" ] || die "$p is not a UI build input"
done
[ -z "$(group_of ui/src/app/dashboard/insights/page.tsx)" ] || die "the Insights route lapses the waiver"
if grep -Fxq ui/src/features/insights/canvas.tsx "$closure_real"; then die "the traced closure includes features/insights/canvas.tsx"; fi
[ "$(group_of ui/src/features/insights/canvas.tsx)" = "" ] || die "an Insights-only path lapses the waiver"
[ "$(group_of ui/package-lock.json)" = "UI build input" ] || die "ui/package-lock.json is not a UI build input"
[ "$(group_of ui/playwright.config.ts)" = "UI build input" ] || die "ui/playwright.config.ts is not a UI build input"
[ "$(group_of internal/api/fleet_handler.go)" = "fleet fixture Go package" ] || die "internal/api is not a fixture package"
[ "$(group_of test/fleetconsole/console.go)" = "fleet fixture Go package" ] || die "test/fleetconsole is not a fixture package"
[ "$(group_of internal/insights/revisionsource/x.go)" = "fleet fixture Go package" ] || die "revisionsource is not a fixture package"
[ "$(group_of internal/insights/x.go)" = "" ] || die "internal/insights lapses the waiver but is not in the fixture"
[ "$(group_of internal/fleet/gate_test.go)" = "" ] || die "a Go test file lapses the waiver"
[ "$(group_of go.mod)" = "Go module file" ] || die "go.mod does not lapse the waiver"
[ "$(group_of hack/ci/jobs/fleet-scale.sh)" = "fleet-scale gate" ] || die "the fleet-scale job does not lapse the waiver"
[ "$(group_of hack/ci/fleet-ui-closure.mjs)" = "fleet-scale gate" ] || die "the closure tracer does not lapse the waiver"
for p in docs/guides/local-ci.md README.md cmd/paprika/main.go hack/deploy/vke.sh .githooks/pre-push; do
  [ -z "$(group_of "$p")" ] || die "$p lapses the fleet-scale UI waiver"
done
say "the lapse groups cover the traced closure, the UI build inputs, the fixture's Go packages and the gate, and not Insights"

# F1: a tree that changes no fleet UI path records pass-waived with the waiver, and status prints the WAIVED line.
rm -f -- "$fleet_api_marker"
run_cmd ok "fleet-scale on an arm64 server, unchanged UI paths" bash -c "cd '$fleet' && bash hack/ci/run.sh --jobs fleet-scale"
[ -e "$fleet_api_marker" ] || die "the API half did not run for a tree whose waiver holds"
fleet_tree=$(git -C "$fleet" rev-parse 'HEAD^{tree}')
fleet_stamp=$(stamp_path "$fleet" "$fleet_tree")
[ "$(jq -r '.jobs["fleet-scale"].result' "$fleet_stamp")" = pass-waived ] || die "fleet-scale was not recorded as pass-waived"
jq -e --arg base "$fleet_base" '.jobs["fleet-scale"].waiver |
  .part == "ui" and .base == $base and .baseKind == "anchor" and .anchorReason == "self-test base" and
  .checkedPaths == 1 and .apiP95Ms == 117.448' \
  "$fleet_stamp" >/dev/null || die "the fleet-scale waiver object is wrong: $(jq -c '.jobs["fleet-scale"]' "$fleet_stamp")"
say "an arm64 run with no fleet UI change records pass-waived with its anchored base"

run_cmd fail "fleet status, partial stamp" bash -c "cd '$fleet' && bash hack/ci/status.sh HEAD"
expect_output "WAIVED fleet-scale ui half: UI scale half needs a native linux/amd64 Docker server"
expect_output "(base ${fleet_base:0:12} anchor: self-test base, 1 paths checked, API p95 117.448 ms)"
expect_output "PAPRIKA_CI_SELFTEST=1 is set"
say "status.sh prints the WAIVED line on every call, with the reason, base, base kind, paths checked and API p95, and notes the self-test gate"
run_cmd fail "fleet status outside the self-test gate" bash -c "cd '$fleet' && env -u PAPRIKA_CI_SELFTEST bash hack/ci/status.sh HEAD"
expect_no_output "PAPRIKA_CI_SELFTEST=1 is set"
say "status.sh outside the self-test gate does not print the self-test note"

cp "$fleet_stamp" "$work/fleet-waived-good.json"
full_stamp "$fleet"
run_cmd ok "fleet status, full stamp with the waiver" bash -c "cd '$fleet' && bash hack/ci/status.sh HEAD"
expect_output "(1 waived, see the WAIVED line)"
say "status.sh passes a full stamp whose only waiver is the fleet-scale UI half"

# The pre-push master gate prints the WAIVED line for the same stamp.
run_cmd ok "pre-push master gate with a waived stamp" bash -c \
  "cd '$fleet' && printf 'refs/heads/master %s refs/heads/master %s\n' '$(git -C "$fleet" rev-parse HEAD)' '$ZD' | bash .githooks/pre-push"
expect_output "WAIVED fleet-scale ui half:"
say "the pre-push master gate prints the WAIVED line for a valid pass-waived stamp"

# F2: pass-waived on any other job fails the status, even with a well-formed waiver.
jq '.jobs["go-lint"] = {result: "pass-waived", seconds: 1, log: "x", finishedAt: "2026-01-01T00:00:00Z", waiver: .jobs["fleet-scale"].waiver}' \
  "$fleet_stamp" >"$fleet_stamp.tmp" && mv -- "$fleet_stamp.tmp" "$fleet_stamp"
run_cmd fail "pass-waived on go-lint" bash -c "cd '$fleet' && bash hack/ci/status.sh HEAD"
say "status.sh fails a pass-waived result on any job other than fleet-scale"

# F3: malformed fleet-scale waivers fail the status, and print no WAIVED line.
for variant in 'del(.waiver.base)' '.waiver.part = "api"' '.waiver.apiP95Ms = "fast"' \
  '.waiver.base |= .[0:12]' '.waiver.checkedPaths = -1' '.waiver.checkedPaths = 1.5' '.waiver.checkedPaths = "2"' \
  '.waiver.reason = ""' 'del(.waiver.reason)' '.waiver.baseKind = "bogus"' 'del(.waiver.anchorReason)' \
  '.waiver.baseKind = "stamp-pass"' '.waiver.baseKind = "bogus" | del(.waiver.anchorReason)' \
  '.waiver.baseKind = "unverified" | del(.waiver.anchorReason)'; do
  jq ".jobs[\"fleet-scale\"] |= (. as \$f | \$f | $variant)" "$work/fleet-waived-good.json" >"$fleet_stamp"
  run_cmd fail "malformed fleet-scale waiver: $variant" bash -c "cd '$fleet' && bash hack/ci/status.sh HEAD"
  grep -Eq 'not passing: .*fleet-scale' <<<"$last_out" || die "malformed waiver ($variant) is not listed as not passing"
  expect_no_output "WAIVED fleet-scale"
done
say "status.sh fails a malformed fleet-scale waiver (base, part, API p95, checked paths, reason, base kind, anchor reason) and prints no WAIVED line"

# F4: a change to a fleet UI path lapses the waiver before the API half runs: the job fails and its log lists the path.
echo "// touched" >>"$fleet/ui/src/components/fleet/fleet-view.tsx"
git -C "$fleet" add -A
git -C "$fleet" -c core.hooksPath=/dev/null commit --quiet -m "fleet UI change"
rm -f -- "$fleet_api_marker"
run_cmd fail "fleet-scale with a fleet UI change" bash -c "cd '$fleet' && bash hack/ci/run.sh --jobs fleet-scale"
[ ! -e "$fleet_api_marker" ] || die "the API half ran although the waiver had lapsed"
lapse_tree=$(git -C "$fleet" rev-parse 'HEAD^{tree}')
lapse_log=$fleet/artifacts/ci/${lapse_tree:0:12}/fleet-scale.log
grep -Fq "ui/src/components/fleet/fleet-view.tsx" "$lapse_log" || die "the lapse log does not list the fleet UI path"
grep -Fq "its waiver lapses" "$lapse_log" || die "the lapse log does not say the waiver lapses"
[ "$(jq -r '.jobs["fleet-scale"].result' "$(stamp_path "$fleet" "$lapse_tree")")" = fail ] ||
  die "a lapsed fleet-scale was not recorded as fail"
say "a change to a fleet UI path lapses the waiver: fleet-scale fails and its log lists the path"
run_cmd fail "fleet status after the lapse" bash -c "cd '$fleet' && bash hack/ci/status.sh HEAD"
say "status.sh does not pass a tree whose fleet-scale waiver lapsed"

# F5b: when the lapse set cannot be computed (here a goto whose route is not a double-quoted literal), the job fails
# closed: no pass-waived is recorded and the API half does not run.
# shellcheck disable=SC2016 # the backticks are the literal text written into the spec
sed -i.bak 's|goto("/dashboard/applications"|goto(`/dashboard/applications`|' "$fleet/ui/e2e/fleet-scale.spec.ts"
rm -f -- "$fleet/ui/e2e/fleet-scale.spec.ts.bak"
# shellcheck disable=SC2016 # as above
grep -Fq 'goto(`/dashboard/applications`' "$fleet/ui/e2e/fleet-scale.spec.ts" || die "the F5b spec edit did not apply"
git -C "$fleet" add -A
git -C "$fleet" -c core.hooksPath=/dev/null commit --quiet -m "spec goto with a template literal"
rm -f -- "$fleet_api_marker"
run_cmd fail "fleet-scale when the lapse set cannot be computed" bash -c "cd '$fleet' && bash hack/ci/run.sh --jobs fleet-scale"
untraced_tree=$(git -C "$fleet" rev-parse 'HEAD^{tree}')
grep -Fq "could not compute the fleet-scale lapse set" "$fleet/artifacts/ci/${untraced_tree:0:12}/fleet-scale.log" ||
  die "the job did not say the lapse set could not be computed"
grep -Fq "does not name a double-quoted route" "$fleet/artifacts/ci/${untraced_tree:0:12}/fleet-scale.log" ||
  die "the tracer did not explain the untraceable goto"
[ "$(jq -r '.jobs["fleet-scale"].result' "$(stamp_path "$fleet" "$untraced_tree")")" = fail ] ||
  die "an untraceable tree was not recorded as fail"
[ ! -e "$fleet_api_marker" ] || die "the API half ran although the lapse set could not be computed"
say "fleet-scale fails closed when the lapse set cannot be computed"

# Base search on a clone whose origin master holds a fleet UI file, with the base anchored.
make_fleet_clone fleetbase
fleetbase=$work/fleetbase
cp "$fleet/hack/test-fleet-scale.sh" "$fleetbase/hack/test-fleet-scale.sh"
git -C "$fleetbase" add -A
git -C "$fleetbase" -c core.hooksPath=/dev/null commit --quiet -m "fleet base snapshot"
git -C "$fleetbase" -c core.hooksPath=/dev/null push --quiet origin master
git -C "$fleetbase" fetch --quiet origin
fb_base=$(git -C "$fleetbase" rev-parse origin/master)
bash "$fleetbase/hack/ci/fleet-anchor.sh" add "$fb_base" "self-test base" >/dev/null

# fb_commit <message> <path>...: writes each path (its content is the message) and commits it on the fleetbase clone.
fb_commit() {
  local msg=$1 p
  shift
  for p in "$@"; do
    mkdir -p "$fleetbase/$(dirname "$p")"
    printf '%s\n' "$msg" >"$fleetbase/$p"
  done
  git -C "$fleetbase" add -A
  git -C "$fleetbase" -c core.hooksPath=/dev/null commit --quiet -m "$msg"
}
# fb_expect_waiver <base> <checkedPaths> <baseKind>: HEAD's fleet-scale entry is pass-waived with that base, count and kind.
fb_expect_waiver() {
  local stamp
  stamp=$(stamp_path "$fleetbase" "$(git -C "$fleetbase" rev-parse 'HEAD^{tree}')")
  jq -e --arg base "$1" --argjson n "$2" --arg kind "$3" \
    '.jobs["fleet-scale"] | .result == "pass-waived" and .waiver.base == $base and .waiver.checkedPaths == $n and .waiver.baseKind == $kind' \
    "$stamp" >/dev/null || die "fleet-scale is not pass-waived with base $1, $2 paths, kind $3: $(jq -c '.jobs["fleet-scale"]' "$stamp")"
}
fb_run() { bash -c "cd '$fleetbase' && bash hack/ci/run.sh --jobs fleet-scale"; }

# B1: docs-only commits above the anchored base: the base is the merge base, and both paths are checked.
fb_commit "docs one" docs/b1-one.md
fb_commit "docs two" docs/b1-two.md
run_cmd ok "fleet-scale on docs-only commits off the anchored base" fb_run
fb_expect_waiver "$fb_base" 2 anchor
say "the waiver base is the anchored merge base with origin/master for a branch two commits above it"

# B2: a rename out of the traced closure lapses the waiver: the old path is listed as well as the new one.
git -C "$fleetbase" mv ui/src/lib/utils.ts docs/utils.ts
git -C "$fleetbase" -c core.hooksPath=/dev/null commit --quiet -m "move a traced helper out"
run_cmd fail "fleet-scale after a rename out of the closure" fb_run
rename_tree=$(git -C "$fleetbase" rev-parse 'HEAD^{tree}')
grep -Fq "ui/src/lib/utils.ts" "$fleetbase/artifacts/ci/${rename_tree:0:12}/fleet-scale.log" ||
  die "the rename's old closure path is not listed in the lapse log"
say "a rename out of the traced closure lapses the waiver and lists the old path"

# B3: a fleet UI change two commits below HEAD lapses: the diff runs from the anchored base, not from HEAD^1.
fb_commit "fleet UI change" ui/src/components/fleet/fleet-view.tsx
fb_commit "docs three" docs/b3.md
rm -f -- "$fleet_api_marker"
run_cmd fail "fleet UI change two commits below HEAD" fb_run
[ ! -e "$fleet_api_marker" ] || die "the API half ran although a commit below HEAD lapsed the waiver"
say "a fleet UI change two commits below HEAD lapses the waiver"

# B4: HEAD on origin/master with a fleet UI change in HEAD itself lapses.
fb_commit "fleet UI change on master" ui/src/components/fleet/fleet-view.tsx
git -C "$fleetbase" -c core.hooksPath=/dev/null push --quiet origin HEAD:master
git -C "$fleetbase" fetch --quiet origin
run_cmd fail "fleet UI change in HEAD on origin/master" fb_run
say "a fleet UI change in HEAD on origin/master lapses the waiver"

# B5: a docs-only commit on origin/master above an unanchored fleet UI change: the base search skips past the first
# parent to the anchored base, so the UI change is checked and lapses the waiver. The first parent is not trusted.
fb_commit "docs five" docs/b5.md
git -C "$fleetbase" -c core.hooksPath=/dev/null push --quiet origin HEAD:master
git -C "$fleetbase" fetch --quiet origin
run_cmd fail "fleet-scale on a docs-only master commit above an unverified UI change" fb_run
say "on origin/master an unverified fleet UI change below the tip lapses the waiver"

# B6: the same tree once the UI commit is anchored: the base is the first parent and one path is checked.
bash "$fleetbase/hack/ci/fleet-anchor.sh" add "$(git -C "$fleetbase" rev-parse 'HEAD^1')" "reviewed fleet UI change" >/dev/null
run_cmd ok "fleet-scale on a docs-only commit above an anchored UI change" fb_run
fb_expect_waiver "$(git -C "$fleetbase" rev-parse 'HEAD^1')" 1 anchor
say "an anchor on the first parent makes it the waiver base"

# Anchors tool: a bad revision or an empty reason is refused; a good one is appended as "<full sha> <reason>".
run_cmd fail "fleet-anchor refuses a revision that is not a commit" bash -c "cd '$fleetbase' && bash hack/ci/fleet-anchor.sh add deadbeefdeadbeef 'a reason'"
run_cmd fail "fleet-anchor refuses an empty reason" bash -c "cd '$fleetbase' && bash hack/ci/fleet-anchor.sh add HEAD ' '"
anchors_file=$(git -C "$fleetbase" rev-parse --path-format=absolute --git-common-dir)/paprika-ci-selftest/fleet-scale-anchors
grep -Eq "^[0-9a-f]{40} reason with spaces$" <(bash "$fleetbase/hack/ci/fleet-anchor.sh" add HEAD reason with spaces >/dev/null 2>&1; cat "$anchors_file") ||
  die "fleet-anchor did not append a '<full sha> <reason>' line"
say "fleet-anchor refuses a non-commit and an empty reason, and appends full-sha lines"

# T1: two commits pushed to master together, a fleet UI change and then a docs change. The first parent is not verified,
# so the base is the stub below both, and the UI change lapses the waiver.
make_fleet_clone twin
twin=$work/twin
cp "$fleet/hack/test-fleet-scale.sh" "$twin/hack/test-fleet-scale.sh"
git -C "$twin" add -A
git -C "$twin" -c core.hooksPath=/dev/null commit --quiet -m "twin stub"
git -C "$twin" -c core.hooksPath=/dev/null push --quiet origin master
git -C "$twin" fetch --quiet origin
twin_base=$(git -C "$twin" rev-parse origin/master)
bash "$twin/hack/ci/fleet-anchor.sh" add "$twin_base" "self-test base" >/dev/null
echo "// fleet change" >"$twin/ui/src/components/fleet/fleet-view.tsx"
git -C "$twin" add -A
git -C "$twin" -c core.hooksPath=/dev/null commit --quiet -m "twin fleet UI change"
echo "docs" >"$twin/docs-twin.md"
git -C "$twin" add -A
git -C "$twin" -c core.hooksPath=/dev/null commit --quiet -m "twin docs"
git -C "$twin" -c core.hooksPath=/dev/null push --quiet origin HEAD:master
git -C "$twin" fetch --quiet origin
run_cmd fail "two commits pushed to master together, the UI change below the tip" bash -c "cd '$twin' && bash hack/ci/run.sh --jobs fleet-scale"
twin_tree=$(git -C "$twin" rev-parse 'HEAD^{tree}')
grep -Fq "ui/src/components/fleet/fleet-view.tsx" "$twin/artifacts/ci/${twin_tree:0:12}/fleet-scale.log" ||
  die "the UI change below the master tip is not listed as lapsing"
say "two commits landing on master together lapse when the UI change is below the tip"

# T2: without an anchors file and without a stamp there is no verified base: the job fails and says so.
twin_anchors=$(git -C "$twin" rev-parse --path-format=absolute --git-common-dir)/paprika-ci-selftest/fleet-scale-anchors
mv "$twin_anchors" "$twin_anchors.hidden"
run_cmd fail "no anchors file and no stamp" bash -c "cd '$twin' && bash hack/ci/run.sh --jobs fleet-scale"
grep -Fq "no verified fleet-scale base" "$twin/artifacts/ci/${twin_tree:0:12}/fleet-scale.log" ||
  die "a missing anchors file is not reported as no verified base"
say "without an anchor or a stamp, the base search fails"

# T3: a stamp showing fleet-scale passing is a verified base in its own right (kind stamp-pass). The base is the stubbed
# commit, and the docs-only commit above it passes waived with that base.
git -C "$twin" checkout --quiet --detach "$twin_base"
write_passing_stamp "$twin"
git -C "$twin" checkout --quiet --detach "$twin_base"
echo "docs above a stamped base" >"$twin/docs-stamped.md"
git -C "$twin" add -A
git -C "$twin" -c core.hooksPath=/dev/null commit --quiet -m "docs above a stamped base"
run_cmd ok "fleet-scale on a docs commit above a stamped base" bash -c "cd '$twin' && bash hack/ci/run.sh --jobs fleet-scale"
stamped_stamp=$(stamp_path "$twin" "$(git -C "$twin" rev-parse 'HEAD^{tree}')")
jq -e --arg base "$twin_base" '.jobs["fleet-scale"] | .result == "pass-waived" and .waiver.base == $base and .waiver.baseKind == "stamp-pass" and (.waiver | has("anchorReason") | not)' \
  "$stamped_stamp" >/dev/null || die "the stamped base is not recorded as stamp-pass: $(jq -c '.jobs["fleet-scale"]' "$stamped_stamp")"
say "a stamp that shows fleet-scale passing is a verified base, recorded as stamp-pass"

# T4: a malformed anchor line is ignored with a warning, and the valid anchor after it still counts.
printf 'not-a-full-sha some reason\nbadline\n%s self-test base\n' "$twin_base" >"$twin_anchors"
rm -f -- "$stamped_stamp"
run_cmd ok "malformed anchor lines are ignored" bash -c "cd '$twin' && bash hack/ci/run.sh --jobs fleet-scale"
grep -Fq "ignored a malformed fleet-scale anchor" "$twin/artifacts/ci/$(git -C "$twin" rev-parse 'HEAD^{tree}' | cut -c1-12)/fleet-scale.log" ||
  die "a malformed anchor line is not reported"
say "a malformed anchor line is ignored with a warning, and the valid anchor after it still counts"

# CI1: the ci.yml lapse follows the fleet-scale job block only, not the rest of ci.yml.
make_fleet_clone cib
cib=$work/cib
cib_base=$(git -C "$cib" rev-parse origin/master)
awk '/^  go-lint:$/ { print; print "    # probe"; next } { print }' "$cib/.github/workflows/ci.yml" >"$cib/ci.tmp" && mv -- "$cib/ci.tmp" "$cib/.github/workflows/ci.yml"
git -C "$cib" add -A
git -C "$cib" -c core.hooksPath=/dev/null commit --quiet -m "probe in another job"
git -C "$cib" -c core.hooksPath=/dev/null push --quiet origin master
git -C "$cib" fetch --quiet origin
cib_other=$(bash -c "source '$repo_root/hack/ci/fleet-lapse.sh' && fleet_lapse_list '$cib_base' '$cib'") || die "the lapse set for a go-lint ci.yml change cannot be computed"
[ -z "$cib_other" ] || die "a ci.yml change outside the fleet-scale block lapses the waiver: $cib_other"
awk '/^  fleet-scale:$/ { print; print "    # probe"; next } { print }' "$cib/.github/workflows/ci.yml" >"$cib/ci.tmp" && mv -- "$cib/ci.tmp" "$cib/.github/workflows/ci.yml"
git -C "$cib" add -A
git -C "$cib" -c core.hooksPath=/dev/null commit --quiet -m "probe in the fleet-scale job"
cib_fleet=$(bash -c "source '$repo_root/hack/ci/fleet-lapse.sh' && fleet_lapse_list '$(git -C "$cib" rev-parse HEAD^1)' '$cib'") || die "the lapse set for a fleet-scale ci.yml change cannot be computed"
printf '%s\n' "$cib_fleet" | grep -Fq "ci.yml fleet-scale job" || die "a change to the fleet-scale job block does not lapse the waiver"
say "a ci.yml change lapses the waiver only inside the fleet-scale job block"

# F6: an arm64 server with the default gate environment still fails (ci.yml behaviour is unchanged).
mkdir -p "$work/fsreal/hack"
cp "$repo_root/hack/test-fleet-scale.sh" "$work/fsreal/hack/test-fleet-scale.sh"
run_cmd fail "default fleet gate on arm64" env -u PAPRIKA_FLEET_SCALE_PARTS -u PAPRIKA_FLEET_SCALE_ALLOW_EMULATED_AMD64 \
  PATH="$fakebin:$PATH" bash -c "cd '$work/fsreal' && bash hack/test-fleet-scale.sh"
expect_output "Docker server must report linux/amd64; got linux/arm64"
say "the default fleet gate still refuses an arm64 Docker server"

# G2: a time-limit knob is read only under the self-test gate. Outside it the job gets its ci.yml limit and the stamp goes
# to paprika-ci. Then a job other than fleet-scale that writes a waiver file fails, even under the gate.
make_clone waiver
waiver=$work/waiver
cp "$runner/hack/ci/jobs/go-lint.sh" "$waiver/hack/ci/jobs/go-lint.sh"
git -C "$waiver" add -A
git -C "$waiver" -c core.hooksPath=/dev/null commit --quiet -m "waiver stub"
waiver_tree=$(git -C "$waiver" rev-parse 'HEAD^{tree}')
run_cmd ok "go-lint with a time-limit knob outside the self-test gate" bash -c \
  "cd '$waiver' && env -u PAPRIKA_CI_SELFTEST PAPRIKA_CI_SELFTEST_TIMEOUT_SECS=3 bash hack/ci/run.sh --jobs go-lint"
expect_output "time limit"
expect_no_output "test override"
[ -f "$(git -C "$waiver" rev-parse --path-format=absolute --git-common-dir)/paprika-ci/$waiver_tree.json" ] ||
  die "a run outside the self-test gate did not write its stamp to paprika-ci"
say "a time-limit knob outside the self-test gate is ignored, and the stamp goes to paprika-ci"

run_cmd fail "a non-fleet job that writes a waiver file" bash -c \
  "cd '$waiver' && env PAPRIKA_CI_SELFTEST_WAIVE=1 bash hack/ci/run.sh --jobs go-lint"
expect_output "a waiver is only accepted for fleet-scale"
[ "$(jq -r '.jobs["go-lint"].result' "$(stamp_path "$waiver" "$waiver_tree")")" = fail ] ||
  die "a non-fleet job with a waiver file was not recorded as fail"
say "a waiver file written by a job other than fleet-scale fails that job"

# G2b: the time-limit knobs are read only under the self-test gate (static: the behaviour is G2 for run.sh).
# shellcheck disable=SC2016 # literal shell text, matched against the script
grep -Fq 'if ci_selftest && [ -n "${PAPRIKA_CI_SELFTEST_TIMEOUT_SECS:-}" ]; then' "$repo_root/hack/ci/run.sh" ||
  die "run.sh reads PAPRIKA_CI_SELFTEST_TIMEOUT_SECS outside the self-test gate"
# shellcheck disable=SC2016 # literal shell text, matched against the script
grep -Fq 'if ci_selftest && [ -n "${PAPRIKA_CI_SELFTEST_CLUSTER_PHASE_SECS:-}" ]; then' "$repo_root/hack/deploy/vke.sh" ||
  die "vke.sh reads PAPRIKA_CI_SELFTEST_CLUSTER_PHASE_SECS outside the self-test gate"
# shellcheck disable=SC2016 # literal shell text, matched against the script
grep -Fq 'if ci_selftest && [ -n "${PAPRIKA_CI_SELFTEST_PUBLISH_SECS:-}" ]; then' "$repo_root/hack/deploy/vke.sh" ||
  die "vke.sh reads PAPRIKA_CI_SELFTEST_PUBLISH_SECS outside the self-test gate"
say "the time-limit knobs are read only under the self-test gate"

printf '\nhack/test-local-ci.sh: all self-tests passed\n'
