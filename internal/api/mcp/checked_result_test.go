package mcp

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"connectrpc.com/connect"
	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

func structuredOf(t *testing.T, res *sdkmcp.CallToolResult) json.RawMessage {
	t.Helper()
	raw, ok := res.StructuredContent.(json.RawMessage)
	require.True(t, ok)
	return raw
}

func contentText(t *testing.T, content sdkmcp.Content) string {
	t.Helper()
	text, ok := content.(*sdkmcp.TextContent)
	require.True(t, ok)
	return text.Text
}

func TestCheckedWriteResultPutsStructuredJSONFirst(t *testing.T) {
	report := &insightsv1.CheckReport{WarningCount: 1, Total: 1, Issues: []*insightsv1.CheckFinding{{RuleId: "stat.density", Severity: insightsv1.Severity_SEVERITY_WARNING, WidgetId: "compact", Pointer: "/widgets/0/options/showStatBar", Message: "is at most two rows tall"}}}
	payload := map[string]any{"document": json.RawMessage(`{"id":"d"}`), "etag": `"e"`}
	res, err := CheckedResult(payload, report)
	require.NoError(t, err)
	require.Len(t, res.Content, 2)

	// content[0] is the structured content, so a client that drops
	// structuredContent can still parse the first text block.
	require.JSONEq(t, string(structuredOf(t, res)), contentText(t, res.Content[0]))
	var structured map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(structuredOf(t, res), &structured))
	require.JSONEq(t, `{"id":"d"}`, string(structured["document"]))
	require.Contains(t, structured, "checks", "checks sits beside the document")
	require.NotContains(t, string(structured["document"]), "checks")

	verdict := contentText(t, res.Content[1])
	require.True(t, strings.HasPrefix(verdict, "Checks: 0 errors, 1 warning\n"), verdict)
	require.Contains(t, verdict, "- warning /widgets/0/options/showStatBar (widget compact): is at most two rows tall")
}

func TestCheckedResultWithoutAReportKeepsThePlainPayload(t *testing.T) {
	res, err := CheckedResult(map[string]any{"document": json.RawMessage(`{"id":"d"}`)}, nil)
	require.NoError(t, err)
	require.Len(t, res.Content, 1)
	require.NotContains(t, string(structuredOf(t, res)), "checks")
}

func TestOversizeDocumentIsInvalidArgumentNotCapacity(t *testing.T) {
	// A retry cannot shrink the document, so the agent must read a fault in its
	// input, not "capacity is exhausted; retry later".
	res := toolErrorResult(connect.NewError(connect.CodeInvalidArgument, errors.New("dashboard document exceeds 256 KiB")))
	require.NotNil(t, res)
	require.True(t, res.IsError)
	text := contentText(t, res.Content[0])
	require.Contains(t, text, "dashboard document exceeds 256 KiB")
	require.NotContains(t, strings.ToLower(text), "retry")
	require.NotContains(t, strings.ToLower(text), "capacity")
}
