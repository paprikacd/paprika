package gcpcloudmonitoring

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestFilterEscapeRejectedBeforeCredentialsAndNetwork(t *testing.T) {
	t.Parallel()
	fake := newFakeGCP(t, false, timeSeriesOK)
	for _, query := range []string{
		`metric.type="foo") OR resource.type="global" AND (metric.type="other"`,
		`(metric.type="never-echo"`,
		`metric.type="never-echo\`,
		`metric.type="never-echo" -- comment (`,
		`metric.type="never-echo" # comment (`,
	} {
		result, err := New().Query(context.Background(), connector.QueryRequest{
			Signal: connector.SignalMetrics, Query: query, Config: testConfig(t, fake.server.URL),
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
