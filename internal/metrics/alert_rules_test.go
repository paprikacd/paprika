package metrics

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
)

// These tests keep every paprika_* metric name in the shipped alert rules, the
// metrics guide's PromQL and the Grafana overview defined by Go code. A
// reference to an undefined name is a rule that can never fire.

const (
	alertRulesRelPath   = "charts/chart/templates/prometheus/prometheusrules.yaml"
	metricsGuideRelPath = "docs/guides/metrics.md"
	overviewRelPath     = "charts/chart/files/overview.json"
)

var (
	exportedNamesOnce sync.Once
	exportedNames     map[string]bool
	exportedNamesErr  error
)

// repoExportedMetricNames caches scanExportedMetricNames for the repository.
func repoExportedMetricNames(t *testing.T) map[string]bool {
	t.Helper()
	exportedNamesOnce.Do(func() {
		exportedNames, exportedNamesErr = scanExportedMetricNames(filepath.Join("..", ".."))
	})
	if exportedNamesErr != nil {
		t.Fatalf("scan Go metric definitions: %v", exportedNamesErr)
	}
	return exportedNames
}

func readRepoFile(t *testing.T, rel string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", rel)) //nolint:gosec // repo fixture path under the module root.
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(raw)
}

// yamlBlockIndicator matches a YAML block scalar header: '|' or '>', with an
// optional indentation digit and chomping indicator in either order.
var yamlBlockIndicator = regexp.MustCompile(`^[|>](?:[1-9][+-]?|[+-][1-9]?)?$`)

var metricNameRe = regexp.MustCompile(`paprika_[A-Za-z0-9_]+`)

// alertExprs returns the text of every `expr:` value in a YAML-like rules
// document, including block scalars with any YAML indicator.
func alertExprs(rules string) []string {
	var exprs []string
	lines := strings.Split(rules, "\n")
	for i := 0; i < len(lines); i++ {
		line := lines[i]
		trimmed := strings.TrimLeft(line, " ")
		if !strings.HasPrefix(trimmed, "expr:") {
			continue
		}
		indent := len(line) - len(trimmed)
		rest := strings.TrimSpace(strings.TrimPrefix(trimmed, "expr:"))
		if rest != "" && !yamlBlockIndicator.MatchString(rest) {
			exprs = append(exprs, rest)
			continue
		}
		var block []string
		for i+1 < len(lines) {
			next := lines[i+1]
			if strings.TrimSpace(next) == "" {
				block = append(block, next)
				i++
				continue
			}
			if len(next)-len(strings.TrimLeft(next, " ")) <= indent {
				break
			}
			block = append(block, next)
			i++
		}
		exprs = append(exprs, strings.Join(block, "\n"))
	}
	return exprs
}

// referencedPaprikaMetrics returns each paprika_* name used in the texts, in
// first-seen order.
func referencedPaprikaMetrics(texts []string) []string {
	seen := map[string]bool{}
	var names []string
	for _, text := range texts {
		for _, name := range metricNameRe.FindAllString(text, -1) {
			if !seen[name] {
				seen[name] = true
				names = append(names, name)
			}
		}
	}
	return names
}

// undefinedMetricRefs returns the referenced names that defined does not contain.
func undefinedMetricRefs(refs []string, defined map[string]bool) []string {
	var missing []string
	for _, ref := range refs {
		if !defined[ref] {
			missing = append(missing, ref)
		}
	}
	return missing
}

// markdownPromQL returns the PromQL in a markdown document: the bodies of
// ```promql blocks (with # comments removed), the expr values of ```yaml blocks,
// and the "expr" strings of ```json blocks. Other fenced blocks are ignored.
func markdownPromQL(t *testing.T, md string) []string {
	t.Helper()
	var out []string
	var lang string
	var body []string
	inFence := false
	for _, line := range strings.Split(md, "\n") {
		if strings.HasPrefix(line, "```") {
			if !inFence {
				inFence = true
				lang = strings.TrimSpace(strings.TrimPrefix(line, "```"))
				body = nil
				continue
			}
			inFence = false
			text := strings.Join(body, "\n")
			switch lang {
			case "promql":
				out = append(out, stripPromQLComments(text))
			case "yaml":
				out = append(out, alertExprs(text)...)
			case "json":
				var v any
				if err := json.Unmarshal([]byte(text), &v); err != nil {
					t.Fatalf("json block does not parse: %v\n%s", err, text)
				}
				out = append(out, jsonStringsForKey(v, "expr")...)
			}
			continue
		}
		if inFence {
			body = append(body, line)
		}
	}
	return out
}

var promQLComment = regexp.MustCompile(`(^|\s)#.*$`)

func stripPromQLComments(text string) string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		lines[i] = promQLComment.ReplaceAllString(l, "")
	}
	return strings.Join(lines, "\n")
}

// dashboardPromQL returns the expr and query strings of every panel target and
// template variable in a Grafana JSON document.
func dashboardPromQL(t *testing.T, raw string) []string {
	t.Helper()
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		t.Fatalf("dashboard does not parse: %v", err)
	}
	return append(jsonStringsForKey(v, "expr"), jsonStringsForKey(v, "query")...)
}

