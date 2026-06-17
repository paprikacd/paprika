package analysis

import (
	"testing"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestSubstituteCheck(t *testing.T) {
	check := pipelinesv1alpha1.AnalysisCheck{
		Type:      "http",
		URL:       "http://{{ .application }}/{{ .args.path }}",
		Threshold: "{{ .args.threshold }}",
		HTTPHeaders: map[string]string{
			"X-Namespace": "{{ .namespace }}",
		},
	}
	ctx := SubstituteContext{
		Args:        map[string]string{"path": "health", "threshold": "99"},
		Application: "my-app",
		Namespace:   "prod",
	}
	got, err := SubstituteCheck(check, ctx)
	if err != nil {
		t.Fatalf("substitute check: %v", err)
	}
	if got.URL != "http://my-app/health" {
		t.Errorf("url: got %q, want %q", got.URL, "http://my-app/health")
	}
	if got.Threshold != "99" {
		t.Errorf("threshold: got %q, want %q", got.Threshold, "99")
	}
	if got.HTTPHeaders["X-Namespace"] != "prod" {
		t.Errorf("header: got %q, want %q", got.HTTPHeaders["X-Namespace"], "prod")
	}
}
