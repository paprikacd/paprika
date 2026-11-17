# Paprika mock profiling fixtures

These files contain deterministic synthetic costs and stack samples. Function names are representative of PostgreSQL, Go, and Python workloads; they are not captured production profiles.

Regenerate from the same fixture builders used by Query Atlas:

```sh
npm run fixtures:profiles
```

- `*.flamebearer.json`: Pyroscope Flamebearer v1 **single** profiles. Per-level records contain delta offset, inclusive cost, self cost, and symbol index. `metadata.units` and `sampleRate` determine interpretation.
- `*.speedscope.json`: time-ordered **sampled** profiles with millisecond weights. The three CPU fixtures preserve the same costs as their aggregate companions. A sampled interval represents weighted coverage, not instrumented function-entry and exit timestamps.
- `*.folded`: sample counts at **100 Hz**, only exported for CPU profiles. This format does not carry units or sample-rate metadata; allocation bytes therefore remain JSON.
- `manifest.json`: file inventory, units, costs, frame counts and sample counts.

The Go allocation fixture has no chronological companion. An aggregate allocation profile cannot establish a time axis.

Query Atlas additionally imports current Pyroscope Querier FlameGraph JSON. Binary pprof, differential Flamebearer profiles and Speedscope evented profiles need separate adapters. Imports are parsed in the browser; the mock lab does not connect to a profiler service. Its current normalized widget host accepts at most 1,000 frames and 1,000 chronological samples per imported fixture, within a 4 MB text limit.

References: [Pyroscope server API](https://grafana.com/docs/pyroscope/latest/reference-server-api/), [Pyroscope Flamebearer model](https://github.com/grafana/pyroscope/blob/main/pkg/og/structs/flamebearer/flamebearer.go), [Speedscope file format](https://www.speedscope.app/file-format-schema.json).
