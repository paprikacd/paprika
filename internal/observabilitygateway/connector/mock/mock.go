// Package mock implements connector.Connector for a synthetic observability
// backend: it answers all three signals without any network egress,
// generating deterministic data in each backend's native wire shape
// (Prometheus matrix, Loki streams, Tempo-style trace summaries). It exists
// for load testing, demos and e2e — a provider that is always healthy and
// never leaves the process, so a perf run measures the gateway rather than a
// backend deployment.
package mock

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math/rand/v2"
	"strconv"
	"time"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// Config keys of the strict mock configuration document. Every key is
// optional; an absent key (or an empty document) selects the default.
const (
	configKeyLatencyMs       = "latencyMs"
	configKeyFailEvery       = "failEvery"
	configKeySeed            = "seed"
	configKeySeries          = "series"
	configKeyPointsPerSeries = "pointsPerSeries"
	configKeyLabelsPerSeries = "labelsPerSeries"
	configKeyLogEntries      = "logEntries"
	configKeyTraces          = "traces"
	configKeySpansPerTrace   = "spansPerTrace"
)

// Bounds for the strict configuration values. The caps keep one mock
// provider from asking the gateway to materialize an unbounded synthetic
// payload — the totals below are generous (hundreds of KiB to a few MiB of
// JSON) but bounded.
const (
	maxLatencyMs       = 120_000
	maxFailEvery       = 10_000
	maxSeries          = 1_000_000
	maxPointsPerSeries = 100_000
	maxLabelsPerSeries = 32
	maxLogEntries      = 2_000_000
	maxTraces          = 100_000
	maxSpansPerTrace   = 10_000

	// totalMetricPoints caps series*pointsPerSeries so a config document
	// cannot make one query build an unbounded matrix.
	totalMetricPoints = 2_000_000
	// totalSpans caps traces*spansPerTrace for the same reason.
	totalSpans = 1_000_000

	defaultSeries          = 16
	defaultPointsPerSeries = 32
	defaultLabelsPerSeries = 3
	defaultLogEntries      = 100
	defaultTraces          = 4
	defaultSpansPerTrace   = 8
)

// defaultQuerySpan is the time span synthetic timestamps cover when a query
// arrives without a range.
const defaultQuerySpan = 30 * time.Minute

// config is the decoded mock configuration: every knob a load test or demo
// needs to shape synthetic traffic.
type config struct {
	latency         time.Duration
	failEvery       int
	seed            uint64
	series          int
	pointsPerSeries int
	labelsPerSeries int
	logEntries      int
	traces          int
	spansPerTrace   int
}

// defaultConfig is what an empty config document selects.
func defaultConfig() config {
	return config{
		series:          defaultSeries,
		pointsPerSeries: defaultPointsPerSeries,
		labelsPerSeries: defaultLabelsPerSeries,
		logEntries:      defaultLogEntries,
		traces:          defaultTraces,
		spansPerTrace:   defaultSpansPerTrace,
	}
}

// Mock is a synthetic observability backend. It is a stateless struct;
// per-call state travels in connector.QueryRequest.
type Mock struct{}

// New returns a Mock connector.
func New() connector.Connector { return Mock{} }

// Descriptor advertises name, signals and network needs. NeedsEgress is
// false on purpose: the mock never leaves the process.
func (Mock) Descriptor() connector.Descriptor {
	return connector.Descriptor{
		Name:        connector.ProviderMock,
		Signals:     []connector.Signal{connector.SignalMetrics, connector.SignalLogs, connector.SignalTraces},
		NeedsEgress: false,
	}
}

// ValidateConfig checks the strict mock configuration document ahead of use.
// Unlike the endpoint-based connectors an empty document is valid — every
// key is optional and selects a default.
func (Mock) ValidateConfig(config json.RawMessage) error {
	_, err := parseConfig(config)
	if err != nil {
		return fmt.Errorf("validate config: %w", err)
	}
	return nil
}

