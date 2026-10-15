#!/usr/bin/env bash
# Synthetic only: fake Kubernetes objects + loopback httptest responses.
# No cluster, cloud credentials, token secret, or persistent client config.
set -euo pipefail

cd "$(dirname "$0")/../.."
go_bin="${GO_BIN:-go}"
benchmark_seconds="${BENCH_SECONDS:-1}"
benchmark_count="${BENCH_COUNT:-3}"
export GOMAXPROCS="${GOMAXPROCS:-2}"

case "$GOMAXPROCS" in
  1|2|3|4) ;;
  *) echo 'GOMAXPROCS must be between 1 and 4 for this bounded local baseline' >&2; exit 2 ;;
esac
case "$benchmark_seconds" in
  1|2|3|4|5|6|7|8|9|10) ;;
  *) echo 'BENCH_SECONDS must be an integer between 1 and 10' >&2; exit 2 ;;
esac
case "$benchmark_count" in
  1|2|3|4|5) ;;
  *) echo 'BENCH_COUNT must be an integer between 1 and 5' >&2; exit 2 ;;
esac

output_dir="${1:-/tmp/paprika-observability-synthetic-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$output_dir"
output_dir="$(cd "$output_dir" && pwd)"

{
  echo 'SYNTHETIC LOCAL FIXTURES: these results are not live provider/GKE capacity.'
  echo 'Included: fake Kubernetes provider resolution, loopback Prometheus HTTP, tool preview/JSON rendering and result validation.'
  echo 'Excluded: real Kubernetes/cloud query execution, MCP HTTP/auth/rate limiting/compression, container resource limits.'
  echo "Recorded UTC: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Repository commit: $(git rev-parse HEAD)"
  echo "GOMAXPROCS: $GOMAXPROCS"
  echo "Baseline: ${benchmark_seconds}s per case, ${benchmark_count} repetitions, explicit concurrency 1 and 4."
  "$go_bin" version
  "$go_bin" env GOOS GOARCH GOROOT
  git status --short
} > "$output_dir/metadata.txt"

# This unit suite catches measurement regressions before recording a baseline.
"$go_bin" test -p 2 ./hack/obsloadgen -count=1 \
  | tee "$output_dir/loadgen-tests.txt"

# Keep the baseline free of profiler overhead. ns/op for concurrency 4 is
# amortized wall time per completed operation, not per-request latency.
"$go_bin" test -p 2 ./internal/observabilitygateway -run '^$' \
  -bench '^BenchmarkSyntheticGateway(Query|Overload)$' \
  -benchtime="${benchmark_seconds}s" -count="$benchmark_count" -benchmem \
  | tee "$output_dir/baseline.txt"

# Capture a separate representative large-response profile, retaining the
# exact test binary so the profile remains usable after source changes.
"$go_bin" test -p 2 ./internal/observabilitygateway -run '^$' \
  -bench '^BenchmarkSyntheticGatewayQuery/series_1000/' \
  -benchtime="${benchmark_seconds}s" -count=1 -benchmem \
  -o "$output_dir/gateway.test" \
  -cpuprofile "$output_dir/cpu.pprof" -memprofile "$output_dir/heap.pprof" \
  | tee "$output_dir/profile-run.txt"

"$go_bin" tool pprof -top -nodecount=15 "$output_dir/gateway.test" "$output_dir/cpu.pprof" \
  > "$output_dir/cpu-top.txt"
"$go_bin" tool pprof -top -alloc_space -nodecount=15 "$output_dir/gateway.test" "$output_dir/heap.pprof" \
  > "$output_dir/alloc-top.txt"
echo "Synthetic baseline and profiles: $output_dir"
