package events

// EventPayload is the standard shape for resource phase-change events
// published by controllers and consumed by the UI / notification system.
type EventPayload struct {
	ResourceType  string `json:"resourceType"`
	Name          string `json:"name"`
	Namespace     string `json:"namespace"`
	Phase         string `json:"phase"`
	PreviousPhase string `json:"previousPhase,omitempty"`
	Reason        string `json:"reason,omitempty"`
	Message       string `json:"message,omitempty"`
	Timestamp     string `json:"timestamp"`
}

// AuditPayload is the shape for user action events from the audit interceptor.
type AuditPayload struct {
	Action    string `json:"action"`
	Resource  string `json:"resource"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Principal string `json:"principal"`
	Success   bool   `json:"success"`
	Error     string `json:"error,omitempty"`
	Timestamp string `json:"timestamp"`
}
