package insights

import (
	"fmt"
	"regexp"
	"strconv"
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
}

// placeholder matches a raw {{name}} placeholder in a widget query.
var placeholder = regexp.MustCompile(`\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}`)

// lintVariable is one declared variable with the members the variable rules read.
// sourceType is empty when the variable has no source.
type lintVariable struct {
	index        int
	name         string
	defaultValue *string
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