// Query synthesizes one response. A configured latency is honored with a
// context-aware sleep, so cancellation still releases the caller; the
// failEvery knob deterministically marks a stable subset of distinct query
// strings as failed, so a load mix can include error paths without a flaky
// backend.
//
//nolint:gocritic // QueryRequest travels by value by design — per-call state belongs in the request, not the connector.
func (Mock) Query(ctx context.Context, req connector.QueryRequest) (*connector.QueryResult, error) {
	cfg, err := parseConfig(req.Config)
	if err != nil {
		return nil, fmt.Errorf("mock: %w", err)
	}
	if err := sleep(ctx, cfg.latency); err != nil {
		return &connector.QueryResult{State: connector.StateError, Reason: "the observability backend query failed"}, nil
	}
	if failsEveryHit(fnvSum64(req.Query), cfg.failEvery) {
		return &connector.QueryResult{State: connector.StateError, Reason: "the observability backend query failed"}, nil
	}

	// The generator is deliberately deterministic (seeded from the config
	// seed and the query text), which is what makes identical queries return
	// identical data; unpredictability would add nothing to synthetic data.
	rng := rand.New(rand.NewPCG(cfg.seed, fnvSum64(req.Query))) //nolint:gosec // G404: deterministic synthetic data for load tests, not security-sensitive.
	start, end := querySpan(req.Range)
	switch req.Signal {
	case connector.SignalMetrics:
		return &connector.QueryResult{State: connector.StateOK, Data: metricPayload(rng, cfg, start, end, req.Limit)}, nil
	case connector.SignalLogs:
		return &connector.QueryResult{State: connector.StateOK, Data: logPayload(rng, cfg, start, end, req.Limit)}, nil
	case connector.SignalTraces:
		return &connector.QueryResult{State: connector.StateOK, Data: tracePayload(rng, cfg, start, end, req.Limit)}, nil
	default:
		return &connector.QueryResult{
			State:  connector.StateNotAvailable,
			Reason: "mock connector supplies metrics, logs and traces only",
		}, fmt.Errorf("%w: mock connector supplies metrics, logs and traces only", connector.ErrUnsupported)
	}
}

// parseConfig decodes the strict mock configuration document: only the nine
// documented keys, each an integer inside its own bounds, then the two
// product-budget guards. An empty document selects every default.
func parseConfig(document json.RawMessage) (config, error) {
	cfg := defaultConfig()
	trimmed := bytes.TrimSpace(document)
	if len(trimmed) == 0 {
		return cfg, nil
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &raw); err != nil {
		return config{}, fmt.Errorf("config: invalid JSON document: %w", err)
	}
	if err := validateKeys(raw); err != nil {
		return config{}, err
	}
	if err := decodeBehavior(raw, &cfg); err != nil {
		return config{}, err
	}
	if err := decodePayloadShape(raw, &cfg); err != nil {
		return config{}, err
	}
	if err := validateBudgets(&cfg); err != nil {
		return config{}, err
	}
	return cfg, nil
}

// validateKeys rejects any document key outside the nine documented ones,
// so a typo fails at admission instead of being silently ignored.
func validateKeys(raw map[string]json.RawMessage) error {
	for key := range raw {
		switch key {
		case configKeyLatencyMs, configKeyFailEvery, configKeySeed, configKeySeries,
			configKeyPointsPerSeries, configKeyLabelsPerSeries, configKeyLogEntries,
			configKeyTraces, configKeySpansPerTrace:
		default:
			return fmt.Errorf("config: unknown key %q", key)
		}
	}
	return nil
}

// decodeBehavior reads the timing knobs: synthetic latency, the stable
// failure subset and the generator seed.
func decodeBehavior(raw map[string]json.RawMessage, cfg *config) error {
	var latencyMs int
	if err := decodeInt(raw, configKeyLatencyMs, 0, maxLatencyMs, &latencyMs); err != nil {
		return err
	}
	cfg.latency = time.Duration(latencyMs) * time.Millisecond
	if err := decodeInt(raw, configKeyFailEvery, 0, maxFailEvery, &cfg.failEvery); err != nil {
		return err
	}
	var seed int64
	if err := decodeInt64(raw, configKeySeed, &seed); err != nil {
		return err
	}
	cfg.seed = uint64(seed) //nolint:gosec // G115: a seed's bit pattern is the value; signedness carries no meaning here.
	return nil
}

// decodePayloadShape reads the data-volume knobs: series, points, labels,
// log entries, traces and spans.
func decodePayloadShape(raw map[string]json.RawMessage, cfg *config) error {
	for _, field := range []struct {
		key         string
		max         int
		destination *int
	}{
		{configKeySeries, maxSeries, &cfg.series},
		{configKeyPointsPerSeries, maxPointsPerSeries, &cfg.pointsPerSeries},
		{configKeyLabelsPerSeries, maxLabelsPerSeries, &cfg.labelsPerSeries},
		{configKeyLogEntries, maxLogEntries, &cfg.logEntries},
		{configKeyTraces, maxTraces, &cfg.traces},
		{configKeySpansPerTrace, maxSpansPerTrace, &cfg.spansPerTrace},
	} {
		if err := decodeInt(raw, field.key, 0, field.max, field.destination); err != nil {
			return err
		}
	}
	return nil
}

