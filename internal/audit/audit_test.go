package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"

	"go.opentelemetry.io/otel/trace"
)

func TestLogAuditorWritesValidJSONWithExpectedFields(t *testing.T) {
	var buf bytes.Buffer
	a := newLogAuditor(&buf)

	a.Record(context.Background(), Event{
		Principal: "alice@example.com",
		Action:    "approve",
		Resource:  "Gate",
		Name:      "my-app",
		Namespace: "default",
		Success:   true,
		Extra: map[string]string{
			"method":           "/paprika.v1.PaprikaService/ApproveGate",
			ExtraAccessModeKey: "kubernetes-port-forward-admin",
		},
	})

	var got Event
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("LogAuditor wrote invalid JSON: %v (output=%q)", err, buf.String())
	}

	if got.Principal != "alice@example.com" {
		t.Errorf("Principal: got %q, want %q", got.Principal, "alice@example.com")
	}
	if got.Action != "approve" {
		t.Errorf("Action: got %q, want %q", got.Action, "approve")
	}
	if got.Resource != "Gate" {
		t.Errorf("Resource: got %q, want %q", got.Resource, "Gate")
	}
	if got.Name != "my-app" {
		t.Errorf("Name: got %q, want %q", got.Name, "my-app")
	}
	if got.Namespace != "default" {
		t.Errorf("Namespace: got %q, want %q", got.Namespace, "default")
	}
	if !got.Success {
		t.Errorf("Success: got false, want true")
	}
	if got.Error != "" {
		t.Errorf("Error: got %q, want empty on success", got.Error)
	}
	if got.Extra["method"] != "/paprika.v1.PaprikaService/ApproveGate" {
		t.Errorf("Extra.method: got %q, want procedure", got.Extra["method"])
	}
	if got.Extra[ExtraAccessModeKey] != "kubernetes-port-forward-admin" {
		t.Errorf("Extra.access_mode: got %q, want kubernetes-port-forward-admin",
			got.Extra[ExtraAccessModeKey])
	}
	if got.Timestamp == "" {
		t.Error("Timestamp: got empty, want RFC3339 timestamp")
	}
}

func TestLogAuditorRecordsFailureWithError(t *testing.T) {
	var buf bytes.Buffer
	a := newLogAuditor(&buf)

	a.Record(context.Background(), Event{
		Principal: "bob",
		Action:    "update",
		Resource:  "Application",
		Name:      "payments",
		Namespace: "team-a",
		Success:   false,
		Error:     "permission denied",
	})

	var got Event
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("LogAuditor wrote invalid JSON: %v (output=%q)", err, buf.String())
	}
	if got.Success {
		t.Error("Success: got true, want false")
	}
	if got.Error != "permission denied" {
		t.Errorf("Error: got %q, want %q", got.Error, "permission denied")
	}
}

func TestLogAuditorEmitsOneJSONLinePerEvent(t *testing.T) {
	var buf bytes.Buffer
	a := newLogAuditor(&buf)

	a.Record(context.Background(), Event{Action: "approve", Resource: "Gate", Success: true})
	a.Record(context.Background(), Event{Action: "reject", Resource: "Gate", Success: true})

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 JSON lines, got %d (output=%q)", len(lines), buf.String())
	}
	for i, line := range lines {
		var ev Event
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("line %d invalid JSON: %v (line=%q)", i, err, line)
		}
	}
}

func TestNoopAuditorDiscardsEvents(t *testing.T) {
	var buf bytes.Buffer
	a := NoopAuditor{}
	a.Record(context.Background(), Event{Action: "approve", Success: true})
	if buf.Len() != 0 {
		t.Errorf("NoopAuditor wrote %d bytes, want 0", buf.Len())
	}
}

func TestLogAuditorFillsMissingTimestamp(t *testing.T) {
	var buf bytes.Buffer
	a := newLogAuditor(&buf)

	a.Record(context.Background(), Event{Action: "update", Success: true})

	var got Event
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if got.Timestamp == "" {
		t.Error("Timestamp: LogAuditor should populate a missing timestamp")
	}
}

// TestLogAuditorEnrichesTraceContext verifies that Record extracts the active
// span's TraceID and SpanID from ctx and writes them into the audit event, so a
// JSON audit line can be correlated with the distributed trace that produced it.
func TestLogAuditorEnrichesTraceContext(t *testing.T) {
	var buf bytes.Buffer
	a := newLogAuditor(&buf)

	const (
		wantTraceID = "0af7651916cd43dd8448eb211c80319c"
		wantSpanID  = "b7ad6b7169203331"
	)
	ctx := trace.ContextWithSpanContext(context.Background(), mustSpanContext(t, wantTraceID, wantSpanID))

	a.Record(ctx, Event{Action: "apply", Resource: "Application", Success: true})

	var got Event
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v (output=%q)", err, buf.String())
	}
	if got.TraceID != wantTraceID {
		t.Errorf("TraceID: got %q, want %q", got.TraceID, wantTraceID)
	}
	if got.SpanID != wantSpanID {
		t.Errorf("SpanID: got %q, want %q", got.SpanID, wantSpanID)
	}
}

// TestLogAuditorOmitsTraceContextWhenAbsent verifies that when no span is active
// the TraceID/SpanID fields are empty and omitted from the JSON output.
func TestLogAuditorOmitsTraceContextWhenAbsent(t *testing.T) {
	var buf bytes.Buffer
	a := newLogAuditor(&buf)

	a.Record(context.Background(), Event{Action: "approve", Success: true})

	// The JSON line must not contain traceId/spanId keys when no span is active.
	if strings.Contains(buf.String(), "traceId") || strings.Contains(buf.String(), "spanId") {
		t.Errorf("audit line unexpectedly contains trace fields: %q", buf.String())
	}
	var got Event
	if err := json.Unmarshal(buf.Bytes(), &got); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	if got.TraceID != "" || got.SpanID != "" {
		t.Errorf("trace fields should be empty, got TraceID=%q SpanID=%q", got.TraceID, got.SpanID)
	}
}

// mustSpanContext builds a valid (sampled) SpanContext from hex IDs for testing.
func mustSpanContext(t *testing.T, traceIDHex, spanIDHex string) trace.SpanContext {
	t.Helper()
	tid, err := trace.TraceIDFromHex(traceIDHex)
	if err != nil {
		t.Fatalf("parse TraceID: %v", err)
	}
	sid, err := trace.SpanIDFromHex(spanIDHex)
	if err != nil {
		t.Fatalf("parse SpanID: %v", err)
	}
	return trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    tid,
		SpanID:     sid,
		TraceFlags: trace.FlagsSampled,
		Remote:     true,
	})
}
