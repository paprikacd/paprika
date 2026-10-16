// Command obsloadgen drives the observability gateway's MCP surface with
// many concurrent clients to measure throughput and latency, and to give
// pprof something to profile. Each client carries its own self-signed
// paprika-observability token with a distinct subject, so the MCP server's
// per-subject rate limiter bounds no client but the one it describes.
//
// Typical use against the local perf stack (see Taskfile perf:obs-load):
//
//	go run ./hack/obsloadgen \
//	  -gateway http://localhost:18090 \
//	  -secret perf-token-secret -issuer http://localhost:13100 \
//	  -clients 32 -secs 60 -rps 5 \
//	  -providers observability/mock-0,observability/mock-1 \
//	  -mix "query_metrics:5,query_logs:3,query_traces:2,list_observability_providers:1"
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/benebsworth/paprika/internal/api/auth"
	"github.com/benebsworth/paprika/internal/api/mcp"
)

// callStats is one call's outcome, appended under its worker's lock.
type callStats struct {
	tool    string
	latency time.Duration
	bytes   int
	err     string // "" = success; else a short class: http_<status>, rpc_error, tool_<state>
}

// toolSpec is one mix entry: a tool name and its relative weight.
type toolSpec struct {
	name   string
	weight int
}

const maxResponseBytes int64 = 32 << 20

type options struct {
	gateway  string
	clients  int
	secs     int
	rps      float64
	timeout  time.Duration
	maxCalls int64
}

// Bound both concurrency and retained samples: even an unpaced run must
// stop before its per-call statistics can consume arbitrary memory.
func (o options) validate() error {
	if err := validateGateway(o.gateway); err != nil {
		return err
	}
	if o.clients < 1 || o.clients > 256 {
		return errors.New("clients must be between 1 and 256")
	}
	if err := o.validateDurationLimits(); err != nil {
		return err
	}
	if err := validateRate(o.rps); err != nil {
		return err
	}
	if o.maxCalls < 1 || o.maxCalls > 1000000 {
		return errors.New("max-calls must be between 1 and 1000000")
	}
	return nil
}

func validateGateway(gateway string) error {
	u, err := url.Parse(gateway)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return errors.New("gateway must be an HTTP(S) base URL without credentials, query or fragment")
	}
	return nil
}

func (o options) validateDurationLimits() error {
	if o.secs < 1 || o.secs > 3600 {
		return errors.New("secs must be between 1 and 3600")
	}
	if o.timeout <= 0 || o.timeout > 5*time.Minute {
		return errors.New("timeout must be positive and no greater than 5m")
	}
	return nil
}

func validateRate(rps float64) error {
	if math.IsNaN(rps) || math.IsInf(rps, 0) || rps < 0 || rps > 1000 || (rps > 0 && rps < 0.001) {
		return errors.New("rps must be 0 (unpaced) or finite and between 0.001 and 1000")
	}
	return nil
}

func main() {
	os.Exit(run())
}

// run returns the CLI status after deferred cancellation and connection
// cleanup, including report encoding or output failures.
func run() int {
	var (
		gateway    = flag.String("gateway", "http://localhost:18090", "gateway base URL (forwarded /observe port)")
		secret     = flag.String("secret", "", "HMAC secret the gateway signs paprika-observability tokens with (the perf stack uses the literal PAPRIKA_AUTH_TOKEN_SECRET value)")
		issuer     = flag.String("issuer", "", "token issuer; must equal the gateway's --mcp-public-url (the perf stack uses http://localhost:13100)")
		clients    = flag.Int("clients", 16, "concurrent clients; each gets its own token and subject")
		secs       = flag.Int("secs", 60, "load duration in seconds")
		rps        = flag.Float64("rps", 5, "calls per second per client; 0 hammers without pause")
		providers  = flag.String("providers", "observability/mock-0", "comma-separated namespace/name providers the query tools rotate through")
		mix        = flag.String("mix", "query_metrics:5,query_logs:3,query_traces:2,list_observability_providers:1", "comma-separated tool:weight pairs")
		timeout    = flag.Duration("timeout", 30*time.Second, "per-call timeout")
		reportPath = flag.String("out", "", "write the JSON report here (default: stdout only)")
		maxCalls   = flag.Int64("max-calls", 100000, "maximum attempted calls across all clients (bounds retained samples)")
		seed       = flag.Uint64("seed", 1, "deterministic tool-selection seed")
	)
	flag.Parse()
	if err := (options{*gateway, *clients, *secs, *rps, *timeout, *maxCalls}).validate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}

	if *secret == "" || *issuer == "" {
		fmt.Fprintln(os.Stderr, "-secret and -issuer are required (use the perf stack's PAPRIKA_AUTH_TOKEN_SECRET literal and --mcp-public-url)")
		return 2
	}
	tools, err := parseMix(*mix)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	providerList, err := parseProviders(*providers)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}

	transport := &http.Transport{
		MaxIdleConns:        *clients + 8,
		MaxIdleConnsPerHost: *clients + 8,
		MaxConnsPerHost:     *clients,
		IdleConnTimeout:     90 * time.Second,
	}
	defer transport.CloseIdleConnections()
	var totalCalls atomic.Int64
	start := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(*secs)*time.Second)
	defer cancel()

	stats := make([][]callStats, *clients)
	var wg sync.WaitGroup
	for c := 0; c < *clients; c++ {
		wg.Add(1)
		go func(clientID int) {
			defer wg.Done()
			stats[clientID] = runClient(ctx, clientID, *gateway, *secret, *issuer, tools, providerList, *rps, *timeout, transport, &totalCalls, *maxCalls, *seed)
		}(c)
	}
	wg.Wait()
	elapsed := time.Since(start)

	report := buildReport(tools, stats, elapsed, *clients, *rps)
	report.Seed = *seed
	report.MaxCalls = *maxCalls
	report.CallLimitReached = totalCalls.Load() >= *maxCalls
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal report: %v\n", err)
		return 1
	}
	if *reportPath != "" {
		if err := os.WriteFile(*reportPath, encoded, 0o644); err != nil { //nolint:gosec // perf artifact, not a credential.
			fmt.Fprintf(os.Stderr, "write report: %v\n", err)
			return 1
		}
	}
	fmt.Println(string(encoded))
	return 0
}

