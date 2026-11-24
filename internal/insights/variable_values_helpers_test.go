package insights

import "github.com/benebsworth/paprika/internal/insights/variablevalue"

// variableValues lifts single-string test fixtures to the variable value type.
func variableValues(text map[string]string) map[string]variablevalue.Value {
	values := make(map[string]variablevalue.Value, len(text))
	for name, value := range text {
		values[name] = variablevalue.Single(value)
	}
	return values
}

// valueText is a single value's text, for assertions on single-value variables.
func valueText(value variablevalue.Value) string {
	text, _ := value.Text()
	return text
}

// valuePtr points at a single value, for declarations that take an optional default.
func valuePtr(text string) *variablevalue.Value {
	value := variablevalue.Single(text)
	return &value
}
