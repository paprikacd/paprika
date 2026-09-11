package mcp

import (
	"os"
	"regexp"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// optedOutRPCs lists every RPC deliberately not exposed over MCP, with the
// reason. Adding an RPC to api.proto without registering a tool or adding it
// here fails this test on purpose. Reasons are specific to each RPC: either
// it is reachable through a merged tool, it is server-streaming (incompatible
// with request/response tool calls), it is deliberately withheld as too
// broad or dangerous to expose, or it is too narrow to earn its own schema
// budget alongside the read/write tools that already cover the operational
// surface. The four mutating exclusions repeat the spec's Exclusions table
// verbatim (docs/superpowers/specs/2026-09-11-mcp-server-design.md).
//
// GetResourceTreeDetailed, GetResourceLogs, and GetStepLogs are NOT listed
// here even though they are also reachable through a merged tool
// (get_resource_tree's detailed parameter, get_logs's kind parameter): they
// are already present in readToolRPCs, so the coverage loop marks them
// covered before optedOutRPCs is ever consulted. Listing them here too would
// just be dead weight.
var optedOutRPCs = map[string]string{
	// --- mutating: deliberately withheld (spec Exclusions table) ---
	"ApplyBundle":        "Applies an arbitrary manifest bundle. Effectively unbounded write access to the fleet; no useful scope boundary can be drawn around it.",
	"ApplyResourcePatch": "Arbitrary patch against an arbitrary resource. Same objection.",
	"SyncResources":      "Bulk multi-resource sync with a blast radius that is hard to preview, making the two-phase confirmation summary untrustworthy.",
	"IgnoreDriftedField": "Durably suppresses drift detection. A configuration-governance decision that should be made by a human in the console, not inferred by a model from a log line.",

	// --- server-streaming: incompatible with request/response tool calls ---
	"StreamResourceLogs": "server-streaming RPC; MCP tool calls are request/response. get_logs wraps GetResourceLogs/GetStepLogs with a required tail limit instead.",

	// --- reachable through a merged tool ---
	"ListStages":     "Application.stages is already embedded in get_application's response; a separate stage listing duplicates it.",
	"ListGateStatus": "Application.gates is already embedded in get_application's response; a separate gate-status listing duplicates it.",
	"GetResource":    "a single resource node is already reachable inside get_resource_tree's returned tree; no standalone fetch is needed.",

	// --- ListApplications: corrected per Task 10 brief ---
	"ListApplications": "no pagination on ListApplicationsRequest; list_applications is backed by QueryApplications instead.",

	// --- too narrow / overlapping: admin & config objects outside the
	// operational (fleet health / delivery) read surface the tool set targets ---
	"ListPolicies":            "static policy configuration listing (name/severity/action); not fleet runtime state, too narrow to justify a schema budget.",
	"ListApplicationSets":     "ApplicationSet is a fleet-templating admin object, not runtime delivery state; too narrow to justify a schema budget.",
	"GetApplicationSet":       "single-record form of ListApplicationSets; same admin-object reasoning.",
	"ListNotificationConfigs": "notification-routing configuration, unrelated to fleet health investigation; too narrow to justify a schema budget.",

	// --- too narrow: internal plumbing / rendering helpers ---
	"ResolveSource": "internal source-resolution helper used by the render/apply pipeline; takes an arbitrary spec_json blob and has no standalone investigative use case.",
	"Render":        "renders a manifest preview from arbitrary spec_json/values_json bytes; an internal templating passthrough, too narrow to justify a schema budget.",

	// --- too narrow: duplicated by richer tool responses ---
	"ListAnalysisRuns": "Argo Rollouts AnalysisRun detail is already summarized in Application.analysis_results and Rollout.analysis_checks; too narrow to justify a separate tool.",
	"GetAnalysisRun":   "single-record form of ListAnalysisRuns; same reasoning.",
	"GetPipeline":      "Pipeline's steps/statuses/artifacts duplicate what get_pipeline_run's PipelineRunSummary already returns for a run; too narrow to justify a separate tool.",
	"GetArtifact":      "a single ArtifactRef plus a download_url; artifacts are already listed on the owning pipeline run, and a download link is not actionable from an MCP read tool.",
	"ListArtifacts":    "artifact refs are already reachable via the owning pipeline/pipeline run response; too narrow to justify a separate tool.",
	"GetCluster":       "single-cluster detail is already covered by list_clusters, which returns full Cluster records; too narrow to justify a separate tool.",

	// --- too narrow: discovery / introspection, not fleet state ---
	"ListInvestigatorPlugins": "static list of investigator plugin names/types; capability discovery, not fleet state, too narrow to justify a schema budget.",
	"GetDataSources":          "reports which observability data classes are configured; operational introspection, not investigative fleet data, too narrow to justify a schema budget.",

	// --- too narrow: overlaps existing query tools ---
	"QueryFleetMatrix":        "pivot-table rendering of the same fleet index fleet_map already exposes as a tree with facets; too narrow a marginal use case to justify a second, overlapping tool.",
	"QueryApplicationSignals": "batch (up to 100 identities) health-signal query that overlaps investigate/fleet_map's existing health surfacing; too narrow a marginal use case to justify a second, overlapping tool.",

	// --- too narrow: history/event feeds not covered by any tool ---
	"ListSourceEvents":   "recent-window feed of raw source webhook/poll events; too narrow an operational value beyond investigate/get_application to justify a schema budget.",
	"ListRolloutHistory": "historical rollout event feed; get_rollout/list_rollouts already cover current rollout state, and history is too narrow to justify a separate tool.",
	"ListPipelineRuns":   "list_pipelines and get_pipeline_run already cover pipeline discovery and single-run detail; a bare multi-run listing is too narrow to justify a separate tool.",

	// --- too narrow: single peripheral fields ---
	"GetRevisionInfo":         "commit/build metadata for a single revision; too narrow to justify a schema budget.",
	"GetApplicationOwnership": "single-field ownership lookup (team/contact) for an application; too narrow to justify a separate tool.",
	"ListDriftDetails":        "per-resource drift-field listing; too narrow to justify a schema budget.",
	"GetApplicationLifecycle": "application lifecycle metadata (created/promoted timestamps); too narrow to justify a separate tool.",
	"GetRolloutHold":          "hold detail (held_by/expiry/reason) beyond get_rollout's paused state; too narrow a marginal use case to justify a separate tool.",
}

// toolRPCs merges readToolRPCs and writeToolRPCs. They are declared
// separately, one per tool file, because a single package-level identifier
// cannot be declared in two files.
func toolRPCs() map[string][]string {
	merged := make(map[string][]string, len(readToolRPCs)+len(writeToolRPCs))
	for name, rpcs := range readToolRPCs {
		merged[name] = rpcs
	}
	for name, rpcs := range writeToolRPCs {
		merged[name] = rpcs
	}
	return merged
}

// TestEveryProtoRPCIsExposedOrOptedOut enumerates every RPC declared in
// api.proto and asserts that each one is either exposed as an MCP tool
// (derived from the actual registered tools, never a hand-written list) or
// explicitly opted out with a stated reason. This is the standing guard
// against the audit-classifier failure mode: an RPC added to the proto with
// no decision made about it fails the build, rather than being silently
// dropped.
func TestEveryProtoRPCIsExposedOrOptedOut(t *testing.T) {
	data, err := os.ReadFile("../../../proto/paprika/v1/api.proto")
	require.NoError(t, err)
	re := regexp.MustCompile(`(?m)^\s+rpc\s+([A-Za-z]+)\s*\(`)
	matches := re.FindAllStringSubmatch(string(data), -1)
	require.NotEmpty(t, matches)

	r := NewRegistry()
	require.NoError(t, RegisterReadTools(r))
	require.NoError(t, RegisterWriteTools(r))

	merged := toolRPCs()
	covered := map[string]bool{}
	for _, tool := range r.All() {
		for _, rpc := range merged[tool.Name] {
			covered[rpc] = true
		}
	}

	for _, m := range matches {
		name := m[1]
		t.Run(name, func(t *testing.T) {
			if covered[name] {
				return
			}
			reason, ok := optedOutRPCs[name]
			assert.True(t, ok,
				"%s is neither exposed as a tool nor opted out: register a tool "+
					"or add it to optedOutRPCs with a reason", name)
			assert.NotEmpty(t, reason, "%s needs a stated reason", name)
		})
	}
}
