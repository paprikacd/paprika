package observabilitygateway

import (
	"context"
	"encoding/json"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/dataframe"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func queryRecordsTool(backend Backend) mcp.Tool {
	tool := nativeQueryTool(backend, connector.SignalRecords)
	tool.Description = "Read bounded typed records from an authorized application or SQL provider. Results contain columns, scalar-or-null rows, and explicit truncation. Use a provider's allowlisted JSON operation or read-only SQL; records never accept a metric projection. The query range defaults to 30 minutes (maximum 31 days); application snapshots may use explicit source windows instead. Limit defaults to 100 (maximum 1000)."
	tool.InputSchema = json.RawMessage(`{
		"type":"object","properties":{
			"provider":{"type":"string"},"query":{"type":"string"},
			"start":{"type":"string"},"end":{"type":"string"},
			"limit":{"type":"integer","minimum":1,"maximum":1000,"default":100}
		},"required":["provider","query"],"additionalProperties":false
	}`)
	invoke := tool.Invoke
	tool.Invoke = func(ctx context.Context, client v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
		in, err := decodeArgs(raw)
		if err != nil {
			return nil, invalidDashboardRequest()
		}
		for key := range in {
			switch key {
			case "provider", "query", "start", "end", "limit":
			default:
				return nil, invalidDashboardRequest()
			}
		}
		return invoke(ctx, client, raw)
	}
	return tool
}

// Validate records at both public boundaries and the shared backend seam. A
// connector may not smuggle nested payloads, unsafe numeric values or unbounded
// cells into the query response by declaring the records signal.
func boundedRecordResult(signal connector.Signal, result *connector.QueryResult) *connector.QueryResult {
	if signal != connector.SignalRecords || result == nil || result.State != connector.StateOK {
		return result
	}
	if _, err := dataframe.Decode(result.Data); err != nil {
		return &connector.QueryResult{State: connector.StateError, Reason: "the provider returned an invalid or oversized record frame"}
	}
	return result
}
