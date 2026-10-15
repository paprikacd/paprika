package observabilitygateway

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestUsageTrackerRecordsOutcomes(t *testing.T) {
	t.Parallel()

	tracker := NewUsageTracker()
	tracker.Record("query_metrics", nil)
	tracker.Record("query_metrics", nil)
	tracker.Record("query_metrics", errors.New("backend refused"))
	tracker.Record("query_logs", nil)

	snapshot := tracker.Snapshot()
	require.Len(t, snapshot.Tools, 2)

	byName := map[string]UsageToolSnapshot{}
	for _, tool := range snapshot.Tools {
		byName[tool.Name] = tool
	}
	metrics := byName["query_metrics"]
	assert.Equal(t, uint64(3), metrics.Calls)
	assert.Equal(t, uint64(1), metrics.Errors)
	assert.False(t, metrics.LastUsedAt.IsZero())

	logs := byName["query_logs"]
	assert.Equal(t, uint64(1), logs.Calls)
	assert.Equal(t, uint64(0), logs.Errors)
}

func TestUsageTrackerSnapshotSortsByName(t *testing.T) {
	t.Parallel()

	tracker := NewUsageTracker()
	tracker.Record("query_traces", nil)
	tracker.Record("list_observability_providers", nil)
	tracker.Record("query_logs", nil)

	snapshot := tracker.Snapshot()
	names := make([]string, len(snapshot.Tools))
	for i, tool := range snapshot.Tools {
		names[i] = tool.Name
	}
	assert.Equal(t, []string{"list_observability_providers", "query_logs", "query_traces"}, names)
}

func TestUsageTrackerEmptySnapshotSerializesToolsAsArray(t *testing.T) {
	t.Parallel()

	snapshot := NewUsageTracker().Snapshot()
	require.NotNil(t, snapshot.Tools)

	raw, err := json.Marshal(snapshot)
	require.NoError(t, err)
	var decoded UsageSnapshot
	require.NoError(t, json.Unmarshal(raw, &decoded))
	assert.Empty(t, decoded.Tools)
	// The wire contract: an idle tracker answers {"tools": []}, never null.
	assert.Contains(t, string(raw), `"tools":[]`)
}

func TestUsageTrackerNilSafe(t *testing.T) {
	t.Parallel()

	var tracker *UsageTracker
	assert.NotPanics(t, func() {
		tracker.Record("query_metrics", nil)
	})
	snapshot := tracker.Snapshot()
	assert.Empty(t, snapshot.Tools)
	assert.NotNil(t, snapshot.Tools)
}

func TestRegisterToolsRecordsOutcomesWhenTrackerSet(t *testing.T) {
	t.Parallel()

	tracker := NewUsageTracker()
	reg := mcp.NewRegistry()
	backend := &fakeBackend{
		providers: []ProviderInfo{{Name: "obs/prometheus", Namespace: "obs", Type: "prometheus"}},
	}
	require.NoError(t, RegisterTools(reg, backend, tracker))

	// A successful list and a failed query both land in the tracker.
	_, err := invokeTool(t, reg, "list_observability_providers", `{}`)
	require.NoError(t, err)
	backend.queryErr = errors.New("boom")
	_, err = invokeTool(t, reg, "query_metrics", `{"provider":"obs/prometheus","query":"up"}`)
	require.Error(t, err)

	snapshot := tracker.Snapshot()
	byName := map[string]UsageToolSnapshot{}
	for _, tool := range snapshot.Tools {
		byName[tool.Name] = tool
	}
	require.Contains(t, byName, "list_observability_providers")
	assert.Equal(t, uint64(1), byName["list_observability_providers"].Calls)
	assert.Equal(t, uint64(0), byName["list_observability_providers"].Errors)
	require.Contains(t, byName, "query_metrics")
	assert.Equal(t, uint64(1), byName["query_metrics"].Calls)
	assert.Equal(t, uint64(1), byName["query_metrics"].Errors)
}

func TestRegisterToolsNilTrackerSkipsRecording(t *testing.T) {
	t.Parallel()

	// The nil-tracker configuration must register working tools — recording
	// is disabled, not the tools.
	reg := newRegisteredTools(t, &fakeBackend{
		providers: []ProviderInfo{{Name: "obs/prometheus", Namespace: "obs", Type: "prometheus"}},
		queryResult: &connector.QueryResult{
			State: connector.StateOK,
			Data:  json.RawMessage(`{}`),
		},
	})
	_, err := invokeTool(t, reg, "list_observability_providers", `{}`)
	require.NoError(t, err)
}

func TestUsageTrackerConcurrentRecords(t *testing.T) {
	t.Parallel()

	tracker := NewUsageTracker()
	const workers = 8
	const perWorker = 50
	done := make(chan struct{}, workers)
	for w := 0; w < workers; w++ {
		go func() {
			defer func() { done <- struct{}{} }()
			for i := 0; i < perWorker; i++ {
				tracker.Record("query_metrics", nil)
				tracker.Snapshot()
			}
		}()
	}
	for w := 0; w < workers; w++ {
		<-done
	}

	snapshot := tracker.Snapshot()
	require.Len(t, snapshot.Tools, 1)
	assert.Equal(t, uint64(workers*perWorker), snapshot.Tools[0].Calls)
}
