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
	"math/rand/v2"
	"net/http"
	"os"
	"sort"
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

func main() {
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
	)
	flag.Parse()

	if *secret == "" || *issuer == "" {
		fmt.Fprintln(os.Stderr, "-secret and -issuer are required (use the perf stack's PAPRIKA_AUTH_TOKEN_SECRET literal and --mcp-public-url)")
		os.Exit(2)
	}
	tools, err := parseMix(*mix)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	providerList := strings.Split(*providers, ",")

	transport := &http.Transport{
		MaxIdleConns:        *clients + 8,
		MaxIdleConnsPerHost: *clients + 8,
		IdleConnTimeout:     90 * time.Second,
	}
	var totalCalls atomic.Int64
	start := time.Now()
	deadline := start.Add(time.Duration(*secs) * time.Second)

	stats := make([][]callStats, *clients)
	var wg sync.WaitGroup
	for c := 0; c < *clients; c++ {
		wg.Add(1)
		go func(clientID int) {
			defer wg.Done()
			stats[clientID] = runClient(clientID, *gateway, *secret, *issuer, tools, providerList, deadline, *rps, *timeout, transport, &totalCalls)
		}(c)
	}
	wg.Wait()
	elapsed := time.Since(start)

	report := buildReport(tools, stats, elapsed, *clients, *rps)
	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal report: %v\n", err)
		os.Exit(1)
	}
	if *reportPath != "" {
		if err := os.WriteFile(*reportPath, encoded, 0o644); err != nil { //nolint:gosec // perf artifact, not a credential.
			fmt.Fprintf(os.Stderr, "write report: %v\n", err)
			os.Exit(1)
		}
	}
	fmt.Println(string(encoded))
}

// runClient drives one token-bearing client until the deadline, returning
// every call's stats. Calls are spaced rps apart; rps 0 issues the next call
// as soon as the previous one returns.
func runClient(clientID int, gateway, secret, issuer string, tools []toolSpec, providers []string, deadline time.Time, rps float64, timeout time.Duration, transport *http.Transport, totalCalls *atomic.Int64) []callStats {
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
		return nil
	}
	httpClient := &http.Client{Transport: transport, Timeout: timeout}
	endpoint := strings.TrimRight(gateway, "/") + "/observe/mcp"
	// Call pacing needs no cryptographic randomness — a PCG source per
	// client just spreads tool picks and query texts.
	rng := rand.New(rand.NewPCG(uint64(clientID), uint64(time.Now().UnixNano()))) //nolint:gosec // G404: load pacing, not security-sensitive.
	interval := time.Duration(0)
	if rps > 0 {
		interval = time.Duration(float64(time.Second) / rps)
	}

	var out []callStats
	iteration := 0
	for intervalClock(deadline, interval, iteration) {
		tool := pickTool(rng, tools)
		args := buildArgs(tool, providers, clientID, iteration)
		latency, n, callErr := call(httpClient, endpoint, token, tool, args)
		out = append(out, callStats{tool: tool, latency: latency, bytes: n, err: callErr})
		totalCalls.Add(1)
		iteration++
	}
	return out
}

// intervalClock waits out the per-client pacing; it returns false once the
// deadline has passed. The first call fires immediately.
func intervalClock(deadline time.Time, interval time.Duration, iteration int) bool {
	if iteration == 0 {
		return time.Now().Before(deadline)
	}
	wakeAt := time.Now().Add(interval)
	if !wakeAt.Before(deadline) {
		return false
	}
	if interval > 0 {
		time.Sleep(interval)
	}
	return time.Now().Before(deadline)
}

// call issues one tools/call and classifies the outcome: HTTP status, then
// JSON-RPC error, then the tool-level state for the query tools.
func call(client *http.Client, endpoint, token, tool string, args map[string]any) (latency time.Duration, responseBytes int, class string) {
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
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return 0, 0, "build_request"
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	req.Header.Set("Authorization", "Bearer "+token)

	start := time.Now()
	resp, err := client.Do(req)
	latency = time.Since(start)
	if err != nil {
		return latency, 0, "transport"
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // loadgen: body is fully read before close.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return latency, len(body), "read_body"
	}
	if resp.StatusCode != http.StatusOK {
		return latency, len(body), fmt.Sprintf("http_%d", resp.StatusCode)
	}
	var envelope struct {
		Error  any `json:"error"`
		Result struct {
			StructuredContent struct {
				State string `json:"state"`
			} `json:"structuredContent"`
		} `json:"result"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return latency, len(body), "decode"
	}
	if envelope.Error != nil {
		return latency, len(body), "rpc_error"
	}
	if state := envelope.Result.StructuredContent.State; state != "" && state != "OK" {
		return latency, len(body), "tool_" + state
	}
	return latency, len(body), ""
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
	for _, part := range strings.Split(mix, ",") {
		name, weightText, ok := strings.Cut(strings.TrimSpace(part), ":")
		if !ok {
			return nil, fmt.Errorf("mix entry %q must be tool:weight", part)
		}
		var weight int
		if _, err := fmt.Sscanf(weightText, "%d", &weight); err != nil || weight <= 0 {
			return nil, fmt.Errorf("mix entry %q has an invalid weight", part)
		}
		out = append(out, toolSpec{name: strings.TrimSpace(name), weight: weight})
	}
	if len(out) == 0 {
		return nil, errors.New("mix must name at least one tool")
	}
	return out, nil
}

// report is the JSON summary the task writes into PERF_OUT_DIR.
//
//nolint:tagliatelle // Perf-artifact JSON read by scripts and humans; snake_case matches the paprika usage-snapshot wire convention.
type report struct {
	WallSeconds  float64               `json:"wall_seconds"`
	Clients      int                   `json:"clients"`
	RPSPerClient float64               `json:"rps_per_client"`
	TotalCalls   int                   `json:"total_calls"`
	CallsPerSec  float64               `json:"calls_per_sec"`
	Errors       map[string]int        `json:"errors"`
	LatencyMS    map[string]float64    `json:"latency_ms"`
	BytesTotal   int64                 `json:"bytes_total"`
	BytesPerSec  float64               `json:"bytes_per_sec"`
	ByTool       map[string]toolReport `json:"by_tool"`
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
	for name, calls := range perTool {
		toolLat := make([]time.Duration, 0, len(calls))
		var sum time.Duration
		toolErrs := 0
		for _, s := range calls {
			toolLat = append(toolLat, s.latency)
			sum += s.latency
			if s.err != "" {
				toolErrs++
			}
		}
		sortDurations(toolLat)
		byTool[name] = toolReport{
			Calls:  len(calls),
			Errors: toolErrs,
			P90MS:  float64(percentile(toolLat, 0.90)) / float64(time.Millisecond),
			AvgMS:  float64(sum) / float64(len(calls)) / float64(time.Millisecond),
		}
	}
	sortDurations(lat)
	wall := elapsed.Seconds()
	return report{
		WallSeconds:  wall,
		Clients:      clients,
		RPSPerClient: rps,
		TotalCalls:   len(all),
		CallsPerSec:  float64(len(all)) / wall,
		Errors:       errs,
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

func sortDurations(d []time.Duration) {
	sort.Slice(d, func(i, j int) bool { return d[i] < d[j] })
}

// percentile reads the nearest-rank percentile off a sorted slice.
func percentile(sorted []time.Duration, p float64) time.Duration {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(p*float64(len(sorted)) + 0.5)
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}
