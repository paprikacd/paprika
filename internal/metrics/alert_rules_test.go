package metrics

import (
	"bytes"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// This file guards the Helm PrometheusRule template against alerts on metric
// names that no Go code defines. Such rules never fire and give operators false
// confidence (see be-metrics.md "Dangling alert rules").
//
// Defined names are derived from the source, not from a running process:
//   - Prometheus client options: the Name field of CounterOpts, GaugeOpts,
//     HistogramOpts and SummaryOpts composite literals.
//   - OTel instruments: the first "paprika..." string literal passed to an
//     instrument constructor, mapped to the exporter's Prometheus name (dots to
//     underscores, unit suffix, _total for monotonic counters, _ratio for unit
//     "1" gauges). Annotation units such as "{release}" add nothing. This mirrors
//     github.com/prometheus/otlptranslator as used by the OTel Prometheus
//     exporter in go.opentelemetry.io/otel/exporters/prometheus.
//
// Not covered: names built at runtime or from non-literal arguments, metrics
// exported by other binaries or dependencies (controller-runtime, client-go,
// cAdvisor, kube-state-metrics), label names and label values, and whether a
// referenced metric is emitted with the labels a rule selects on. The test
// checks names only.

const alertRulesRelPath = "charts/chart/templates/prometheus/prometheusrules.yaml"

var (
	definedMetricsOnce sync.Once
	definedMetricNames map[string]bool
	definedMetricsErr  error
)

// instrumentUnitSuffix maps the OTel units used in this repo to the suffix the
// exporter appends. Unknown units fail the test so the mapping cannot drift
// silently.
var instrumentUnitSuffix = map[string]string{
	"":   "",
	"1":  "",
	"s":  "_seconds",
	"ms": "_milliseconds",
	"By": "_bytes",
}

var metricNameRe = regexp.MustCompile(`paprika_[A-Za-z0-9_]+`)

// alertExprs returns the text of every `expr:` value in a rules template,
// including multi-line block scalars.
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
		if rest != "|" && rest != "|-" && rest != ">" && rest != "" {
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

// referencedPaprikaMetrics returns each paprika_* metric name used in expr
// text, in first-seen order.
func referencedPaprikaMetrics(exprs []string) []string {
	seen := map[string]bool{}
	var names []string
	for _, expr := range exprs {
		for _, name := range metricNameRe.FindAllString(expr, -1) {
			if !seen[name] {
				seen[name] = true
				names = append(names, name)
			}
		}
	}
	return names
}

// undefinedMetricRefs returns the referenced names that defined does not
// contain. Histogram series (_bucket, _sum, _count) are already expanded into
// defined by scanDefinedPaprikaMetrics.
func undefinedMetricRefs(refs []string, defined map[string]bool) []string {
	var missing []string
	for _, ref := range refs {
		if defined[ref] {
			continue
		}
		missing = append(missing, ref)
	}
	return missing
}

func definedPaprikaMetrics(t *testing.T) map[string]bool {
	t.Helper()
	definedMetricsOnce.Do(func() {
		definedMetricNames, definedMetricsErr = scanDefinedPaprikaMetrics(filepath.Join("..", ".."))
	})
	if definedMetricsErr != nil {
		t.Fatalf("scan Go metric definitions: %v", definedMetricsErr)
	}
	return definedMetricNames
}

// scanDefinedPaprikaMetrics walks the non-test Go sources under internal/ and
// cmd/ in root and returns the exported Prometheus names they define.
func scanDefinedPaprikaMetrics(root string) (map[string]bool, error) {
	defined := map[string]bool{}
	fset := token.NewFileSet()
	for _, dir := range []string{"internal", "cmd"} {
		err := filepath.WalkDir(filepath.Join(root, dir), func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
				return nil
			}
			src, err := os.ReadFile(path) //nolint:gosec // reads repo sources under the module root during tests.
			if err != nil {
				return err
			}
			// Cheap prefilter: most files define no paprika metrics. Skips the
			// large generated protobuf files as well.
			if !bytes.Contains(src, []byte(`"paprika`)) {
				return nil
			}
			file, err := parser.ParseFile(fset, path, src, 0)
			if err != nil {
				return err
			}
			return collectMetricDefs(file, defined)
		})
		if err != nil {
			return nil, err
		}
	}
	return defined, nil
}

