#!/usr/bin/env bash
# Local mirror of the ci.yml job "release-contract" (CLI release contract).
# Runs inside the snapshot created by hack/ci/run.sh.
set -Eeuo pipefail
# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"
ci_job_init release-contract
export GOTOOLCHAIN=auto # ci.yml job env

# ci.yml: Checkout / Reclaim self-hosted runner disk / Set up Go -> snapshot, tools.sh.
# ci.yml: Install GoReleaser (v2.16.0) -> verified by hack/ci/tools.sh.

# ci.yml: Verify release configuration
bash hack/test-cli-release-contract.sh
bash hack/test-find-github-release.sh
bash hack/test-verify-release-archives.sh

# ci.yml: Build and exercise host-platform CLI
# Exercises the artifact for the host platform (darwin/arm64 here, linux/amd64 on ubuntu-latest).
goreleaser build --snapshot --clean --id cli
goos="$(go env GOOS)"
goarch="$(go env GOARCH)"
cli_paths="$(
  jq -r --arg goos "$goos" --arg goarch "$goarch" '.[] | select(
    .type == "Binary" and
    .name == "paprika" and
    .goos == $goos and
    .goarch == $goarch
  ) | .path' .goreleaser-dist/artifacts.json
)"
cli_count="$(grep -c . <<<"$cli_paths" || true)"
if [[ "$cli_count" -ne 1 ]]; then
  printf 'expected exactly one %s/%s CLI artifact, found %s\n' "$goos" "$goarch" "$cli_count" >&2
  exit 1
fi
cli="$cli_paths"
test -x "$cli"
"$cli" version
"$cli" login --help
"$cli" status --help
"$cli" version --help
help_output="$($cli --help)"
grep -Eq '(^|[[:space:]])login([[:space:]]|$)' <<<"$help_output"
grep -Eq '(^|[[:space:]])status([[:space:]]|$)' <<<"$help_output"
grep -Eq '(^|[[:space:]])version([[:space:]]|$)' <<<"$help_output"
