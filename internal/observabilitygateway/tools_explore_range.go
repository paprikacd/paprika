package observabilitygateway

import (
	"context"
	"encoding/json"
	"fmt"

	"connectrpc.com/connect"

	"github.com/benebsworth/paprika/internal/api/mcp"
	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// Exploration retains an omitted range for connectors that use timeless
// metadata. Explicit ranges and series enumeration use the same bounded
// contract as the dashboard's query path.
func exploreToolRequest(ctx context.Context, backend Backend, provider string, in toolArgs, request *connector.ExploreRequest) (*connector.ExploreResult, error) {
	var err error
	request.Range.Start, err = parseTimeArg(in, "start")
	if err != nil {
		return nil, err
	}
	request.Range.End, err = parseTimeArg(in, "end")
	if err != nil {
		return nil, err
	}
	if err = boundExplore(request); err != nil {
		return nil, err
	}
	result, err := backend.Explore(ctx, provider, *request)
	if err != nil {
		return nil, fmt.Errorf("explore provider: %w", err)
	}
	return result, nil
}

func listMetricSeriesTool(backend Backend) mcp.Tool {
	return mcp.Tool{
		Name:        "list_metric_series",
		Description: "Inspect a bounded sample of series and label sets for one metric in a time range. This supports dashboard label discovery and approximate cardinality; a bounded or truncated response is not a global active-series count. Omitted ranges use the trailing thirty minutes.",
		Scope:       mcp.ScopeObserve,
		InputSchema: json.RawMessage(`{
			"type":"object",
			"properties":{
				"provider":{"type":"string"},
				"metric":{"type":"string"},
				"start":{"type":"string"},
				"end":{"type":"string"},
				"limit":{"type":"integer","minimum":1,"maximum":1000,"default":100}
			},
			"required":["provider","metric"],
			"additionalProperties":false
		}`),
		Invoke: func(ctx context.Context, _ v1connect.PaprikaServiceClient, raw json.RawMessage) (any, error) {
			in, err := decodeArgs(raw)
			if err != nil {
				return nil, connect.NewError(connect.CodeInvalidArgument, err)
			}
			provider, err := requiredString(in, "list_metric_series", "provider")
			if err != nil {
				return nil, err
			}
			metric, err := requiredString(in, "list_metric_series", "metric")
			if err != nil {
				return nil, err
			}
			result, err := exploreToolRequest(ctx, backend, provider, in, &connector.ExploreRequest{
				Kind: connector.ExploreMetricSeries, Metric: metric, Limit: limitArg(in, 100),
			})
			if err != nil {
				return nil, fmt.Errorf("list_metric_series: %w", err)
			}
			return providerToolPreview(exploreToolResponse(provider, connector.ExploreMetricSeries, result), result.State)
		},
	}
}
