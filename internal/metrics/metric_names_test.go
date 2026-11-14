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
	"sort"
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

// metricDefinition is one paprika metric definition found in the Go sources.
type metricDefinition struct {
	Source   string   // the OTel dotted name, or the Prometheus name for client collectors
	Exported string   // the base Prometheus name after the exporter's naming rules
	Kind     string   // Counter, Gauge or Histogram: the exported Prometheus type
	Series   []string // every exported series: Exported, plus _bucket/_sum/_count for histograms
	File     string   // source path relative to root, for diagnostics
}

// scanExportedMetricNames returns every Prometheus series name that the paprika
// metric definitions under root/internal and root/cmd export, including the
// _bucket, _sum and _count series of histograms.
func scanExportedMetricNames(root string) (map[string]bool, error) {
	defs, err := scanMetricDefinitions(root)
	if err != nil {
		return nil, err
	}
	names := map[string]bool{}
	for _, def := range defs {
		for _, series := range def.Series {
			names[series] = true
		}
	}
	return names, nil
}

// scanMetricDefinitions reads every paprika metric definition from the non-test
// Go sources under root/internal and root/cmd. Two kinds of definition are read
// from the AST:
//   - Prometheus client options: CounterOpts, GaugeOpts and HistogramOpts literals
//     whose Name, optionally joined with Namespace and Subsystem, starts with
//     "paprika". The result is used verbatim.
//   - OTel instruments: the first argument starting with "paprika." or "paprika_"
//     passed to a constructor (Int64Counter, Float64Histogram, ...) or to any
//     must* helper. The unit is a string literal in the constructor's unit
//     position, a metric.WithUnit argument, or "1" for mustCounter. The name is
//     then passed through the exporter's namer, so suffixes match what
//     Prometheus sees.
//   - Entries of a literal table of []struct{name, unit, ...} are treated as
//     observable gauges, which is how newHealthInstruments creates them.
//
// String values are resolved through package-level string constants in the
// same package directory and through "+" concatenation. A name or unit that
// cannot be resolved to a value is an error, so a definition cannot disappear
// silently.
//
// Not covered: constants defined in another package and referenced with a
// selector (pkg.Const), computed names, metrics emitted by dependencies
// (controller-runtime, client-go, cAdvisor), and metric types that the
// constructor name does not reveal (a must* helper whose name has no Counter,
// Gauge or Histogram in it is rejected rather than guessed).
func scanMetricDefinitions(root string) ([]metricDefinition, error) {
	fset := token.NewFileSet()
	var parsed []parsedSource
	for _, dir := range []string{"internal", "cmd"} {
		if _, err := os.Stat(filepath.Join(root, dir)); os.IsNotExist(err) {
			continue
		}
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
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			parsed = append(parsed, parsedSource{file: file, dir: filepath.Dir(path), rel: rel})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	c := &collector{consts: map[string]string{}}
	for _, src := range parsed {
		c.collectConsts(src)
	}
	var defs []metricDefinition
	for _, src := range parsed {
		found, err := c.collectDefinitions(src)
		if err != nil {
			return nil, err
		}
		defs = append(defs, found...)
	}
	sort.Slice(defs, func(i, j int) bool { return defs[i].Exported < defs[j].Exported })
	return defs, nil
}

type parsedSource struct {
	file *ast.File
	dir  string
	rel  string
}

type collector struct {
	consts map[string]string // key: package directory + "\x00" + constant name
}

// collectConsts records package-level string constants of one file.
func (c *collector) collectConsts(src parsedSource) {
	for _, decl := range src.file.Decls {
		gen, ok := decl.(*ast.GenDecl)
		if !ok || gen.Tok != token.CONST {
			continue
		}
		for _, spec := range gen.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for i, id := range vs.Names {
				if i >= len(vs.Values) {
					continue
				}
				if v, ok := c.str(vs.Values[i], src.dir); ok {
					c.consts[src.dir+"\x00"+id.Name] = v
				}
			}
		}
	}
}

// str resolves an expression to a string value within the package directory dir.
func (c *collector) str(expr ast.Expr, dir string) (string, bool) {
	switch e := expr.(type) {
	case *ast.BasicLit:
		if e.Kind != token.STRING {
			return "", false
		}
		s, err := strconv.Unquote(e.Value)
		return s, err == nil
	case *ast.Ident:
		v, ok := c.consts[dir+"\x00"+e.Name]
		return v, ok
	case *ast.ParenExpr:
		return c.str(e.X, dir)
	case *ast.BinaryExpr:
		if e.Op != token.ADD {
			return "", false
		}
		l, lok := c.str(e.X, dir)
		r, rok := c.str(e.Y, dir)
		return l + r, lok && rok
	}
	return "", false
}

