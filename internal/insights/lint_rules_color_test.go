package insights

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// ciede2000Pairs are the 34 CIEDE2000 test pairs of Sharma, Wu and Dalal (2005), Table I: the L*a*b*
// values of each sample and the published delta E00. They verify the reference implementation below.
var ciede2000Pairs = []struct {
	pair int
	p, q lab
	want float64
}{
	{1, lab{50.0000, 2.6772, -79.7751}, lab{50.0000, 0.0000, -82.7485}, 2.0425},
	{2, lab{50.0000, 3.1571, -77.2803}, lab{50.0000, 0.0000, -82.7485}, 2.8615},
	{3, lab{50.0000, 2.8361, -74.0200}, lab{50.0000, 0.0000, -82.7485}, 3.4412},
	{4, lab{50.0000, -1.3802, -84.2814}, lab{50.0000, 0.0000, -82.7485}, 1.0000},
	{5, lab{50.0000, -1.1848, -84.8006}, lab{50.0000, 0.0000, -82.7485}, 1.0000},
	{6, lab{50.0000, -0.9009, -85.5211}, lab{50.0000, 0.0000, -82.7485}, 1.0000},
	{7, lab{50.0000, 0.0000, 0.0000}, lab{50.0000, -1.0000, 2.0000}, 2.3669},
	{8, lab{50.0000, -1.0000, 2.0000}, lab{50.0000, 0.0000, 0.0000}, 2.3669},
	{9, lab{50.0000, 2.4900, -0.0010}, lab{50.0000, -2.4900, 0.0009}, 7.1792},
	{10, lab{50.0000, 2.4900, -0.0010}, lab{50.0000, -2.4900, 0.0010}, 7.1792},
	{11, lab{50.0000, 2.4900, -0.0010}, lab{50.0000, -2.4900, 0.0011}, 7.2195},
	{12, lab{50.0000, 2.4900, -0.0010}, lab{50.0000, -2.4900, 0.0012}, 7.2195},
	{13, lab{50.0000, -0.0010, 2.4900}, lab{50.0000, 0.0009, -2.4900}, 4.8045},
	{14, lab{50.0000, -0.0010, 2.4900}, lab{50.0000, 0.0010, -2.4900}, 4.8045},
	{15, lab{50.0000, -0.0010, 2.4900}, lab{50.0000, 0.0011, -2.4900}, 4.7461},
	{16, lab{50.0000, 2.5000, 0.0000}, lab{50.0000, 0.0000, -2.5000}, 4.3065},
	{17, lab{50.0000, 2.5000, 0.0000}, lab{73.0000, 25.0000, -18.0000}, 27.1492},
	{18, lab{50.0000, 2.5000, 0.0000}, lab{61.0000, -5.0000, 29.0000}, 22.8977},
	{19, lab{50.0000, 2.5000, 0.0000}, lab{56.0000, -27.0000, -3.0000}, 31.9030},
	{20, lab{50.0000, 2.5000, 0.0000}, lab{58.0000, 24.0000, 15.0000}, 19.4535},
	{21, lab{50.0000, 2.5000, 0.0000}, lab{50.0000, 3.1736, 0.5854}, 1.0000},
	{22, lab{50.0000, 2.5000, 0.0000}, lab{50.0000, 3.2972, 0.0000}, 1.0000},
	{23, lab{50.0000, 2.5000, 0.0000}, lab{50.0000, 1.8634, 0.5757}, 1.0000},
	{24, lab{50.0000, 2.5000, 0.0000}, lab{50.0000, 3.2592, 0.3350}, 1.0000},
	{25, lab{60.2574, -34.0099, 36.2677}, lab{60.4626, -34.1751, 39.4387}, 1.2644},
	{26, lab{63.0109, -31.0961, -5.8663}, lab{62.8187, -29.7946, -4.0864}, 1.2630},
	{27, lab{61.2901, 3.7196, -5.3901}, lab{61.4292, 2.2480, -4.9620}, 1.8731},
	{28, lab{35.0831, -44.1164, 3.7933}, lab{35.0232, -40.0716, 1.5901}, 1.8645},
	{29, lab{22.7233, 20.0904, -46.6940}, lab{23.0331, 14.9730, -42.5619}, 2.0373},
	{30, lab{36.4612, 47.8580, 18.3852}, lab{36.2715, 50.5065, 21.2231}, 1.4146},
	{31, lab{90.8027, -2.0831, 1.4410}, lab{91.1528, -1.6435, 0.0447}, 1.4441},
	{32, lab{90.9257, -0.5406, -0.9208}, lab{88.6381, -0.8985, -0.7239}, 1.5381},
	{33, lab{6.7747, -0.2908, -2.4247}, lab{5.8714, -0.0985, -2.2286}, 0.6377},
	{34, lab{2.0776, 0.0795, -1.1350}, lab{0.9033, -0.0636, -0.5514}, 0.9082},
}

