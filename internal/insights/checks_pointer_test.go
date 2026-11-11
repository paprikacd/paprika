package insights

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/benebsworth/paprika/internal/insights/checkwire"
)

// pointerCase names the exact member a validator must report. Each message is
// the text the save has always returned, so the table also pins the legacy error.
type pointerCase struct {
	name     string
	document any // a Dashboard or a string literal
	pointer  string
	rule     string
	message  string
}

// asDocument converts a case's document to the Dashboard type.
func asDocument(document any) Dashboard {
	switch value := document.(type) {
	case string:
		return json.RawMessage(value)
	case Dashboard:
		return value
	}
	panic(fmt.Sprintf("unsupported document type %T", document))
}

// documentWithHeader builds a document with its own top-level fields, for cases
// that set variables, custom ranges or a time zone.
func documentWithHeader(extraHeader string, widgets ...string) Dashboard {
	return json.RawMessage(fmt.Sprintf(`{"schemaVersion":1,"id":"demo","title":"Checks","timeRange":"1h","refreshInterval":30,%s"widgets":[%s]}`, extraHeader, strings.Join(widgets, ",")))
}

func pluginWidget(id, extra string) string {
	return widgetJSON(id, "", `"type":"plugin","pluginId":"thing","dataKind":"metrics"`+extra)
}

