package tempo

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

// Optional real Tempo check. Run only against the isolated synthetic gallery
// after ingesting more than 100 checkout traces; never depends on production.
func TestLiveGallerySearchReportsTruncation(t *testing.T) {
	address := os.Getenv("PAPRIKA_GALLERY_TEMPO_URL")
	if address == "" {
		t.Skip("set PAPRIKA_GALLERY_TEMPO_URL for the local synthetic gallery")
	}
	endpoint, err := url.Parse(address)
	require.NoError(t, err)
	require.Equal(t, "http", endpoint.Scheme)
	require.Equal(t, "127.0.0.1", endpoint.Hostname())
	require.Empty(t, endpoint.User)
	require.Empty(t, endpoint.RawQuery)
	result, err := New().Query(context.Background(), connector.QueryRequest{Signal: connector.SignalTraces, Query: `{ resource.service.name = "checkout" }`, Limit: 100, Config: endpointConfig(t, address)})
	require.NoError(t, err)
	require.Equal(t, connector.StateOK, result.State)
	var body struct {
		Traces    []json.RawMessage `json:"traces"`
		Truncated bool              `json:"truncated"`
	}
	require.NoError(t, json.Unmarshal(result.Data, &body))
	require.Len(t, body.Traces, 100)
	require.True(t, body.Truncated)
}
