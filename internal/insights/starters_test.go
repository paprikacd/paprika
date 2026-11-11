package insights

import (
	"encoding/json"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// signalsReferencePath is the metric reference that the starters' queries must
// use. internal/metrics checks that reference against the Go definitions.
const signalsReferencePath = "../../.agents/skills/paprika-dashboard-design/references/paprika-signals.md"

var (
	signalMetricName = regexp.MustCompile(`paprika_[a-z0-9_]+`)
	matcherBlock     = regexp.MustCompile(`\{([^{}]*)\}`)
	matcherLabel     = regexp.MustCompile(`([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=~|!~|!=|=)`)
	byClause         = regexp.MustCompile(`\bby\s*\(([^)]*)\)`)
	backtickLabel    = regexp.MustCompile("`([a-z_]+)`")
)

type signalMetric struct {
	kind   string
	labels []string
}

func readStarters(t *testing.T) []Starter {
	t.Helper()
	starters, err := Starters()
	if err != nil {
		t.Fatalf("Starters() failed: %v", err)
	}
	if len(starters) == 0 {
		t.Fatal("no starter dashboards are embedded")
	}
	return starters
}

// readSignals parses the metric reference table. Only the first five cells of a
// row are read, so a pipe inside a later cell cannot shift the columns that matter.
func readSignals(t *testing.T) map[string]signalMetric {
	t.Helper()
	data, err := os.ReadFile(signalsReferencePath)
	if err != nil {
		t.Fatalf("read metric reference: %v", err)
	}
	signals := map[string]signalMetric{}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "| `") {
			continue
		}
		cells := strings.Split(line, "|")
		if len(cells) < 6 {
			continue
		}
		name := strings.Trim(strings.TrimSpace(cells[1]), "`")
		var labels []string
		for _, match := range backtickLabel.FindAllStringSubmatch(cells[4], -1) {
			labels = append(labels, match[1])
		}
		signals[name] = signalMetric{kind: strings.TrimSpace(cells[3]), labels: labels}
	}
	return signals
}

func TestStartersValidateAndLintClean(t *testing.T) {
	for _, starter := range readStarters(t) {
		t.Run(starter.ID, func(t *testing.T) {
			var head struct {
				ID string `json:"id"`
			}
			if err := json.Unmarshal(starter.Document, &head); err != nil {
				t.Fatalf("starter is not a JSON object: %v", err)
			}
			if head.ID != starter.ID {
				t.Fatalf("document id %q must match its file name %q", head.ID, starter.ID)
			}
			if err := validateDashboard(starter.ID, starter.Document); err != nil {
				t.Fatalf("schema validation failed: %v", err)
			}
			for _, finding := range CheckDocument(starter.Document) {
				t.Errorf("%s %s at %s: %s", finding.GetSeverity(), finding.GetRuleId(), finding.GetPointer(), finding.GetMessage())
			}
		})
	}
}

// TestStarterMetricsMatchTheSignalsReference checks every paprika_* name a starter
// queries against the metric reference: the name exists and is not marked as never
// recorded, counters are read through rate or increase, and each label a query
// names belongs to a metric the query uses.
func TestStarterMetricsMatchTheSignalsReference(t *testing.T) {
	signals := readSignals(t)
	if len(signals) == 0 {
		t.Fatal("the metric reference has no rows")
	}
	for _, starter := range readStarters(t) {
		var document struct {
			Widgets []struct {
				ID    string `json:"id"`
				Query string `json:"query"`
			} `json:"widgets"`
		}
		if err := json.Unmarshal(starter.Document, &document); err != nil {
			t.Fatalf("%s: %v", starter.ID, err)
		}
		for _, widget := range document.Widgets {
			if widget.Query == "" {
				continue
			}
			names := signalMetricName.FindAllString(widget.Query, -1)
			if len(names) == 0 {
				t.Errorf("%s/%s: query names no paprika_* metric", starter.ID, widget.ID)
			}
			var allowed []string
			for _, name := range names {
				signal, ok := signals[name]
				if !ok {
					t.Errorf("%s/%s: %s is not in the metric reference", starter.ID, widget.ID, name)
					continue
				}
				allowed = append(allowed, signal.labels...)
				if signal.kind == "Counter" && !regexp.MustCompile(`(?:rate|increase)\(\s*`+regexp.QuoteMeta(name)+`[\[{]`).MatchString(widget.Query) {
					t.Errorf("%s/%s: counter %s must be read through rate() or increase()", starter.ID, widget.ID, name)
				}
			}
			for _, block := range matcherBlock.FindAllStringSubmatch(widget.Query, -1) {
				for _, match := range matcherLabel.FindAllStringSubmatch(block[1], -1) {
					checkLabel(t, starter.ID, widget.ID, match[1], allowed)
				}
			}
			for _, clause := range byClause.FindAllStringSubmatch(widget.Query, -1) {
				for _, label := range strings.Split(clause[1], ",") {
					checkLabel(t, starter.ID, widget.ID, strings.TrimSpace(label), allowed)
				}
			}
		}
	}
}

func checkLabel(t *testing.T, starterID, widgetID, label string, allowed []string) {
	t.Helper()
	if label == "" {
		return
	}
	if !slices.Contains(allowed, label) {
		t.Errorf("%s/%s: label %q is not a label of any metric the query uses", starterID, widgetID, label)
	}
}