// validateBudgets applies the two product guards so one config document
// cannot make a single query materialize an unbounded payload.
func validateBudgets(cfg *config) error {
	if cfg.series > 0 && cfg.pointsPerSeries == 0 {
		cfg.pointsPerSeries = defaultPointsPerSeries
	}
	if cfg.series*cfg.pointsPerSeries > totalMetricPoints {
		return fmt.Errorf("config: %s * %s exceeds the %d point budget", configKeySeries, configKeyPointsPerSeries, totalMetricPoints)
	}
	if cfg.traces > 0 && cfg.spansPerTrace == 0 {
		cfg.spansPerTrace = defaultSpansPerTrace
	}
	if cfg.traces*cfg.spansPerTrace > totalSpans {
		return fmt.Errorf("config: %s * %s exceeds the %d span budget", configKeyTraces, configKeySpansPerTrace, totalSpans)
	}
	return nil
}

// failsEveryHit reports whether a query hash lands in the configured stable
// failure subset.
func failsEveryHit(hash uint64, every int) bool {
	return every > 0 && hash%uint64(every) == 0
}

// decodeInt reads one optional bounded integer key. An absent key leaves the
// destination untouched; the value itself is never echoed, matching the
// sanitizing discipline of every other connector.
func decodeInt(raw map[string]json.RawMessage, key string, lo, hi int, dst *int) error {
	value, ok := raw[key]
	if !ok {
		return nil
	}
	var n int
	if err := json.Unmarshal(value, &n); err != nil {
		return fmt.Errorf("config: key %q must be an integer", key)
	}
	if n < lo || n > hi {
		return fmt.Errorf("config: key %q must be between %d and %d", key, lo, hi)
	}
	*dst = n
	return nil
}

// decodeInt64 reads one optional integer key that may be negative (the seed).
func decodeInt64(raw map[string]json.RawMessage, key string, dst *int64) error {
	value, ok := raw[key]
	if !ok {
		return nil
	}
	var n int64
	if err := json.Unmarshal(value, &n); err != nil {
		return fmt.Errorf("config: key %q must be an integer", key)
	}
	*dst = n
	return nil
}

// below returns a deterministic pseudo-random int in [0, n). Every caller
// passes a small positive constant bound, so the modulo result always fits.
func below(rng *rand.Rand, n int) int {
	return int(rng.Uint64() % uint64(n)) //nolint:gosec // G115: n is a small positive constant bound at every call site.
}

// belowDuration returns a deterministic pseudo-random duration in [0, span).
func belowDuration(rng *rand.Rand, span time.Duration) time.Duration {
	return time.Duration(int64(rng.Uint64() % uint64(span.Nanoseconds()))) //nolint:gosec // G115: span is clamped positive by the callers.
}

// sleep honors a configured synthetic latency without leaking a timer on
// cancellation.
func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return fmt.Errorf("mock latency interrupted: %w", ctx.Err())
	case <-timer.C:
		return nil
	}
}

// querySpan resolves the timestamps synthetic data covers: the requested
// range when both bounds are set, the trailing defaultQuerySpan otherwise.
func querySpan(r connector.TimeRange) (start, end time.Time) {
	end = r.End
	if end.IsZero() {
		end = time.Now().UTC()
	}
	start = r.Start
	if start.IsZero() {
		start = end.Add(-defaultQuerySpan)
	}
	return start, end
}

// fnvSum64 hashes a query string into the rng seed and failEvery selection,
// so identical queries return identical data and a stable error subset.
func fnvSum64(s string) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(s))
	return h.Sum64()
}

// metricPayload builds a Prometheus query_range response: cfg.series matrix
// entries, each carrying its own label set and cfg.pointsPerSeries [ts,
// "value"] samples spread across the span. limit, when positive, caps the
// series count so a caller cannot ask for more than it wants.
func metricPayload(rng *rand.Rand, cfg config, start, end time.Time, limit int) json.RawMessage {
	series := clampCount(cfg.series, limit)
	buf := bytes.NewBuffer(make([]byte, 0, series*cfg.pointsPerSeries*24+256))
	buf.WriteString(`{"status":"success","data":{"resultType":"matrix","result":[`)
	step := end.Sub(start) / time.Duration(max(cfg.pointsPerSeries-1, 1))
	for s := 0; s < series; s++ {
		if s > 0 {
			buf.WriteByte(',')
		}
		buf.WriteString(`{"metric":{"__name__":"mock_metric_`)
		buf.WriteString(strconv.Itoa(s % 8))
		for l := 0; l < cfg.labelsPerSeries; l++ {
			buf.WriteString(`","label_`)
			buf.WriteString(strconv.Itoa(l))
			buf.WriteString(`":"value_`)
			buf.WriteString(strconv.Itoa(below(rng, 1024)))
		}
		buf.WriteString(`"},"values":[`)
		for p := 0; p < cfg.pointsPerSeries; p++ {
			if p > 0 {
				buf.WriteByte(',')
			}
			buf.WriteByte('[')
			buf.WriteString(strconv.FormatInt(start.Add(time.Duration(p)*step).Unix(), 10))
			buf.WriteString(`,"`)
			buf.WriteString(strconv.FormatFloat(rng.Float64()*100, 'f', 3, 64))
			buf.WriteString(`"]`)
		}
		buf.WriteString("]}")
	}
	buf.WriteString("]}}")
	return json.RawMessage(buf.Bytes())
}

