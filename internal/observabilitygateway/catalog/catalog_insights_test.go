package catalog

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// insightsDecodedKinds are the data planes the Insights console decodes.
var insightsDecodedKinds = map[connector.Signal]struct{}{
	connector.SignalMetrics: {},
	connector.SignalTraces:  {},
	connector.SignalRecords: {},
}

// insightsReasonCodes is the closed set of reasons for an unsupported type.
var insightsReasonCodes = map[string]struct{}{
	InsightsReasonLogs:          {},
	InsightsReasonMetricsFormat: {},
	InsightsReasonTracesFormat:  {},
	InsightsReasonPassthrough:   {},
}

func TestInsightsSupportIsConsistentForEveryType(t *testing.T) {
	t.Parallel()

	for _, info := range All() {
		label := "type " + info.Type
		support := info.Insights

		require.NotNil(t, support.Kinds, "%s: kinds must be a non-nil array", label)
		if len(support.Kinds) == 0 {
			require.NotEmpty(t, support.Reason, "%s: an unqueryable type needs a reason", label)
			require.Contains(t, insightsReasonCodes, support.Reason, label)
			require.NotEmpty(t, support.Note, "%s: an unqueryable type needs a note", label)
			continue
		}

		require.Empty(t, support.Reason, "%s: a queryable type has no reason", label)
		seen := map[connector.Signal]struct{}{}
		for _, kind := range support.Kinds {
			require.Contains(t, insightsDecodedKinds, kind, label)
			require.Contains(t, info.Signals, kind, "%s: kind %q is not a signal the connector serves", label, kind)
			_, duplicate := seen[kind]
			require.False(t, duplicate, "%s: duplicate kind %q", label, kind)
			seen[kind] = struct{}{}
		}
	}
}

func TestInsightsQueryableTypesAreExactlyTheDecodedSet(t *testing.T) {
	t.Parallel()

	// Pinned on purpose: a new connector must be listed here, so it cannot
	// be silently hidden from Insights or silently admitted to it.
	want := map[string][]connector.Signal{
		connector.ProviderPrometheus: {connector.SignalMetrics},
		connector.ProviderTempo:      {connector.SignalTraces},
		connector.ProviderShorted:    {connector.SignalMetrics, connector.SignalRecords},
		connector.ProviderUptime:     {connector.SignalMetrics, connector.SignalRecords},
		connector.ProviderPostgreSQL: {connector.SignalMetrics, connector.SignalRecords},
		connector.ProviderMock:       {connector.SignalMetrics, connector.SignalTraces},
	}

	got := map[string][]connector.Signal{}
	for _, info := range All() {
		if len(info.Insights.Kinds) > 0 {
			got[info.Type] = info.Insights.Kinds
		}
	}
	require.Len(t, got, 6)
	require.Equal(t, want, got)
}

func TestInsightsUnsupportedTypesReportTheirReason(t *testing.T) {
	t.Parallel()

	want := map[string]string{
		connector.ProviderLoki:                 InsightsReasonLogs,
		connector.ProviderGCPCloudLogging:      InsightsReasonLogs,
		connector.ProviderAWSCloudWatchLogs:    InsightsReasonLogs,
		connector.ProviderAWSCloudTrail:        InsightsReasonLogs,
		connector.ProviderGCPCloudMonitoring:   InsightsReasonMetricsFormat,
		connector.ProviderAWSCloudWatchMetrics: InsightsReasonMetricsFormat,
		connector.ProviderVultrMonitoring:      InsightsReasonMetricsFormat,
		connector.ProviderGCPCloudTrace:        InsightsReasonTracesFormat,
		connector.ProviderAWSXRay:              InsightsReasonTracesFormat,
		connector.ProviderOTLP:                 InsightsReasonPassthrough,
	}
	for providerType, reason := range want {
		info, ok := Get(providerType)
		require.True(t, ok, providerType)
		require.Empty(t, info.Insights.Kinds, providerType)
		require.Equal(t, reason, info.Insights.Reason, providerType)
	}
}

func TestInsightsUnsupportedKindsMarshalAsEmptyArray(t *testing.T) {
	t.Parallel()

	info, ok := Get(connector.ProviderLoki)
	require.True(t, ok)

	raw, err := json.Marshal(info.Insights)
	require.NoError(t, err)
	require.JSONEq(t, `{"kinds":[],"reason":"logs_not_supported","note":"`+insightsNoteLogs+`"}`, string(raw))
}
