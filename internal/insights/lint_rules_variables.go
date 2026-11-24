package insights

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"

	"github.com/benebsworth/paprika/internal/insights/variablevalue"
)

// guidanceVariables is the guidance line the variable and plugin rules map to.
const guidanceVariables = "Declare every variable a query placeholder or binding uses, and give each plugin widget a built-in plugin id."

// Guidance lines for variable sources. Each rule's summary is its line verbatim. The undeclared source
// dependency rule shares guidanceVariables, which already says every placeholder and binding must be declared.
const (
	guidanceSourceProvider = "A label-values variable with a selector needs a Prometheus provider, because only Prometheus matches a selector."
	guidanceSourceDefault  = "A variable with a source sets a defaultValue, because a source does not choose a value on its own."
	guidanceSourceQuery    = "A variable source reads a metrics or records saved query, because a traces result has no column or series label to supply values."
)

// savedQueryKindKey is the key a saved query's kind takes in the resolved map the rules read. Provider IDs share
// that map, and a valid ID never contains a colon, so the prefix keeps the two apart.
func savedQueryKindKey(id string) string {
	return "saved-query:" + id
}

var variableLintRules = []lintRule{
	{
		ID:       "variables.undeclared",
		Severity: warningSeverity,
		Summary:  guidanceVariables,
		Fix:      "Declare the variable in the dashboard variables, or bind the reference to one that is declared.",
		check:    checkUndeclaredVariables,
	},
	{
		ID:       "variables.source-provider-kind",
		Severity: warningSeverity,
		Summary:  guidanceSourceProvider,
		Fix:      "Point the selector's variable source at a Prometheus provider, or remove the selector.",
		check:    checkSourceProviderKind,
	},
	{
		ID:       "variables.source-query-kind",
		Severity: errorSeverity,
		Summary:  guidanceSourceQuery,
		Fix:      "Point the source at a metrics or records saved query, or read the values from a label-values source.",
		check:    checkSourceQueryKind,
	},
	{
		ID:       "variables.source-undeclared-dependency",
		Severity: warningSeverity,
		Summary:  guidanceVariables,
		Fix:      "Declare the variable a source placeholder or binding reads, or remove the reference.",
		check:    checkSourceUndeclaredDependency,
	},
	{
		ID:       "variables.source-no-default",
		Severity: infoSeverity,
		Summary:  guidanceSourceDefault,
		Fix:      "Set a default value for the variable, or leave it unset and choose a value when the dashboard opens.",
		check:    checkSourceNoDefault,
	},
	{
		ID:       "variables.multi-operator",
		Severity: errorSeverity,
		Summary:  guidanceMultiValues,
		Fix:      "Use =~ or !~ before {{name}}, or bind it in a SQL parameters array with = ANY($n).",
		check:    checkMultiOperator,
	},
	{
		ID:       "variables.multi-binding",
		Severity: errorSeverity,
		Summary:  guidanceMultiValues,
		Fix:      "Bind the variable to a parameter of several values, or turn off Allow several values on the variable.",
		check:    checkMultiBinding,
	},
}

// guidanceMultiValues is the one composition line both several-values rules share. A list is only valid after a
// regex operator or in an array, and a list binds only a parameter of several values.
const guidanceMultiValues = "A variable with several values is used after =~ or !~, or as an element of a SQL parameters array, and binds only a saved query parameter of several values."

// savedQueryParameterKey is the key a saved query parameter's several-values flag takes in the resolved map.
// Its value is "multi" or "single".
func savedQueryParameterKey(id, parameter string) string {
	return "saved-query-parameter:" + id + ":" + parameter
}

// resolveSavedQueryParameterKinds records, for each stored saved query, whether each parameter takes several values
// ("multi") or one ("single"), under savedQueryParameterKey. An id that is not stored is left out.
func (s *Server) resolveSavedQueryParameterKinds(ids []string) map[string]string {
	var kinds map[string]string
	for _, id := range ids {
		document, _, err := s.savedQueries.get(id)
		if err != nil {
			continue
		}
		var stored struct {
			Parameters []struct {
				Name  string `json:"name"`
				Multi bool   `json:"multi"`
			} `json:"parameters"`
		}
		if json.Unmarshal(document, &stored) != nil {
			continue
		}
		for _, parameter := range stored.Parameters {
			if kinds == nil {
				kinds = map[string]string{}
			}
			kinds[savedQueryParameterKey(id, parameter.Name)] = "single"
			if parameter.Multi {
				kinds[savedQueryParameterKey(id, parameter.Name)] = "multi"
			}
		}
	}
	return kinds
}

