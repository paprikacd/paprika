package gcpcloudlogging

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestFilterEscapeRejectedBeforeCredentialsAndNetwork(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, entriesOK)
	for _, query := range []string{
		`severity=ERROR) OR timestamp<"2000-01-01T00:00:00Z" AND (severity=INFO`,
		"-- (\nseverity=ERROR) OR timestamp<\"2000-01-01T00:00:00Z\" AND (severity=INFO",
		`(textPayload="never-echo"`,
		`textPayload="never-echo\`,
	} {
		result, err := New().Query(context.Background(), connector.QueryRequest{
			Signal: connector.SignalLogs, Query: query, Config: testConfig(t, fake.server.URL),
			Credentials: []byte("must-not-be-parsed-as-credentials"),
		})
		require.ErrorIs(t, err, connector.ErrUnsupported)
		require.Equal(t, connector.StateNotAvailable, result.State)
		require.NotContains(t, err.Error(), "never-echo")
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	require.Empty(t, fake.reqs)
}

func TestLoggingCommentsCannotConsumeTimeConstraints(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, entriesOK)
	start := time.Date(2026, 10, 15, 10, 0, 0, 0, time.UTC)
	query := "-- ignored )(\n(textPayload=\"literal () -- \\\"quote\\\"\") -- trailing )("
	result, err := New().Query(context.Background(), connector.QueryRequest{
		Signal: connector.SignalLogs, Query: query, Config: testConfig(t, fake.server.URL),
		Credentials: fakeServiceAccountCreds(t, fake.server.URL+"/token", "test-proj"),
		Range:       connector.TimeRange{Start: start, End: start.Add(5 * time.Minute)}, Limit: 10,
	})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, result.State)
	var body entriesBody
	require.NoError(t, json.Unmarshal(fake.last(t).body, &body))
	require.Equal(t, []string{"projects/test-proj"}, body.ResourceNames)
	require.Equal(t, 10, body.PageSize)
	require.NotContains(t, body.Filter, "ignored")
	require.NotContains(t, body.Filter, "trailing")
	require.Contains(t, body.Filter, `literal () -- \"quote\"`)
	require.Contains(t, body.Filter, `AND timestamp >= "2026-10-15T10:00:00Z" AND timestamp <= "2026-10-15T10:05:00Z"`)
}