// deltaE2000 is the CIEDE2000 colour difference with unit weights (kL = kC = kH = 1), following Sharma,
// Wu and Dalal (2005), including the hue-angle wrap rules. The lint rule judges hue and chroma directly,
// so this is the reference that checks the Lab values the rule reads.
func deltaE2000(p, q lab) float64 {
	radians := func(deg float64) float64 { return deg * math.Pi / 180 }
	degrees := func(rad float64) float64 { return rad * 180 / math.Pi }
	hueAngle := func(b, a float64) float64 {
		if a == 0 && b == 0 {
			return 0
		}
		h := degrees(math.Atan2(b, a))
		if h < 0 {
			h += 360
		}
		return h
	}
	c1, c2 := math.Hypot(p.a, p.b), math.Hypot(q.a, q.b)
	cBar := (c1 + c2) / 2
	pow7 := math.Pow(cBar, 7)
	g := 0.5 * (1 - math.Sqrt(pow7/(pow7+math.Pow(25, 7))))
	a1p, a2p := (1+g)*p.a, (1+g)*q.a
	c1p, c2p := math.Hypot(a1p, p.b), math.Hypot(a2p, q.b)
	h1p, h2p := hueAngle(p.b, a1p), hueAngle(q.b, a2p)
	dLp := q.l - p.l
	dCp := c2p - c1p
	dhp := 0.0
	if c1p*c2p != 0 {
		dhp = h2p - h1p
		if dhp > 180 {
			dhp -= 360
		} else if dhp < -180 {
			dhp += 360
		}
	}
	dHp := 2 * math.Sqrt(c1p*c2p) * math.Sin(radians(dhp/2))
	lBarP := (p.l + q.l) / 2
	cBarP := (c1p + c2p) / 2
	hBarP := meanHue(h1p, h2p, c1p*c2p != 0)
	t := 1 - 0.17*math.Cos(radians(hBarP-30)) + 0.24*math.Cos(radians(2*hBarP)) +
		0.32*math.Cos(radians(3*hBarP+6)) - 0.20*math.Cos(radians(4*hBarP-63))
	dTheta := 30 * math.Exp(-square((hBarP-275)/25))
	cBarP7 := math.Pow(cBarP, 7)
	rC := 2 * math.Sqrt(cBarP7/(cBarP7+math.Pow(25, 7)))
	sL := 1 + 0.015*square(lBarP-50)/math.Sqrt(20+square(lBarP-50))
	sC := 1 + 0.045*cBarP
	sH := 1 + 0.015*cBarP*t
	rT := -math.Sin(radians(2*dTheta)) * rC
	termL, termC, termH := dLp/sL, dCp/sC, dHp/sH
	return math.Sqrt(termL*termL + termC*termC + termH*termH + rT*termC*termH)
}

func square(x float64) float64 { return x * x }

// meanHue is the mean hue angle of two colours, taking the short way round the circle.
// A colour with zero chroma has no hue, so the sum is returned unchanged.
func meanHue(h1p, h2p float64, chromatic bool) float64 {
	switch {
	case !chromatic:
		return h1p + h2p
	case math.Abs(h1p-h2p) <= 180:
		return (h1p + h2p) / 2
	case h1p+h2p < 360:
		return (h1p + h2p + 360) / 2
	default:
		return (h1p + h2p - 360) / 2
	}
}

// The reference must reproduce all 34 published pairs. Sharma's table is printed to four decimals.
func TestDeltaE2000MatchesAllPublishedPairs(t *testing.T) {
	if len(ciede2000Pairs) != 34 {
		t.Fatalf("pairs = %d, want 34", len(ciede2000Pairs))
	}
	for _, pair := range ciede2000Pairs {
		if got := deltaE2000(pair.p, pair.q); math.Abs(got-pair.want) > 0.0001 {
			t.Errorf("pair %d: deltaE2000 = %.4f, want %.4f", pair.pair, got, pair.want)
		}
	}
	if got := deltaE2000(srgbToLab([3]float64{10, 120, 200}), srgbToLab([3]float64{10, 120, 200})); got != 0 {
		t.Fatalf("identical colours have distance %v, want 0", got)
	}
}

// The marks are mirrored from docs/design/insights/status-tokens.json, which the UI keeps equal to the
// Gamma CSS. This test keeps the Go copy equal to the file.
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

