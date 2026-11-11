package metrics

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/prometheus/otlptranslator"
)

// exporterNamer names OTel instruments exactly as the OTel Prometheus exporter
// does: go.opentelemetry.io/otel/exporters/prometheus v0.69.0 calls
// otlptranslator.NewMetricNamer(namespace, UnderscoreEscapingWithSuffixes)
// with an empty namespace and no WithoutUnits or WithoutCounterSuffixes option.
// If the exporter version changes, re-check its getName and the strategy it
// passes.
var exporterNamer = otlptranslator.NewMetricNamer("", otlptranslator.UnderscoreEscapingWithSuffixes)

// scanExportedMetricNames returns the Prometheus series names that the paprika
// instruments defined in the non-test Go sources under root/internal and
// root/cmd are exported as.
//
// Two kinds of definition are read from the AST:
//   - Prometheus client options: the Name field of CounterOpts, GaugeOpts,
//     HistogramOpts and SummaryOpts literals is used verbatim.
//   - OTel instruments: the first string literal starting with "paprika." or
//     "paprika_" passed to a constructor (Int64Counter, Float64Histogram,
//     Int64ObservableGauge, the repo's mustCounter-style helpers, ...). Its unit
//     comes from the constructor's unit argument or metric.WithUnit. Entries of
//     a literal table of []struct{name, unit, ...} are treated as observable
//     gauges, which is how newHealthInstruments creates them.
//
// The OTel names are passed through the exporter's own namer, so suffixes such
// as _total, _ratio and unit suffixes match what Prometheus sees. Histograms
// also contribute _bucket, _sum and _count.
//
// Not covered: names that are not string literals, instruments created by
// computed names or by unit values that are not literals (an error is returned
// for units the namer cannot handle), and metrics emitted by other binaries or
// dependencies (controller-runtime, client-go, cAdvisor, kube-state-metrics).
func scanExportedMetricNames(root string) (map[string]bool, error) {
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
			// Cheap prefilter: most files define no paprika metrics. It also keeps the
			// large generated protobuf files out of the parser.
			if !bytes.Contains(src, []byte(`"paprika`)) {
				return nil
			}
			file, err := parser.ParseFile(fset, path, src, 0)
			if err != nil {
				return fmt.Errorf("parse %s: %w", path, err)
			}
			return collectMetricDefinitions(file, defined)
		})
		if err != nil {
			return nil, err
		}
	}
	return defined, nil
}

// collectMetricDefinitions adds the exported names defined in one file to defined.
func collectMetricDefinitions(file *ast.File, defined map[string]bool) error {
	var firstErr error
	record := func(names []string, err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
		for _, n := range names {
			defined[n] = true
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		if firstErr != nil {
			return false
		}
		switch node := n.(type) {
		case *ast.CompositeLit:
			if typeName := selectorOrIdentName(node.Type); strings.HasSuffix(typeName, "Opts") {
				record(prometheusOptNames(node, typeName))
				return true
			}
			if isInstrumentTable(node.Type) {
				for _, elt := range node.Elts {
					lit, ok := elt.(*ast.CompositeLit)
					if !ok || len(lit.Elts) < 2 {
						continue
					}
					name, ok := stringLit(lit.Elts[0])
					if !ok || !isPaprikaInstrumentName(name) {
						continue
					}
					unit, ok := stringLit(lit.Elts[1])
					if !ok {
						continue
					}
					record(exportedInstrumentNames(name, unit, otlptranslator.MetricTypeGauge))
				}
			}
		case *ast.CallExpr:
			callee := selectorOrIdentName(node.Fun)
			typ, ok := instrumentType(callee)
			if !ok {
				return true
			}
			name, unit, found, err := instrumentNameAndUnit(node, callee)
			if err != nil {
				record(nil, err)
				return false
			}
			if found {
				record(exportedInstrumentNames(name, unit, typ))
			}
		}
		return true
	})
	return firstErr
}

// prometheusOptNames reads the Name field of a Prometheus client options literal.
func prometheusOptNames(lit *ast.CompositeLit, typeName string) ([]string, error) {
	for _, elt := range lit.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok || selectorOrIdentName(kv.Key) != "Name" {
			continue
		}
		name, ok := stringLit(kv.Value)
		if !ok || !strings.HasPrefix(name, "paprika_") {
			continue
		}
		names := []string{name}
		switch typeName {
		case "HistogramOpts":
			names = append(names, name+"_bucket", name+"_sum", name+"_count")
		case "SummaryOpts":
			names = append(names, name+"_sum", name+"_count")
		}
		return names, nil
	}
	return nil, nil
}

// exportedInstrumentNames runs one OTel instrument through the exporter's namer.
// Histograms also yield their _bucket, _sum and _count series.
func exportedInstrumentNames(otelName, unit string, typ otlptranslator.MetricType) ([]string, error) {
	name, err := exporterNamer.Build(otlptranslator.Metric{Name: otelName, Unit: unit, Type: typ})
	if err != nil {
		return nil, fmt.Errorf("name instrument %s (unit %q): %w", otelName, unit, err)
	}
	if typ == otlptranslator.MetricTypeHistogram {
		return []string{name, name + "_bucket", name + "_sum", name + "_count"}, nil
	}
	return []string{name}, nil
}

// instrumentType classifies an OTel instrument constructor by name. It matches
// both the repo's must* helpers and the meter methods (Int64Counter, ...).
func instrumentType(callee string) (otlptranslator.MetricType, bool) {
	isOTel := strings.HasPrefix(callee, "must") ||
		strings.HasPrefix(callee, "Int64") || strings.HasPrefix(callee, "Float64")
	if !isOTel {
		return 0, false
	}
	switch {
	case strings.Contains(callee, "UpDown"):
		return otlptranslator.MetricTypeNonMonotonicCounter, true
	case strings.Contains(callee, "Counter"):
		return otlptranslator.MetricTypeMonotonicCounter, true
	case strings.Contains(callee, "Gauge"):
		return otlptranslator.MetricTypeGauge, true
	case strings.Contains(callee, "Histogram"):
		return otlptranslator.MetricTypeHistogram, true
	}
	return 0, false
}

// instrumentNameAndUnit extracts the literal instrument name and unit of a
// constructor call. must* helpers take the name as their second argument and
// the unit as their third, except mustCounter, which always uses unit "1".
// Meter methods take the name first and the unit via metric.WithUnit.
func instrumentNameAndUnit(call *ast.CallExpr, callee string) (name, unit string, found bool, err error) {
	nameIdx := -1
	for i, arg := range call.Args {
		if s, ok := stringLit(arg); ok && isPaprikaInstrumentName(s) {
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
			return "", "", false, nil // unit comes from a variable: not a literal definition
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

// isInstrumentTable reports whether a composite literal type is a slice of
// structs with name and unit fields, the shape of the health instrument table.
func isInstrumentTable(t ast.Expr) bool {
	arr, ok := t.(*ast.ArrayType)
	if !ok {
		return false
	}
	st, ok := arr.Elt.(*ast.StructType)
	if !ok {
		return false
	}
	var hasName, hasUnit bool
	for _, f := range st.Fields.List {
		for _, id := range f.Names {
			hasName = hasName || id.Name == "name"
			hasUnit = hasUnit || id.Name == "unit"
		}
	}
	return hasName && hasUnit
}

func isPaprikaInstrumentName(s string) bool {
	return strings.HasPrefix(s, "paprika.") || strings.HasPrefix(s, "paprika_")
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