// collectDefinitions returns the paprika metric definitions in one file.
func (c *collector) collectDefinitions(src parsedSource) ([]metricDefinition, error) {
	var defs []metricDefinition
	var firstErr error
	add := func(source, exported string, kind string) {
		def := metricDefinition{Source: source, Exported: exported, Kind: kind, File: src.rel, Series: []string{exported}}
		if kind == "Histogram" {
			def.Series = append(def.Series, exported+"_bucket", exported+"_sum", exported+"_count")
		}
		defs = append(defs, def)
	}
	ast.Inspect(src.file, func(n ast.Node) bool {
		if firstErr != nil {
			return false
		}
		switch node := n.(type) {
		case *ast.CompositeLit:
			if typeName := selectorOrIdentName(node.Type); strings.HasSuffix(typeName, "Opts") {
				if name, kind, ok := c.prometheusOpts(node, typeName, src.dir); ok {
					add(name, name, kind)
				}
				return true
			}
			if isInstrumentTable(node.Type) {
				for _, elt := range node.Elts {
					lit, ok := elt.(*ast.CompositeLit)
					if !ok || len(lit.Elts) < 2 {
						continue
					}
					name, ok := c.str(lit.Elts[0], src.dir)
					if !ok || !isPaprikaInstrumentName(name) {
						continue
					}
					unit, ok := c.str(lit.Elts[1], src.dir)
					if !ok {
						firstErr = fmt.Errorf("%s: unit of health table entry %s is not a string value", src.rel, name)
						return false
					}
					exported, kind, err := exportedInstrument(name, unit, otlptranslator.MetricTypeGauge)
					if err != nil {
						firstErr = fmt.Errorf("%s: %w", src.rel, err)
						return false
					}
					add(name, exported, kind)
				}
			}
		case *ast.CallExpr:
			callee := selectorOrIdentName(node.Fun)
			typ, ok := instrumentType(callee)
			if !ok {
				return true
			}
			name, unit, found, err := c.instrumentNameAndUnit(node, callee, src.dir)
			if err != nil {
				firstErr = fmt.Errorf("%s: %w", src.rel, err)
				return false
			}
			if found {
				exported, kind, err := exportedInstrument(name, unit, typ)
				if err != nil {
					firstErr = fmt.Errorf("%s: %w", src.rel, err)
					return false
				}
				add(name, exported, kind)
			}
		}
		return true
	})
	return defs, firstErr
}

// prometheusOpts reads a Prometheus client options literal. The full name is
// Namespace_Subsystem_Name with empty parts dropped; only names starting with
// "paprika" are paprika metrics.
func (c *collector) prometheusOpts(lit *ast.CompositeLit, typeName string, dir string) (string, string, bool) {
	fields := map[string]string{}
	for _, elt := range lit.Elts {
		kv, ok := elt.(*ast.KeyValueExpr)
		if !ok {
			continue
		}
		key := selectorOrIdentName(kv.Key)
		if key != "Name" && key != "Namespace" && key != "Subsystem" {
			continue
		}
		if v, ok := c.str(kv.Value, dir); ok {
			fields[key] = v
		}
	}
	var parts []string
	for _, key := range []string{"Namespace", "Subsystem", "Name"} {
		if fields[key] != "" {
			parts = append(parts, fields[key])
		}
	}
	name := strings.Join(parts, "_")
	if !strings.HasPrefix(name, "paprika") || fields["Name"] == "" {
		return "", "", false
	}
	kinds := map[string]string{"CounterOpts": "Counter", "GaugeOpts": "Gauge", "HistogramOpts": "Histogram"}
	kind, ok := kinds[typeName]
	return name, kind, ok
}

// exportedInstrument runs one OTel instrument through the exporter's namer and
// returns its Prometheus base name and type.
func exportedInstrument(otelName, unit string, typ otlptranslator.MetricType) (string, string, error) {
	name, err := exporterNamer.Build(otlptranslator.Metric{Name: otelName, Unit: unit, Type: typ})
	if err != nil {
		return "", "", fmt.Errorf("name instrument %s (unit %q): %w", otelName, unit, err)
	}
	kinds := map[otlptranslator.MetricType]string{
		otlptranslator.MetricTypeMonotonicCounter:    "Counter",
		otlptranslator.MetricTypeNonMonotonicCounter: "Gauge",
		otlptranslator.MetricTypeGauge:               "Gauge",
		otlptranslator.MetricTypeHistogram:           "Histogram",
	}
	return name, kinds[typ], nil
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

// instrumentNameAndUnit extracts the name and unit of a constructor call.
// The name is the first argument that resolves to a paprika instrument name.
// The unit is, in order: "1" for mustCounter; the string at the position after
// the name for must* helpers; a metric.WithUnit argument anywhere in the call.
// A missing unit is "". A unit that is present but not a value is an error.
func (c *collector) instrumentNameAndUnit(call *ast.CallExpr, callee, dir string) (name, unit string, found bool, err error) {
	nameIdx := -1
	for i, arg := range call.Args {
		if s, ok := c.str(arg, dir); ok && isPaprikaInstrumentName(s) {
			name, nameIdx = s, i
			break
		}
	}
	if nameIdx < 0 {
		return "", "", false, nil
	}
	if callee == "mustCounter" {
		return name, "1", true, nil
	}
	if strings.HasPrefix(callee, "must") && nameIdx+1 < len(call.Args) {
		if u, ok := c.str(call.Args[nameIdx+1], dir); ok {
			return name, u, true, nil
		}
	}
	for _, arg := range call.Args {
		inner, ok := arg.(*ast.CallExpr)
		if !ok || selectorOrIdentName(inner.Fun) != "WithUnit" || len(inner.Args) != 1 {
			continue
		}
		u, ok := c.str(inner.Args[0], dir)
		if !ok {
			return "", "", false, fmt.Errorf("metric.WithUnit for %s must be a string value", name)
		}
		return name, u, true, nil
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
