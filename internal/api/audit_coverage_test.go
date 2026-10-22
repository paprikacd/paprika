package apiserver

import (
	"os"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// knownReadOnlyRPCs lists every RPC deliberately treated as non-mutating.
// Adding an RPC to api.proto without adding it here (or giving it a
// mutating verb prefix) fails this test on purpose.
var knownReadOnlyRPCs = map[string]bool{
	"GetAnalysisRun": true, "GetApplication": true, "GetApplicationLifecycle": true,
	"GetApplicationOwnership": true, "GetApplicationSet": true, "GetArtifact": true,
	"GetCluster": true, "GetDataSources": true, "GetObservabilityProviderType": true,
	"GetObservabilityUsage": true, "GetPipeline": true,
	"GetPipelineRun": true, "GetResource": true, "GetResourceLogs": true,
	"GetResourceTree": true, "GetResourceTreeDetailed": true, "GetRevisionInfo": true,
	"GetRollout": true, "GetRolloutHold": true, "GetStepLogs": true,
	"GetSystemStatus": true, "GetSystemHealth": true, "Investigate": true, "ListAnalysisRuns": true,
	"ListApplications": true, "ListApplicationSets": true, "ListArtifacts": true,
	"ListClusters": true, "ListDriftDetails": true, "ListGateStatus": true,
	"ListInvestigatorPlugins": true, "ListNotificationConfigs": true, "ListObservabilityProviders": true, "ListObservabilityProviderTypes": true, "ListPipelines": true,
	"ListPipelineRuns": true, "ListPolicies": true, "ListReleases": true,
	"ListRollouts": true, "ListRolloutHistory": true, "ListSourceEvents": true,
	"ListStages": true, "QueryApplications": true, "QueryApplicationSignals": true,
	"QueryCost": true, "QueryFleetMap": true, "QueryFleetMatrix": true,
	"Render": true, "ResolveSource": true, "StreamResourceLogs": true,
	"ValidateObservabilityProvider": true,
}

func TestEveryProtoRPCIsClassified(t *testing.T) {
	data, err := os.ReadFile("../../proto/paprika/v1/api.proto")
	require.NoError(t, err)

	// Only PaprikaService is audited: the middleware wraps that service's
	// handler, and the satellite link is an agent-facing RPC on its own service
	// with its own credential, so console audit verbs say nothing about it.
	re := regexp.MustCompile(`(?ms)^service PaprikaService \{.*?^\}`)
	service := re.FindString(string(data))
	require.NotEmpty(t, service, "no service block parsed from api.proto")

	rpc := regexp.MustCompile(`(?m)^\s+rpc\s+([A-Za-z]+)\s*\(`)
	matches := rpc.FindAllStringSubmatch(service, -1)
	require.NotEmpty(t, matches, "no RPCs parsed from api.proto")

	for _, m := range matches {
		name := m[1]
		t.Run(name, func(t *testing.T) {
			_, _, mutating := classifyAudit("/paprika.v1.PaprikaService/" + name)
			if mutating {
				assert.False(t, knownReadOnlyRPCs[name],
					"%s is classified mutating but listed as read-only", name)
				return
			}
			assert.True(t, knownReadOnlyRPCs[name],
				"%s is unclassified: give it a mutating verb prefix in auditVerbs, "+
					"or add it to knownReadOnlyRPCs with justification", name)
		})
	}
}
