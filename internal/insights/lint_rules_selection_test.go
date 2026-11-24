package insights

import (
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	insightsv1 "github.com/benebsworth/paprika/internal/api/paprika/insights/v1"
)

// rawWidget is a widget with the given members, in its own grid row so the layout rules see no overlap.
func rawWidget(id string, row int, members string) string {
	return fmt.Sprintf(`{"id":%q,"title":%q,"layout":{"x":0,"y":%d,"w":6,"h":4},%s}`, id, "Widget "+id, row*4, members)
}

// selectingWidget is a widget of the given type whose one selection sets the service variable from its label.
func selectingWidget(id string, row int, widgetType, query string) string {
	return rawWidget(id, row, `"type":"`+widgetType+`","providerId":"prom","query":"`+query+`","unit":"ms",`+serviceBinding)
}

const serviceBinding = `"selectionBindings":[{"variable":"service","source":"label","value":"service"}]`

func TestSelectionBindingsOnInactiveWidgetWarn(t *testing.T) {
	findings := lintFor(t, documentWithWidgets("inactive", selectingWidget("count", 0, "stat", "up")))
	finding := requireOneHit(t, findings, "selection.inactive-binding", "/widgets/0/selectionBindings")
	if finding.GetSeverity() != insightsv1.Severity_SEVERITY_WARNING {
		t.Fatalf("severity = %v, want warning", finding.GetSeverity())
	}
	if !strings.Contains(finding.GetMessage(), "stay inactive") {
		t.Fatalf("message %q does not say the bindings are inactive", finding.GetMessage())
	}
}

func TestSelectionBindingsOnSelectableWidgetsDoNotWarn(t *testing.T) {
	findings := lintFor(t, documentWithWidgets("active",
		selectingWidget("latency", 0, "timeseries", "latency"),
		selectingWidget("traffic", 1, "bar", "traffic"),
		selectingWidget("grid", 2, "heatmap", "grid"),
		selectingWidget("rows", 3, "table", "rows"),
		selectingWidget("slow", 4, "traces", "slow"),
		pluginTestWidget("share", "pie", serviceBinding),
	))
	requireNoHits(t, findings, "selection.inactive-binding")
}

func TestSelectionBindingsOnUnlistedPluginWarn(t *testing.T) {
	findings := lintFor(t, documentWithWidgets("plugin", pluginTestWidget("custom", "custom-chart", serviceBinding)))
	requireOneHit(t, findings, "selection.inactive-binding", "/widgets/0/selectionBindings")
}

func TestSelfFilteringSelectionWarnsOnItsOwnPlaceholder(t *testing.T) {
	findings := lintFor(t, documentWithWidgets("self", selectingWidget("latency", 0, "timeseries", `latency{service=\"{{service}}\"}`)))
	finding := requireOneHit(t, findings, "selection.self-filter", "/widgets/0/selectionBindings/0/variable")
	if !strings.Contains(finding.GetMessage(), `"service"`) {
		t.Fatalf("message %q does not name the variable", finding.GetMessage())
	}
}

func TestSelfFilteringSelectionWarnsOnItsOwnSavedQueryBinding(t *testing.T) {
	saved := `"queryRef":{"id":"latency-query","bindings":[{"source":"variable","variable":"service"}]}`
	widget := rawWidget("latency", 0, `"type":"timeseries","providerId":"prom","unit":"ms",`+serviceBinding+`,`+saved)
	findings := lintFor(t, documentWithWidgets("saved", widget))
	requireOneHit(t, findings, "selection.self-filter", "/widgets/0/selectionBindings/0/variable")
}

// The unfiltered source is the authoring pattern: it selects a service but reads no variable, so it cannot narrow itself.
// The filtered panel reads the variable and only reads it, so it does not select.
func TestUnfilteredSourceDoesNotSelfFilter(t *testing.T) {
	findings := lintFor(t, documentWithWidgets("overview",
		selectingWidget("overview", 0, "timeseries", "requests"),
		rawWidget("detail", 1, `"type":"timeseries","providerId":"prom","query":"latency{service=\"{{service}}\"}","unit":"ms"`),
	))
	requireNoHits(t, findings, "selection.self-filter")
}

// TestSelectableWidgetsMatchTheUI keeps the Go selectable lists equal to the lists the canvas uses to offer selection:
// the built-in types in selection-support.ts and the plugins that declare the selection capability in the table.
func TestSelectableWidgetsMatchTheUI(t *testing.T) {
	source, err := os.ReadFile("../../ui/src/features/insights/selection-support.ts")
	if err != nil {
		t.Fatal(err)
	}
	builtins := setLiterals(t, string(source), `const selectableBuiltins = new Set<[^>]*>\(\[(.*?)\]\)`)
	if !slices.Equal(sortedKeys(selectableWidgetTypes), builtins) {
		t.Fatalf("selectableWidgetTypes = %v, UI selectableBuiltins = %v", sortedKeys(selectableWidgetTypes), builtins)
	}
	table, err := os.ReadFile("../../ui/src/features/insights/plugins/plugin-capabilities.ts")
	if err != nil {
		t.Fatal(err)
	}
	plugins := capabilityEntries(t, string(table), "selection")
	if !slices.Equal(sortedKeys(selectablePluginIDs), plugins) {
		t.Fatalf("selectablePluginIDs = %v, UI capability table selection = %v", sortedKeys(selectablePluginIDs), plugins)
	}
}

var capabilityTable = regexp.MustCompile(`(?s)PLUGIN_DOCUMENT_CAPABILITIES = Object\.freeze\(\{(.*?)\} satisfies`)

var capabilityEntry = regexp.MustCompile(`"([a-z][a-z0-9-]*)": \{([^}]*)\}`)

// capabilityEntries lists the plugin ids in the UI capability table whose entry sets the named capability, sorted.
func capabilityEntries(t *testing.T, text, capability string) []string {
	t.Helper()
	table := capabilityTable.FindStringSubmatch(text)
	if table == nil {
		t.Fatal("PLUGIN_DOCUMENT_CAPABILITIES table not found in plugin-capabilities.ts")
	}
	var ids []string
	for _, entry := range capabilityEntry.FindAllStringSubmatch(table[1], -1) {
		if strings.Contains(entry[2], capability+": true") {
			ids = append(ids, entry[1])
		}
	}
	slices.Sort(ids)
	return ids
}

var quotedLiteral = regexp.MustCompile(`"([^"]+)"`)

func setLiterals(t *testing.T, text, pattern string) []string {
	t.Helper()
	match := regexp.MustCompile("(?s)" + pattern).FindStringSubmatch(text)
	if match == nil {
		t.Fatalf("selection-support.ts has no set matching %s", pattern)
	}
	literals := quotedLiteral.FindAllStringSubmatch(match[1], -1)
	values := make([]string, 0, len(literals))
	for _, literal := range literals {
		values = append(values, literal[1])
	}
	slices.Sort(values)
	return values
}

func sortedKeys(set map[string]bool) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
