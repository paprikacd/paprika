// Package audit provides structured audit logging for the Paprika API surface.
//
// The LogAuditor writes one JSON object per auditable action to stdout, where a
// Kubernetes log aggregator (fluent-bit, Loki, Cloud Logging, etc.) collects
// them. Audit events are emitted only for mutating API operations; read-only
// requests are filtered upstream by the audit interceptor.
package audit

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"time"
)

// Event records a single auditable action.
type Event struct {
	Timestamp string            `json:"timestamp"` // RFC3339
	Principal string            `json:"principal"` // authenticated user/service
	Action    string            `json:"action"`    // "create"|"update"|"delete"|"apply"|"promote"|"approve"|"reject"
	Resource  string            `json:"resource"`  // e.g. "Application", "Release", "ConftestPolicy"
	Name      string            `json:"name"`      // resource name
	Namespace string            `json:"namespace"` // resource namespace
	Success   bool              `json:"success"`
	Error     string            `json:"error,omitempty"` // empty on success
	Extra     map[string]string `json:"extra,omitempty"` // optional extra fields
}

// Auditor records audit events. Implementations must be safe for concurrent use.
type Auditor interface {
	Record(ctx context.Context, event Event)
}

// LogAuditor writes structured JSON audit events to stdout (K8s convention —
// collected by the platform's log aggregator).
type LogAuditor struct {
	out io.Writer
}

// NewLogAuditor returns a LogAuditor that writes JSON audit events to os.Stdout.
func NewLogAuditor() *LogAuditor {
	return &LogAuditor{out: os.Stdout}
}

// newLogAuditor returns a LogAuditor writing to the given writer. Used by tests
// to capture output without polluting stdout.
func newLogAuditor(w io.Writer) *LogAuditor {
	return &LogAuditor{out: w}
}

// Record writes the event as a single JSON object to the configured output. If
// the event has no Timestamp it is populated with the current UTC RFC3339 time.
//
//nolint:gocritic // hugeParam: Event is passed by value per the Auditor contract.
func (l *LogAuditor) Record(ctx context.Context, event Event) {
	_ = ctx // reserved for future tracing/correlation
	if event.Timestamp == "" {
		event.Timestamp = time.Now().UTC().Format(time.RFC3339)
	}
	enc := json.NewEncoder(l.out)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(event); err != nil {
		// Best-effort write: a stdout encode failure is unrecoverable here
		// without risking recursion, so drop the event silently.
		return
	}
}

// NoopAuditor is an Auditor that discards every event. Used when auditing is
// disabled so callers can avoid nil checks.
type NoopAuditor struct{}

// Record implements Auditor by discarding the event.
func (NoopAuditor) Record(context.Context, Event) {}
