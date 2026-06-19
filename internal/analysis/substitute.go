package analysis

import (
	"bytes"
	"fmt"
	"strings"
	"text/template"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// SubstituteContext provides values for check substitution.
type SubstituteContext struct {
	Args        map[string]string
	Application string
	Namespace   string
}

// SubstituteCheck returns a copy of the check with placeholders replaced.
//
//nolint:gocritic // AnalysisCheck is passed by value to keep the API simple.
func SubstituteCheck(check pipelinesv1alpha1.AnalysisCheck, ctx SubstituteContext) (pipelinesv1alpha1.AnalysisCheck, error) {
	out := check
	rendered, err := substitute(check.URL, ctx)
	if err != nil {
		return out, fmt.Errorf("substituting URL: %w", err)
	}
	out.URL = rendered

	rendered, err = substitute(check.Threshold, ctx)
	if err != nil {
		return out, fmt.Errorf("substituting threshold: %w", err)
	}
	out.Threshold = rendered

	for k, v := range check.HTTPHeaders {
		rendered, err := substitute(v, ctx)
		if err != nil {
			return out, fmt.Errorf("substituting header %s: %w", k, err)
		}
		if out.HTTPHeaders == nil {
			out.HTTPHeaders = map[string]string{}
		}
		out.HTTPHeaders[k] = rendered
	}
	return out, nil
}

func substitute(input string, ctx SubstituteContext) (string, error) {
	if input == "" {
		return "", nil
	}
	if !strings.Contains(input, "{{") {
		return input, nil
	}
	tmpl, err := template.New("check").Parse(input)
	if err != nil {
		return "", fmt.Errorf("parsing template: %w", err)
	}
	data := map[string]any{
		"args":        ctx.Args,
		"application": ctx.Application,
		"namespace":   ctx.Namespace,
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, data); err != nil {
		return "", fmt.Errorf("executing template: %w", err)
	}
	return buf.String(), nil
}

// SubstituteChecks applies substitution to a slice of checks.
func SubstituteChecks(checks []pipelinesv1alpha1.AnalysisCheck, ctx SubstituteContext) ([]pipelinesv1alpha1.AnalysisCheck, error) {
	out := make([]pipelinesv1alpha1.AnalysisCheck, 0, len(checks))
	for i := range checks {
		rendered, err := SubstituteCheck(checks[i], ctx)
		if err != nil {
			return nil, err
		}
		out = append(out, rendered)
	}
	return out, nil
}