// checkMultiOperator fires for a placeholder of a variable with several values that is not after =~, !~ or inside
// an array. Equality and function arguments cannot take a list, so the query would fail at the provider. Widget
// queries without a saved query and source selectors are checked.
func checkMultiOperator(doc *lintDocument) []lintHit {
	return append(multiOperatorWidgetHits(doc), multiOperatorSelectorHits(doc)...)
}

// multiOperatorWidgetHits checks the raw query placeholders of widgets that have no saved query.
func multiOperatorWidgetHits(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		if widget.hasQueryRef {
			continue
		}
		for _, match := range placeholder.FindAllStringSubmatchIndex(widget.query, -1) {
			name := widget.query[match[2]:match[3]]
			if doc.multi[name] && listContextBefore(widget.query[:match[0]]) == contextNone {
				hits = append(hits, lintHit{
					pointer:  widgetBase(widget.index) + "/query",
					widgetID: widget.id,
					message:  fmt.Sprintf("%s reads variable %q, which takes several values, outside =~, !~ or an array", widgetLabel(widget), name),
				})
			}
		}
	}
	return hits
}

// multiOperatorSelectorHits checks the placeholders of label-values source selectors.
func multiOperatorSelectorHits(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.sourceVariables {
		variable := &doc.sourceVariables[i]
		if variable.selector == nil {
			continue
		}
		for _, match := range variableSourceSelectorPlaceholder.FindAllStringSubmatchIndex(*variable.selector, -1) {
			name := (*variable.selector)[match[2]:match[3]]
			if doc.multi[name] && listContextBefore((*variable.selector)[:match[0]]) == contextNone {
				hits = append(hits, lintHit{
					pointer: variableSourcePointer(variable.index) + "/selector",
					message: fmt.Sprintf("The source selector reads variable %q, which takes several values, outside =~, !~ or an array", name),
				})
			}
		}
	}
	return hits
}

// checkMultiBinding fires for a saved query parameter of one value that a variable with several values binds. A
// single value binds a parameter of several values, because it is wrapped as a one-item list; the reverse is not valid.
func checkMultiBinding(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		for _, ref := range widget.variables {
			if ref.queryRefID == "" || !doc.multi[ref.variable] {
				continue
			}
			if kind, known := doc.providerTypes[savedQueryParameterKey(ref.queryRefID, ref.parameter)]; known && kind == "single" {
				hits = append(hits, lintHit{
					pointer:  ref.pointer,
					widgetID: widget.id,
					message:  fmt.Sprintf("%s binds variable %q, which takes several values, to parameter %q, which takes one value", widgetLabel(widget), ref.variable, ref.parameter),
				})
			}
		}
	}
	return hits
}

// placeholder matches a raw {{name}} placeholder in a widget query.
var placeholder = regexp.MustCompile(`\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}`)

// lintVariable is one declared variable with the members the variable rules read.
// sourceType is empty when the variable has no source.
type lintVariable struct {
	index        int
	name         string
	defaultValue *variablevalue.Value
	options      []string
	sourceType   string
	providerID   string
	// queryRefID is the saved query a savedQuery source reads, resolved to its kind by the caller.
	queryRefID string
	selector   *string
	// refs lists each variable the source reads, with the pointer of the member that reads it.
	refs []lintVariableRef
}

// variableBase is the JSON Pointer of a declared variable by its index.
func variableBase(index int) string {
	return "/variables/" + strconv.Itoa(index)
}

func lintVariableOf(i int, variable *wireVariable) lintVariable {
	lv := lintVariable{index: i, name: variable.Name, defaultValue: variable.DefaultValue, options: variable.Options}
	if variable.Source == nil {
		return lv
	}
	base := variableBase(i) + "/source"
	lv.sourceType = variable.Source.Type
	lv.providerID = variable.Source.ProviderID
	lv.selector = variable.Source.Selector
	if variable.Source.QueryRef != nil {
		lv.queryRefID = variable.Source.QueryRef.ID
	}
	if variable.Source.Selector != nil {
		for _, match := range variableSourceSelectorPlaceholder.FindAllStringSubmatch(*variable.Source.Selector, -1) {
			lv.refs = append(lv.refs, lintVariableRef{pointer: base + "/selector", variable: match[1]})
		}
	}
	lv.refs = append(lv.refs, variableRefs(base+"/queryRef", variable.Source.QueryRef)...)
	return lv
}

