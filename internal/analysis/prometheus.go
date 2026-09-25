package analysis

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/google/cel-go/cel"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// promQueryResponse is the subset of the Prometheus /api/v1/query response we
// consume: an instant vector of {metric, value:[timestamp,"value"]} samples.
type promQueryResponse struct {
	Status string `json:"status"`
	Error  string `json:"error"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Metric map[string]string `json:"metric"`
			Value  [2]any            `json:"value"`
		} `json:"result"`
	} `json:"data"`
}

// promSample is one instant-vector sample with the string value pre-parsed to
// float64 for ergonomic CEL conditions (result[i].value < 0.05).
type promSample struct {
	Metric map[string]string
	Value  float64
}

// runPrometheusCheck evaluates a PromQL instant query and applies CEL
// success/failure conditions over the returned samples. `result` is exposed
// to the conditions as a list of {metric: map, value: float64}.
//
// Evaluation order: query → failureCondition → successCondition → default
// (non-empty result passes). Any transport, parse, or condition error fails
// the check — analysis must fail closed.
func (a *CELAnalyzer) runPrometheusCheck(ctx context.Context, check *pipelinesv1alpha1.AnalysisCheck) Result {
	if check.Address == "" {
		return Result{Passed: false, Message: "prometheus check requires address"}
	}
	if check.Query == "" {
		return Result{Passed: false, Message: "prometheus check requires query"}
	}
	timeout := check.TimeoutSeconds
	if timeout <= 0 {
		timeout = 30
	}

	samples, err := a.queryPrometheus(ctx, check, timeout)
	if err != nil {
		return Result{
			Passed:  false,
			Message: fmt.Sprintf("prometheus query failed: %v", err),
			Detail:  fmt.Sprintf("address=%s query=%q", check.Address, check.Query),
		}
	}
	return evaluateConditions(check, samples)
}

// evaluateConditions applies failureCondition, then successCondition, then
// the default non-empty-result rule.
func evaluateConditions(check *pipelinesv1alpha1.AnalysisCheck, samples []promSample) Result {
	result := make([]any, 0, len(samples))
	for _, s := range samples {
		result = append(result, map[string]any{"metric": s.Metric, "value": s.Value})
	}
	detail := fmt.Sprintf("samples=%d query=%q", len(samples), check.Query)

	if check.FailureCondition != "" {
		fired, err := evalCondition(check.FailureCondition, result)
		if err != nil {
			return Result{Passed: false, Message: fmt.Sprintf("failureCondition error: %v", err)}
		}
		if fired {
			return Result{Passed: false, Message: "failureCondition matched: " + check.FailureCondition, Detail: detail}
		}
	}
	if check.SuccessCondition != "" {
		passed, err := evalCondition(check.SuccessCondition, result)
		if err != nil {
			return Result{Passed: false, Message: fmt.Sprintf("successCondition error: %v", err)}
		}
		return Result{
			Passed:  passed,
			Message: fmt.Sprintf("successCondition %s: %s", map[bool]string{true: "met", false: "not met"}[passed], check.SuccessCondition),
			Detail:  detail,
		}
	}
	passed := len(samples) > 0
	return Result{
		Passed:  passed,
		Message: fmt.Sprintf("prometheus query returned %d samples", len(samples)),
		Detail:  detail,
	}
}

// queryPrometheus runs an instant query against check.Address and returns the
// vector samples. HTTPHeaders on the check are forwarded (bearer auth etc.).
func (a *CELAnalyzer) queryPrometheus(ctx context.Context, check *pipelinesv1alpha1.AnalysisCheck, timeout int) ([]promSample, error) {
	q := url.Values{}
	q.Set("query", check.Query)
	q.Set("timeout", strconv.Itoa(timeout)+"s")
	endpoint := check.Address + "/api/v1/query?" + q.Encode()

	client := a.HTTPClient
	if client == nil {
		client = http.DefaultClient
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, http.NoBody)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	for k, v := range check.HTTPHeaders {
		req.Header.Set(k, v)
	}
	reqCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	req = req.WithContext(reqCtx)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("query request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close

	return decodePromResponse(resp)
}

func decodePromResponse(resp *http.Response) ([]promSample, error) {
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("prometheus returned HTTP %d", resp.StatusCode)
	}
	var pr promQueryResponse
	if err := json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if pr.Status != "success" {
		if pr.Error != "" {
			return nil, fmt.Errorf("prometheus error: %s", pr.Error)
		}
		return nil, fmt.Errorf("prometheus status %q", pr.Status)
	}
	if pr.Data.ResultType != "vector" {
		return nil, fmt.Errorf("unsupported resultType %q (want vector)", pr.Data.ResultType)
	}
	return parsePromSamples(pr)
}

func parsePromSamples(pr promQueryResponse) ([]promSample, error) {
	samples := make([]promSample, 0, len(pr.Data.Result))
	for _, r := range pr.Data.Result {
		raw, ok := r.Value[1].(string)
		if !ok {
			return nil, fmt.Errorf("non-string sample value for %v", r.Metric)
		}
		f, err := strconv.ParseFloat(raw, 64)
		if err != nil {
			return nil, fmt.Errorf("parse sample value %q: %w", raw, err)
		}
		samples = append(samples, promSample{Metric: r.Metric, Value: f})
	}
	return samples, nil
}

// evalCondition compiles and evaluates a CEL boolean expression with `result`
// bound to the sample list.
func evalCondition(expr string, result []any) (bool, error) {
	env, err := cel.NewEnv(cel.Variable("result", cel.DynType))
	if err != nil {
		return false, fmt.Errorf("cel env: %w", err)
	}
	ast, iss := env.Compile(expr)
	if iss.Err() != nil {
		return false, fmt.Errorf("compile: %w", iss.Err())
	}
	if ast.OutputType() != cel.BoolType {
		return false, fmt.Errorf("expression must evaluate to bool, got %v", ast.OutputType())
	}
	prg, err := env.Program(ast)
	if err != nil {
		return false, fmt.Errorf("program: %w", err)
	}
	out, _, err := prg.Eval(map[string]any{"result": result})
	if err != nil {
		return false, fmt.Errorf("eval: %w", err)
	}
	b, ok := out.Value().(bool)
	if !ok {
		return false, fmt.Errorf("expression returned %T, want bool", out.Value())
	}
	return b, nil
}
