#!/usr/bin/env bash
# Local deploy of the published Paprika images to the VKE paprika-e2e namespace (task deploy).
#
# Replaces the GitHub `publish` job (.github/workflows/ci.yml) and the deploy-vke.yml workflow. This script
# runs the preconditions and the image build, then hack/deploy/vke-cluster.sh (the deploy-vke.yml steps) from
# the same fresh worktree, under the 20-minute limit of deploy-vke.yml. Steps, in order:
#   1. preconditions: no arguments, branch master, HEAD == origin/master, clean tree, a passing local CI
#      stamp, the pinned tools, and no other deploy holding the lock
#   2. kubeconfig: PAPRIKA_DEPLOY_KUBECONFIG (environment, or the same key in the gitignored .env.deploy); the
#      file must live outside the repository and its context must be vke
#   3. registry login with the gh token, piped on stdin, into a Docker config private to this deploy
#   4. buildx push of the manager image and the dashboard renderer (linux/amd64); digests come from
#      --metadata-file and must match the same regexes deploy-vke.yml enforces
#   5. the cluster phase (hack/deploy/vke-cluster.sh): access, retained Insights PVC, Secrets, pinned Helm
#      upgrade, rollout, port-forward health checks, digest and Helm verification, and the report
#
# Secret values are read into shell variables, written only to 0600 files in a private temp directory, and
# never printed or passed on argv. Nothing here runs set -x.
set -Eeuo pipefail

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../ci/lib.sh"
[ "$#" -eq 0 ] || ci_die "deploy: takes no arguments (got: $*); configuration comes from the environment (docs/guides/local-ci.md)"

readonly VKE_NAMESPACE=paprika-e2e
readonly PAPRIKA_IMAGE_REPO=ghcr.io/paprikacd/paprika
readonly RENDER_IMAGE_REPO=ghcr.io/paprikacd/paprika-render-worker
readonly PAPRIKA_REF_RE='^ghcr\.io/paprikacd/paprika@sha256:[0-9a-f]{64}$'
readonly RENDER_REF_RE='^ghcr\.io/paprikacd/paprika-render-worker@sha256:[0-9a-f]{64}$'
# deploy-vke.yml: timeout-minutes 20 for the whole deploy job. PAPRIKA_CI_SELFTEST_CLUSTER_PHASE_SECS shortens the limit in the
# self-test only (as PAPRIKA_CI_SELFTEST_TIMEOUT_SECS does for a job); the static self-test checks the default is 20 minutes.
CLUSTER_PHASE_SECS=$((20 * 60))
if ci_selftest && [ -n "${PAPRIKA_CI_SELFTEST_CLUSTER_PHASE_SECS:-}" ]; then CLUSTER_PHASE_SECS=$PAPRIKA_CI_SELFTEST_CLUSTER_PHASE_SECS; fi
readonly CLUSTER_PHASE_SECS

deploy_log() { ci_log "deploy: $*"; }
deploy_die() { ci_die "deploy: $*"; }

