package mcp

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestToolResultCarriesPayloadTwice(t *testing.T) {
	t.Parallel()

	result, err := toolResult(map[string]any{"state": "OK", "data": map[string]any{"a": 1}})
	require.NoError(t, err)
	require.Len(t, result.Content, 1)
	text, ok := result.Content[0].(*sdkmcp.TextContent)
	require.True(t, ok, "content should be a TextContent, got %T", result.Content[0])
	structured, ok := result.StructuredContent.(json.RawMessage)
	require.True(t, ok, "structuredContent should be a json.RawMessage, got %T", result.StructuredContent)
	assert.JSONEq(t, `{"state":"OK","data":{"a":1}}`, text.Text)
	assert.JSONEq(t, string(text.Text), string(structured))
}

func TestPreviewToolResultTruncatesOnlyTheText(t *testing.T) {
	t.Parallel()

	payload := map[string]any{"state": "OK", "data": strings.Repeat("x", 64<<10)}
	full, err := json.Marshal(payload)
	require.NoError(t, err)

	result, err := PreviewToolResult(payload, 16<<10)
	require.NoError(t, err)

	// structuredContent stays verbatim.
	structured, ok := result.StructuredContent.(json.RawMessage)
	require.True(t, ok, "structuredContent should be a json.RawMessage, got %T", result.StructuredContent)
	assert.Equal(t, json.RawMessage(full), structured)

	// The text rendering caps at the preview budget and marks the cut.
	text, ok := result.Content[0].(*sdkmcp.TextContent)
	require.True(t, ok, "content should be a TextContent, got %T", result.Content[0])
	assert.Len(t, text.Text, 16<<10+len(" … truncated "+strconv.Itoa(len(full)-(16<<10))+" bytes; the full payload is in structuredContent"))
	assert.Contains(t, text.Text, "truncated")
	assert.False(t, json.Valid([]byte(text.Text)), "a truncated preview is not parseable JSON — the marker says so")
}

func TestPreviewToolResultSmallPayloadPassesThrough(t *testing.T) {
	t.Parallel()

	result, err := PreviewToolResult(map[string]any{"state": "OK"}, 16<<10)
	require.NoError(t, err)
	text, ok := result.Content[0].(*sdkmcp.TextContent)
	require.True(t, ok)
	structured, ok := result.StructuredContent.(json.RawMessage)
	require.True(t, ok)
	assert.JSONEq(t, `{"state":"OK"}`, text.Text)
	assert.JSONEq(t, string(text.Text), string(structured))
}
