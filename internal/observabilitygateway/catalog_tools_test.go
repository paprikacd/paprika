package observabilitygateway

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"connectrpc.com/connect"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/observabilitygateway/catalog"
	"github.com/benebsworth/paprika/internal/observabilitygateway/connector"
)

func TestListProviderTypesTool(t *testing.T) {
	t.Parallel()

	reg := newRegisteredTools(t, &fakeBackend{})

	out, err := invokeTool(t, reg, "list_provider_types", "")
	require.NoError(t, err)

	m, ok := out.(map[string]any)
	require.True(t, ok, "response is a map, got %T", out)
	types, ok := m["types"].([]catalog.TypeSummary)
	require.True(t, ok, "types is a []catalog.TypeSummary, got %T", m["types"])
	require.Len(t, types, 13)
	// The catalog's deterministic order is Vendor then DisplayName.
	assert.Equal(t, connector.ProviderAWSCloudTrail, types[0].Type)
	requireObservedAt(t, out)
}

func TestDescribeProviderTypeTool(t *testing.T) {
	t.Parallel()

	reg := newRegisteredTools(t, &fakeBackend{})

	t.Run("happy path round trips the catalog entry", func(t *testing.T) {
		out, err := invokeTool(t, reg, "describe_provider_type", `{"type":"loki"}`)
		require.NoError(t, err)
		info, ok := out.(catalog.TypeInfo)
		require.True(t, ok, "response is a catalog.TypeInfo, got %T", out)
		assert.Equal(t, connector.ProviderLoki, info.Type)
		assert.Equal(t, "Grafana Loki", info.DisplayName)
		assert.NotEmpty(t, info.ConfigFields)
		assert.NotEmpty(t, info.Steps)
		assert.Equal(t, connector.SignalLogs, info.Probe.Signal)
	})

	t.Run("unknown type becomes a connect NotFound", func(t *testing.T) {
		_, err := invokeTool(t, reg, "describe_provider_type", `{"type":"nope"}`)
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
		assert.Contains(t, err.Error(), `"nope" is not in the catalog`)
	})

	t.Run("missing type argument", func(t *testing.T) {
		_, err := invokeTool(t, reg, "describe_provider_type", `{}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})
}

func TestValidateProviderTool(t *testing.T) {
	t.Parallel()

	reg := newRegisteredTools(t, &fakeBackend{})

	t.Run("reachable backend answers state OK", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprint(w, `{"status":"success","data":{"result":[]}}`)
		}))
		t.Cleanup(server.Close)

		out, err := invokeTool(t, reg, "validate_provider",
			fmt.Sprintf(`{"type":"loki","config":{"endpoint":%q}}`, server.URL))
		require.NoError(t, err)
		res, ok := out.(validateToolResult)
		require.True(t, ok, "response is a validateToolResult, got %T", out)
		assert.Equal(t, connector.ProviderLoki, res.Type)
		assert.Equal(t, connector.StateOK, res.State)
		assert.Empty(t, res.Reason)
		require.NotEmpty(t, res.ObservedAt)
	})

	t.Run("unknown type becomes a connect NotFound", func(t *testing.T) {
		_, err := invokeTool(t, reg, "validate_provider", `{"type":"nope","config":{}}`)
		require.Equal(t, connect.CodeNotFound, connect.CodeOf(err))
	})

	t.Run("config that is not an object becomes InvalidArgument", func(t *testing.T) {
		_, err := invokeTool(t, reg, "validate_provider", `{"type":"loki","config":"endpoint"}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})

	t.Run("missing type argument", func(t *testing.T) {
		_, err := invokeTool(t, reg, "validate_provider", `{"config":{}}`)
		require.Equal(t, connect.CodeInvalidArgument, connect.CodeOf(err))
	})
}
