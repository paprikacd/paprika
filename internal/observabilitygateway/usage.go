package observabilitygateway

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

// UsageTracker counts observability tool invocations per tool name: total
// calls, failed calls, and the last time each tool ran. It answers the
// "which tools does anyone actually use" question the console's usage board
// asks, entirely from outcomes the gateway already observes — no exporter,
// no scrape interval, just a mutex-guarded map updated on every Invoke.
//
// The tracker is process-local and in-memory on purpose: usage counts are
// operational telemetry, not fleet state, so losing them with a pod restart
// is honest (the counters restart from zero, the snapshot's generated_at
// says when), and no cross-replica consistency story is needed for a number
// an operator reads by eye.
type UsageTracker struct {
	mu    sync.Mutex
	tools map[string]*toolUsage
}

// toolUsage is the mutable per-tool counter set Snapshot copies out from
// under the lock.
type toolUsage struct {
	calls      uint64
	errors     uint64
	lastUsedAt time.Time
}

// UsageToolSnapshot is one tool's counters at snapshot time.
//
//nolint:tagliatelle // The wire contract (/observe/api/usage) is snake_case by MCP-adjacent JSON convention, matching the tool argument field names.
type UsageToolSnapshot struct {
	Name string `json:"name"`
	// Calls is the total invocation count; Errors the subset that returned
	// an error or an MCP result with isError=true. Both monotonically increase
	// for the process lifetime.
	Calls      uint64    `json:"calls"`
	Errors     uint64    `json:"errors"`
	LastUsedAt time.Time `json:"last_used_at"`
}

// UsageSnapshot is the tracker's whole state at one instant, serialized
// verbatim as the /observe/api/usage response body.
//
//nolint:tagliatelle // Wire contract — see UsageToolSnapshot.
type UsageSnapshot struct {
	GeneratedAt time.Time           `json:"generated_at"`
	Tools       []UsageToolSnapshot `json:"tools"`
}

// NewUsageTracker returns an empty tracker ready to record.
func NewUsageTracker() *UsageTracker {
	return &UsageTracker{tools: map[string]*toolUsage{}}
}

// Record registers one invocation outcome for tool. A nil error counts a
// successful call, any non-nil error counts a failure; the tool's last-used
// time moves to now either way, because an errored call was still a call.
// Record is safe on a nil tracker so wrappers never need a nil check of
// their own — a nil tracker is the "recording disabled" configuration.
func (t *UsageTracker) Record(tool string, err error) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	entry, ok := t.tools[tool]
	if !ok {
		entry = &toolUsage{}
		t.tools[tool] = entry
	}
	entry.calls++
	if err != nil {
		entry.errors++
	}
	entry.lastUsedAt = time.Now().UTC()
}

// Snapshot copies the counters out under the lock and returns them sorted by
// tool name, so the response is deterministic for the same counter state and
// diffs cleanly when an operator compares two snapshots. An idle tracker
// yields an empty (non-nil) Tools slice, which serializes as [] rather than
// null — the shape a client can render without a special case.
func (t *UsageTracker) Snapshot() UsageSnapshot {
	snapshot := UsageSnapshot{
		GeneratedAt: time.Now().UTC(),
		Tools:       []UsageToolSnapshot{},
	}
	if t == nil {
		return snapshot
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for name, entry := range t.tools {
		snapshot.Tools = append(snapshot.Tools, UsageToolSnapshot{
			Name:       name,
			Calls:      entry.calls,
			Errors:     entry.errors,
			LastUsedAt: entry.lastUsedAt,
		})
	}
	sort.Slice(snapshot.Tools, func(i, j int) bool { return snapshot.Tools[i].Name < snapshot.Tools[j].Name })
	return snapshot
}

// recordUsage wraps a tool Invoke so every outcome — success or error
// return — lands in the tracker exactly once, before the result reaches the
// MCP layer. The recording happens after the invoke so the error it sees is
// the invoke's own, not the tracker's.
func recordUsage(usage *UsageTracker, name string, invoke func(ctx context.Context, client v1connect.PaprikaServiceClient, args json.RawMessage) (any, error)) func(ctx context.Context, client v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
	return func(ctx context.Context, client v1connect.PaprikaServiceClient, args json.RawMessage) (any, error) {
		result, err := invoke(ctx, client, args)
		outcome := err
		if toolResult, ok := result.(*sdkmcp.CallToolResult); outcome == nil && ok && toolResult != nil && toolResult.IsError {
			// Count the failure without copying the tool's content, provider
			// payload or reason into telemetry or changing the returned error.
			outcome = errProviderToolResult
		}
		usage.Record(name, outcome)
		return result, err
	}
}

var errProviderToolResult = errors.New("observability tool returned a failed provider outcome")
