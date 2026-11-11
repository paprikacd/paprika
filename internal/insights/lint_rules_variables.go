package insights

import "fmt"

var variableLintRules = []lintRule{
	{
		ID:       "variables.undeclared",
		Severity: warningSeverity,
		Summary:  "Bind each variable reference to a variable that the dashboard declares.",
		Fix:      "Declare the variable in the dashboard variables, or bind the reference to one that is declared.",
		check:    checkUndeclaredVariables,
	},
}

// checkUndeclaredVariables fires for each binding whose source is variable and
// whose variable name the dashboard does not declare. Such a widget fails at
// query time, so the warning is raised at save. Bindings with other sources are
// not variable references and are not checked.
func checkUndeclaredVariables(doc *lintDocument) []lintHit {
	var hits []lintHit
	for i := range doc.widgets {
		widget := &doc.widgets[i]
		for _, ref := range widget.variables {
			if doc.variables[ref.variable] {
				continue
			}
			hits = append(hits, lintHit{
				pointer:  ref.pointer,
				widgetID: widget.id,
				message:  fmt.Sprintf("binding reads variable %q, which the dashboard does not declare", ref.variable),
			})
		}
	}
	return hits
}
