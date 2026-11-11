package insights

import (
	"fmt"
	"regexp"
)

// guidanceVariables is the guidance line the variable and plugin rules map to.
const guidanceVariables = "Declare every variable a query placeholder or binding uses, and use plugin ids the schema notes name."

var variableLintRules = []lintRule{
	{
		ID:       "variables.undeclared",
		Severity: warningSeverity,
		Summary:  guidanceVariables,
		Fix:      "Declare the variable in the dashboard variables, or bind the reference to one that is declared.",
		check:    checkUndeclaredVariables,
	},
}

// placeholder matches a raw {{name}} placeholder in a widget query.
var placeholder = regexp.MustCompile(`\{\{([A-Za-z_][A-Za-z0-9_]{0,63})\}\}`)

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
