package observabilitygateway

import (
	"context"
	"encoding/json"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

const insightsMergePatchSchema = `{"type":"object","minProperties":1,"description":"Object merge patch: nested objects merge, null removes a field, arrays replace as a whole. Omitted fields remain unchanged. Discover valid fields with get_insights_schema. Identity fields cannot be edited."}`

const insightsWidgetEditsSchema = `{"type":"array","minItems":1,"maxItems":48,"description":"Atomic widget edits by stable ID; one operation per ID. Add appends a new widget; update/remove require an existing widget. Unchanged widget order is preserved.","items":{"oneOf":[{"type":"object","properties":{"op":{"const":"update"},"id":` + insightsIDSchema + `,"patch":` + insightsMergePatchSchema + `},"required":["op","id","patch"],"additionalProperties":false},{"type":"object","properties":{"op":{"const":"add"},"widget":{"type":"object","description":"Complete canonical widget from get_insights_schema(kind=widget)."}},"required":["op","widget"],"additionalProperties":false},{"type":"object","properties":{"op":{"const":"remove"},"id":` + insightsIDSchema + `},"required":["op","id"],"additionalProperties":false}]}}`

func insightsPatchTool(c *InsightsAuthoringClient, singular, collection string) mcp.Tool {
	properties := `"id":` + insightsIDSchema + `,"etag":` + insightsETagSchema + `,"patch":` + insightsMergePatchSchema
	required := `["id","etag","patch"]`
	extra := ""
	detail := "Saved-query id, schemaVersion, providerId and kind cannot be changed."
	if collection == "dashboards" {
		properties += `,"widget_edits":` + insightsWidgetEditsSchema
		required = `["id","etag"]`
		extra = `,"anyOf":[{"required":["patch"]},{"required":["widget_edits"]}]`
		detail = "Dashboard patch cannot change id, schemaVersion or widgets. Use widget_edits to add, update or remove widgets by ID; widget IDs cannot change. All edits are saved atomically."
	}
	return mcp.Tool{
		Name: "patch_" + singular, Scope: mcp.ScopeInsightsWrite,
		Description: "Edit selected fields without resending the whole document. Requires the exact current ETag, paprika:observe, paprika:insights:write and human Insights write permission. Nested objects merge, null removes optional fields, arrays replace. " + detail + " Discover the canonical schema first. The resulting document uses the same validation and persistence as the UI. Clean views refresh automatically; unsaved drafts remain protected. A conflict requires rereading and reviewing; never retry blindly.",
		InputSchema: json.RawMessage(`{"type":"object","properties":{` + properties + `},"required":` + required + `,"additionalProperties":false` + extra + `}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
			args, err := decodeInsightsPatchArgs(raw)
			if err != nil {
				return nil, err
			}
			return c.patch(ctx, collection, args)
		},
	}
}
