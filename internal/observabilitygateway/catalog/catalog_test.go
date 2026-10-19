package catalog

import (
	"cmp"
	"encoding/json"
	"slices"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// connectorProviderTypes is the expected library contents: exactly the
// provider-type constants the connector package defines, no more. The
// catalog is metadata for the connector set, so the two must move together.
var connectorProviderTypes = []string{
	connector.ProviderPrometheus,
	connector.ProviderLoki,
	connector.ProviderTempo,
	connector.ProviderOTLP,
	connector.ProviderGCPCloudLogging,
	connector.ProviderGCPCloudMonitoring,
	connector.ProviderGCPCloudTrace,
	connector.ProviderAWSCloudWatchLogs,
	connector.ProviderAWSCloudWatchMetrics,
	connector.ProviderAWSXRay,
	connector.ProviderAWSCloudTrail,
	connector.ProviderVultrMonitoring,
	connector.ProviderMock,
}

func TestAllListsExactlyTheConnectorProviderTypes(t *testing.T) {
	t.Parallel()

	all := All()
	require.Len(t, all, len(connectorProviderTypes))

	got := make([]string, 0, len(all))
	for i := range all {
		got = append(got, all[i].Type)
	}
	require.ElementsMatch(t, connectorProviderTypes, got)
}

func TestEveryEntryCarriesCompleteMetadata(t *testing.T) {
	t.Parallel()

	validVendors := map[string]struct{}{
		vendorAWS:         {},
		vendorGoogleCloud: {},
		vendorOpenSource:  {},
		vendorPaprika:     {},
		vendorVultr:       {},
	}
	validCategories := map[string]struct{}{
		categoryLogs:    {},
		categoryMetrics: {},
		categoryTraces:  {},
		categoryAudit:   {},
		categoryTest:    {},
	}
	validSignals := map[connector.Signal]struct{}{
		connector.SignalLogs:    {},
		connector.SignalMetrics: {},
		connector.SignalTraces:  {},
	}

	for _, info := range All() {
		label := "type " + info.Type

		require.NotEmpty(t, info.DisplayName, label)
		require.NotEmpty(t, info.Summary, label)
		require.NotEmpty(t, info.Description, label)
		require.Contains(t, validVendors, info.Vendor, label)
		require.Contains(t, validCategories, info.Category, label)

		require.NotEmpty(t, info.Signals, label)
		for _, signal := range info.Signals {
			require.Contains(t, validSignals, signal, label)
		}
		require.Contains(t, info.Signals, info.Probe.Signal, label)
		require.NotEmpty(t, info.Probe.Note, label)

		require.NotEmpty(t, info.Steps, label)
		for _, step := range info.Steps {
			require.NotEmpty(t, step.Title, label)
			require.NotEmpty(t, step.Body, label)
		}

		seenKeys := map[string]struct{}{}
		for _, field := range info.ConfigFields {
			require.NotEmpty(t, field.Key, label)
			require.NotEmpty(t, field.Label, label)
			_, duplicate := seenKeys[field.Key]
			require.False(t, duplicate, "%s: duplicate config key %q", label, field.Key)
			seenKeys[field.Key] = struct{}{}
			if field.Required && field.Input == "string" {
				require.NotEmpty(t, field.Help, "%s: required field %q needs Help", label, field.Key)
			}
		}
	}
}

func TestCloudCredentialKindsMatchTheirVendors(t *testing.T) {
	t.Parallel()

	for _, providerType := range []string{
		connector.ProviderAWSCloudWatchLogs,
		connector.ProviderAWSCloudWatchMetrics,
		connector.ProviderAWSXRay,
		connector.ProviderAWSCloudTrail,
	} {
		info, ok := Get(providerType)
		require.True(t, ok, providerType)
		require.Equal(t, credentialKindAWSKeys, info.Credential.Kind, providerType)
		require.NotEmpty(t, info.Credential.Help, providerType)
	}

	for _, providerType := range []string{
		connector.ProviderGCPCloudLogging,
		connector.ProviderGCPCloudMonitoring,
		connector.ProviderGCPCloudTrace,
	} {
		info, ok := Get(providerType)
		require.True(t, ok, providerType)
		require.Equal(t, credentialKindGCPServiceAccount, info.Credential.Kind, providerType)
		require.NotEmpty(t, info.Credential.Help, providerType)
	}
}

func TestCloudWatchSelectorsAreRequiredFields(t *testing.T) {
	t.Parallel()

	logs, ok := Get(connector.ProviderAWSCloudWatchLogs)
	require.True(t, ok)
	for _, key := range []string{"region", "logGroup"} {
		field, found := findField(logs, key)
		require.True(t, found, "aws-cloudwatch-logs: missing field %q", key)
		require.True(t, field.Required, "aws-cloudwatch-logs: field %q must be required", key)
	}

	metrics, ok := Get(connector.ProviderAWSCloudWatchMetrics)
	require.True(t, ok)
	for _, key := range []string{"region", "namespace"} {
		field, found := findField(metrics, key)
		require.True(t, found, "aws-cloudwatch-metrics: missing field %q", key)
		require.True(t, field.Required, "aws-cloudwatch-metrics: field %q must be required", key)
	}
}

func TestSummariesIsTheLightProjectionInLibraryOrder(t *testing.T) {
	t.Parallel()

	all := All()
	summaries := Summaries()
	require.Len(t, summaries, len(all))

	for i := range all {
		require.Equal(t, all[i].Type, summaries[i].Type)
		require.Equal(t, all[i].DisplayName, summaries[i].DisplayName)
		require.Equal(t, all[i].Vendor, summaries[i].Vendor)
		require.Equal(t, all[i].Category, summaries[i].Category)
		require.Equal(t, all[i].Signals, summaries[i].Signals)
		require.Equal(t, all[i].Summary, summaries[i].Summary)
	}

	// The wire shape is the contract with the React list view: exactly the
	// six light keys, with no config schema, walkthrough or description
	// leaking into the list payload.
	encoded, err := json.Marshal(summaries[0])
	require.NoError(t, err)
	var payload map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(encoded, &payload))
	keys := make([]string, 0, len(payload))
	for key := range payload {
		keys = append(keys, key)
	}
	require.ElementsMatch(t,
		[]string{"type", "displayName", "vendor", "category", "signals", "summary"},
		keys)
}

