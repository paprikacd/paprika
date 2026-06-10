package health

import (
	"context"
	"testing"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestNewEvaluator(t *testing.T) {
	eval := NewEvaluator()
	if eval == nil {
		t.Fatal("expected non-nil evaluator")
	}
}

func TestEvaluate_BoolExpression(t *testing.T) {
	eval := NewEvaluator()
	app := &paprikav1.Application{
		Spec: paprikav1.ApplicationSpec{
			Parameters: map[string]string{"env": "prod"},
		},
	}

	check := paprikav1.HealthCheck{
		Name:       "test-bool",
		Expression: "true",
	}

	result := eval.Evaluate(context.Background(), check, app)
	if result.Status != paprikav1.HealthHealthy {
		t.Errorf("expected Healthy, got %s: %s", result.Status, result.Message)
	}

	check.Expression = "false"
	result = eval.Evaluate(context.Background(), check, app)
	if result.Status != paprikav1.HealthDegraded {
		t.Errorf("expected Degraded, got %s: %s", result.Status, result.Message)
	}
}

func TestEvaluate_StringExpression(t *testing.T) {
	eval := NewEvaluator()
	app := &paprikav1.Application{
		Spec: paprikav1.ApplicationSpec{
			Parameters: map[string]string{"env": "prod"},
		},
	}

	tests := []struct {
		expr     string
		expected paprikav1.HealthStatus
	}{
		{"'Healthy'", paprikav1.HealthHealthy},
		{"'Degraded'", paprikav1.HealthDegraded},
		{"'Progressing'", paprikav1.HealthProgressing},
	}

	for _, tc := range tests {
		result := eval.Evaluate(context.Background(), paprikav1.HealthCheck{
			Name:       "test-string",
			Expression: tc.expr,
		}, app)
		if result.Status != tc.expected {
			t.Errorf("expression %q: expected %s, got %s (%s)", tc.expr, tc.expected, result.Status, result.Message)
		}
	}
}

func TestEvaluate_CompileError(t *testing.T) {
	eval := NewEvaluator()
	app := &paprikav1.Application{}

	check := paprikav1.HealthCheck{
		Name:       "compile-error",
		Expression: "invalid{syntax(",
	}

	result := eval.Evaluate(context.Background(), check, app)
	if result.Status != paprikav1.HealthUnknown {
		t.Errorf("expected Unknown for compile error, got %s", result.Status)
	}
}

func TestEvaluate_AccessAppFields(t *testing.T) {
	eval := NewEvaluator()
	app := &paprikav1.Application{
		Spec: paprikav1.ApplicationSpec{
			Strategy: paprikav1.StrategyCanary,
		},
	}

	check := paprikav1.HealthCheck{
		Name:       "test-app-fields",
		Expression: `app.strategy == "Canary"`,
	}

	result := eval.Evaluate(context.Background(), check, app)
	if result.Status != paprikav1.HealthHealthy {
		t.Errorf("expected Healthy, got %s: %s", result.Status, result.Message)
	}
}

func TestEvaluate_HTTPResult(t *testing.T) {
	eval := NewEvaluator()
	app := &paprikav1.Application{}

	httpResult := &HTTPResult{
		StatusCode: 200,
		Body:       `{"status": "ok"}`,
		Headers:    map[string]string{"Content-Type": "application/json"},
	}

	status, msg := eval.evalExpression("http.statusCode == 200", app, httpResult)
	if status != paprikav1.HealthHealthy {
		t.Errorf("expected Healthy, got %s: %s", status, msg)
	}

	status, msg = eval.evalExpression("http.statusCode != 200", app, httpResult)
	if status != paprikav1.HealthDegraded {
		t.Errorf("expected Degraded, got %s: %s", status, msg)
	}
}

func TestAggregateHealth(t *testing.T) {
	tests := []struct {
		name     string
		results  []EvalResult
		expected paprikav1.HealthStatus
	}{
		{
			"all healthy",
			[]EvalResult{
				{Name: "a", Status: paprikav1.HealthHealthy},
				{Name: "b", Status: paprikav1.HealthHealthy},
			},
			paprikav1.HealthHealthy,
		},
		{
			"one degraded",
			[]EvalResult{
				{Name: "a", Status: paprikav1.HealthHealthy},
				{Name: "b", Status: paprikav1.HealthDegraded},
			},
			paprikav1.HealthDegraded,
		},
		{
			"unknown takes precedence over progressing",
			[]EvalResult{
				{Name: "a", Status: paprikav1.HealthProgressing},
				{Name: "b", Status: paprikav1.HealthUnknown},
			},
			paprikav1.HealthUnknown,
		},
		{
			"progressing when no degraded or unknown",
			[]EvalResult{
				{Name: "a", Status: paprikav1.HealthProgressing},
				{Name: "b", Status: paprikav1.HealthHealthy},
			},
			paprikav1.HealthProgressing,
		},
		{
			"empty results",
			[]EvalResult{},
			paprikav1.HealthUnknown,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := AggregateHealth(tc.results)
			if got != tc.expected {
				t.Errorf("expected %s, got %s", tc.expected, got)
			}
		})
	}
}

func TestEvaluate_WithHTTPProbe(t *testing.T) {
	eval := NewEvaluator()
	app := &paprikav1.Application{}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	check := paprikav1.HealthCheck{
		Name:       "bad-url",
		Expression: "http.statusCode == 200",
		HTTPProbe: &paprikav1.HTTPProbe{
			URL:     "http://127.0.0.1:1/nonexistent",
			Timeout: 1,
		},
	}

	result := eval.Evaluate(ctx, check, app)
	if result.HTTPResult == nil {
		t.Error("expected HTTP result to be populated")
	}
	if result.HTTPResult.StatusCode != 0 {
		t.Logf("got statusCode=%d (expected 0 for failed connection)", result.HTTPResult.StatusCode)
	}
}

func TestEvaluate_VarAccessStatus(t *testing.T) {
	eval := NewEvaluator()
	app := &paprikav1.Application{
		Status: paprikav1.ApplicationStatus{
			Phase:          paprikav1.ApplicationHealthy,
			SourceHash:     "abc123",
			SourceRevision: "def456",
			Conditions: []metav1.Condition{{
				Type:   "Healthy",
				Status: "True",
			}},
		},
	}

	check := paprikav1.HealthCheck{
		Name:       "status-access",
		Expression: `status.sourceHash != ""`,
	}

	result := eval.Evaluate(context.Background(), check, app)
	if result.Status != paprikav1.HealthHealthy {
		t.Errorf("expected Healthy, got %s: %s", result.Status, result.Message)
	}
}
