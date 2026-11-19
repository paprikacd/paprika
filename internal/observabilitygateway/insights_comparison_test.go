package observabilitygateway

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	sdkmcp "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/require"

	"github.com/benebsworth/paprika/internal/api/auth"
)

// The display rule decides "≈0" the way the UI does, so a change that rounds to nothing never reads as a direction.
func TestSettleDashboardComparisonsReadsARoundedChangeAsUnchanged(t *testing.T) {
	// Each widget shows a displayed sample of 100 unless it says otherwise, so Auto noise is judged against 100.
	cases := map[string]struct {
		widget     string
		comparison string
		want       string
	}{
		"float noise in Auto": {`"unit":"req/s"`,
			`"delta":4e-17,"percent":1.3e-14,"changeUnit":"req/s","direction":"up","assessment":"worse"`, "flat"},
		"rounds to nothing at explicit decimals": {`"unit":"req/s","decimals":1`,
			`"delta":0.001,"percent":0.001,"changeUnit":"req/s","direction":"up","assessment":"worse"`, "flat"},
		"a real change at explicit decimals": {`"unit":"req/s","decimals":1`,
			`"delta":0.06,"percent":12,"changeUnit":"req/s","direction":"up"`, "up"},
		// 0.4 MiB rounds to zero MiB, but the UI shows it in KiB (419 KiB), so it is a change and keeps its direction.
		"a change that scales to a smaller unit": {`"unit":"MiB","decimals":0`,
			`"delta":0.4,"changeUnit":"MiB","direction":"down"`, "down"},
		"a percentage widget in points": {`"unit":"%"`,
			`"delta":0.0000001,"percent":0.0000002,"changeUnit":"pp","direction":"up","assessment":"worse"`, "flat"},
		// The percentage widget's points round to nothing at one decimal, though its relative percent is large.
		"a percentage widget's points at explicit decimals": {`"unit":"%","decimals":1`,
			`"delta":0.04,"percent":40,"changeUnit":"pp","direction":"up"`, "flat"},
		// Below the Auto noise floor (1 part in 2,000 of 100), but explicit decimals show it, so it keeps its direction.
		"a change below the Auto noise floor at explicit decimals": {`"unit":"req/s","decimals":4`,
			`"delta":0.0004,"percent":0.0004,"changeUnit":"req/s","direction":"up"`, "up"},
		"a relative change the author can read": {`"unit":"req/s"`,
			`"delta":12,"percent":12,"changeUnit":"req/s","direction":"up","assessment":"better"`, "up"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			body := `{"schemaVersion":1,"widgets":[{"id":"rate",` + tc.widget + `,"comparison":{"state":"ok","current":{"timestamp":1,"value":100},` + tc.comparison + `}}],"signals":[]}`
			var got struct {
				Widgets []struct {
					Comparison comparisonDisplay `json:"comparison"`
				} `json:"widgets"`
			}
			if err := json.Unmarshal(settleDashboardComparisons(json.RawMessage(body)), &got); err != nil {
				t.Fatal(err)
			}
			if direction := got.Widgets[0].Comparison.Direction; direction != tc.want {
				t.Fatalf("direction = %q, want %q", direction, tc.want)
			}
		})
	}
}

// A flat change with a declared direction is unchanged, and the settle keeps the backend's other fields.
func TestSettleDashboardComparisonsKeepsTheOtherFields(t *testing.T) {
	body := json.RawMessage(`{"schemaVersion":1,"widgets":[{"id":"rate","unit":"req/s","comparison":{"state":"ok","window":"previous","offsetSeconds":3600,"current":{"timestamp":1,"value":100},"baseline":{"timestamp":0,"value":99.99999999},"delta":1e-9,"changeUnit":"req/s","direction":"up","assessment":"worse"}}],"signals":[]}`)
	settled := settleDashboardComparisons(body)
	var got map[string]json.RawMessage
	if err := json.Unmarshal(settled, &got); err != nil {
		t.Fatal(err)
	}
	var widgets []struct {
		Comparison map[string]json.RawMessage `json:"comparison"`
	}
	if err := json.Unmarshal(got["widgets"], &widgets); err != nil {
		t.Fatal(err)
	}
	comparison := widgets[0].Comparison
	if string(comparison["direction"]) != `"flat"` || string(comparison["assessment"]) != `"unchanged"` || string(comparison["window"]) != `"previous"` || comparison["baseline"] == nil || string(comparison["delta"]) != "1e-9" {
		t.Fatalf("settled comparison: %v", comparison)
	}
	if _, ok := got["signals"]; !ok {
		t.Fatal("the rest of the body must be kept")
	}
}

