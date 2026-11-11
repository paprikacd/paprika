#!/usr/bin/env bash
# Runs insights-visual-matrix.e2e.mjs in the Playwright Linux image that matches CI (ubuntu-latest,
# x86_64). Use it to record or check the baseline on any host with Docker, including macOS.
#
#   ui/e2e/insights-visual-matrix-linux.sh            # check
#   ui/e2e/insights-visual-matrix-linux.sh --update   # record ui/e2e/baselines/visual-matrix.json
#
# Needs: Docker, Go, and a built ui/out (cd ui && npm run build). The fixture harness is
# cross-built for the chosen platform into artifacts/insights/visual-matrix/bin.
#
# VISUAL_MATRIX_PLATFORM selects the container platform (default linux/amd64, the CI runner).
# Use linux/arm64 on Apple Silicon when the amd64 image cannot be pulled, for example when Docker
# has no disk space. /tmp is a 2 GB tmpfs, so the run needs no free space in the container layer.
# Record and check on the same platform; the baseline records what it renders.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
image="mcr.microsoft.com/playwright:v1.61.1-noble"
platform="${VISUAL_MATRIX_PLATFORM:-linux/amd64}"
bin="$root/artifacts/insights/visual-matrix/bin"
mkdir -p "$bin"
(cd "$root" && CGO_ENABLED=0 GOOS=linux GOARCH="${platform#linux/}" go build -o "$bin/observe-e2e" ./hack/insights-observe-e2e)

exec docker run --rm --init --ipc=host --platform "$platform" \
  --user "$(id -u):$(id -g)" -e HOME=/tmp --tmpfs /tmp:rw,size=2g \
  -e VISUAL_MATRIX_HARNESS=/repo/artifacts/insights/visual-matrix/bin/observe-e2e \
  -v "$root:/repo" -w /repo/ui \
  "$image" \
  node --experimental-strip-types e2e/insights-visual-matrix.e2e.mjs "$@"
