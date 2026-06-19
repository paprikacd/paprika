package gates

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"time"
)

// ApprovalGateType values.
const (
	ApprovalGateTypeManual  = "manual"
	ApprovalGateTypeWebhook = "webhook"
	ApprovalGateTypeSlack   = "slack"
)

// ApprovalGateStatus values.
const (
	ApprovalGateStatusPending  = "Pending"
	ApprovalGateStatusApproved = "Approved"
	ApprovalGateStatusRejected = "Rejected"
)

// ApprovalGate describes an approval gate to be evaluated.
type ApprovalGate struct {
	Name            string
	Stage           string
	Type            string
	Required        bool
	URL             string
	Method          string
	Headers         map[string]string
	Body            string
	SuccessStatus   int
	SlackWebhookURL string
	SlackChannel    string
}

// ApprovalGatePayload is passed to webhook/Slack gates.
type ApprovalGatePayload struct {
	Application string
	Namespace   string
	Release     string
	Stage       string
	Gate        string
}

// ApprovalGateResult is the outcome of evaluating one gate.
type ApprovalGateResult struct {
	Status     string
	ApprovedBy string
	Message    string
	Error      error
}

// ApprovalGateEvaluator evaluates approval gates.
type ApprovalGateEvaluator struct {
	HTTPClient *http.Client
}

// NewApprovalGateEvaluator creates an evaluator with the given HTTP client.
func NewApprovalGateEvaluator(client *http.Client) *ApprovalGateEvaluator {
	if client == nil {
		client = http.DefaultClient
	}
	return &ApprovalGateEvaluator{HTTPClient: client}
}

// Evaluate returns the result for a single gate given its current status.
func (e *ApprovalGateEvaluator) Evaluate(ctx context.Context, gate ApprovalGate, payload ApprovalGatePayload, currentStatus string) ApprovalGateResult {
	if currentStatus == ApprovalGateStatusApproved {
		return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: "manual"}
	}
	if currentStatus == ApprovalGateStatusRejected {
		return ApprovalGateResult{Status: ApprovalGateStatusRejected}
	}

	switch gate.Type {
	case ApprovalGateTypeManual:
		return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "waiting for manual approval"}
	case ApprovalGateTypeWebhook:
		return e.evaluateWebhook(ctx, gate, payload)
	case ApprovalGateTypeSlack:
		return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "Slack interaction is Phase 2"}
	default:
		return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "unknown gate type: " + gate.Type}
	}
}

func (e *ApprovalGateEvaluator) evaluateWebhook(ctx context.Context, gate ApprovalGate, payload ApprovalGatePayload) ApprovalGateResult {
	if gate.URL == "" {
		return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: "webhook gate missing URL"}
	}
	method := gate.Method
	if method == "" {
		method = http.MethodPost
	}
	body := gate.Body
	if body == "" {
		body = fmt.Sprintf(`{"application":"%s","namespace":"%s","release":"%s","stage":"%s","gate":"%s"}`,
			payload.Application, payload.Namespace, payload.Release, payload.Stage, payload.Gate)
	}

	req, err := http.NewRequestWithContext(ctx, method, gate.URL, bytes.NewBufferString(body))
	if err != nil {
		return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("invalid webhook request: %v", err), Error: err}
	}
	req.Header.Set("Content-Type", "application/json")
	for k, v := range gate.Headers {
		req.Header.Set(k, v)
	}

	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	resp, err := e.HTTPClient.Do(req.WithContext(ctx))
	if err != nil {
		return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("webhook call failed: %v", err), Error: err}
	}
	defer func() { _ = resp.Body.Close() }()

	if gate.SuccessStatus > 0 {
		if resp.StatusCode == gate.SuccessStatus {
			return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: "webhook", Message: fmt.Sprintf("HTTP %d", resp.StatusCode)}
		}
		return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("HTTP %d (expected %d)", resp.StatusCode, gate.SuccessStatus)}
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return ApprovalGateResult{Status: ApprovalGateStatusApproved, ApprovedBy: "webhook", Message: fmt.Sprintf("HTTP %d", resp.StatusCode)}
	}
	return ApprovalGateResult{Status: ApprovalGateStatusPending, Message: fmt.Sprintf("HTTP %d (expected 2xx)", resp.StatusCode)}
}