func TestAllIsSortedByVendorThenDisplayName(t *testing.T) {
	t.Parallel()

	all := All()
	sorted := slices.Clone(all)
	slices.SortFunc(sorted, func(a, b TypeInfo) int {
		return cmp.Or(
			cmp.Compare(a.Vendor, b.Vendor),
			cmp.Compare(a.DisplayName, b.DisplayName),
		)
	})
	require.Equal(t, sorted, all)
}

func TestGetRoundTripsKnownTypes(t *testing.T) {
	t.Parallel()

	for _, info := range All() {
		got, ok := Get(info.Type)
		require.True(t, ok, info.Type)
		require.Equal(t, info, got, info.Type)
	}

	_, ok := Get("not-a-provider")
	require.False(t, ok)
	_, ok = Get("")
	require.False(t, ok)
}

func findField(info TypeInfo, key string) (Field, bool) {
	for i := range info.ConfigFields {
		if info.ConfigFields[i].Key == key {
			return info.ConfigFields[i], true
		}
	}
	return Field{}, false
}

func TestGCPOnboardingUsesApprovedReadPermissionsWithoutKeyExport(t *testing.T) {
	for _, providerType := range []string{connector.ProviderGCPCloudLogging, connector.ProviderGCPCloudMonitoring, connector.ProviderGCPCloudTrace} {
		info, ok := Get(providerType)
		require.True(t, ok)
		raw, err := json.Marshal(info.Steps)
		require.NoError(t, err)
		require.NotContains(t, string(raw), "service-accounts keys create")
		require.NotContains(t, string(raw), "--role=\"roles/cloudtrace.user")
		require.Contains(t, string(raw), "approval")
		require.Contains(t, string(raw), "credentialsSecretRef")
	}
}