// logPayload builds a Loki query response: cfg.logEntries stream values
// [unixnano, line] spread across the span, grouped into a handful of
// streams by level. limit caps the entry count when positive.
func logPayload(rng *rand.Rand, cfg config, start, end time.Time, limit int) json.RawMessage {
	entries := clampCount(cfg.logEntries, limit)
	levels := []string{"info", "info", "info", "warn", "error"}
	buf := bytes.NewBuffer(make([]byte, 0, entries*96+256))
	buf.WriteString(`{"status":"success","data":{"resultType":"streams","result":[`)
	streams := min(len(levels), max(entries, 1))
	perStream := max(entries/streams, 1)
	written := 0
	span := max(end.Sub(start), time.Nanosecond)
	for s := 0; written < entries && s < streams; s++ {
		if s > 0 {
			buf.WriteByte(',')
		}
		buf.WriteString(`{"stream":{"app":"mock","level":"`)
		buf.WriteString(levels[s])
		buf.WriteString(`"},"values":[`)
		n := min(perStream, entries-written)
		for i := 0; i < n; i++ {
			if i > 0 {
				buf.WriteByte(',')
			}
			ts := start.Add(belowDuration(rng, span))
			buf.WriteByte('[')
			buf.WriteString(strconv.FormatInt(ts.UnixNano(), 10))
			buf.WriteString(`,"level=`)
			buf.WriteString(levels[s])
			buf.WriteString(` msg=synthetic request handled path=/api/v1/mock/`)
			buf.WriteString(strconv.Itoa(below(rng, 64)))
			buf.WriteString(` duration_ms=`)
			buf.WriteString(strconv.Itoa(below(rng, 900)))
			buf.WriteString(`"]`)
		}
		buf.WriteString("]}")
		written += n
	}
	buf.WriteString("]}}")
	return json.RawMessage(buf.Bytes())
}

// tracePayload builds a Tempo-style search response: cfg.traces summary
// entries with synthetic trace IDs, root services and durations. limit caps
// the trace count when positive.
func tracePayload(rng *rand.Rand, cfg config, start, end time.Time, limit int) json.RawMessage {
	traces := clampCount(cfg.traces, limit)
	buf := bytes.NewBuffer(make([]byte, 0, traces*160+256))
	buf.WriteString(`{"traces":[`)
	span := max(end.Sub(start), time.Nanosecond)
	for i := 0; i < traces; i++ {
		if i > 0 {
			buf.WriteByte(',')
		}
		startNs := start.Add(belowDuration(rng, span)).UnixNano()
		buf.WriteString(`{"traceID":"`)
		buf.WriteString(traceID(rng))
		buf.WriteString(`","rootServiceName":"mock-svc-`)
		buf.WriteString(strconv.Itoa(below(rng, 8)))
		buf.WriteString(`","rootTraceName":"op-`)
		buf.WriteString(strconv.Itoa(below(rng, 32)))
		buf.WriteString(`","startTimeUnixNano":"`)
		buf.WriteString(strconv.FormatInt(startNs, 10))
		buf.WriteString(`","durationMs":`)
		buf.WriteString(strconv.Itoa(below(rng, cfg.spansPerTrace) + 1))
		buf.WriteByte('}')
	}
	buf.WriteString(`],"metrics":{"inspectedBlocks":`)
	buf.WriteString(strconv.Itoa(traces))
	buf.WriteString(`,"inspectedBytes":"`)
	buf.WriteString(strconv.Itoa(traces * 128))
	buf.WriteString(`"}}`)
	return json.RawMessage(buf.Bytes())
}

// traceID renders one 32-hex-char synthetic trace ID.
func traceID(rng *rand.Rand) string {
	const hex = "0123456789abcdef"
	var id [32]byte
	for i := range id {
		id[i] = hex[rng.Uint64()%16] // #nosec G602 -- i ranges over id and modulo 16 bounds the index to the 16-character alphabet.
	}
	return string(id[:])
}

// clampCount applies a positive limit onto a configured count.
func clampCount(count, limit int) int {
	if limit > 0 && limit < count {
		return limit
	}
	return count
}
