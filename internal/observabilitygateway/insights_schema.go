package observabilitygateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

const insightsSchemaResponseBytes = 64 << 10

const insightsSchemaInputSchema = `{"type":"object","required":["kind"],"additionalProperties":false,"properties":{"kind":{"type":"string","enum":["dashboard","widget","saved_query"],"description":"Canonical document contract to inspect before authoring or editing."}}}`
const insightsSchemaOutputSchema = `{"type":"object","required":["schemaVersion","kind","schema","examples","notes"],"properties":{"schemaVersion":{"const":1},"kind":{"enum":["dashboard","widget","saved_query"]},"schema":{"type":"object"},"examples":{"type":"array","items":{"type":"object"}},"notes":{"type":"array","items":{"type":"string"}}}}`

func insightsSchemaTool(c *InsightsAuthoringClient) mcp.Tool {
	return mcp.Tool{
		Name: "get_insights_schema", Title: "Inspect Insights authoring schema", Scope: mcp.ScopeObserve,
		Description: "Get the full canonical dashboard, widget or saved-query JSON Schema and an illustrative valid example from the deployed Insights service. Read this before constructing or editing documents. Includes options, bindings, metadata, layout bounds and runtime-validation notes. Read-only; requires paprika:observe and existing Insights read permission, not authoring consent.",
		InputSchema: json.RawMessage(insightsSchemaInputSchema), OutputSchema: json.RawMessage(insightsSchemaOutputSchema),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
			kind, err := decodeInsightsSchemaKind(raw)
			if err != nil {
				return nil, err
			}
			body, _, err := c.requestAuthorized(ctx, http.MethodGet, "schemas/"+kind, nil, nil, false, insightsSchemaResponseBytes)
			if err != nil {
				return nil, err
			}
			if err := validateInsightsSchemaResponse(body, kind); err != nil {
				return nil, err
			}
			text := fmt.Sprintf("Insights %s schema v1. Full JSON Schema and a canonical example are in structuredContent. Replace illustrative provider IDs and metric names; runtime semantic validation also applies. Read current documents and use their exact ETags before updating.", kind)
			return &sdkmcp.CallToolResult{StructuredContent: body, Content: []sdkmcp.Content{&sdkmcp.TextContent{Text: text}}}, nil
		},
	}
}

func decodeInsightsSchemaKind(raw json.RawMessage) (string, error) {
	var kind string
	if len(raw) > 1024 {
		return "", connect.NewError(connect.CodeInvalidArgument, errors.New("expected one kind argument: dashboard, widget, or saved_query"))
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	opening, openErr := decoder.Token()
	key, keyErr := decoder.Token()
	valueErr := decoder.Decode(&kind)
	closing, closeErr := decoder.Token()
	_, trailingErr := decoder.Token()
	if errors.Join(openErr, keyErr, valueErr, closeErr) != nil || opening != json.Delim('{') || key != "kind" || closing != json.Delim('}') || !errors.Is(trailingErr, io.EOF) {
		return "", connect.NewError(connect.CodeInvalidArgument, errors.New("expected one kind argument: dashboard, widget, or saved_query"))
	}
	switch kind {
	case "dashboard", "widget", "saved_query":
		return kind, nil
	default:
		return "", connect.NewError(connect.CodeInvalidArgument, errors.New("schema kind must be dashboard, widget, or saved_query"))
	}
}

func validateInsightsSchemaResponse(raw json.RawMessage, kind string) error {
	var response struct {
		SchemaVersion int                          `json:"schemaVersion"`
		Kind          string                       `json:"kind"`
		Schema        map[string]json.RawMessage   `json:"schema"`
		Examples      []map[string]json.RawMessage `json:"examples"`
		Notes         []string                     `json:"notes"`
	}
	if json.Unmarshal(raw, &response) != nil || response.SchemaVersion != 1 || response.Kind != kind || len(response.Schema) == 0 || len(response.Examples) == 0 || response.Notes == nil {
		return connect.NewError(connect.CodeInternal, errors.New("insights returned an invalid authoring schema"))
	}
	return nil
}
