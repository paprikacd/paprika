package insights

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// Sharma, Wu and Dalal (2005) CIEDE2000 test pairs, as L*a*b* values.
func TestDeltaE2000MatchesReferencePairs(t *testing.T) {
	reference := lab{l: 50, a: 0, b: -82.7485}
	for _, pair := range []struct {
		name string
		p    lab
		want float64
	}{
		{"pair 1", lab{50, 2.6772, -79.7751}, 2.0425},
		{"pair 2", lab{50, 3.1571, -77.2803}, 2.8615},
		{"pair 3", lab{50, 2.8361, -74.0200}, 3.4412},
		{"pair 4", lab{50, -1.3802, -84.2814}, 1.0000},
	} {
		if got := deltaE2000(pair.p, reference); got < pair.want-0.001 || got > pair.want+0.001 {
			t.Errorf("%s: deltaE2000 = %.4f, want %.4f", pair.name, got, pair.want)
		}
	}
	if got := deltaE2000(srgbToLab([3]float64{10, 120, 200}), srgbToLab([3]float64{10, 120, 200})); got != 0 {
		t.Fatalf("identical colours have distance %v, want 0", got)
	}
}

// The marks are mirrored from docs/design/insights/status-tokens.json, which the UI
// keeps equal to the Gamma CSS. This test keeps the Go copy equal to the file.
func TestStatusMarksMirrorStatusTokens(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "docs", "design", "insights", "status-tokens.json"))
	if err != nil {
		t.Fatal(err)
	}
	var tokens struct {
		Blocks map[string]map[string]string `json:"blocks"`
	}
	if err := json.Unmarshal(data, &tokens); err != nil {
		t.Fatal(err)
	}
	if len(statusMarks) != 15 {
		t.Fatalf("status marks = %d, want 5 levels in 3 themes", len(statusMarks))
	}
	for _, mark := range statusMarks {
		block, ok := tokens.Blocks[mark.theme]
		if !ok {
			t.Fatalf("status-tokens.json has no %s block", mark.theme)
		}
		if got := block["--gamma-status-"+mark.level]; got != mark.hex {
			t.Errorf("%s %s mark = %s in status-tokens.json, lint has %s", mark.theme, mark.level, got, mark.hex)
		}
	}
}

func colourFinding(t *testing.T, widgets ...string) []*insightsv1.CheckFinding {
	t.Helper()
	return lintFor(t, documentWithWidgets("colour-check", widgets...))
}

func TestNearStatusColourWarnsOnBareHexNearAStatus(t *testing.T) {
	// #4b9865 is one step from the light ok mark; #7f0a13 is the light critical mark.
	findings := colourFinding(t,
		widgetJSON("threshold-hex", "", `"options":{"thresholds":[{"value":0,"color":"#4b9865"}]}`),
		widgetJSON("reference-hex", "", `"options":{"referenceLines":[{"value":5,"color":"#7f0a13"}]}`),
		widgetJSON("series-hex", "", `"options":{"seriesColors":[{"label":"status","value":"ok","color":"#3f72b5"}]}`),
		widgetJSON("widget-hex", "", `"color":"#986112"`),
	)
	for _, pointer := range []string{
		"/widgets/0/options/thresholds/0/color",
		"/widgets/1/options/referenceLines/0/color",
		"/widgets/2/options/seriesColors/0/color",
		"/widgets/3/color",
	} {
		finding := requireOneHitAmong(t, findings, "color.near-status", pointer)
		if finding.GetSeverity() != insightsv1.Severity_SEVERITY_WARNING {
			t.Fatalf("%s severity = %v, want warning", pointer, finding.GetSeverity())
		}
	}
	if msg := requireOneHitAmong(t, findings, "color.near-status", "/widgets/0/options/thresholds/0/color").GetMessage(); !strings.Contains(msg, "ok status colour") || !strings.Contains(msg, "dE2000") {
		t.Fatalf("message %q does not name the status and distance", msg)
	}
}

func TestNearStatusColourAcceptsStatusesRolesAndDistantHues(t *testing.T) {
	findings := colourFinding(t,
		// A status names the band; a hex beside it is a hue override, not a bare colour.
		widgetJSON("status-with-override", "", `"options":{"thresholds":[{"value":0,"status":"ok","color":"#4b9865"}]}`),
		// A role names the series colour, so no hex is authored.
		widgetJSON("role-series", "", `"options":{"seriesColors":[{"label":"status_class","value":"5xx","role":"server-error"}]}`),
		// Blue-violet and magenta are well outside every status mark.
		widgetJSON("distant", "", `"color":"#8e44ad","options":{"thresholds":[{"value":0,"color":"#c2185b"}]}`),
	)
	requireNoHits(t, findings, "color.near-status")
}

// Status-badge mapping colours are the status display itself, so they are not bare colours until a
// mapping can name a status. A series rule in plugin config is still checked.
func TestNearStatusColourSkipsStatusBadgeMappingsButChecksSeriesRules(t *testing.T) {
	findings := colourFinding(t,
		pluginTestWidget("records", "record-table", `"dataKind":"records","config":{"cellStyles":[{"column":"status","display":"status-badge","mappings":[{"value":"Down","color":"#7f0a14"}]}],"seriesColors":[{"label":"status","value":"down","color":"#7f0a14"}]}`),
	)
	requireOneHitAmong(t, findings, "color.near-status", "/widgets/0/config/seriesColors/0/color")
	if count := countRule(findings, "color.near-status"); count != 1 {
		t.Fatalf("color.near-status hits = %d, want only the series rule", count)
	}
}

// requireOneHitAmong is requireOneHit for a rule that fires on several widgets of one document.
func requireOneHitAmong(t *testing.T, findings []*insightsv1.CheckFinding, ruleID, pointer string) *insightsv1.CheckFinding {
	t.Helper()
	for _, finding := range findings {
		if finding.GetRuleId() == ruleID && finding.GetPointer() == pointer {
			return finding
		}
	}
	t.Fatalf("no %s finding at %s; findings = %v", ruleID, pointer, findings)
	return nil
}

func countRule(findings []*insightsv1.CheckFinding, ruleID string) int {
	count := 0
	for _, finding := range findings {
		if finding.GetRuleId() == ruleID {
			count++
		}
	}
	return count
}
