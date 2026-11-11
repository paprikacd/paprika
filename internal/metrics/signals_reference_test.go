package metrics

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// signalsReference is the agent-facing catalogue of platform metrics. Each row
// names its source identifier in the Source column, which is the Prometheus
// name for client collectors and the dotted OTel name for instruments.
const signalsReference = "../../.agents/skills/paprika-dashboard-design/references/paprika-signals.md"

var meterConstructors = map[string]bool{
	"Int64Counter": true, "Float64Counter": true, "Int64UpDownCounter": true,
	"Int64Histogram": true, "Float64Histogram": true, "Int64Gauge": true,
	"Float64Gauge": true, "Int64ObservableGauge": true, "Float64ObservableGauge": true,
}

// mustHelpers are the package-local wrappers in otel.go; their first argument is the meter.
var mustHelpers = map[string]bool{
	"mustCounter": true, "mustUnitCounter": true, "mustSyncGauge": true, "mustFloatHistogram": true,
	"mustHistogram": true, "mustGauge": true, "mustUpDownCounter": true,
}

// TestSignalsReferenceCoversDefinedMetrics fails when a metric defined in Go is
// missing from the agent reference, or when the reference lists a metric that
// no longer has a definition. It parses source; it does not run the exporter.
// Not covered: exporter suffix rules and units (checked by hand against
// exporter v0.69), labels, healthy ranges, PromQL, client-go and
// controller-runtime metrics, and names built at runtime.
func TestSignalsReferenceCoversDefinedMetrics(t *testing.T) {
	defined := definedMetricNames(t, "*.go", "../insights/server.go")
	require.NotEmpty(t, defined)

	body, err := os.ReadFile(signalsReference)
	require.NoError(t, err)
	listed := map[string]bool{}
	for _, line := range strings.Split(string(body), "\n") {
		if !strings.HasPrefix(line, "| `") {
			continue
		}
		// Cells are split on unescaped pipes; PromQL cells escape theirs as \|,
		// so the Source column (index 2 after the leading empty field) is stable.
		cells := strings.Split(line, "|")
		require.GreaterOrEqual(t, len(cells), 8, "table row must have seven cells: %s", line)
		listed[strings.Trim(strings.TrimSpace(cells[2]), "`")] = true
	}

	var missing, stale []string
	for name := range defined {
		if !listed[name] {
			missing = append(missing, name)
		}
	}
	for name := range listed {
		if !defined[name] {
			stale = append(stale, name)
		}
	}
	sort.Strings(missing)
	sort.Strings(stale)
	require.Empty(t, missing, "defined in Go but missing from %s (add a row with its Source name)", signalsReference)
	require.Empty(t, stale, "listed in %s but no longer defined in Go", signalsReference)
}

// definedMetricNames returns Prometheus collector names and OTel instrument names
// (dotted, as passed to the meter) defined in the files matched by patterns.
func definedMetricNames(t *testing.T, patterns ...string) map[string]bool {
	t.Helper()
	fset := token.NewFileSet()
	names := map[string]bool{}
	for _, pattern := range patterns {
		files, err := filepath.Glob(pattern)
		require.NoError(t, err)
		for _, file := range files {
			if strings.HasSuffix(file, "_test.go") {
				continue
			}
			parsed, err := parser.ParseFile(fset, file, nil, 0)
			require.NoError(t, err)
			ast.Inspect(parsed, func(node ast.Node) bool {
				switch n := node.(type) {
				case *ast.KeyValueExpr:
					// prometheus.CounterOpts{Name: "paprika_..."} and similar Opts literals.
					if key, ok := n.Key.(*ast.Ident); ok && key.Name == "Name" {
						if name, ok := stringLiteral(n.Value); ok && strings.HasPrefix(name, "paprika_") {
							names[name] = true
						}
					}
				case *ast.CallExpr:
					if name, ok := instrumentName(n); ok {
						names[name] = true
					}
				case *ast.CompositeLit:
					// health.go declares its gauges as {name, unit, description} rows.
					if len(n.Elts) >= 1 {
						if name, ok := stringLiteral(n.Elts[0]); ok && strings.HasPrefix(name, "paprika.") && strings.Count(name, ".") >= 2 {
							names[name] = true
						}
					}
				}
				return true
			})
		}
	}
	// Keep only names shaped like metric identifiers.
	return filterMetricNames(names)
}

var metricNamePattern = regexp.MustCompile(`^paprika(\.[a-z][a-z0-9_]*)+$|^paprika_[a-z][a-z0-9_]*$`)

func filterMetricNames(names map[string]bool) map[string]bool {
	out := map[string]bool{}
	for name := range names {
		if metricNamePattern.MatchString(name) {
			out[name] = true
		}
	}
	return out
}

func instrumentName(call *ast.CallExpr) (string, bool) {
	switch fn := call.Fun.(type) {
	case *ast.SelectorExpr:
		if meterConstructors[fn.Sel.Name] && len(call.Args) >= 1 {
			return stringLiteral(call.Args[0])
		}
	case *ast.Ident:
		if mustHelpers[fn.Name] && len(call.Args) >= 2 {
			return stringLiteral(call.Args[1])
		}
	}
	return "", false
}

func stringLiteral(expr ast.Expr) (string, bool) {
	lit, ok := expr.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return "", false
	}
	value, err := strconv.Unquote(lit.Value)
	return value, err == nil
}
