// Package health provides CEL-based health evaluation with HTTP probe support.
package health

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"time"

	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/common/types/ref"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// CELEvaluator evaluates CEL expressions for health checks.
type CELEvaluator struct {
	httpClient *http.Client
}

// NewCELEvaluator creates a new CEL health evaluator.
func NewCELEvaluator() *CELEvaluator {
	return &CELEvaluator{
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

// HTTPResult contains the result of an HTTP probe.
type HTTPResult struct {
	StatusCode int               `json:"statusCode"`
	Body       string            `json:"body"`
	Headers    map[string]string `json:"headers"`
}

// EvalResult contains the result of a health check evaluation.
type EvalResult struct {
	Name       string
	Status     paprikav1.HealthStatus
	Message    string
	HTTPResult *HTTPResult
}

// Evaluate runs a health check and returns the result.
func (e *CELEvaluator) Evaluate(ctx context.Context, check paprikav1.HealthCheck, app *paprikav1.Application) EvalResult {
	result := EvalResult{Name: check.Name}

	var httpResult *HTTPResult
	if check.HTTPProbe != nil {
		httpResult = e.doHTTPProbe(ctx, check.HTTPProbe)
		result.HTTPResult = httpResult
	}

	status, message := e.evalExpression(check.Expression, app, httpResult)
	result.Status = status
	result.Message = message

	return result
}

// doHTTPProbe executes an HTTP probe and returns the result.
func (e *CELEvaluator) doHTTPProbe(ctx context.Context, probe *paprikav1.HTTPProbe) *HTTPResult {
	timeout := time.Duration(probe.Timeout) * time.Second
	if timeout == 0 {
		timeout = 5 * time.Second
	}

	client := &http.Client{Timeout: timeout}
	method := strings.ToUpper(probe.Method)
	if method == "" {
		method = http.MethodGet
	}

	var body io.Reader
	if probe.Body != "" {
		body = bytes.NewBufferString(probe.Body)
	}

	req, err := http.NewRequestWithContext(ctx, method, probe.URL, body)
	if err != nil {
		return &HTTPResult{StatusCode: 0, Body: err.Error(), Headers: map[string]string{}}
	}

	for k, v := range probe.Headers {
		req.Header.Set(k, v)
	}

	resp, err := client.Do(req)
	if err != nil {
		return &HTTPResult{StatusCode: 0, Body: err.Error(), Headers: map[string]string{}}
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close

	respBody, err := io.ReadAll(resp.Body)
	headers := make(map[string]string)
	for k, v := range resp.Header {
		if len(v) > 0 {
			headers[k] = v[0]
		}
	}
	if err != nil {
		return &HTTPResult{StatusCode: resp.StatusCode, Body: err.Error(), Headers: headers}
	}

	return &HTTPResult{
		StatusCode: resp.StatusCode,
		Body:       string(respBody),
		Headers:    headers,
	}
}

// evalExpression evaluates a CEL expression and returns the health status.
func (e *CELEvaluator) evalExpression(expr string, app *paprikav1.Application, httpResult *HTTPResult) (status paprikav1.HealthStatus, message string) {
	env, err := cel.NewEnv(
		cel.Variable("app", cel.AnyType),
		cel.Variable("status", cel.AnyType),
		cel.Variable("http", cel.AnyType),
	)
	if err != nil {
		return paprikav1.HealthUnknown, fmt.Sprintf("env error: %s", err)
	}

	ast, iss := env.Compile(expr)
	if iss != nil {
		return paprikav1.HealthUnknown, fmt.Sprintf("compile error: %s", iss.Err())
	}

	prg, err := env.Program(ast)
	if err != nil {
		return paprikav1.HealthUnknown, fmt.Sprintf("program error: %s", err)
	}

	vars := map[string]interface{}{
		"app":    structToMap(app.Spec),
		"status": structToMap(app.Status),
	}
	if httpResult != nil {
		vars["http"] = map[string]interface{}{
			"statusCode": httpResult.StatusCode,
			"body":       httpResult.Body,
			"headers":    httpResult.Headers,
		}
	}

	out, _, err := prg.Eval(vars)
	if err != nil {
		return paprikav1.HealthUnknown, fmt.Sprintf("eval error: %s", err)
	}

	return interpretResult(out)
}

// interpretResult converts a CEL result value to a health status.
func interpretResult(out ref.Val) (status paprikav1.HealthStatus, message string) {
	val := out.Value()

	switch v := val.(type) {
	case bool:
		if v {
			return paprikav1.HealthHealthy, "check passed"
		}
		return paprikav1.HealthDegraded, "check failed"
	case string:
		switch paprikav1.HealthStatus(v) {
		case paprikav1.HealthHealthy:
			return paprikav1.HealthHealthy, v
		case paprikav1.HealthDegraded:
			return paprikav1.HealthDegraded, v
		case paprikav1.HealthProgressing:
			return paprikav1.HealthProgressing, v
		case paprikav1.HealthUnknown:
			return paprikav1.HealthUnknown, v
		default:
			return paprikav1.HealthUnknown, v
		}
	default:
		return paprikav1.HealthUnknown, fmt.Sprintf("unexpected result type: %T", val)
	}
}

// AggregateHealth computes the overall health from multiple check results.
func AggregateHealth(results []EvalResult) paprikav1.HealthStatus {
	if len(results) == 0 {
		return paprikav1.HealthUnknown
	}
	for _, r := range results {
		if r.Status == paprikav1.HealthDegraded {
			return paprikav1.HealthDegraded
		}
	}
	hasProgressing := false
	hasUnknown := false
	for _, r := range results {
		switch r.Status {
		case paprikav1.HealthHealthy, paprikav1.HealthDegraded:
		case paprikav1.HealthUnknown:
			hasUnknown = true
		case paprikav1.HealthProgressing:
			hasProgressing = true
		}
	}
	if hasUnknown {
		return paprikav1.HealthUnknown
	}
	if hasProgressing {
		return paprikav1.HealthProgressing
	}
	return paprikav1.HealthHealthy
}

// structToMap converts a struct to a map using JSON marshaling.
func structToMap(v interface{}) map[string]interface{} {
	if v == nil {
		return nil
	}

	if m, ok := v.(map[string]interface{}); ok {
		return m
	}

	data, err := json.Marshal(v)
	if err != nil {
		return nil
	}

	var result map[string]interface{}
	if err := json.Unmarshal(data, &result); err != nil {
		return nil
	}

	cleanNested(result)
	return result
}

// cleanNested recursively cleans nested maps and slices in place.
func cleanNested(m map[string]interface{}) {
	for k, v := range m {
		switch val := v.(type) {
		case map[string]interface{}:
			cleanNested(val)
			m[k] = val
		case []interface{}:
			cleanSlice(val)
			m[k] = val
		default:
			if converted, ok := convertToMap(v); ok {
				cleanNested(converted)
				m[k] = converted
			}
		}
	}
}

// cleanSlice recursively cleans a slice of interfaces.
func cleanSlice(s []interface{}) {
	for i, item := range s {
		switch val := item.(type) {
		case map[string]interface{}:
			cleanNested(val)
			s[i] = val
		case []interface{}:
			cleanSlice(val)
			s[i] = val
		}
	}
}

// convertToMap attempts to convert a value to a map[string]interface{}.
func convertToMap(v interface{}) (map[string]interface{}, bool) {
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Pointer || rv.IsNil() {
		return nil, false
	}
	elem := rv.Elem().Interface()
	if m, ok := elem.(map[string]interface{}); ok {
		return m, true
	}
	data, err := json.Marshal(elem)
	if err != nil {
		return nil, false
	}
	var nested map[string]interface{}
	if err := json.Unmarshal(data, &nested); err != nil {
		return nil, false
	}
	return nested, true
}
