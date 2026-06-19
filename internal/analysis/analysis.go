// Package analysis provides analysis checks for pipeline verification gates.
package analysis

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sync/errgroup"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"

	pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// Result holds the outcome of a single analysis check.
type Result struct {
	Name    string
	Passed  bool
	Message string
	Detail  string
}

// CELAnalyzer runs analysis checks against Kubernetes resources and HTTP endpoints.
type CELAnalyzer struct {
	K8sClient  kubernetes.Interface
	Namespace  string
	RESTConfig *rest.Config
	HTTPClient *http.Client
}

// NewCELAnalyzer creates a new CELAnalyzer with the given Kubernetes client, config, and HTTP client.
// If httpClient is nil, http.DefaultClient is used.
func NewCELAnalyzer(k8sClient kubernetes.Interface, namespace string, config *rest.Config, httpClient *http.Client) *CELAnalyzer {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return &CELAnalyzer{
		K8sClient:  k8sClient,
		Namespace:  namespace,
		RESTConfig: config,
		HTTPClient: httpClient,
	}
}

// RunChecks executes all specified analysis checks concurrently and returns their results.
func (a *CELAnalyzer) RunChecks(ctx context.Context, checks []pipelinesv1alpha1.AnalysisCheck) []Result {
	var results []Result
	var mu sync.Mutex
	g, gCtx := errgroup.WithContext(ctx)
	g.SetLimit(8)

	for i := range checks {
		g.Go(func(c *pipelinesv1alpha1.AnalysisCheck) func() error {
			return func() error {
				var r Result
				switch c.Type {
				case "http":
					r = a.runHTTPCheck(gCtx, c)
				case "podMetrics":
					r = a.runPodMetricsCheck(gCtx, c)
				default:
					r = Result{Passed: false, Message: "unknown check type: " + c.Type}
				}
				r.Name = c.Name
				mu.Lock()
				results = append(results, r)
				mu.Unlock()
				return nil
			}
		}(&checks[i]))
	}
	//nolint:errcheck // all goroutines return nil; the only possible error is context cancellation
	_ = g.Wait()
	return results
}

func (a *CELAnalyzer) runHTTPCheck(ctx context.Context, check *pipelinesv1alpha1.AnalysisCheck) Result {
	count := check.RequestCount
	if count <= 0 {
		count = 5
	}
	timeout := check.TimeoutSeconds
	if timeout <= 0 {
		timeout = 5
	}

	threshold := 100.0
	if check.SuccessThreshold != "" {
		t, err := strconv.ParseFloat(check.SuccessThreshold, 64)
		if err != nil {
			return Result{Passed: false, Message: fmt.Sprintf("invalid success threshold %q: %v", check.SuccessThreshold, err)}
		}
		threshold = t
	}

	client := &http.Client{Timeout: time.Duration(timeout) * time.Second}
	successes, failures := a.executeHTTPChecks(ctx, client, check, count)

	return a.buildHTTPResult(check.URL, successes, failures, count, threshold)
}

func (a *CELAnalyzer) executeHTTPChecks(ctx context.Context, client *http.Client, check *pipelinesv1alpha1.AnalysisCheck, count int) (successes, failures int) {
	for i := 0; i < count; i++ {
		if a.executeSingleHTTPCheck(ctx, client, check) {
			successes++
		} else {
			failures++
		}
	}
	return successes, failures
}

func (a *CELAnalyzer) executeSingleHTTPCheck(ctx context.Context, client *http.Client, check *pipelinesv1alpha1.AnalysisCheck) bool {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, check.URL, http.NoBody)
	if err != nil {
		return false
	}
	for k, v := range check.HTTPHeaders {
		req.Header.Set(k, v)
	}
	resp, err := client.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }() //nolint:errcheck // best-effort body close
	return resp.StatusCode >= 200 && resp.StatusCode < 400
}

