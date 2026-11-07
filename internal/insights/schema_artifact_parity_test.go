package insights

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"

	insightsschema "github.com/benebsworth/paprika/docs/design/insights"
)

// Validate the embedded artifacts themselves, including constraints that the
// Zod exporter cannot express, and the separately published widget schema.
func TestPublishedWidgetLayoutAndAnnotationSchema(t *testing.T) {
	for _, kind := range []string{"dashboard", "widget"} {
		t.Run(kind, func(t *testing.T) {
			source, err := insightsschema.Document(kind)
			require.NoError(t, err)
			var raw any
			require.NoError(t, json.Unmarshal(source, &raw))
			compiler := jsonschema.NewCompiler()
			url := fmt.Sprintf("https://example.test/%s.schema.json", kind)
			require.NoError(t, compiler.AddResource(url, raw))
			schema, err := compiler.Compile(url)
			require.NoError(t, err)
			layout := map[string]any{"x": 0, "y": 0, "w": 4, "h": 1}
			widget := map[string]any{
				"id": "sample", "title": "Sample", "type": "stat", "providerId": "prom", "query": "up", "unit": "",
				"layout": layout,
			}
			doc := func() any {
				if kind == "widget" {
					return widget
				}
				return map[string]any{"schemaVersion": 1, "id": "example", "title": "Example", "timeRange": "1h", "refreshInterval": 0, "widgets": []any{widget}}
			}
			require.NoError(t, schema.Validate(doc()), "stat widgets may use one row")
			options := map[string]any{"showStatBar": true}
			widget["options"] = options
			require.Error(t, schema.Validate(doc()), "stat bar must require both bounds")
			options["min"] = 0
			options["max"] = 100
			require.NoError(t, schema.Validate(doc()), "stat bar with an explicit scale must be published")
			delete(widget, "options")
			for _, visual := range []string{"timeseries", "bar", "table", "traces", "heatmap", "plugin"} {
				widget["type"] = visual
				if visual == "plugin" {
					widget["pluginId"] = "custom"
					widget["dataKind"] = "metrics"
				}
				require.Error(t, schema.Validate(doc()), "%s must reject one row", visual)
				layout["h"] = 2
				require.NoError(t, schema.Validate(doc()), "%s must accept two rows", visual)
				layout["h"] = 1
				delete(widget, "pluginId")
				delete(widget, "dataKind")
			}
			widget["type"] = "timeseries"
			layout["h"] = 2
			annotation := map[string]any{"queryRef": map[string]any{"id": "events"}, "timestampColumn": "start", "endColumn": "end", "labelColumn": "event"}
			widget["annotationSource"] = annotation
			require.NoError(t, schema.Validate(doc()), "an interval end column must be published")
			for _, invalid := range []any{"", strings.Repeat("x", 129), 123, nil} {
				annotation["endColumn"] = invalid
				require.Error(t, schema.Validate(doc()), "invalid end column must be rejected")
			}
			delete(annotation, "endColumn")
			require.NoError(t, schema.Validate(doc()), "end column is optional")
		})
	}
}
