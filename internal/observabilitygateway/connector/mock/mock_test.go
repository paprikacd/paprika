package mock

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func query(t *testing.T, signal connector.Signal, query string, cfg string, limit int) *connector.QueryResult {
	t.Helper()
	m := New()
	result, err := m.Query(t.Context(), connector.QueryRequest{
		Signal: signal, Query: query, Limit: limit,
		Config: json.RawMessage(cfg),
	})
	require.NoError(t, err)
	require.NotNil(t, result)
	return result
}

func TestDescriptorSuppliesAllSignalsWithoutEgress(t *testing.T) {
	d := New().Descriptor()
	assert.Equal(t, connector.ProviderMock, d.Name)
	assert.False(t, d.NeedsEgress)
	for _, s := range []connector.Signal{connector.SignalMetrics, connector.SignalLogs, connector.SignalTraces} {
		assert.True(t, d.CanSupply(s), "should supply %s", s)
	}
}

func TestValidateConfigAcceptsEmptyDocument(t *testing.T) {
	require.NoError(t, New().ValidateConfig(nil))
	require.NoError(t, New().ValidateConfig(json.RawMessage(`{}`)))
}

func TestValidateConfigRejectsUnknownKeys(t *testing.T) {
	err := New().ValidateConfig(json.RawMessage(`{"endpooint":"typo"}`))
	require.Error(t, err)
	assert.Contains(t, err.Error(), `unknown key "endpooint"`)
}

func TestValidateConfigRejectsOutOfBoundsAndWrongTypes(t *testing.T) {
	for name, cfg := range map[string]string{
		"negative latency":    `{"latencyMs":-1}`,
		"huge latency":        `{"latencyMs":999999999}`,
		"non-integer":         `{"series":"many"}`,
		"point budget breach": `{"series":2000,"pointsPerSeries":2000}`,
		"span budget breach":  `{"traces":2000,"spansPerTrace":2000}`,
	} {
		t.Run(name, func(t *testing.T) {
			require.Error(t, New().ValidateConfig(json.RawMessage(cfg)))
		})
	}
}

func TestQueryMetricsReturnsDeterministicMatrix(t *testing.T) {
	first := query(t, connector.SignalMetrics, `up{job="a"}`, `{"series":4,"pointsPerSeries":8,"seed":7}`, 0)
	second := query(t, connector.SignalMetrics, `up{job="a"}`, `{"series":4,"pointsPerSeries":8,"seed":7}`, 0)
	require.Equal(t, connector.StateOK, first.State)
	assert.JSONEq(t, string(first.Data), string(second.Data), "identical query and seed must produce identical data")

	var decoded struct {
		Status string `json:"status"`
		Data   struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Metric map[string]string `json:"metric"`
				Values [][2]any          `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(first.Data, &decoded))
	assert.Equal(t, "success", decoded.Status)
	assert.Equal(t, "matrix", decoded.Data.ResultType)
	require.Len(t, decoded.Data.Result, 4)
	for _, s := range decoded.Data.Result {
		assert.Len(t, s.Values, 8)
		assert.NotEmpty(t, s.Metric["__name__"])
	}
}

func TestQueryMetricsLimitCapsSeries(t *testing.T) {
	result := query(t, connector.SignalMetrics, "up", `{"series":50}`, 5)
	var decoded struct {
		Data struct {
			Result []json.RawMessage `json:"result"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(result.Data, &decoded))
	assert.Len(t, decoded.Data.Result, 5)
}