func TestSchemaFindingsNameTheExactMemberForEachValidator(t *testing.T) {
	cases := []pointerCase{
		{"document identity id", `{"schemaVersion":1,"id":"other","title":"Checks","timeRange":"1h","refreshInterval":30,"widgets":[]}`, "/id", "schema.document", "dashboard schemaVersion must be 1 and id must match the path"},
		{"document schema version", `{"schemaVersion":2,"id":"demo","title":"Checks","timeRange":"1h","refreshInterval":30,"widgets":[]}`, "/schemaVersion", "schema.document", "dashboard schemaVersion must be 1 and id must match the path"},
		{"document description", `{"schemaVersion":1,"id":"demo","title":"Checks","description":"` + strings.Repeat("d", 501) + `","timeRange":"1h","refreshInterval":30,"widgets":[]}`, "/description", "schema.document", "dashboard title or description is invalid"},
		{"document refresh", `{"schemaVersion":1,"id":"demo","title":"Checks","timeRange":"1h","refreshInterval":45,"widgets":[]}`, "/refreshInterval", "schema.document.refreshInterval", "unsupported refresh interval"},
		{"document folder", documentWithHeader(`"folder":"a//b",`), "/folder", "schema.document.folder", "folder must not contain empty, dot, or parent segments"},
		{"document time zone", documentWithHeader(`"timeZone":"Mars/Olympus",`), "/timeZone", "schema.document.timeZone", "timeZone must be an IANA time zone name such as Europe/London or UTC"},
		{"custom range from", documentWithHeader(`"customTimeRange":{"from":"yesterday","to":"2026-01-02T00:00:00Z"},`), "/customTimeRange/from", "schema.document.customTimeRange", "custom time bounds must be ISO datetimes with timezones"},
		{"custom range to", documentWithHeader(`"customTimeRange":{"from":"2026-01-01T00:00:00Z","to":"soon"},`), "/customTimeRange/to", "schema.document.customTimeRange", "custom time bounds must be ISO datetimes with timezones"},
		{"variable name", documentWithHeader(`"variables":[{"name":"svc"},{"name":"svc"}],`), "/variables/1/name", "schema.document.variables", "dashboard variables require unique identifier names up to 64 characters, labels up to 80, and string values up to 1024"},
		{"variable option", documentWithHeader(`"variables":[{"name":"svc","options":["a","a"]}],`), "/variables/0/options/1", "schema.document.variables", "dashboard variable options require unique string values up to 1024 characters"},
		{"widget title", documentWithWidgets("demo", widgetJSON("a", "", `"title":"   "`)), "/widgets/0/title", "schema.widget.text", "widget title or metadata is invalid"},
		{"widget description", documentWithWidgets("demo", widgetJSON("a", "", `"description":"`+strings.Repeat("d", 501)+`"`)), "/widgets/0/description", "schema.widget.text", "widget title or metadata is invalid"},
		{"widget unit", documentWithWidgets("demo", widgetJSON("a", "", `"unit":"`+strings.Repeat("u", 25)+`"`)), "/widgets/0/unit", "schema.widget.text", "widget title or metadata is invalid"},
		{"widget provider", documentWithWidgets("demo", widgetJSON("a", "", `"providerId":"!!"`)), "/widgets/0/providerId", "schema.widget.text", "widget provider and query are required"},
		{"widget query", documentWithWidgets("demo", widgetJSON("a", "", `"query":"  "`)), "/widgets/0/query", "schema.widget.text", "widget provider and query are required"},
		{"widget type", documentWithWidgets("demo", widgetJSON("a", "", `"type":"bogus"`)), "/widgets/0/type", "schema.widget.type", "unsupported widget type"},
		{"widget layout y", documentWithWidgets("demo", widgetJSON("a", `{"x":0,"y":1001,"w":4,"h":4}`, "")), "/widgets/0/layout/y", "schema.widget.layout", "widget layout is outside the dashboard grid"},
		{"widget layout overflow", documentWithWidgets("demo", widgetJSON("a", `{"x":8,"y":0,"w":6,"h":4}`, "")), "/widgets/0/layout/w", "schema.widget.layout", "widget layout is outside the dashboard grid"},
		{"widget layout height", documentWithWidgets("demo", widgetJSON("a", `{"x":0,"y":0,"w":4,"h":1}`, "")), "/widgets/0/layout/h", "schema.widget.layout", "widget layout is outside the dashboard grid"},
		{"widget color", documentWithWidgets("demo", widgetJSON("a", "", `"color":"red"`)), "/widgets/0/color", "schema.widget.color", "widget color must be a six-digit hex color"},
		{"widget query reference", documentWithWidgets("demo", widgetJSON("a", "", `"queryRef":{"id":"!!"}`)), "/widgets/0/queryRef/id", "schema.widget.queryRef", "saved query references require a valid id"},
		{"query binding variable", documentWithWidgets("demo", widgetJSON("a", "", `"queryRef":{"id":"q","bindings":[{"parameter":"p","source":"variable"}]}`)), "/widgets/0/queryRef/bindings/0", "schema.widget.queryRef", "saved query variable bindings require a valid dashboard variable name"},
		{"plugin id", documentWithWidgets("demo", pluginWidget("a", `,"pluginId":"!!"`)), "/widgets/0/pluginId", "schema.widget.pluginId", "plugin widgets require a valid pluginId"},
		{"plugin member on a timeseries", documentWithWidgets("demo", widgetJSON("a", "", `"pluginId":"thing"`)), "/widgets/0/pluginId", "schema.widget.pluginId", "pluginId, dataKind, and config are only valid for plugin widgets"},
		{"plugin config reserved key", documentWithWidgets("demo", pluginWidget("a", `,"config":{"nested":{"constructor":true}}`)), "/widgets/0/config/nested/constructor", "schema.widget.config", "plugin configuration contains a reserved key"},
		{"plugin config reserved key order", documentWithWidgets("demo", pluginWidget("a", `,"config":{"prototype":1,"constructor":2}`)), "/widgets/0/config/constructor", "schema.widget.config", "plugin configuration contains a reserved key"},
		{"drilldown id", documentWithWidgets("demo", widgetJSON("a", "", `"drilldowns":[{"id":"x","title":"t","dashboardId":"d"},{"id":"x","title":"t","dashboardId":"d"}]`)), "/widgets/0/drilldowns/1/id", "schema.widget.drilldowns", "drilldowns require unique IDs, local dashboard IDs, titles up to 120 characters, and optional boolean carryTimeRange"},
		{"drilldown binding source", documentWithWidgets("demo", widgetJSON("a", "", `"drilldowns":[{"id":"x","title":"t","dashboardId":"d","bindings":[{"variable":"v","source":"nope"}]}]`)), "/widgets/0/drilldowns/0/bindings/0/source", "schema.widget.drilldowns", "drilldown binding source must be label, value, series, or constant"},
		{"selection binding", documentWithWidgets("demo", widgetJSON("a", "", `"selectionBindings":[{"variable":"v","source":"label"}]`)), "/widgets/0/selectionBindings/0", "schema.widget.selectionBindings", "label bindings require a label key of 1–128 characters"},
		{"annotation column", documentWithWidgets("demo", widgetJSON("a", "", `"annotationSource":{"queryRef":{"id":"q"},"timestampColumn":"ts","labelColumn":" lbl"}`)), "/widgets/0/annotationSource/labelColumn", "schema.widget.annotationSource", "event query column names must contain 1–128 characters"},
		{"option axis label", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"yAxisLabel":"`+strings.Repeat("y", 81)+`"}`)), "/widgets/0/options/yAxisLabel", "schema.widget.options", "axis labels must be strings of at most 80 characters"},
		{"option tooltip view type", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"tooltipView":{"type":"bogus"}}`)), "/widgets/0/options/tooltipView/type", "schema.widget.options", "unsupported tooltip widget type"},
		{"option tooltip view source", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"tooltipView":{"type":"timeseries","source":{"type":"saved","ref":{"id":"!!"}}}}`)), "/widgets/0/options/tooltipView/source/ref/id", "schema.widget.options", "saved query references require a valid id"},
		{"option tooltip binding", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"tooltipView":{"type":"timeseries","source":{"type":"query","providerId":"p","query":"up","bindings":[{"variable":"v","label":"x"},{"variable":"v","label":"x"}]}}}`)), "/widgets/0/options/tooltipView/source/bindings/1/variable", "schema.widget.options", "tooltip bindings require unique valid variable names"},
		{"option tooltip placement", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"tooltipMaxWidth":9999}`)), "/widgets/0/options/tooltipMaxWidth", "schema.widget.options", "tooltipMaxWidth must be from 220 to 640"},
		{"option decimals", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"decimals":99}`)), "/widgets/0/options/decimals", "schema.widget.options", "decimals must be an integer from 0 to 8"},
		{"option line width", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"lineWidth":9}`)), "/widgets/0/options/lineWidth", "schema.widget.options", "line width must be from 0.5 to 8"},
		{"option max below min", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"min":10,"max":5}`)), "/widgets/0/options/max", "schema.widget.options", "maximum must exceed minimum"},
		{"option stat bar bound", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"showStatBar":true,"min":0}`)), "/widgets/0/options", "schema.widget.options", "stat bar requires an explicit maximum"},
		{"option reference line label", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"referenceLines":[{"value":1,"color":"#111111"},{"value":2,"label":""}]}`)), "/widgets/0/options/referenceLines/1/label", "schema.widget.options", "reference line labels must be 1 to 80 characters"},
		{"option reference line colour", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"referenceLines":[{"value":1,"color":"blue"}]}`)), "/widgets/0/options/referenceLines/0/color", "schema.widget.options", "reference line colors must be six-digit hex colors"},
		{"option threshold status", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"thresholds":[{"value":1,"status":"danger"}]}`)), "/widgets/0/options/thresholds/0/status", "schema.widget.options", "threshold status must be one of ok, info, warning, critical, unknown; success, danger and similar names are not statuses"},
		{"option threshold order", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"thresholds":[{"value":5,"status":"ok"},{"value":5,"status":"warning"}]}`)), "/widgets/0/options/thresholds/1/value", "schema.widget.options", "thresholds require increasing finite values"},
		{"option threshold names nothing", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"thresholds":[{"value":1,"status":"ok"},{"value":2}]}`)), "/widgets/0/options/thresholds/1", "schema.widget.options", "each threshold must name a status (ok, info, warning, critical, unknown) or a six-digit hex color"},
		{"option threshold label", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"thresholds":[{"value":1,"status":"ok","label":"`+strings.Repeat("x", 81)+`"}]}`)), "/widgets/0/options/thresholds/0/label", "schema.widget.options", "threshold labels must be at most 80 characters"},
		{"option series colour", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"seriesColors":[{"label":"code","value":"2xx","color":"#111111"},{"label":"code","value":"4xx","color":"red"}]}`)), "/widgets/0/options/seriesColors/1/color", "schema.widget.options", "series colors require a valid metric label, nonempty value, and six-digit hex color"},
		{"option series duplicate", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"seriesColors":[{"label":"code","value":"2xx","color":"#111111"},{"label":"code","value":"2xx","color":"#222222"}]}`)), "/widgets/0/options/seriesColors/1", "schema.widget.options", "duplicate series color label and value"},
		// A decode failure names the element, not a valid neighbour of the bad member.
		{"drilldown carryTimeRange type", documentWithWidgets("demo", widgetJSON("a", "", `"drilldowns":[{"id":"x","title":"t","dashboardId":"d","carryTimeRange":"yes"}]`)), "/widgets/0/drilldowns/0", "schema.widget.drilldowns", "drilldowns require unique IDs, local dashboard IDs, titles up to 120 characters, and optional boolean carryTimeRange"},
		{"variable label type", documentWithHeader(`"variables":[{"name":"svc","label":7}],`), "/variables/0", "schema.document.variables", "dashboard variables require unique identifier names up to 64 characters, labels up to 80, and string values up to 1024"},
		{"binding source type", documentWithWidgets("demo", widgetJSON("a", "", `"queryRef":{"id":"q","bindings":[{"parameter":"p","source":7}]}`)), "/widgets/0/queryRef/bindings/0", "schema.widget.queryRef", "saved query bindings require unique valid parameter names"},
		{"selection binding source type", documentWithWidgets("demo", widgetJSON("a", "", `"selectionBindings":[{"variable":"v","source":7}]`)), "/widgets/0/selectionBindings/0", "schema.widget.selectionBindings", "drilldown bindings require unique variable names and string values up to 1024 characters"},
		{"reference line label type", documentWithWidgets("demo", widgetJSON("a", "", `"options":{"referenceLines":[{"value":1,"label":7}]}`)), "/widgets/0/options/referenceLines/0", "schema.widget.options", "reference lines require a finite value"},
		{"unknown widget member", documentWithWidgets("demo", widgetJSON("a", "", `"zeta":1`)), "/widgets/0/zeta", "schema.widget.shape", `unknown dashboard field "zeta"`},
		{"unknown layout member", documentWithWidgets("demo", widgetJSON("a", `{"x":0,"y":0,"w":4,"h":4,"z":1}`, "")), "/widgets/0/layout/z", "schema.widget.layout", `unknown dashboard field "z"`},
		{"missing widget member", documentWithWidgets("demo", `{"id":"a","title":"A","type":"timeseries","providerId":"prometheus","query":"up","unit":"req/s"}`), "/widgets/0", "schema.widget.shape", `required dashboard field "layout" is missing`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			findings := schemaFindings("demo", asDocument(tc.document))
			if len(findings) == 0 {
				t.Fatalf("no finding; want %q at %q", tc.message, tc.pointer)
			}
			first := findings[0]
			if first.GetPointer() != tc.pointer || first.GetRuleId() != tc.rule || first.GetMessage() != tc.message {
				t.Fatalf("finding = pointer %q rule %q message %q\nwant pointer %q rule %q message %q",
					first.GetPointer(), first.GetRuleId(), first.GetMessage(), tc.pointer, tc.rule, tc.message)
			}
			if err := validateDashboard("demo", asDocument(tc.document)); err == nil || err.Error() != first.GetMessage() {
				t.Fatalf("save error = %v, want the first finding %q", err, first.GetMessage())
			}
		})
	}
}

// Pointers use RFC 6901 escaping, so a submitted key with "/" or "~" names the
// member it is, not a neighbour.
func TestSchemaFindingsEscapeKeysInPointers(t *testing.T) {
	findings := schemaFindings("demo", documentWithWidgets("demo", widgetJSON("a", "", `"a/b~c":1`)))
	if len(findings) != 1 || findings[0].GetPointer() != "/widgets/0/a~1b~0c" {
		t.Fatalf("findings = %v", findings)
	}
}

// A key too long to name exactly is reported at the object that holds it, so
// the pointer stays short and never names a neighbour.
func TestSchemaFindingsFallBackToTheObjectForLongKeys(t *testing.T) {
	long := strings.Repeat("k", 200)
	findings := schemaFindings("demo", documentWithWidgets("demo", widgetJSON("a", "", fmt.Sprintf(`%q:true`, long))))
	if len(findings) != 1 || findings[0].GetPointer() != "/widgets/0" || findings[0].GetRuleId() != "schema.widget.shape" {
		t.Fatalf("findings = pointer %q rule %q", findings[0].GetPointer(), findings[0].GetRuleId())
	}
}

// Finding order and the reported member are fixed per document: a map of
// keys must not change which member a call names.
func TestSchemaFindingPointersAreStableAcrossCalls(t *testing.T) {
	document := documentWithWidgets("demo", pluginWidget("a", `,"config":{"prototype":1,"constructor":2,"zeta":{"constructor":3}}`))
	first := schemaFindings("demo", document)[0].GetPointer()
	for range 50 {
		if got := schemaFindings("demo", document)[0].GetPointer(); got != first {
			t.Fatalf("pointer changed from %q to %q", first, got)
		}
	}
}

func TestBoundPointerNamesTheNearestAncestorThatFits(t *testing.T) {
	if got := boundPointer("/widgets/0/" + strings.Repeat("p", 300)); got != "/widgets/0" {
		t.Fatalf("bounded pointer = %q", got)
	}
	if got := boundPointer("/widgets/0/layout/w"); got != "/widgets/0/layout/w" {
		t.Fatalf("short pointer changed to %q", got)
	}
	// A slash exactly at the limit starts a segment that does not fit: the
	// segments before it are the longest pointer that does.
	atLimit := "/widgets/0/" + strings.Repeat("p", checkwire.MaxPointerBytes-len("/widgets/0/")) + "/child"
	if len(atLimit) <= checkwire.MaxPointerBytes+1 || atLimit[checkwire.MaxPointerBytes] != '/' {
		t.Fatalf("fixture must put a slash at byte %d: %q", checkwire.MaxPointerBytes, atLimit[checkwire.MaxPointerBytes])
	}
	if got := boundPointer(atLimit); got != atLimit[:checkwire.MaxPointerBytes] {
		t.Fatalf("slash at the limit: bounded pointer = %d bytes, want %d", len(got), checkwire.MaxPointerBytes)
	}
}

func TestRuleIDsAreClosedOverSubmittedKeys(t *testing.T) {
	for pointer, want := range map[string]string{
		"":                       "schema.document",
		"/timeRange":             "schema.document.timeRange",
		"/refreshInterval":       "schema.document.refreshInterval",
		"/variables/0/name":      "schema.document.variables",
		"/widgets":               "schema.widgets",
		"/widgets/3":             "schema.widget.shape",
		"/widgets/3/layout/x":    "schema.widget.layout",
		"/widgets/3/options/a/b": "schema.widget.options",
		"/widgets/3/not-a-field": "schema.widget.shape",
		"/widgets/3/providerId":  "schema.widget.text",
		"/widgets/3/id":          "schema.widget.id",
		"/widgets/3/pluginId":    "schema.widget.pluginId",
		"/extra":                 "schema.document",
		"/schemaVersion":         "schema.document",
	} {
		if got := ruleFor(pointer); got != want {
			t.Errorf("ruleFor(%q) = %q, want %q", pointer, got, want)
		}
	}
}
