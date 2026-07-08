package health

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestNewCELEvaluator(t *testing.T) {
	t.Parallel()

	eval := NewCELEvaluator()
	if eval == nil {
		t.Fatal("expected non-nil evaluator")
	}
}

func TestEvaluate(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		app        *paprikav1.Application
		check      paprikav1.HealthCheck
		wantStatus paprikav1.HealthStatus
		wantMsg    string
	}{
		{
			name:       "true bool expression",
			app:        &paprikav1.Application{},
			check:      paprikav1.HealthCheck{Name: "test-bool", Expression: "true"},
			wantStatus: paprikav1.HealthHealthy,
		},
		{
			name:       "false bool expression",
			app:        &paprikav1.Application{},
			check:      paprikav1.HealthCheck{Name: "test-bool", Expression: "false"},
			wantStatus: paprikav1.HealthDegraded,
		},
		{
			name:       "string healthy expression",
			app:        &paprikav1.Application{},
			check:      paprikav1.HealthCheck{Name: "test-string", Expression: "'Healthy'"},
			wantStatus: paprikav1.HealthHealthy,
			wantMsg:    "Healthy",
		},
		{
			name:       "string degraded expression",
			app:        &paprikav1.Application{},
			check:      paprikav1.HealthCheck{Name: "test-string", Expression: "'Degraded'"},
			wantStatus: paprikav1.HealthDegraded,
			wantMsg:    "Degraded",
		},
		{
			name:       "string progressing expression",
			app:        &paprikav1.Application{},
			check:      paprikav1.HealthCheck{Name: "test-string", Expression: "'Progressing'"},
			wantStatus: paprikav1.HealthProgressing,
		},
		{
			name:       "compile error",
			app:        &paprikav1.Application{},
			check:      paprikav1.HealthCheck{Name: "compile-error", Expression: "invalid{syntax("},
			wantStatus: paprikav1.HealthUnknown,
		},
		{
			name: "access app fields",
			app: &paprikav1.Application{
				Spec: paprikav1.ApplicationSpec{
					Strategy: paprikav1.StrategyCanary,
				},
			},
			check:      paprikav1.HealthCheck{Name: "test-app-fields", Expression: `app.strategy == "Canary"`},
			wantStatus: paprikav1.HealthHealthy,
		},
		{
			name: "access status fields",
			app: &paprikav1.Application{
				Status: paprikav1.ApplicationStatus{
					SourceHash: "abc123",
				},
			},
			check:      paprikav1.HealthCheck{Name: "status-access", Expression: `status.sourceHash != ""`},
			wantStatus: paprikav1.HealthHealthy,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			eval := NewCELEvaluator()
			result := eval.Evaluate(context.Background(), tc.check, tc.app)
			require.Equal(t, tc.wantStatus, result.Status)
			if tc.wantMsg != "" {
				require.Contains(t, result.Message, tc.wantMsg)
			}
		})
	}
}

func TestEvalExpression_HTTPResult(t *testing.T) {
	t.Parallel()

	app := &paprikav1.Application{}
	httpResult := &HTTPResult{
		StatusCode: 200,
		Body:       `{"status": "ok"}`,
		Headers:    map[string]string{"Content-Type": "application/json"},
	}

	tests := []struct {
		name       string
		expr       string
		httpResult *HTTPResult
		wantStatus paprikav1.HealthStatus
	}{
		{
			name:       "http status match",
			expr:       "http.statusCode == 200",
			httpResult: httpResult,
			wantStatus: paprikav1.HealthHealthy,
		},
		{
			name:       "http status mismatch",
			expr:       "http.statusCode != 200",
			httpResult: httpResult,
			wantStatus: paprikav1.HealthDegraded,
		},
		{
			name:       "http body contains",
			expr:       `http.statusCode == 200 && http.body.contains('"status": "ok"')`,
			httpResult: httpResult,
			wantStatus: paprikav1.HealthHealthy,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			eval := NewCELEvaluator()
			status, _ := eval.evalExpression(tc.expr, app, tc.httpResult)
			require.Equal(t, tc.wantStatus, status)
		})
	}
}

func TestEvaluate_WithHTTPProbe(t *testing.T) {
	t.Parallel()

	eval := NewCELEvaluator()
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

func TestAggregateHealth(t *testing.T) {
	t.Parallel()

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
			t.Parallel()
			got := AggregateHealth(tc.results)
			if got != tc.expected {
				t.Errorf("expected %s, got %s", tc.expected, got)
			}
		})
	}
}