func TestQueryLogsReturnsLokiStreamsShape(t *testing.T) {
	result := query(t, connector.SignalLogs, `{app="mock"}`, `{"logEntries":20}`, 0)
	require.Equal(t, connector.StateOK, result.State)
	var decoded struct {
		Data struct {
			ResultType string `json:"resultType"`
			Result     []struct {
				Stream map[string]string `json:"stream"`
				Values [][2]any          `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(result.Data, &decoded))
	assert.Equal(t, "streams", decoded.Data.ResultType)
	total := 0
	for _, s := range decoded.Data.Result {
		total += len(s.Values)
		assert.Contains(t, s.Stream, "level")
	}
	assert.Equal(t, 20, total)
}

func TestQueryLogsLimitCapsEntries(t *testing.T) {
	result := query(t, connector.SignalLogs, `{app="mock"}`, `{"logEntries":500}`, 10)
	var decoded struct {
		Data struct {
			Result []struct {
				Values [][2]any `json:"values"`
			} `json:"result"`
		} `json:"data"`
	}
	require.NoError(t, json.Unmarshal(result.Data, &decoded))
	total := 0
	for _, s := range decoded.Data.Result {
		total += len(s.Values)
	}
	assert.Equal(t, 10, total)
}

func TestQueryTracesReturnsSearchShape(t *testing.T) {
	result := query(t, connector.SignalTraces, `{.service.name="mock"}`, `{"traces":6,"spansPerTrace":4}`, 0)
	require.Equal(t, connector.StateOK, result.State)
	var decoded tempoTraceShape
	require.NoError(t, json.Unmarshal(result.Data, &decoded))
	require.Len(t, decoded.Traces, 6)
	for _, tr := range decoded.Traces {
		assert.Len(t, tr.TraceID, 32)
		assert.NotEmpty(t, tr.RootServiceName)
	}
}

// tempoTraceShape decodes the Tempo search wire shape; the field spellings
// (traceID) are the backend's contract, not this repo's camelCase.
//
//nolint:tagliatelle // Mirrors the Tempo search API response keys.
type tempoTraceShape struct {
	Traces []struct {
		TraceID           string `json:"traceID"`
		RootServiceName   string `json:"rootServiceName"`
		StartTimeUnixNano string `json:"startTimeUnixNano"`
	} `json:"traces"`
}

func TestQueryTracesByIDStillSynthesizes(t *testing.T) {
	result := query(t, connector.SignalTraces, "", "", 0)
	require.Equal(t, connector.StateOK, result.State)
	assert.Contains(t, string(result.Data), `"traces"`)
}

func TestQueryUnsupportedSignal(t *testing.T) {
	result, err := New().Query(t.Context(), connector.QueryRequest{
		Signal: connector.Signal("profiles"), Config: json.RawMessage(`{}`),
	})
	require.Error(t, err)
	assert.ErrorIs(t, err, connector.ErrUnsupported)
	require.NotNil(t, result)
	assert.Equal(t, connector.StateNotAvailable, result.State)
}

func TestQueryFailEveryMarksAStableQuerySubset(t *testing.T) {
	cfg := `{"failEvery":2}`
	first := make([]connector.State, 16)
	for i := range first {
		first[i] = query(t, connector.SignalMetrics, "q-"+string(rune('a'+i)), cfg, 0).State
	}
	// Half of the sixteen distinct queries fail, and the failure set is
	// stable: a second pass over the same query texts reports per-query
	// exactly the same state.
	outcomes := map[connector.State]int{}
	for i := range first {
		outcomes[first[i]]++
		repeated := query(t, connector.SignalMetrics, "q-"+string(rune('a'+i)), cfg, 0).State
		assert.Equal(t, first[i], repeated, "state is stable per query text")
	}
	assert.Equal(t, 8, outcomes[connector.StateError])
	assert.Equal(t, 8, outcomes[connector.StateOK])
}

func TestQueryLatencyHonorsContextCancellation(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	result, err := New().Query(ctx, connector.QueryRequest{
		Signal: connector.SignalMetrics, Query: "slow",
		Config: json.RawMessage(`{"latencyMs":5000}`),
	})
	require.NoError(t, err)
	require.NotNil(t, result)
	assert.Equal(t, connector.StateError, result.State, "a cancelled synthetic latency reports the fixed error sentence")
	assert.Less(t, time.Since(start), 2*time.Second)
}

func TestQueryLatencySleepsBeforeAnswering(t *testing.T) {
	start := time.Now()
	result := query(t, connector.SignalMetrics, "up", `{"latencyMs":50}`, 0)
	assert.Equal(t, connector.StateOK, result.State)
	assert.GreaterOrEqual(t, time.Since(start), 50*time.Millisecond)
}

func TestQueryInvalidConfigIsACallerBug(t *testing.T) {
	_, err := New().Query(t.Context(), connector.QueryRequest{
		Signal: connector.SignalMetrics, Config: json.RawMessage(`{"series":-3}`),
	})
	require.Error(t, err)
	assert.NotErrorIs(t, err, connector.ErrForbidden)
}

func TestPayloadSizesScaleWithConfig(t *testing.T) {
	small := query(t, connector.SignalMetrics, "up", `{"series":4,"pointsPerSeries":4}`, 0)
	large := query(t, connector.SignalMetrics, "up", `{"series":200,"pointsPerSeries":64,"labelsPerSeries":6}`, 0)
	assert.Greater(t, len(large.Data), len(small.Data)*10)
}