// checkUndeclaredVariables fires for each variable the dashboard does not
// declare that a widget reads. Those reads are: a variable binding in a saved
// query reference (widget, annotation or saved tooltip), a selection binding, and
// a raw {{name}} placeholder in a widget query that has no saved query. Such a
// read fails at query time or is rejected when the selection is made, so the
// warning is raised at save. A saved query widget's own query text is not used,
// so its placeholders are not checked. The pointer names the member that reads the
// variable.
func checkUndeclaredVariables(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		for _, ref := range widget.variables {
			if !doc.variables[ref.variable] {
				hits = append(hits, undeclaredVariableHit(widget, ref.pointer, ref.variable))
			}
		}
		if widget.hasQueryRef {
			continue
		}
		for _, match := range placeholder.FindAllStringSubmatch(widget.query, -1) {
			if !doc.variables[match[1]] {
				hits = append(hits, undeclaredVariableHit(widget, widgetBase(widget.index)+"/query", match[1]))
			}
		}
	}
	return hits
}

func undeclaredVariableHit(widget *lintWidget, pointer, name string) lintHit {
	return lintHit{
		pointer:  pointer,
		widgetID: widget.id,
		message:  fmt.Sprintf("%s reads variable %q, which the dashboard does not declare", widgetLabel(widget), name),
	}
}

// checkSourceProviderKind fires for a label-values source on a provider that is known to be another type. The
// metadata path serves only Prometheus and Tempo, and only Prometheus matches a selector. An unknown provider is
// not reported here, because its type is not resolved for this check.
func checkSourceProviderKind(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.sourceVariables {
		variable := &doc.sourceVariables[i]
		if variable.sourceType != "labelValues" {
			continue
		}
		providerType, known := doc.providerTypes[variable.providerID]
		if !known {
			continue
		}
		if providerType != "prometheus" && providerType != "tempo" {
			hits = append(hits, lintHit{
				pointer: variableBase(variable.index) + "/source/providerId",
				message: fmt.Sprintf("variable %q reads label values from a %s provider; label values come only from Prometheus or Tempo providers", variable.name, providerType),
			})
			continue
		}
		if variable.selector == nil || providerType == "prometheus" {
			continue
		}
		hits = append(hits, lintHit{
			pointer: variableBase(variable.index) + "/source/selector",
			message: fmt.Sprintf("variable %q selects label values with a selector on a %s provider; a selector needs a Prometheus provider", variable.name, providerType),
		})
	}
	return hits
}

// checkSourceQueryKind refuses a savedQuery source that reads a traces saved query. Its kind is resolved by the
// caller; a query that does not resolve is left out and does not fire.
func checkSourceQueryKind(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.sourceVariables {
		variable := &doc.sourceVariables[i]
		if variable.sourceType != "savedQuery" || variable.queryRefID == "" {
			continue
		}
		if kind, known := doc.providerTypes[savedQueryKindKey(variable.queryRefID)]; !known || kind != "traces" {
			continue
		}
		hits = append(hits, lintHit{
			pointer: variableBase(variable.index) + "/source/queryRef",
			message: fmt.Sprintf("variable %q reads values from traces saved query %q; a variable source needs a metrics or records query", variable.name, variable.queryRefID),
		})
	}
	return hits
}

// checkSourceUndeclaredDependency fires for a source placeholder or binding that reads a variable the dashboard does
// not declare. The save check refuses such a source already, so this rule guards documents read without that check.
func checkSourceUndeclaredDependency(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.sourceVariables {
		variable := &doc.sourceVariables[i]
		for _, ref := range variable.refs {
			if !doc.variables[ref.variable] {
				hits = append(hits, lintHit{
					pointer: ref.pointer,
					message: fmt.Sprintf("variable %q has a source that reads variable %q, which the dashboard does not declare", variable.name, ref.variable),
				})
			}
		}
	}
	return hits
}

// checkSourceNoDefault is an info hint for a sourced variable without a default. A source never selects a value,
// so its widgets stay unset until someone chooses one.
func checkSourceNoDefault(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.sourceVariables {
		variable := &doc.sourceVariables[i]
		if variable.sourceType == "" || variable.defaultValue != nil {
			continue
		}
		hits = append(hits, lintHit{
			pointer: variableBase(variable.index),
			message: fmt.Sprintf("variable %q has a source but no default value, so its widgets stay unset until a value is chosen", variable.name),
		})
	}
	return hits
}