// A body that is not a dashboard summary, or a comparison with no displayed sample, is returned as the backend wrote it.
func TestSettleDashboardComparisonsLeavesOtherBodiesAlone(t *testing.T) {
	for _, body := range []string{`not json`, `{"widgets":[]}`, `{"widgets":[{"id":"rate","comparison":{"state":"unavailable","direction":"up","delta":1e-17}}]}`} {
		if got := settleDashboardComparisons(json.RawMessage(body)); string(got) != body {
			t.Fatalf("body changed: %s -> %s", body, got)
		}
	}
}

func TestDashboardComparisonDurationPhrase(t *testing.T) {
	for seconds, want := range map[float64]string{3600: "1 h", 86400: "1 d", 604800: "7 d", 900: "15 min", 45: "45 s", 5400: "1.5 h"} {
		if got := comparisonDurationPhrase(seconds); got != want {
			t.Fatalf("%v seconds = %q, want %q", seconds, got, want)
		}
	}
}

// The text names a change as the UI does: "≈0" with no sign when it rounds to nothing.
func TestDashboardQueryTextReadsARoundedChangeAsApproximatelyZero(t *testing.T) {
	summary := `{"schemaVersion":1,"dashboard":{"id":"overview","etag":"e"},"signals":[],"widgets":[` +
		`{"id":"rate","title":"Rate","type":"stat","unit":"req/s","comparison":{"state":"ok","window":"previous","offsetSeconds":3600,"delta":4e-17,"percent":1.3e-14,"changeUnit":"req/s","direction":"flat","assessment":"unchanged"}}` +
		`],"queryCount":{"planned":0,"executed":0,"deduplicated":0}}`
	text, err := dashboardQueryText(json.RawMessage(summary))
	if err != nil {
		t.Fatal(err)
	}
	want := `widget "rate": change vs 1 h earlier: state="ok" delta=≈0 req/s percent=≈0% direction=flat assessment=unchanged`
	if !strings.Contains(text, want) {
		t.Fatalf("text lacks %q:\n%s", want, text)
	}
}

// The query_dashboard tool settles a flat change in its structured output and its text together, whatever the backend said.
func TestQueryDashboardToolSettlesARoundedComparison(t *testing.T) {
	backend := `{"schemaVersion":1,"dashboard":{"id":"overview","etag":"e"},"signals":[],"state":"ok","widgets":[` +
		`{"id":"rate","title":"Rate","type":"stat","unit":"req/s","comparison":{"state":"ok","window":"previous","offsetSeconds":3600,"current":{"timestamp":1,"value":100},"delta":4e-17,"percent":1.3e-14,"changeUnit":"req/s","direction":"up","assessment":"worse"}}` +
		`],"queryCount":{"planned":0,"executed":0,"deduplicated":0}}`
	c, _ := newDashboardQueryClient(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, backend)
	}))
	principal := &auth.Principal{Subject: "human", Groups: []string{"readers"}, Scopes: []string{"paprika:observe"}}
	result, err := insightsQueryDashboardTool(c).Invoke(auth.WithPrincipal(t.Context(), principal), nil, json.RawMessage(`{"id":"overview"}`))
	require.NoError(t, err)
	wire, ok := result.(*sdkmcp.CallToolResult)
	require.True(t, ok)
	structured, ok := wire.StructuredContent.(json.RawMessage)
	require.True(t, ok)
	var got struct {
		Widgets []struct {
			Comparison comparisonDisplay `json:"comparison"`
		} `json:"widgets"`
	}
	require.NoError(t, json.Unmarshal(structured, &got))
	require.Equal(t, "flat", got.Widgets[0].Comparison.Direction)
	require.NotNil(t, got.Widgets[0].Comparison.Assessment)
	require.Equal(t, "unchanged", *got.Widgets[0].Comparison.Assessment)
	content, ok := wire.Content[0].(*sdkmcp.TextContent)
	require.True(t, ok)
	require.Contains(t, content.Text, `direction=flat assessment=unchanged`)
}
