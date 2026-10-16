# Observability gateway performance validation

Run an offline baseline from the repository root:

```sh
GOMAXPROCS=2 bash hack/obsloadgen/profile-local.sh /tmp/paprika-observability-baseline
# Optional: GO_BIN=/absolute/path/to/go BENCH_SECONDS=2 BENCH_COUNT=3 ...
```

This uses fake Kubernetes objects and an `httptest` server bound to loopback.
It does not read cloud credentials, create tokens, connect to a cluster, or
configure an MCP client. The production Prometheus connector reads fixed
synthetic responses containing 1, 100 and 1000 series, with two points each
and a five-minute query window. Each case uses exactly 1 or 4 workers.
The overload case occupies the backend's configured query slots and checks
that an additional query fails with `ResourceExhausted` before provider I/O.

The baseline includes provider lookup through a fake Kubernetes client,
connector HTTP reads, tool preview rendering, JSON encoding and harness
result validation. It excludes real Kubernetes/cloud latency, provider
execution, MCP HTTP transport/auth/rate limiting/compression and container
resource limits. These results cannot establish production capacity, live
data correctness, or GKE CPU/RSS requirements. `B/op` and `allocs/op` describe
Go allocation traffic, not retained memory or process RSS. For four workers,
`ns/op` is amortized wall time per operation; it is **not** request latency.

The script caps CPU concurrency at four and Go build parallelism at two. It
records source commit/dirty file metadata, toolchain, platform, repetitions,
`ns/op`, `B/op`, `allocs/op`, and synthetic response byte throughput. Baselines
run without profiling. A separate 1000-series run writes CPU and heap profiles,
the exact test binary, and readable CPU/allocation summaries. Compare repeated
runs on the same host, toolchain and CPU setting; use `go tool pprof -diff_base`
or `benchstat` when available. Run focused checks directly with:

```sh
GOMAXPROCS=2 go test -p 2 ./hack/obsloadgen -count=1
GOMAXPROCS=2 go test -p 2 ./internal/observabilitygateway -run '^$' \
  -bench '^BenchmarkSyntheticGateway(Query|Overload)$' -benchtime=1s -count=3 -benchmem
```

## Load generator measurement contract

`task perf:obs-load` uses this command against the existing local kind perf
stack. Its generated queries are designed for **mock providers**, not real
Prometheus/Loki/Tempo instances. The CLI still requires the local perf stack's
synthetic signing secret and issuer. Never retrieve a live signing secret for
this tool; use the supported MCP OAuth client path for real access.

Latency starts before request encoding and ends after the entire response is
read and its result is validated. It includes error outcomes. HTTP failures,
JSON-RPC errors, MCP `isError`, provider failure states, malformed/missing
results, cancellation/deadline expiry and oversized bodies are classified
separately. The 32 MiB decoded response limit reads one extra byte to detect
truncation; it never accepts a valid JSON prefix as a complete response.
Response byte counts are decoded application bytes (Go's HTTP client may
decompress gzip), not network bytes. A truncated response records only bytes
actually read, including the one-byte probe.

The generator keeps at most one call in flight per client, pacing starts at
the requested rate without adding an extra post-response interval. It cannot
model open-loop arrival rates or coordinated omission. `calls_per_sec` counts
all attempted calls; `successful_calls_per_sec` counts only successful calls.
Inspect `errors` and `by_tool` together with latency percentiles. A fast error
response can improve aggregate latency without improving useful throughput.
The command emits a report even when calls fail; its exit status is not an
SLO assertion.

Inputs are bounded to 256 clients, one hour, 1000 calls/s per client, five-minute
call timeouts and one million retained samples. Defaults retain at most
100,000 samples; set `-max-calls` explicitly for comparisons. All workers share
the sample quota and a run deadline that also cancels in-flight body reads.
`call_limit_reached` distinguishes a quota-limited run from a full-duration
run. `-seed` defaults to 1 for reproducible weighted tool choices. Only the
four tools with supported mock argument builders are accepted in `-mix`.
