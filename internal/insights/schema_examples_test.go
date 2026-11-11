package insights

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/insights/guidance"
)

// servedStatWidgets returns every stat widget the schema endpoint serves, from
// both the widget and dashboard examples, so the rule covers all of them.
func servedStatWidgets(t *testing.T) []json.RawMessage {
	t.Helper()
	widgets := append([]json.RawMessage{}, authoringSchemaExamples("widget")...)
	var dashboard struct {
		Widgets []json.RawMessage `json:"widgets"`
	}
	require.NoError(t, json.Unmarshal(authoringSchemaExample("dashboard"), &dashboard))
	widgets = append(widgets, dashboard.Widgets...)
	var stats []json.RawMessage
	for _, raw := range widgets {
		var widget struct {
			Type string `json:"type"`
		}
		require.NoError(t, json.Unmarshal(raw, &widget))
		if widget.Type == "stat" {
			stats = append(stats, raw)
		}
	}
	return stats
}

// TestServedStatExamplesFollowCompactStatRule asserts the R49 rule directly,
// because no Lint() exists yet: a compact stat (h<=2) never shows a value bar,
// a value bar requires explicit min and max, and every example still passes
// the existing validator.
func TestServedStatExamplesFollowCompactStatRule(t *testing.T) {
	var compact, bounded int
	for _, raw := range servedStatWidgets(t) {
		var widget struct {
			ID     string `json:"id"`
			Layout struct {
				H int `json:"h"`
			} `json:"layout"`
			Options map[string]json.RawMessage `json:"options"`
		}
		require.NoError(t, json.Unmarshal(raw, &widget))
		require.NoError(t, validateDashboardWidgetShape(raw), widget.ID)
		var showBar bool
		if value, ok := widget.Options["showStatBar"]; ok {
			require.NoError(t, json.Unmarshal(value, &showBar), widget.ID)
		}
		if widget.Layout.H <= 2 {
			require.False(t, showBar, "%s: compact stat (h<=2) must not show showStatBar", widget.ID)
			compact++
		}
		if showBar {
			require.GreaterOrEqual(t, widget.Layout.H, 3, "%s: showStatBar requires h>=3", widget.ID)
			require.Contains(t, widget.Options, "min", "%s: showStatBar requires min", widget.ID)
			require.Contains(t, widget.Options, "max", "%s: showStatBar requires max", widget.ID)
			bounded++
		}
	}
	require.Positive(t, compact, "the examples must include a compact stat")
	require.Positive(t, bounded, "the examples must include one labelled bounded-scale stat")
}

func TestServedDashboardExampleIsValidAndCompact(t *testing.T) {
	dashboard := authoringSchemaExample("dashboard")
	require.NoError(t, validateDashboard("service-overview", dashboard))
	var document struct {
		Widgets []struct {
			Layout struct {
				H int `json:"h"`
			} `json:"layout"`
			Options map[string]json.RawMessage `json:"options"`
		} `json:"widgets"`
	}
	require.NoError(t, json.Unmarshal(dashboard, &document))
	require.NotEmpty(t, document.Widgets)
	for _, widget := range document.Widgets {
		require.Equal(t, 2, widget.Layout.H, "the dashboard example stays a compact stat")
		require.NotContains(t, widget.Options, "showStatBar")
	}
}

func TestAuthoringSchemaNotesCarryStatAndCompositionGuidance(t *testing.T) {
	s, _ := testService(t)
	for _, kind := range []string{"dashboard", "widget"} {
		t.Run(kind, func(t *testing.T) {
			w := request(t, s.Handler(), http.MethodGet, "/api/schemas/"+kind, nil, nil)
			require.Equal(t, http.StatusOK, w.Code, w.Body.String())
			var response authoringSchemaResponse
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &response))
			notes := strings.Join(response.Notes, "\n")
			require.Contains(t, notes, "Compact stat (h<=2) = title + value + at most one sparkline; showStatBar only for a bounded scale with explicit min and max and h>=3.")
			for _, line := range guidance.DashboardAuthoring() {
				require.Contains(t, response.Notes, line, "every authoring surface must carry the composition rule")
			}
		})
	}
	w := request(t, s.Handler(), http.MethodGet, "/api/schemas/saved_query", nil, nil)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), "Compact stat cards", "saved queries have no dashboard composition")
}
