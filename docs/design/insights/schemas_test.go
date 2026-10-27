package insightsschema

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDocumentUsesPublishedArtifactsAndRetainsLocalReferences(t *testing.T) {
	for kind, filename := range map[string]string{"dashboard": "dashboard.schema.json", "saved_query": "saved-query.schema.json"} {
		t.Run(kind, func(t *testing.T) {
			published, err := os.ReadFile(filename) //nolint:gosec // Filenames come only from the two fixed canonical artifact paths above.
			require.NoError(t, err)
			actual, err := Document(kind)
			require.NoError(t, err)
			require.JSONEq(t, string(published), string(actual))
			assertSchemaReferences(t, actual)
			actual[0] = '!'
			unchanged, err := Document(kind)
			require.NoError(t, err)
			require.JSONEq(t, string(published), string(unchanged), "callers must not mutate the embedded contract")
		})
	}

	var dashboard map[string]any
	require.NoError(t, json.Unmarshal(dashboardSchema, &dashboard))
	properties, ok := dashboard["properties"].(map[string]any)
	require.True(t, ok)
	widgets, ok := properties["widgets"].(map[string]any)
	require.True(t, ok)
	widget, ok := widgets["items"].(map[string]any)
	require.True(t, ok)
	for _, key := range []string{"$schema", "$defs", "$comment"} {
		widget[key] = dashboard[key]
	}
	expected, err := json.Marshal(widget)
	require.NoError(t, err)
	actual, err := Document("widget")
	require.NoError(t, err)
	require.JSONEq(t, string(expected), string(actual))
	assertSchemaReferences(t, actual)
	_, err = Document("../dashboard")
	require.ErrorIs(t, err, ErrUnknownKind)
}

func assertSchemaReferences(t *testing.T, raw json.RawMessage) {
	t.Helper()
	var root map[string]any
	require.NoError(t, json.Unmarshal(raw, &root))
	require.NotEmpty(t, root["$schema"])
	var visit func(any)
	visit = func(value any) {
		switch node := value.(type) {
		case map[string]any:
			if reference, ok := node["$ref"].(string); ok {
				require.True(t, strings.HasPrefix(reference, "#/"), "unexpected external reference %q", reference)
				var target any = root
				for _, segment := range strings.Split(strings.TrimPrefix(reference, "#/"), "/") {
					object, ok := target.(map[string]any)
					require.True(t, ok, "unresolved reference %q", reference)
					target, ok = object[strings.ReplaceAll(strings.ReplaceAll(segment, "~1", "/"), "~0", "~")]
					require.True(t, ok, "unresolved reference %q", reference)
				}
			}
			for _, child := range node {
				visit(child)
			}
		case []any:
			for _, child := range node {
				visit(child)
			}
		}
	}
	visit(root)
}