func collectMetricDefs(file *ast.File, defined map[string]bool) error {
	var firstErr error
	ast.Inspect(file, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.CompositeLit:
			// Prometheus client options: Name field of *Opts literals.
			typeName := selectorOrIdentName(node.Type)
			if !strings.HasSuffix(typeName, "Opts") {
				return true
			}
			for _, elt := range node.Elts {
				kv, ok := elt.(*ast.KeyValueExpr)
				if !ok || selectorOrIdentName(kv.Key) != "Name" {
					continue
				}
				name, ok := stringLit(kv.Value)
				if !ok || !strings.HasPrefix(name, "paprika_") {
					continue
				}
				defined[name] = true
				if typeName == "HistogramOpts" {
					for _, suffix := range []string{"_bucket", "_sum", "_count"} {
						defined[name+suffix] = true
					}
				}
			}
		case *ast.CallExpr:
			callee := selectorOrIdentName(node.Fun)
			kind, ok := instrumentKind(callee)
			if !ok {
				return true
			}
			name, unit, found, err := instrumentNameAndUnit(node, callee)
			if err != nil {
				firstErr = err
				return false
			}
			if !found {
				return true
			}
			exported, err := exportedName(name, unit, kind)
			if err != nil {
				firstErr = err
				return false
			}
			for _, e := range exported {
				defined[e] = true
			}
		}
		return true
	})
	return firstErr
}

type instrumentType int

const (
	instrumentCounter instrumentType = iota
	instrumentUpDown
	instrumentGauge
	instrumentHistogram
)

// instrumentKind classifies an OTel instrument constructor by name. Both the
// repo's must* helpers and the meter methods (Int64Counter, ...) are matched.
func instrumentKind(callee string) (instrumentType, bool) {
	isOTel := strings.HasPrefix(callee, "must") ||
		strings.HasPrefix(callee, "Int64") || strings.HasPrefix(callee, "Float64")
	if !isOTel {
		return 0, false
	}
	switch {
	case strings.Contains(callee, "UpDown"):
		return instrumentUpDown, true
	case strings.Contains(callee, "Counter"):
		return instrumentCounter, true
	case strings.Contains(callee, "Gauge"):
		return instrumentGauge, true
	case strings.Contains(callee, "Histogram"):
		return instrumentHistogram, true
	}
	return 0, false
}

// instrumentNameAndUnit extracts the first literal "paprika..." name passed to
// an instrument constructor and its unit. The must* helpers take the name as
// their second argument and the unit as their third, except mustCounter, which
// is always unit "1". Meter methods take the name first and pass the unit via
// metric.WithUnit("...").
func instrumentNameAndUnit(call *ast.CallExpr, callee string) (name, unit string, found bool, err error) {
	nameIdx := -1
	for i, arg := range call.Args {
		s, ok := stringLit(arg)
		if ok && (strings.HasPrefix(s, "paprika.") || strings.HasPrefix(s, "paprika_")) {
			name, nameIdx = s, i
			break
		}
	}
	if nameIdx < 0 {
		return "", "", false, nil
	}
	if strings.HasPrefix(callee, "must") {
		if callee == "mustCounter" {
			return name, "1", true, nil
		}
		if nameIdx+1 >= len(call.Args) {
			return "", "", false, nil
		}
		u, ok := stringLit(call.Args[nameIdx+1])
		if !ok {
			return "", "", false, nil // unit passed through a variable: not a definition we can read
		}
		return name, u, true, nil
	}
	for _, arg := range call.Args {
		inner, ok := arg.(*ast.CallExpr)
		if !ok || selectorOrIdentName(inner.Fun) != "WithUnit" || len(inner.Args) != 1 {
			continue
		}
		if u, ok := stringLit(inner.Args[0]); ok {
			return name, u, true, nil
		}
	}
	return name, "", true, nil
}

