#!/usr/bin/env bash
# Capture pprof profiles from a component started with --pprof-bind-address.
#
# Usage:
#   hack/pprof-capture.sh [pprof-url] [cpu-seconds] [output-dir]
#
# Defaults capture a 30s CPU profile plus heap, allocs and goroutine dumps
# from a port-forwarded pprof listener and print the flat/cum top tables.
set -euo pipefail

PPROF="${1:-http://localhost:16060}"
SECS="${2:-30}"
OUT="${3:-/tmp/paprika-perf/capture-$(date +%s)}"
mkdir -p "$OUT"

echo "capturing heap + goroutine + ${SECS}s cpu + allocs from $PPROF -> $OUT" >&2
curl -sf "$PPROF/debug/pprof/heap" -o "$OUT/heap.pprof"
curl -sf "$PPROF/debug/pprof/goroutine?debug=1" -o "$OUT/goroutine.txt"
curl -sf "$PPROF/debug/pprof/profile?seconds=$SECS" -o "$OUT/cpu.pprof"
curl -sf "$PPROF/debug/pprof/allocs" -o "$OUT/allocs.pprof"

echo "=== top CPU ===" >&2
go tool pprof -top -nodecount=20 "$OUT/cpu.pprof" 2>&1 | tail -25
echo "=== top heap (inuse) ===" >&2
go tool pprof -top -inuse_space -nodecount=15 "$OUT/heap.pprof" 2>&1 | tail -20
echo "=== top allocs (cumulative) ===" >&2
go tool pprof -top -alloc_space -nodecount=15 "$OUT/allocs.pprof" 2>&1 | tail -20