// jsonStringsForKey collects every string value stored under key, at any depth.
func jsonStringsForKey(v any, key string) []string {
	var out []string
	switch x := v.(type) {
	case map[string]any:
		for k, child := range x {
			if s, ok := child.(string); ok && k == key {
				out = append(out, s)
				continue
			}
			out = append(out, jsonStringsForKey(child, key)...)
		}
	case []any:
		for _, child := range x {
			out = append(out, jsonStringsForKey(child, key)...)
		}
	}
	return out
}

func TestChartAlertRulesReferenceDefinedMetrics(t *testing.T) {
	refs := referencedPaprikaMetrics(alertExprs(readRepoFile(t, alertRulesRelPath)))
	if len(refs) < 3 {
		t.Fatalf("extracted only %d paprika_* references from %s; the extractor is probably broken", len(refs), alertRulesRelPath)
	}
	for _, name := range undefinedMetricRefs(refs, repoExportedMetricNames(t)) {
		t.Errorf("%s references %s, which no Go instrument defines: the alert can never fire", alertRulesRelPath, name)
	}
}

func TestMetricsGuidePromQLReferenceDefinedMetrics(t *testing.T) {
	texts := markdownPromQL(t, readRepoFile(t, metricsGuideRelPath))
	refs := referencedPaprikaMetrics(texts)
	if len(refs) < 5 {
		t.Fatalf("extracted only %d paprika_* references from %s; the extractor is probably broken", len(refs), metricsGuideRelPath)
	}
	for _, name := range undefinedMetricRefs(refs, repoExportedMetricNames(t)) {
		t.Errorf("%s references %s, which no Go instrument defines", metricsGuideRelPath, name)
	}
}

func TestOverviewDashboardReferencesDefinedMetrics(t *testing.T) {
	refs := referencedPaprikaMetrics(dashboardPromQL(t, readRepoFile(t, overviewRelPath)))
	if len(refs) < 5 {
		t.Fatalf("extracted only %d paprika_* references from %s; the extractor is probably broken", len(refs), overviewRelPath)
	}
	for _, name := range undefinedMetricRefs(refs, repoExportedMetricNames(t)) {
		t.Errorf("%s references %s, which no Go instrument defines", overviewRelPath, name)
	}
}

// The guard must fail on a phantom: feed it a rule block that references one
// defined and one undefined metric.
func TestAlertRuleGuardDetectsPhantomMetric(t *testing.T) {
	rules := `
        - alert: Synthetic
          expr: paprika_releases_stuck > 0 or paprika_cluster_phase{phase="Unhealthy"} == 1
          for: 5m
`
	refs := referencedPaprikaMetrics(alertExprs(rules))
	defined := map[string]bool{"paprika_releases_stuck": true}
	got := undefinedMetricRefs(refs, defined)
	if len(got) != 1 || got[0] != "paprika_cluster_phase" {
		t.Fatalf("undefinedMetricRefs = %v, want [paprika_cluster_phase]", got)
	}
}

func TestAlertExprsAcceptsEveryBlockScalarIndicator(t *testing.T) {
	for _, indicator := range []string{"|", "|-", "|+", ">", ">-", ">+", "|2", "|2-", "|-2", ">1+", ">+1"} {
		rules := "        - alert: Multi\n          expr: " + indicator + "\n            up{job=\"a\"} == 0\n            or\n            absent(up{job=\"a\"})\n          for: 5m\n        - alert: Single\n          expr: paprika_releases_stuck > 0\n"
		exprs := alertExprs(rules)
		if len(exprs) != 2 {
			t.Fatalf("indicator %q: got %d exprs, want 2: %q", indicator, len(exprs), exprs)
		}
		if !strings.Contains(exprs[0], "absent(") || strings.Contains(exprs[0], "for:") {
			t.Fatalf("indicator %q: block scalar captured wrong lines: %q", indicator, exprs[0])
		}
		if exprs[1] != "paprika_releases_stuck > 0" {
			t.Fatalf("indicator %q: single-line expr = %q", indicator, exprs[1])
		}
	}
}

func TestMarkdownPromQLReadsEveryFenceKind(t *testing.T) {
	md := "```promql\n# a comment with paprika_nope\npaprika_releases_stuck > 0\n```\n" +
		"```yaml\n- alert: X\n  expr: >-\n    paprika_fleet_index_degraded == 1\n```\n" +
		"```json\n{\"targets\": [{\"expr\": \"max(paprika_out_of_sync)\"}]}\n```\n" +
		"```sh\ncurl paprika_ignored\n```\n"
	refs := referencedPaprikaMetrics(markdownPromQL(t, md))
	want := []string{"paprika_releases_stuck", "paprika_fleet_index_degraded", "paprika_out_of_sync"}
	if strings.Join(refs, ",") != strings.Join(want, ",") {
		t.Fatalf("refs = %v, want %v", refs, want)
	}
}
