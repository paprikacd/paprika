package observabilitygateway

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
)

// The MCP tool describes the dashboard contract in prose, which an agent reads. These checks hold that prose to the
// published dashboard schema, so an enumeration or a required field cannot drift in one copy only.
func TestDashboardDocumentSchemaRestatesThePublishedContract(t *testing.T) {
	raw, err := insightsschema.Document("dashboard")
	require.NoError(t, err)
	var published map[string]any
	require.NoError(t, json.Unmarshal(raw, &published))
	widget := nestedMap(t, published, "properties", "widgets", "items")
	options := nestedMap(t, widget, "properties", "options", "properties")

	var mcp struct {
		Description string   `json:"description"`
		Required    []string `json:"required"`
	}
	require.NoError(t, json.Unmarshal([]byte(dashboardDocumentSchema), &mcp))

	require.Equal(t, stringList(t, published["required"]), mcp.Required, "top-level required members")
	require.Equal(t, enumOf(t, nestedMap(t, published, "properties", "timeRange")), splitList(t, mcp.Description, `timeRange:([0-9a-z|]+);`, "|"), "timeRange")
	require.Equal(t, enumOf(t, nestedMap(t, widget, "properties", "type")), splitList(t, mcp.Description, `Types:([a-z,]+)\.`, ","), "widget types")
	require.Equal(t, enumOf(t, nestedMap(t, options, "sparklinePlacement")), splitList(t, mcp.Description, `sparklinePlacement \(([a-z ]+)\)`, " or "), "sparklinePlacement")
	require.Equal(t, enumOf(t, nestedMap(t, options, "statIcon")), splitList(t, strings.ReplaceAll(mcp.Description, " or ", ", "), `statIcon \(([a-z, -]+)\)`, ", "), "statIcon")
	require.Equal(t, stringList(t, widget["required"]), splitList(t, mcp.Description, `Each widget requires ([^.]+)\.`, ","), "widget required members")
}

// The MCP id schema and the published id rule accept the same ids: a letter or digit, then up to 79 letters, digits,
// underscores or hyphens. The published rule states the length as a maximum of 80.
func TestInsightsIDSchemaMatchesThePublishedIDRule(t *testing.T) {
	raw, err := insightsschema.Document("dashboard")
	require.NoError(t, err)
	var published map[string]any
	require.NoError(t, json.Unmarshal(raw, &published))
	id := nestedMap(t, published, "properties", "id")
	require.Equal(t, "^[a-zA-Z0-9][a-zA-Z0-9_-]*$", id["pattern"])
	require.Equal(t, float64(80), id["maxLength"])

	var mcp struct {
		Pattern string `json:"pattern"`
	}
	require.NoError(t, json.Unmarshal([]byte(insightsIDSchema), &mcp))
	require.Equal(t, "^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$", mcp.Pattern)
}

func nestedMap(t *testing.T, node map[string]any, path ...string) map[string]any {
	t.Helper()
	for _, key := range path {
		next, ok := node[key].(map[string]any)
		require.True(t, ok, "schema has no %q", key)
		node = next
	}
	return node
}

func stringList(t *testing.T, value any) []string {
	t.Helper()
	list, ok := value.([]any)
	require.True(t, ok, "expected a list, got %T", value)
	out := make([]string, 0, len(list))
	for _, item := range list {
		text, ok := item.(string)
		require.True(t, ok, "expected a string, got %T", item)
		out = append(out, text)
	}
	return out
}

func enumOf(t *testing.T, node map[string]any) []string {
	t.Helper()
	return stringList(t, node["enum"])
}

// splitList returns the first capture of pattern in text, split on separator. It fails when the pattern is absent.
func splitList(t *testing.T, text, pattern, separator string) []string {
	t.Helper()
	match := regexp.MustCompile(pattern).FindStringSubmatch(text)
	require.NotNil(t, match, "description has no %q", pattern)
	// A brace group such as layout{x,y,w,h} names a member's own fields, not further members of the list.
	captured := regexp.MustCompile(`\{[^}]*\}`).ReplaceAllString(match[1], "")
	parts := strings.Split(captured, separator)
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}
