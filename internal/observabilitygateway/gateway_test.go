package observabilitygateway

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestNewBuildsEachConnector(t *testing.T) {
	t.Parallel()

	tests := []struct {
		providerType string
		name         string
	}{
		{providerType: connector.ProviderPrometheus, name: "prometheus"},
		{providerType: connector.ProviderLoki, name: "loki"},
		{providerType: connector.ProviderTempo, name: "tempo"},
		{providerType: connector.ProviderOTLP, name: "otlp"},
		{providerType: connector.ProviderGCPCloudLogging, name: "gcp-cloudlogging"},
		{providerType: connector.ProviderGCPCloudMonitoring, name: "gcp-cloudmonitoring"},
		{providerType: connector.ProviderGCPCloudTrace, name: "gcp-cloudtrace"},
		{providerType: connector.ProviderAWSCloudWatchLogs, name: "aws-cloudwatch-logs"},
		{providerType: connector.ProviderAWSCloudWatchMetrics, name: "aws-cloudwatch-metrics"},
		{providerType: connector.ProviderAWSXRay, name: "aws-xray"},
		{providerType: connector.ProviderAWSCloudTrail, name: "aws-cloudtrail"},
	}
	for _, tt := range tests {
		t.Run(tt.providerType, func(t *testing.T) {
			t.Parallel()
			conn, err := New(tt.providerType)
			require.NoError(t, err)
			require.Equal(t, tt.name, conn.Descriptor().Name)
			require.True(t, conn.Descriptor().NeedsEgress)
		})
	}
}

func TestNewUnknownType(t *testing.T) {
	t.Parallel()
	_, err := New("nope")
	// An unknown type is a caller bug, reported as such.
	require.EqualError(t, err, `unknown observability provider "nope"`)
}
