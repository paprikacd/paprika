// Package variablevalue holds the value of a dashboard variable: one string, or a list of strings for a
// variable with several values. The list rules here mirror ui/src/features/insights/variable-values.ts.
package variablevalue

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"unicode/utf16"
)

// MaxItems bounds a list value. MaxUnits bounds its items plus one separator per gap, in UTF-16 units: the
// same budget as one string value, so URLs, MCP arguments and dry-run envelopes stay bounded.
const (
	MaxItems = 100
	MaxUnits = 1024
)

// Value is a variable value. A single value holds one item with List false. A list holds its items in order;
// an empty list means All, and only a variable with allowAll may hold one.
type Value struct {
	Items []string
	List  bool
}

// Single returns a single-value variable's value.
func Single(text string) Value {
	return Value{Items: []string{text}}
}

// List returns a multi-value variable's value.
func List(items []string) Value {
	if items == nil {
		items = []string{}
	}
	return Value{Items: items, List: true}
}

// Text returns the value of a single-value variable. It reports false for a list.
func (v Value) Text() (string, bool) {
	if v.List || len(v.Items) != 1 {
		return "", false
	}
	return v.Items[0], true
}

// Validate reports whether the value is within its bounds: a single value is one string of at most MaxUnits,
// and a list has at most MaxItems unique items within the combined unit budget.
func (v Value) Validate() error {
	if !v.List {
		if len(v.Items) != 1 || units(v.Items[0]) > MaxUnits {
			return errors.New("variable value must be a string of up to 1024 characters")
		}
		return nil
	}
	if len(v.Items) > MaxItems {
		return errors.New("variable lists hold at most 100 values")
	}
	seen := make(map[string]bool, len(v.Items))
	total := 0
	for index, item := range v.Items {
		if seen[item] {
			return errors.New("variable lists must not repeat a value")
		}
		seen[item] = true
		total += units(item)
		if index > 0 {
			total++ // The separator between items.
		}
	}
	if total > MaxUnits {
		return errors.New("variable list is longer than 1024 characters")
	}
	return nil
}

// Normalize applies a variable's declaration to a value. A multi-value variable takes a single string as a
// one-item list. An empty list is All and needs allowAll. A single-value variable takes no list.
func (v Value) Normalize(multi, allowAll bool) (Value, error) {
	if !multi {
		if v.List {
			return Value{}, errors.New("a list needs a variable with several values")
		}
		return v, v.Validate()
	}
	if !v.List {
		v = List(slices.Clone(v.Items))
	}
	if len(v.Items) == 0 && !allowAll {
		return Value{}, errors.New("an empty list means All; turn on Include All")
	}
	return v, v.Validate()
}

// MarshalJSON writes a string for a single value and an array for a list. An empty list is [], never null.
func (v Value) MarshalJSON() ([]byte, error) {
	var encoded []byte
	var err error
	if v.List {
		encoded, err = json.Marshal(List(v.Items).Items)
	} else {
		text, _ := v.Text()
		encoded, err = json.Marshal(text)
	}
	if err != nil {
		return nil, fmt.Errorf("encode variable value: %w", err)
	}
	return encoded, nil
}

// UnmarshalJSON accepts a string or an array of strings. Any other JSON shape is an error.
func (v *Value) UnmarshalJSON(raw []byte) error {
	if string(bytes.TrimSpace(raw)) == "null" {
		return errors.New("variable values must be a string or an array of strings")
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		*v = Single(text)
		return nil
	}
	var elements []json.RawMessage
	if err := json.Unmarshal(raw, &elements); err != nil || elements == nil {
		return errors.New("variable values must be a string or an array of strings")
	}
	items := make([]string, 0, len(elements))
	for _, element := range elements {
		var item string
		if err := json.Unmarshal(element, &item); err != nil || string(bytes.TrimSpace(element)) == "null" {
			return errors.New("variable values must be a string or an array of strings")
		}
		items = append(items, item)
	}
	*v = List(items)
	return nil
}

func units(text string) int {
	return len(utf16.Encode([]rune(text)))
}
