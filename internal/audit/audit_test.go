package audit

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
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
		Extra:     map[string]string{"method": "/paprika.v1.PaprikaService/ApproveGate"},
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
