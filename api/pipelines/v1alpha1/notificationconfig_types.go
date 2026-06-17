package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// NotificationTrigger selects events that should trigger a notification.
type NotificationTrigger struct {
	// ResourceType filters by event type, e.g. "application" or "release".
	// +optional
	ResourceType string `json:"resourceType,omitempty"`
	// Phase filters by the resource phase reported in the event.
	// +optional
	Phase string `json:"phase,omitempty"`
	// Reason filters by a reason included in the event payload.
	// +optional
	Reason string `json:"reason,omitempty"`
}

// NotificationDestination describes where to deliver matched notifications.
type NotificationDestination struct {
	// Name is a human-readable identifier for this destination.
	// +optional
	Name string `json:"name,omitempty"`
	// WebhookURL is a generic HTTP endpoint that receives a JSON payload.
	// +optional
	WebhookURL string `json:"webhookUrl,omitempty"`
	// SlackWebhookURL is a Slack incoming webhook URL.
	// +optional
	SlackWebhookURL string `json:"slackWebhookUrl,omitempty"`
	// Email is a recipient email address (optional, for future senders).
	// +optional
	Email string `json:"email,omitempty"`
}

// NotificationConfigSpec defines the desired state of NotificationConfig.
type NotificationConfigSpec struct {
	// Triggers select events that should produce notifications.
	// +optional
	Triggers []NotificationTrigger `json:"triggers,omitempty"`
	// Destinations receive notifications for matched events.
	// +optional
	Destinations []NotificationDestination `json:"destinations,omitempty"`
	// Template is an optional Go template string used to format notification
	// messages. The data map contains name, namespace, phase and reason.
	// +optional
	Template string `json:"template,omitempty"`
}

// NotificationConfigStatus defines the observed state of NotificationConfig.
type NotificationConfigStatus struct {
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Namespaced

// NotificationConfig configures event-driven notifications for Paprika resources.
type NotificationConfig struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	Spec   NotificationConfigSpec   `json:"spec,omitempty"`
	Status NotificationConfigStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// NotificationConfigList contains a list of NotificationConfig resources.
type NotificationConfigList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []NotificationConfig `json:"items"`
}

func init() {
	SchemeBuilder.Register(&NotificationConfig{}, &NotificationConfigList{})
}