// exportedName returns the Prometheus series names an OTel instrument produces.
func exportedName(otelName, unit string, kind instrumentType) ([]string, error) {
	base := strings.ReplaceAll(otelName, ".", "_")
	suffix, ok := instrumentUnitSuffix[unit]
	if !ok {
		if strings.HasPrefix(unit, "{") && strings.HasSuffix(unit, "}") {
			suffix = "" // annotations are dropped by the exporter
		} else {
			return nil, &unknownUnitError{name: otelName, unit: unit}
		}
	}
	switch kind {
	case instrumentCounter:
		return []string{base + suffix + "_total"}, nil
	case instrumentGauge:
		if unit == "1" {
			return []string{base + "_ratio"}, nil
		}
		return []string{base + suffix}, nil
	case instrumentUpDown:
		return []string{base + suffix}, nil
	case instrumentHistogram:
		full := base + suffix
		return []string{full, full + "_bucket", full + "_sum", full + "_count"}, nil
	}
	return nil, nil
}

type unknownUnitError struct{ name, unit string }

func (e *unknownUnitError) Error() string {
	return "instrument " + e.name + " has unit " + strconv.Quote(e.unit) +
		" with no entry in instrumentUnitSuffix; add the exporter's suffix for it"
}

func selectorOrIdentName(expr ast.Expr) string {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name
	case *ast.SelectorExpr:
		return e.Sel.Name
	}
	return ""
}

func stringLit(expr ast.Expr) (string, bool) {
	lit, ok := expr.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return "", false
	}
	s, err := strconv.Unquote(lit.Value)
	if err != nil {
		return "", false
	}
	return s, true
}

func TestChartAlertRulesReferenceDefinedMetrics(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", alertRulesRelPath))
	if err != nil {
		t.Fatalf("read %s: %v", alertRulesRelPath, err)
	}
	exprs := alertExprs(string(raw))
	refs := referencedPaprikaMetrics(exprs)
	if len(refs) < 3 {
		t.Fatalf("extracted only %d paprika_* references from %d expr blocks; the extractor is probably broken", len(refs), len(exprs))
	}
	defined := definedPaprikaMetrics(t)
	for _, name := range undefinedMetricRefs(refs, defined) {
		t.Errorf("%s references %s, which no Go instrument defines: the alert can never fire", alertRulesRelPath, name)
	}
}

// The guard must fail on a phantom. Feed it a synthetic rules block that
// references one defined and one undefined metric.
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

func TestAlertExprsReadsBlockScalars(t *testing.T) {
	rules := `
        - alert: Multi
          expr: |
            up{job="a"} == 0
            or
            absent(up{job="a"})
          for: 5m
        - alert: Single
          expr: paprika_releases_stuck > 0
`
	exprs := alertExprs(rules)
	if len(exprs) != 2 {
		t.Fatalf("got %d exprs, want 2: %q", len(exprs), exprs)
	}
	if !strings.Contains(exprs[0], "absent(") || strings.Contains(exprs[0], "for:") {
		t.Fatalf("block scalar captured wrong lines: %q", exprs[0])
	}
}

// The exporter naming rules, checked against instruments defined in this
// package. These pin the suffix behaviour the rules and docs rely on.
func TestExportedNamesMatchExporterConvention(t *testing.T) {
	defined := definedPaprikaMetrics(t)
	cases := map[string]string{
		"paprika_releases_stuck":                         "unit {release} gauge: no suffix",
		"paprika_fleet_index_degraded":                   "unit {state} gauge: no suffix",
		"paprika_applications_release_retries_exhausted": "unit {application} gauge: no suffix",
		"paprika_git_operations_total":                   "unit 1 counter: _total",
		"paprika_applications_active_ratio":              "unit 1 gauge: _ratio",
		"paprika_sse_connections":                        "unit 1 up-down counter: no suffix",
		"paprika_git_fetch_received_bytes_total":         "unit By counter: _bytes_total",
		"paprika_render_duration_seconds_bucket":         "histogram bucket series",
		"paprika_api_request_duration_seconds_bucket":    "prometheus histogram bucket series",
	}
	for name, why := range cases {
		if !defined[name] {
			t.Errorf("%s not derived (%s)", name, why)
		}
	}
	for _, phantom := range []string{"paprika_cluster_phase", "paprika_cache_errors_total", "paprika_webhook_errors_total", "paprika_ratelimit_denials_total"} {
		if defined[phantom] {
			t.Errorf("%s unexpectedly defined; the chart rules that used it were removed", phantom)
		}
	}
}
