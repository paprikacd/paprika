package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/protobuf/types/known/durationpb"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
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

func TestToolErrorResultShowsBoundedIssuesAndRetryDelay(t *testing.T) {
	findings := make([]*insightsv1.CheckFinding, 0, 40)
	for i := range 40 {
		findings = append(findings, &insightsv1.CheckFinding{
			RuleId: "schema.widget.layout", Severity: insightsv1.Severity_SEVERITY_ERROR, Source: insightsv1.Source_SOURCE_SCHEMA,
			WidgetId: fmt.Sprintf("w%02d", i), Pointer: fmt.Sprintf("/widgets/%d/layout", i),
			Message: "widget layout is outside the dashboard grid", Fix: "Keep x + w at most 12.",
		})
	}
	issue := connect.NewError(connect.CodeInvalidArgument, errors.New("widget layout is outside the dashboard grid"))
	detail, err := connect.NewErrorDetail(&insightsv1.CheckReport{Findings: findings, Total: 40, Truncated: true})
	require.NoError(t, err)
	issue.AddDetail(detail)
	result := toolErrorResult(fmt.Errorf("insights: %w", issue))
	require.NotNil(t, result)
	require.True(t, result.IsError)
	text, ok := result.Content[0].(*sdkmcp.TextContent)
	require.True(t, ok)
	assert.Contains(t, text.Text, "widget layout is outside the dashboard grid")
	assert.Contains(t, text.Text, "Issues (32 of 40 shown):")
	assert.Contains(t, text.Text, "- /widgets/0/layout (widget w00): widget layout is outside the dashboard grid Fix: Keep x + w at most 12.")
	assert.NotContains(t, text.Text, "/widgets/32/layout")
	structured, err := json.Marshal(result.StructuredContent)
	require.NoError(t, err)
	var body struct {
		Error struct {
			Code      string            `json:"code"`
			Issues    []json.RawMessage `json:"issues"`
			Total     uint32            `json:"total"`
			Truncated bool              `json:"truncated"`
		} `json:"error"`
	}
	require.NoError(t, json.Unmarshal(structured, &body))
	assert.Equal(t, "invalid_argument", body.Error.Code)
	assert.Len(t, body.Error.Issues, 32)
	assert.Equal(t, uint32(40), body.Error.Total)
	assert.True(t, body.Error.Truncated)
	assert.Contains(t, string(body.Error.Issues[0]), `"pointer":"/widgets/0/layout"`)

	retry := connect.NewError(connect.CodeResourceExhausted, errors.New("private capacity detail"))
	retryDetail, err := connect.NewErrorDetail(&errdetails.RetryInfo{RetryDelay: durationpb.New(2 * time.Second)})
	require.NoError(t, err)
	retry.AddDetail(retryDetail)
	result = toolErrorResult(retry)
	require.NotNil(t, result)
	text, ok = result.Content[0].(*sdkmcp.TextContent)
	require.True(t, ok)
	assert.Equal(t, "tool execution capacity is exhausted; retry later Retry after 2 s.", text.Text)
	assert.NotContains(t, text.Text, "private")
	structured, err = json.Marshal(result.StructuredContent)
	require.NoError(t, err)
	assert.JSONEq(t, `{"error":{"code":"resource_exhausted","retry_after_seconds":2}}`, string(structured))
}
