package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestToolDomainErrorsExposeOnlyFixedMachineCodes(t *testing.T) {
	for _, code := range []connect.Code{
		connect.CodeNotFound, connect.CodeInvalidArgument, connect.CodePermissionDenied,
		connect.CodeAlreadyExists, connect.CodeAborted, connect.CodeFailedPrecondition,
		connect.CodeResourceExhausted, connect.CodeDeadlineExceeded, connect.CodeCanceled, connect.CodeUnauthenticated,
	} {
		t.Run(code.String(), func(t *testing.T) {
			original := "private upstream diagnostics"
			result := toolErrorResult(fmt.Errorf("provider: %w", connect.NewError(code, errors.New(original))))
			require.NotNil(t, result)
			assert.True(t, result.IsError)
			structured, err := json.Marshal(result.StructuredContent)
			require.NoError(t, err)
			assert.JSONEq(t, fmt.Sprintf(`{"error":{"code":%q}}`, code.String()), string(structured))
			assert.NotContains(t, string(structured), "private")
			require.Len(t, result.Content, 1)
			text, ok := result.Content[0].(*sdkmcp.TextContent)
			require.True(t, ok)
			if toolActionableCode(code) {
				assert.Equal(t, original, text.Text, "existing text clients retain the domain message")
			} else {
				assert.NotContains(t, text.Text, "private")
				assert.NotContains(t, text.Text, "password")
			}
		})
	}
	for _, err := range []error{context.Canceled, fmt.Errorf("provider timeout: %w", context.DeadlineExceeded)} {
		result := toolErrorResult(err)
		require.NotNil(t, result)
		assert.True(t, result.IsError)
	}
	require.Nil(t, toolErrorResult(connect.NewError(connect.CodeInternal, errors.New("secret"))))
	require.Nil(t, toolErrorResult(errors.New("unknown secret")))
}

func TestMapInvokeErrorPreservesOperationalCodeForMCPConsumers(t *testing.T) {
	server := newTestServer(t)
	result, err := server.mapInvokeError(t.Context(), "list_observability_providers", connect.NewError(connect.CodeResourceExhausted, errors.New("private resource diagnostics")))
	require.NoError(t, err)
	require.True(t, result.IsError)
	body, err := json.Marshal(result)
	require.NoError(t, err)
	assert.Contains(t, string(body), `"code":"resource_exhausted"`)
	assert.NotContains(t, string(body), "private resource diagnostics")
}
