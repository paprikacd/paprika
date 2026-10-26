package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func TestInsightsVersionConflictIsAnActionableProtocolToolError(t *testing.T) {
	registry := NewRegistry()
	const message = "document already exists or has changed; get the latest document and ETag before retrying"
	require.NoError(t, registry.Register(Tool{Name: "update_dashboard", Scope: ScopeInsightsWrite, InputSchema: json.RawMessage(`{"type":"object"}`), Invoke: func(context.Context, v1connect.PaprikaServiceClient, json.RawMessage) (any, error) {
		return nil, connect.NewError(connect.CodeAborted, errors.New(message))
	}}))
	server := newObservabilityTestServer(t, registry, nil, ScopeObserve, ScopeInsightsWrite)
	body := doJSONRPC(t, server, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"update_dashboard","arguments":{}}}`, observeBearerFor(t, ScopeObserve, ScopeInsightsWrite))
	var response struct {
		Error  json.RawMessage `json:"error"`
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
	}
	require.NoError(t, json.Unmarshal(body, &response))
	require.Empty(t, response.Error)
	require.True(t, response.Result.IsError)
	require.Len(t, response.Result.Content, 1)
	require.Equal(t, message, response.Result.Content[0].Text)
}
