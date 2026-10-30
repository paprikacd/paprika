package insights

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
)

var errSavedQueryCompatibility = errors.New("saved query replacement would invalidate a persisted dashboard")

// Match the browser's numeric binding grammar. JSON's decoder alone accepts
// surrounding whitespace, which a dashboard parameter deliberately does not.
var savedQueryNumericLiteral = regexp.MustCompile(`^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$`)

type persistedQueryBinding struct {
	Parameter string          `json:"parameter"`
	Source    string          `json:"source"`
	Field     string          `json:"field"`
	Value     json.RawMessage `json:"value"`
}

type persistedQueryReference struct {
	ID       string                  `json:"id"`
	Bindings []persistedQueryBinding `json:"bindings"`
}

func queryParameters(query *SavedQuery) map[string]SavedQueryParameter {
	parameters := make(map[string]SavedQueryParameter, len(query.Parameters))
	for _, parameter := range query.Parameters {
		parameters[parameter.Name] = parameter
	}
	return parameters
}

func compatibleBindingLiteral(raw json.RawMessage, kind string) bool {
	var value any
	if json.Unmarshal(raw, &value) != nil {
		return false
	}
	if text, ok := value.(string); ok && kind == "number" {
		if !savedQueryNumericLiteral.MatchString(text) {
			return false
		}
		number, err := strconv.ParseFloat(text, 64)
		return err == nil && finite(number)
	}
	return validateQueryLiteral(raw, kind) == nil
}

// Stable issue keys allow an unrelated edit to an already incomplete portable
// reference. Comparing rendered messages would treat a renamed query as a new
// incompatibility even when its contract is unchanged.
func queryReferenceIssues(query *SavedQuery, reference persistedQueryReference) map[string]string {
	parameters := queryParameters(query)
	issues := map[string]string{}
	bound := map[string]bool{}
	for _, binding := range reference.Bindings {
		bound[binding.Parameter] = true
		parameter, exists := parameters[binding.Parameter]
		if !exists {
			issues["missing:"+binding.Parameter] = fmt.Sprintf("bound parameter %q no longer exists", binding.Parameter)
			continue
		}
		addBindingTypeIssue(issues, binding, parameter)
	}
	for _, parameter := range query.Parameters {
		if len(parameter.DefaultValue) == 0 && !bound[parameter.Name] {
			issues["required:"+parameter.Name] = fmt.Sprintf("required parameter %q has no binding or default", parameter.Name)
		}
	}
	return issues
}

// The caller holds Server.mutations across this check and the query write.
// Dashboard persistence intentionally permits unresolved portable references;
// reject only newly introduced incompatibilities, not every existing problem.
func (s *Store) validateSavedQueryReplacement(previous, incoming *SavedQuery) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ids := make([]string, 0, len(s.documents))
	for id := range s.documents {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	check := func(reference persistedQueryReference, dashboard, widget, location string) error {
		message := savedQueryReplacementIssue(previous, incoming, reference)
		if message == "" {
			return nil
		}
		return fmt.Errorf("%w: dashboard %q, widget %q (%s): %s; repair its bindings or create a copy", errSavedQueryCompatibility, dashboard, widget, location, message)
	}
	for _, id := range ids {
		if err := checkDashboardQueryReferences(s.documents[id], check); err != nil {
			return err
		}
	}
	return nil
}

func addBindingTypeIssue(issues map[string]string, binding persistedQueryBinding, parameter SavedQueryParameter) {
	switch binding.Source {
	case "constant":
		if !compatibleBindingLiteral(binding.Value, parameter.Type) {
			issues["constant:"+binding.Parameter] = fmt.Sprintf("the fixed value for parameter %q is incompatible with its %s type", binding.Parameter, parameter.Type)
		}
	case "field":
		expected := "number"
		if binding.Field == "series" {
			expected = "string"
		}
		if parameter.Type != expected {
			issues["field:"+binding.Parameter] = fmt.Sprintf("observation %s is incompatible with parameter %q", binding.Field, binding.Parameter)
		}
	}
}

func checkDashboardQueryReferences(raw json.RawMessage, check func(persistedQueryReference, string, string, string) error) error {
	var dashboard struct {
		Title   string
		Widgets []struct {
			Title            string
			QueryRef         persistedQueryReference `json:"queryRef"`
			AnnotationSource struct {
				QueryRef persistedQueryReference `json:"queryRef"`
			} `json:"annotationSource"`
			Options struct {
				TooltipView struct {
					Source struct {
						Type string
						Ref  persistedQueryReference
					}
				} `json:"tooltipView"`
			}
		}
	}
	if json.Unmarshal(raw, &dashboard) != nil {
		return errors.New("invalid stored dashboard")
	}
	for _, widget := range dashboard.Widgets {
		if err := check(widget.QueryRef, dashboard.Title, widget.Title, "query"); err != nil {
			return err
		}
		if err := check(widget.AnnotationSource.QueryRef, dashboard.Title, widget.Title, "annotations"); err != nil {
			return err
		}
		if widget.Options.TooltipView.Source.Type == "saved" {
			if err := check(widget.Options.TooltipView.Source.Ref, dashboard.Title, widget.Title, "tooltip"); err != nil {
				return err
			}
		}
	}
	return nil
}

func savedQueryReplacementIssue(previous, incoming *SavedQuery, reference persistedQueryReference) string {
	if reference.ID != incoming.ID {
		return ""
	}
	before, after := queryReferenceIssues(previous, reference), queryReferenceIssues(incoming, reference)
	addDynamicTypeIssues(after, queryParameters(previous), queryParameters(incoming), reference.Bindings)
	keys := make([]string, 0, len(after))
	for key := range after {
		if _, existed := before[key]; !existed {
			keys = append(keys, key)
		}
	}
	if len(keys) == 0 {
		return ""
	}
	sort.Strings(keys)
	return after[keys[0]]
}

func addDynamicTypeIssues(issues map[string]string, oldParameters, newParameters map[string]SavedQueryParameter, bindings []persistedQueryBinding) {
	for _, binding := range bindings {
		old, oldExists := oldParameters[binding.Parameter]
		next, nextExists := newParameters[binding.Parameter]
		if (binding.Source == "variable" || binding.Source == "label") && oldExists && nextExists && old.Type != next.Type {
			issues["dynamic-type:"+binding.Parameter] = fmt.Sprintf("parameter %q changes type while using a dashboard variable or observation label", binding.Parameter)
		}
	}
}