// runClient drives one token-bearing client until the deadline, returning
// every call's stats. Calls are spaced rps apart; rps 0 issues the next call
// as soon as the previous one returns.
func runClient(ctx context.Context, clientID int, gateway, secret, issuer string, tools []toolSpec, providers []string, rps float64, timeout time.Duration, transport *http.Transport, totalCalls *atomic.Int64, maxCalls int64, seed uint64) []callStats {
	token, err := auth.IssueTokenWithOptions(auth.TokenOptions{
		Subject:  fmt.Sprintf("perf-client-%d", clientID),
		Audience: mcp.ObservabilityTokenAudience,
		Issuer:   issuer,
		Scope:    string(mcp.ScopeObserve),
		TTL:      3 * time.Hour,
		Secret:   []byte(secret),
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "client %d: mint token: %v\n", clientID, err)
		return []callStats{{err: "mint_token"}}
	}
	httpClient := &http.Client{Transport: transport, Timeout: timeout}
	endpoint := strings.TrimRight(gateway, "/") + "/observe/mcp"
	// Call pacing needs no cryptographic randomness — a PCG source per
	// client just spreads tool picks and query texts.
	rng := rand.New(rand.NewPCG(uint64(clientID), seed)) //nolint:gosec // G404: load pacing, not security-sensitive.
	interval := time.Duration(0)
	if rps > 0 {
		interval = time.Duration(float64(time.Second) / rps)
	}

	var out []callStats
	iteration := 0
	nextCall := time.Now()
	for waitUntil(ctx, nextCall) && reserveCall(totalCalls, maxCalls) {
		tool := pickTool(rng, tools)
		args := buildArgs(tool, providers, clientID, iteration)
		latency, n, callErr := call(ctx, httpClient, endpoint, token, tool, args)
		out = append(out, callStats{tool: tool, latency: latency, bytes: n, err: callErr})
		iteration++
		// Closed-loop, at most one call per client in flight. A slow response
		// already consumes its pacing interval; never add another full delay
		// or issue a burst of catch-up calls.
		nextCall = nextCall.Add(interval)
		if now := time.Now(); nextCall.Before(now) {
			nextCall = now
		}
	}
	return out
}

func waitUntil(ctx context.Context, when time.Time) bool {
	timer := time.NewTimer(time.Until(when))
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return ctx.Err() == nil
	}
}

func reserveCall(total *atomic.Int64, limit int64) bool {
	for {
		n := total.Load()
		if n >= limit {
			return false
		}
		if total.CompareAndSwap(n, n+1) {
			return true
		}
	}
}

// call issues one tools/call and classifies the outcome: HTTP status, then
// JSON-RPC error, then the tool-level state for the query tools.
func call(ctx context.Context, client *http.Client, endpoint, token, tool string, args map[string]any) (latency time.Duration, responseBytes int, class string) {
	return callWithLimit(ctx, client, endpoint, token, tool, args, maxResponseBytes)
}