work=""
lock_dir=""
build_src=""
cleanup() {
  trap - EXIT
  cd "$CI_REPO_ROOT" 2>/dev/null || true
  if [ -n "$build_src" ]; then
    git -C "$CI_REPO_ROOT" worktree remove --force "$build_src" >/dev/null 2>&1 || rm -rf -- "$build_src"
    git -C "$CI_REPO_ROOT" worktree prune >/dev/null 2>&1 || true
  fi
  # The work directory holds the deploy's Docker config (with the registry login) and the auth values.
  if [ -n "$work" ]; then rm -rf -- "$work"; fi
  if [ -n "$lock_dir" ]; then rmdir -- "$lock_dir" 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'ci_stop_children; exit 143' TERM
trap 'ci_stop_children; exit 130' INT HUP

cd "$CI_REPO_ROOT" || deploy_die "cannot enter $CI_REPO_ROOT"

for tool in git docker gh kubectl jq curl python3; do
  command -v "$tool" >/dev/null 2>&1 || deploy_die "$tool is required on PATH"
done

# 2. Kubeconfig. Only this process and the cluster phase it starts see it; the CI jobs never do.
kubeconfig=${PAPRIKA_DEPLOY_KUBECONFIG:-}
if [ -z "$kubeconfig" ] && [ -f "$CI_REPO_ROOT/.env.deploy" ]; then
  kubeconfig=$(sed -n 's/^PAPRIKA_DEPLOY_KUBECONFIG=//p' "$CI_REPO_ROOT/.env.deploy" | tail -n 1)
fi
[ -n "$kubeconfig" ] || deploy_die "PAPRIKA_DEPLOY_KUBECONFIG is required (path to the VKE kubeconfig, outside the repository)"
[ -f "$kubeconfig" ] || deploy_die "PAPRIKA_DEPLOY_KUBECONFIG does not name a readable file"
kubeconfig="$(cd "$(dirname "$kubeconfig")" && pwd -P)/$(basename "$kubeconfig")"
case "$kubeconfig" in
  "$CI_REPO_ROOT"/*) deploy_die "the kubeconfig must live outside the repository" ;;
esac
unset KUBECONTEXT HELM_KUBECONTEXT HELM_KUBEAPISERVER HELM_KUBETOKEN HELM_KUBEASUSER
k() { kubectl --kubeconfig "$kubeconfig" "$@"; }

# 1. Preconditions. Each refusal names the fix, and none of them touches the cluster.
branch=$(git symbolic-ref --quiet --short HEAD || true)
[ "$branch" = master ] || deploy_die "run from branch master (current: ${branch:-detached HEAD})"
[ -z "$(git status --porcelain)" ] || deploy_die "working tree is not clean; commit or stash first"
git fetch --quiet origin '+refs/heads/master:refs/remotes/origin/master' ||
  deploy_die "could not fetch origin master"
commit=$(git rev-parse --verify --quiet 'HEAD^{commit}')
tree=$(git rev-parse 'HEAD^{tree}')
origin_commit=$(git rev-parse --verify --quiet 'origin/master^{commit}') || deploy_die "origin/master is missing"
[ "$commit" = "$origin_commit" ] || deploy_die "HEAD ${commit:0:12} is not origin/master ${origin_commit:0:12}; push master first"
bash "$CI_REPO_ROOT/hack/ci/status.sh" HEAD >&2 ||
  deploy_die "local CI does not pass for this commit; run: task ci"
bash "$CI_REPO_ROOT/hack/ci/tools.sh" verify >&2 || deploy_die "pinned tools do not match; run: task ci:tools"
[ "$(k config current-context)" = vke ] || deploy_die "the kubeconfig's current context must be vke"

# Lock: one deploy at a time per clone family. Released by cleanup.
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
lock_dir="$common_dir/paprika-deploy.lock"
if ! mkdir "$lock_dir" 2>/dev/null; then
  lock_dir=""
  deploy_die "another deploy holds $common_dir/paprika-deploy.lock; remove it only when no deploy is running"
fi
work=$(mktemp -d "${TMPDIR:-/tmp}/paprika-deploy.XXXXXX")
chmod 0700 "$work"
# The time-limited steps of this deploy are listed here, so the INT and TERM traps stop them (ci_stop_children).
CI_CHILD_LIST="$work/children.txt"
: >"$CI_CHILD_LIST"

# The images and the cluster phase come from a fresh detached worktree of the commit, never from the
# developer's working tree: ignored files and linked worktrees under the checkout are not part of the release.
build_src="$work/src"
git worktree add --detach --quiet "$build_src" "$commit" || deploy_die "could not create a worktree of $commit"

# 3. Registry login. The Docker config is private to this deploy (see ci_docker_config_for_build): the login
# is written there and removed with $work, and the developer's keychain and config.json are not used or changed.
ci_docker_config_for_build "$work/docker-config"
export DOCKER_CONFIG="$work/docker-config"
gh_user=$(gh api user -q .login 2>/dev/null) || deploy_die "gh is not authenticated"
gh auth token | docker login ghcr.io -u "$gh_user" --password-stdin >/dev/null ||
  deploy_die "registry login failed"

# 4. Build and push. Tags match the publish job: latest and sha-<commit>. The token never reaches argv.
build_date=$(git show -s --format=%cI "$commit")
# ci.yml publish timeout-minutes bounds each image build and push, as that job's limit did in CI.
publish_mins=$(ci_job_timeout_minutes "$CI_REPO_ROOT/.github/workflows/ci.yml" publish)
[[ "$publish_mins" =~ ^[1-9][0-9]*$ ]] || deploy_die "ci.yml has no publish timeout-minutes"
publish_secs=$((publish_mins * 60))
# Test hook: the self-test shortens the publish limit under the self-test gate (as the cluster-phase hook does).
if ci_selftest && [ -n "${PAPRIKA_CI_SELFTEST_PUBLISH_SECS:-}" ]; then publish_secs=$PAPRIKA_CI_SELFTEST_PUBLISH_SECS; fi
deploy_log "building and pushing $PAPRIKA_IMAGE_REPO for linux/amd64 (commit ${commit:0:12})"
ci_with_timeout "$publish_secs" docker buildx build --platform linux/amd64 --push \
  -f "$build_src/Dockerfile" \
  --build-arg "VERSION=0.0.0-dev+sha.$commit" \
  --build-arg "GIT_COMMIT=$commit" \
  --build-arg "BUILD_DATE=$build_date" \
  --tag "$PAPRIKA_IMAGE_REPO:latest" \
  --tag "$PAPRIKA_IMAGE_REPO:sha-$commit" \
  --metadata-file "$work/manager-build.json" \
  "$build_src" >&2 || deploy_die "manager image build failed (limit $publish_secs s or an error)"
paprika_digest=$(jq -r '."containerimage.digest" // empty' "$work/manager-build.json" 2>/dev/null || true)
paprika_ref="$PAPRIKA_IMAGE_REPO@$paprika_digest"
[[ "$paprika_ref" =~ $PAPRIKA_REF_RE ]] || deploy_die "manager build reported no valid sha256 digest"

deploy_log "building and pushing the dashboard renderer ($RENDER_IMAGE_REPO)"
ci_with_timeout "$publish_secs" docker buildx build --platform linux/amd64 --push \
  -f "$build_src/ui/Dockerfile.render-worker" \
  --tag "$RENDER_IMAGE_REPO:sha-$commit" \
  --metadata-file "$work/render-build.json" \
  "$build_src" >&2 || deploy_die "dashboard renderer build failed (limit $publish_secs s or an error)"
render_digest=$(jq -r '."containerimage.digest" // empty' "$work/render-build.json" 2>/dev/null || true)
render_ref="$RENDER_IMAGE_REPO@$render_digest"
[[ "$render_ref" =~ $RENDER_REF_RE ]] || deploy_die "renderer build reported no valid sha256 digest"

# 5. The cluster phase, from the commit's own worktree, under the deploy-vke.yml limit. Everything it needs is
# passed in these variables; none of them is a secret.
export KUBECONFIG="$kubeconfig"
export PAPRIKA_DEPLOY_KUBECONFIG="$kubeconfig"
export PAPRIKA_DEPLOY_WORK="$work" PAPRIKA_DEPLOY_BUILD_SRC="$build_src"
export PAPRIKA_DEPLOY_COMMIT="$commit" PAPRIKA_DEPLOY_TREE="$tree"
export PAPRIKA_DEPLOY_REPORT_DIR="$CI_REPO_ROOT/artifacts/deploy"
export PAPRIKA_DEPLOY_PAPRIKA_REF="$paprika_ref" PAPRIKA_DEPLOY_PAPRIKA_DIGEST="$paprika_digest"
export PAPRIKA_DEPLOY_RENDER_REF="$render_ref" PAPRIKA_DEPLOY_RENDER_DIGEST="$render_digest"
export PAPRIKA_CI_TOOL_BIN="$CI_TOOL_BIN"

deploy_log "cluster phase (limit $((CLUSTER_PHASE_SECS / 60)) minutes): deploy-vke.yml steps from the commit's worktree"
# Run from this shell, not a subshell: a Ctrl-C reaches the INT trap, which stops the cluster phase and waits for it
# to exit (ci_stop_children) before cleanup removes the work directory and releases the lock.
cluster_rc=0
cd "$build_src" || deploy_die "cannot enter $build_src"
ci_with_timeout "$CLUSTER_PHASE_SECS" bash "$build_src/hack/deploy/vke-cluster.sh" || cluster_rc=$?
case "$cluster_rc" in
  0) ;;
  124) deploy_die "the cluster phase did not finish within ${CLUSTER_PHASE_SECS} s" ;;
  *) deploy_die "the cluster phase failed (exit $cluster_rc)" ;;
esac

report="$CI_REPO_ROOT/artifacts/deploy/${commit:0:12}.json"
[ -f "$report" ] || deploy_die "the cluster phase wrote no report at ${report#"$CI_REPO_ROOT"/}"
# The fleet-scale waiver (null when fleet-scale passed in full) is part of the record of what was verified.
stamp_waiver=$(jq -c '.jobs["fleet-scale"].waiver // null' "$common_dir/$(ci_stamp_subdir)/$tree.json") ||
  deploy_die "the local CI stamp for this tree cannot be read"
if ! jq --argjson waiver "$stamp_waiver" '. + {waiver: $waiver}' "$report" >"$report.tmp.$$"; then
  deploy_die "could not add the waiver to the deploy report"
fi
mv -- "$report.tmp.$$" "$report"
revision=$(jq -r '.helm.revision' "$report")
deploy_log "deployed $paprika_ref to $VKE_NAMESPACE (revision $revision); report: ${report#"$CI_REPO_ROOT"/}"
