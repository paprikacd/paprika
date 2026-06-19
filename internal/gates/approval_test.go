package gates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestApprovalGateEvaluator_manual(t *testing.T) {
	e := NewApprovalGateEvaluator(nil)
	gate := ApprovalGate{Name: "m", Type: ApprovalGateTypeManual}

	if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusPending {
		t.Errorf("manual gate = %s, want Pending", got.Status)
	}
	if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ApprovalGateStatusApproved); got.Status != ApprovalGateStatusApproved {
		t.Errorf("approved manual gate = %s, want Approved", got.Status)
	}
}

func TestApprovalGateEvaluator_webhook(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	e := NewApprovalGateEvaluator(srv.Client())
	gate := ApprovalGate{Name: "w", Type: ApprovalGateTypeWebhook, URL: srv.URL, Method: http.MethodPost}
	if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusApproved {
		t.Errorf("webhook gate = %s, want Approved", got.Status)
	}

	gate.URL = ""
	if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusPending {
		t.Errorf("webhook missing url = %s, want Pending", got.Status)
	}
}

func TestApprovalGateEvaluator_slack(t *testing.T) {
	e := NewApprovalGateEvaluator(nil)
	gate := ApprovalGate{Name: "s", Type: ApprovalGateTypeSlack}
	if got := e.Evaluate(context.Background(), gate, ApprovalGatePayload{}, ""); got.Status != ApprovalGateStatusPending {
		t.Errorf("slack gate = %s, want Pending", got.Status)
	}
}