// Bare green, amber and red, including the saturated reds that a lightness distance misses, are flagged
// with the family they echo.
func TestNearStatusColourFlagsBareStatusHues(t *testing.T) {
	findings := colourFinding(t,
		widgetJSON("green", "", `"options":{"thresholds":[{"value":0,"color":"#22c55e"}]}`),
		widgetJSON("amber", "", `"options":{"thresholds":[{"value":0,"color":"#eab308"}]}`),
		widgetJSON("red", "", `"options":{"thresholds":[{"value":0,"color":"#ef4444"}]}`),
		widgetJSON("red-orange", "", `"options":{"referenceLines":[{"value":5,"color":"#e24d42"}]}`),
		widgetJSON("pale-red", "", `"options":{"seriesColors":[{"label":"status","value":"down","color":"#ffd4cc"}]}`),
		widgetJSON("widget-red", "", `"color":"#dc2626"`),
	)
	for _, pointer := range []string{
		"/widgets/0/options/thresholds/0/color",
		"/widgets/1/options/thresholds/0/color",
		"/widgets/2/options/thresholds/0/color",
		"/widgets/3/options/referenceLines/0/color",
		"/widgets/4/options/seriesColors/0/color",
		"/widgets/5/color",
	} {
		requireOneHitAmong(t, findings, "color.near-status", pointer)
	}
	if count := countRule(findings, "color.near-status"); count != 6 {
		t.Fatalf("color.near-status hits = %d, want 6", count)
	}
	msg := requireOneHitAmong(t, findings, "color.near-status", "/widgets/2/options/thresholds/0/color").GetMessage()
	if !strings.Contains(msg, "critical status") || !strings.Contains(msg, "degrees from") {
		t.Fatalf("message %q does not name the family and the hue gap", msg)
	}
}

// Blues, violets, teals and neutral greys are not status hues, so they are not flagged, and a status
// named beside a hex override is not a bare colour.
func TestNearStatusColourAcceptsNeutralsOtherHuesStatusesAndRoles(t *testing.T) {
	findings := colourFinding(t,
		widgetJSON("grafana-blue", "", `"options":{"thresholds":[{"value":0,"color":"#2d7ca6"}]}`),
		widgetJSON("bright-blue", "", `"color":"#3b82f6"`),
		widgetJSON("violet", "", `"options":{"seriesColors":[{"label":"s","value":"v","color":"#8a7bf6"}]}`),
		widgetJSON("cyan", "", `"options":{"referenceLines":[{"value":5,"color":"#00cee2"}]}`),
		widgetJSON("teal", "", `"color":"#0c9a93"`),
		widgetJSON("grey", "", `"options":{"thresholds":[{"value":0,"color":"#6b7280"}]}`),
		widgetJSON("status-with-override", "", `"options":{"thresholds":[{"value":0,"status":"ok","color":"#22c55e"}]}`),
		widgetJSON("role-series", "", `"options":{"seriesColors":[{"label":"status_class","value":"5xx","role":"server-error"}]}`),
	)
	requireNoHits(t, findings, "color.near-status")
}

// Status-badge mappings carry their own status or colour. A colour-only mapping is a bare colour; a
// mapping that names a status keeps its colour as a hue override and is not checked.
func TestNearStatusColourChecksColourOnlyMappings(t *testing.T) {
	findings := colourFinding(t,
		pluginTestWidget("records", "record-table", `"dataKind":"records","config":{"cellStyles":[{"column":"status","display":"status-badge","mappings":[{"value":"Down","color":"#ef4444"},{"value":"Up","status":"ok","color":"#22c55e"},{"value":"Idle","color":"#6b7280"}]}]}`),
	)
	requireOneHitAmong(t, findings, "color.near-status", "/widgets/0/config/cellStyles/0/mappings/0/color")
	if count := countRule(findings, "color.near-status"); count != 1 {
		t.Fatalf("color.near-status hits = %d, want only the colour-only red mapping", count)
	}
}

// A plugin config series rule is checked the same way as a widget series rule.
func TestNearStatusColourChecksPluginSeriesRules(t *testing.T) {
	findings := colourFinding(t,
		pluginTestWidget("stacked", "stacked-timeseries", `"dataKind":"metrics","config":{"seriesColors":[{"label":"outcome","value":"blocked","color":"#e24d42"},{"label":"outcome","value":"allowed","role":"success"}]}`),
	)
	requireOneHitAmong(t, findings, "color.near-status", "/widgets/0/config/seriesColors/0/color")
	if count := countRule(findings, "color.near-status"); count != 1 {
		t.Fatalf("color.near-status hits = %d, want 1", count)
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