func callWithLimit(ctx context.Context, client *http.Client, endpoint, token, tool string, args map[string]any, maxBytes int64) (latency time.Duration, responseBytes int, class string) {
	start := time.Now()
	// Include request encoding, the complete body read and result validation,
	// including failed calls. Header arrival is not completed-call latency.
	defer func() { latency = time.Since(start) }()
	id := time.Now().UnixNano()
	payload, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"method":  "tools/call",
		"params":  map[string]any{"name": tool, "arguments": args},
	})
	if err != nil {
		return 0, 0, "marshal_args"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return 0, 0, "build_request"
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := client.Do(req)
	if err != nil {
		return latency, 0, callFailureClass(err, "transport")
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // loadgen: body is fully read before close.
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBytes+1))
	if err != nil {
		return latency, len(body), callFailureClass(err, "read_body")
	}
	if int64(len(body)) > maxBytes {
		return latency, len(body), "response_too_large"
	}
	if resp.StatusCode != http.StatusOK {
		return latency, len(body), fmt.Sprintf("http_%d", resp.StatusCode)
	}
	return latency, len(body), toolResultClass(body)
}

func callFailureClass(err error, fallback string) string {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.Is(err, context.Canceled):
		return "canceled"
	default:
		return fallback
	}
}

func toolResultClass(body []byte) string {
	var envelope struct {
		Error  any `json:"error"`
		Result *struct {
			IsError           bool `json:"isError"`
			StructuredContent struct {
				State string `json:"state"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return "decode"
	}
	if envelope.Error != nil {
		return "rpc_error"
	}
	if envelope.Result == nil {
		return "missing_result"
	}
	if envelope.Result.IsError {
		return "tool_error"
	}
	switch state := envelope.Result.StructuredContent.State; state {
	case "", "OK":
	case "Forbidden", "Error", "NotConfigured", "NotAvailable":
		return "tool_" + state
	default:
		return "tool_unknown_state"
	}
	return ""
}

// buildArgs renders one tool's arguments. Query texts embed the client and
// iteration so distinct queries spread across the mock's deterministic
// output (and its failEvery subset) instead of collapsing onto one response.
func buildArgs(tool string, providers []string, clientID, iteration int) map[string]any {
	switch tool {
	case "query_metrics":
		return map[string]any{
			"provider": providers[(clientID+iteration)%len(providers)],
			"query":    fmt.Sprintf(`mock_metric{client="%d",iter="%d"}`, clientID, iteration),
		}
	case "query_logs":
		return map[string]any{
			"provider": providers[(clientID+iteration)%len(providers)],
			"query":    fmt.Sprintf(`{client="%d",iter="%d"}`, clientID, iteration),
			"limit":    50,
		}
	case "query_traces":
		return map[string]any{
			"provider": providers[(clientID+iteration)%len(providers)],
			"query":    fmt.Sprintf(`{.client="%d" && .iter="%d"}`, clientID, iteration),
		}
	default:
		return map[string]any{}
	}
}

// pickTool chooses one tool by weight.
func pickTool(rng *rand.Rand, tools []toolSpec) string {
	total := 0
	for _, t := range tools {
		total += t.weight
	}
	roll := rng.IntN(total)
	for _, t := range tools {
		if roll < t.weight {
			return t.name
		}
		roll -= t.weight
	}
	return tools[len(tools)-1].name
}

func parseMix(mix string) ([]toolSpec, error) {
	var out []toolSpec
	seen := map[string]bool{}
	totalWeight := 0
	for _, part := range strings.Split(mix, ",") {
		name, weightText, ok := strings.Cut(strings.TrimSpace(part), ":")
		if !ok {
			return nil, fmt.Errorf("mix entry %q must be tool:weight", part)
		}
		name = strings.TrimSpace(name)
		switch name {
		case "query_metrics", "query_logs", "query_traces", "list_observability_providers":
		default:
			return nil, fmt.Errorf("mix entry %q names an unsupported tool", part)
		}
		if seen[name] {
			return nil, fmt.Errorf("mix repeats tool %q", name)
		}
		seen[name] = true
		weight, err := strconv.Atoi(strings.TrimSpace(weightText))
		if err != nil || weight <= 0 || weight > 1000000-totalWeight {
			return nil, fmt.Errorf("mix entry %q has an invalid weight", part)
		}
		totalWeight += weight
		out = append(out, toolSpec{name: name, weight: weight})
	}
	if len(out) == 0 {
		return nil, errors.New("mix must name at least one tool")
	}
	return out, nil
}

func parseProviders(input string) ([]string, error) {
	parts := strings.Split(input, ",")
	if len(parts) > 1000 {
		return nil, errors.New("providers must contain at most 1000 references")
	}
	for i, part := range parts {
		part = strings.TrimSpace(part)
		ns, name, ok := strings.Cut(part, "/")
		if !ok || ns == "" || name == "" || strings.Contains(name, "/") || strings.ContainsAny(part, " \t\r\n") {
			return nil, errors.New("each provider must be a non-empty namespace/name reference")
		}
		parts[i] = part
	}
	return parts, nil
}

// report is the JSON summary the task writes into PERF_OUT_DIR.
//
//nolint:tagliatelle // Perf-artifact JSON read by scripts and humans; snake_case matches the paprika usage-snapshot wire convention.
type report struct {
	Seed                  uint64                `json:"seed"`
	MaxCalls              int64                 `json:"max_calls"`
	CallLimitReached      bool                  `json:"call_limit_reached"`
	WallSeconds           float64               `json:"wall_seconds"`
	Clients               int                   `json:"clients"`
	RPSPerClient          float64               `json:"rps_per_client"`
	TotalCalls            int                   `json:"total_calls"`
	SuccessfulCalls       int                   `json:"successful_calls"`
	SuccessfulCallsPerSec float64               `json:"successful_calls_per_sec"`
	CallsPerSec           float64               `json:"calls_per_sec"`
	Errors                map[string]int        `json:"errors"`
	LatencyMS             map[string]float64    `json:"latency_ms"`
	BytesTotal            int64                 `json:"bytes_total"`
	BytesPerSec           float64               `json:"bytes_per_sec"`
	ByTool                map[string]toolReport `json:"by_tool"`
}

//nolint:tagliatelle // Same perf-artifact snake_case convention as report.
type toolReport struct {
	Calls  int     `json:"calls"`
	Errors int     `json:"errors"`
	P90MS  float64 `json:"p90_ms"`
	AvgMS  float64 `json:"avg_ms"`
}

func buildReport(tools []toolSpec, stats [][]callStats, elapsed time.Duration, clients int, rps float64) report {
	errs := map[string]int{}
	var all []callStats
	perTool := map[string][]callStats{}
	for _, clientStats := range stats {
		all = append(all, clientStats...)
		for _, s := range clientStats {
			perTool[s.tool] = append(perTool[s.tool], s)
			if s.err != "" {
				errs[s.err]++
			}
		}
	}
	lat := make([]time.Duration, 0, len(all))
	var bytesTotal int64
	for _, s := range all {
		lat = append(lat, s.latency)
		bytesTotal += int64(s.bytes)
	}
	byTool := map[string]toolReport{}
	for _, tool := range tools {
		byTool[tool.name] = toolReport{}
	}
	for name, calls := range perTool {
		byTool[name] = summarizeTool(calls)
	}
	sortDurations(lat)
	wall := elapsed.Seconds()
	if wall <= 0 {
		wall = 1e-9
	}
	failed := 0
	for _, count := range errs {
		failed += count
	}
	return report{
		WallSeconds:           wall,
		Clients:               clients,
		RPSPerClient:          rps,
		TotalCalls:            len(all),
		SuccessfulCalls:       len(all) - failed,
		SuccessfulCallsPerSec: float64(len(all)-failed) / wall,
		CallsPerSec:           float64(len(all)) / wall,
		Errors:                errs,
		LatencyMS: map[string]float64{
			"p50":  float64(percentile(lat, 0.50)) / float64(time.Millisecond),
			"p90":  float64(percentile(lat, 0.90)) / float64(time.Millisecond),
			"p99":  float64(percentile(lat, 0.99)) / float64(time.Millisecond),
			"p999": float64(percentile(lat, 0.999)) / float64(time.Millisecond),
		},
		BytesTotal:  bytesTotal,
		BytesPerSec: float64(bytesTotal) / wall,
		ByTool:      byTool,
	}
}

func summarizeTool(calls []callStats) toolReport {
	if len(calls) == 0 {
		return toolReport{}
	}
	latencies := make([]time.Duration, 0, len(calls))
	var sum time.Duration
	errs := 0
	for _, call := range calls {
		latencies = append(latencies, call.latency)
		sum += call.latency
		if call.err != "" {
			errs++
		}
	}
	sortDurations(latencies)
	return toolReport{
		Calls:  len(calls),
		Errors: errs,
		P90MS:  float64(percentile(latencies, 0.90)) / float64(time.Millisecond),
		AvgMS:  float64(sum) / float64(len(calls)) / float64(time.Millisecond),
	}
}

func sortDurations(d []time.Duration) {
	sort.Slice(d, func(i, j int) bool { return d[i] < d[j] })
}

// percentile reads the nearest-rank percentile off a sorted slice.
func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(math.Ceil(p * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}
