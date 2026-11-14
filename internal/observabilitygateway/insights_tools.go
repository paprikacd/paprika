package observabilitygateway

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

const insightsIDSchema = `{"type":"string","pattern":"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$"}`
const insightsETagSchema = `{"type":"string","description":"Exact quoted ETag returned by get. Never use a wildcard or reuse an old ETag after a conflict."}`
const savedQueryDocumentSchema = `{"type":"object","description":"Canonical saved query document used by the UI. Optional description, imageUrl, tags, metadata and typed parameters are supported. Use list_insights_providers for providerId. Query placeholders are unquoted {{parameter}} literals. Get before updating and preserve all existing fields.","required":["schemaVersion","id","name","providerId","kind","query"],"properties":{"schemaVersion":{"const":1},"id":` + insightsIDSchema + `,"name":{"type":"string"},"providerId":{"type":"string"},"kind":{"enum":["metrics","traces","records"]},"query":{"type":"string"}}}`
const dashboardDocumentSchema = `{"type":"object","description":"Canonical UI dashboard. timeRange:15m|30m|1h|6h|24h|7d|30d; refreshInterval:0|15|30|60. Each widget requires id,title,type,providerId,query,unit,layout{x,y,w,h}. Types:timeseries,bar,stat,table,traces,heatmap,plugin. A saved reference uses queryRef{id,bindings}; create its query first. Stat options include decimals, showSparkline, showStatBar (requires min and max), sparklinePlacement (background or side) and statIcon (arrow-down, arrow-up, shield, network, activity, target or pie). Dashboard variables bind explicitly through queryRef. Get before updating and preserve other fields. Unresolved references are retained for portable imports and show errors in UI.","required":["schemaVersion","id","title","timeRange","refreshInterval","widgets"],"properties":{"schemaVersion":{"const":1},"id":` + insightsIDSchema + `,"title":{"type":"string"},"timeRange":{"type":"string"},"refreshInterval":{"type":"integer"},"widgets":{"type":"array"}}}`

// RegisterInsightsTools adds document authoring only when the authenticated
// Insights proxy is configured. Telemetry tools retain their read-only scope.
func RegisterInsightsTools(registry *mcp.Registry, c *InsightsAuthoringClient, usage *UsageTracker) error {
	tools := make([]mcp.Tool, 0, 14)
	tools = append(tools, insightsListTool(c, "list_insights_providers", "providers"), insightsListTool(c, "list_saved_queries", "saved-queries"), insightsListTool(c, "list_dashboards", "dashboards"), insightsQueryDashboardTool(c), insightsSchemaTool(c), insightsValidateTool(c))
	if c.renderer != nil {
		tools = append(tools, insightsRenderDashboardTool(c))
	}
	for _, document := range []struct{ singular, collection, schema string }{{"saved_query", "saved-queries", savedQueryDocumentSchema}, {"dashboard", "dashboards", dashboardDocumentSchema}} {
		tools = append(tools, insightsGetTool(c, document.singular, document.collection), insightsPutTool(c, document.singular, document.collection, document.schema, true), insightsPutTool(c, document.singular, document.collection, document.schema, false), insightsPatchTool(c, document.singular, document.collection))
	}
	for i := range tools {
		if usage != nil {
			tools[i].Invoke = recordUsage(usage, tools[i].Name, tools[i].Invoke)
		}
		if err := registry.Register(tools[i]); err != nil {
			return fmt.Errorf("register Insights tool: %w", err)
		}
	}
	return nil
}

func insightsListTool(c *InsightsAuthoringClient, name, collection string) mcp.Tool {
	properties := "{}"
	if collection == "saved-queries" {
		properties = `{"provider_id":` + insightsIDSchema + `}`
	}
	description := "List authorized Insights " + collection + " in the same workspace as the dashboard UI. Lists contain summaries; get a document and its ETag before updating. Provider IDs are the exact IDs required by saved queries and dashboard widgets."
	if collection == "providers" {
		description += " Shared providers come from a shared catalog. If that catalog is busy, denied or unavailable and no providers are listed, the call fails instead of returning an empty list (busy carries a retry delay), so a successful empty list means no providers are available to this caller. If some providers are listed, the result also carries sharedCatalog with the failure status and a note says shared providers are missing."
	}
	return mcp.Tool{Name: name, Description: description, Scope: mcp.ScopeObserve, InputSchema: json.RawMessage(`{"type":"object","properties":` + properties + `,"additionalProperties":false}`), Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
		args, err := decodeInsightsAuthoringArgs(raw)
		if err != nil {
			return nil, err
		}
		if collection == "providers" {
			return c.listProviders(ctx, args.ProviderID)
		}
		return c.list(ctx, collection, args.ProviderID)
	}}
}

// insightsCompositionPointer keeps the dashboard composition rules out of every
// tool description: clients read them once in the server instructions and in
// get_insights_schema notes, and only dashboard writes need the reminder. The
// same writes also point at validate_dashboard and the checks they return.
func insightsCompositionPointer(singular string) string {
	if singular != "dashboard" {
		return ""
	}
	return " Follow the dashboard composition rules in the server instructions or get_insights_schema notes. Use validate_dashboard to check a draft without saving; successful writes return warnings in checks."
}

func insightsGetTool(c *InsightsAuthoringClient, singular, collection string) mcp.Tool {
	return mcp.Tool{Name: "get_" + singular, Description: "Get the current canonical " + singular + ", its exact ETag and UI URL. Keep all unchanged fields when constructing an update. Changes saved through MCP use the same storage as the UI.", Scope: mcp.ScopeObserve, InputSchema: json.RawMessage(`{"type":"object","properties":{"id":` + insightsIDSchema + `},"required":["id"],"additionalProperties":false}`), Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
		args, err := decodeInsightsAuthoringArgs(raw)
		if err != nil {
			return nil, err
		}
		return c.get(ctx, collection, args.ID)
	}}
}

func insightsPutTool(c *InsightsAuthoringClient, singular, collection, documentSchema string, create bool) mcp.Tool {
	action, required, extra := "create", `["document"]`, ""
	description := "Create a new document only if its ID does not already exist. Existing documents are never overwritten."
	if !create {
		action, required, extra = "update", `["document","etag"]`, `,"etag":`+insightsETagSchema
		description = "Update a document only if its exact ETag is still current. Get the latest first; a conflict requires reviewing and rebuilding the change, never blindly retrying."
	}
	return mcp.Tool{Name: action + "_" + singular, Description: description + " Requires paprika:observe, paprika:insights:write and human Insights write permission. The document is validated by the same service as the UI. Active clean UI views refresh automatically; unsaved drafts are preserved." + insightsCompositionPointer(singular), Scope: mcp.ScopeInsightsWrite, InputSchema: json.RawMessage(`{"type":"object","properties":{"document":` + documentSchema + extra + `},"required":` + required + `,"additionalProperties":false}`), Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
		args, err := decodeInsightsAuthoringArgs(raw)
		if err != nil {
			return nil, err
		}
		return insightsWriteResult(c.put(ctx, collection, args, create))
	}}
}