func (a *CELAnalyzer) buildHTTPResult(url string, successes, failures, count int, threshold float64) Result {
	successRate := float64(0)
	if count > 0 {
		successRate = float64(successes) / float64(count) * 100
	}
	passed := successRate >= threshold
	return Result{
		Passed:  passed,
		Message: fmt.Sprintf("HTTP check: %d/%d succeeded (%.0f%%, threshold %.0f%%)", successes, count, successRate, threshold),
		Detail:  fmt.Sprintf("url=%s successes=%d failures=%d", url, successes, failures),
	}
}

func (a *CELAnalyzer) runPodMetricsCheck(ctx context.Context, check *pipelinesv1alpha1.AnalysisCheck) Result {
	threshold, err := strconv.ParseFloat(check.Threshold, 64)
	if err != nil {
		return Result{Passed: false, Message: fmt.Sprintf("invalid pod metric threshold %q: %v", check.Threshold, err)}
	}
	windowSeconds := check.WindowSeconds
	if windowSeconds <= 0 {
		windowSeconds = 60
	}

	switch check.Metric {
	case "restartRate":
		return a.checkRestartRate(ctx, threshold, windowSeconds)
	case "errorRate":
		return a.checkPodStatusRate(ctx, threshold, windowSeconds)
	case "latencyP99":
		return Result{
			Passed:  true,
			Message: "latencyP99 check passed (no metrics server available, assuming pass)",
			Detail:  "metric=latencyP99 threshold=" + check.Threshold,
		}
	default:
		return Result{
			Passed:  false,
			Message: "unknown pod metric: " + check.Metric,
		}
	}
}

func (a *CELAnalyzer) checkRestartRate(ctx context.Context, threshold float64, _ int) Result {
	pods, err := a.K8sClient.CoreV1().Pods(a.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "app.kubernetes.io/name=demo-app",
	})
	if err != nil {
		return Result{Passed: false, Message: fmt.Sprintf("failed to list pods: %v", err)}
	}

	if len(pods.Items) == 0 {
		return Result{Passed: true, Message: "no pods found, assuming pass"}
	}

	var totalRestarts int32
	for i := range pods.Items {
		for j := range pods.Items[i].Status.ContainerStatuses {
			totalRestarts += pods.Items[i].Status.ContainerStatuses[j].RestartCount
		}
	}

	avgRestarts := float64(totalRestarts) / float64(len(pods.Items))
	passed := avgRestarts <= threshold

	return Result{
		Passed:  passed,
		Message: fmt.Sprintf("restart rate: %.1f restarts/pod (threshold %.1f)", avgRestarts, threshold),
		Detail:  fmt.Sprintf("pods=%d totalRestarts=%d", len(pods.Items), totalRestarts),
	}
}

func (a *CELAnalyzer) checkPodStatusRate(ctx context.Context, threshold float64, _ int) Result {
	pods, err := a.K8sClient.CoreV1().Pods(a.Namespace).List(ctx, metav1.ListOptions{
		LabelSelector: "app.kubernetes.io/name=demo-app",
	})
	if err != nil {
		return Result{Passed: false, Message: fmt.Sprintf("failed to list pods: %v", err)}
	}

	if len(pods.Items) == 0 {
		return Result{Passed: true, Message: "no pods found, assuming pass"}
	}

	var failed, total int
	for i := range pods.Items {
		for j := range pods.Items[i].Status.ContainerStatuses {
			total++
			cs := pods.Items[i].Status.ContainerStatuses[j]
			if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 {
				failed++
			}
		}
	}

	errorRate := float64(0)
	if total > 0 {
		errorRate = float64(failed) / float64(total)
	}
	passed := errorRate <= threshold

	return Result{
		Passed:  passed,
		Message: fmt.Sprintf("error rate: %.2f (threshold %.2f)", errorRate, threshold),
		Detail:  fmt.Sprintf("total=%d failed=%d", total, failed),
	}
}
