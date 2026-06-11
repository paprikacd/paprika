package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ReleasePhase represents the phase of a release.
type ReleasePhase string

const (
	// ReleasePending indicates the release is pending.
	ReleasePending ReleasePhase = "Pending"
	// ReleasePromoting indicates the release is promoting.
	ReleasePromoting ReleasePhase = "Promoting"
	// ReleaseCanarying indicates the release is canarying.
	ReleaseCanarying ReleasePhase = "Canarying"
	// ReleaseVerifying indicates the release is verifying.
	ReleaseVerifying ReleasePhase = "Verifying"
	// ReleaseComplete indicates the release completed successfully.
	ReleaseComplete ReleasePhase = "Complete"
	// ReleaseFailed indicates the release failed.
	ReleaseFailed ReleasePhase = "Failed"
	// ReleaseRolledBack indicates the release was rolled back.
	ReleaseRolledBack ReleasePhase = "RolledBack"
	// ReleaseSuperseded indicates the release was superseded by a newer one.
	ReleaseSuperseded ReleasePhase = "Superseded"
)

// FailureAction defines the action to take on failure.
type FailureAction struct {
	// +kubebuilder:validation:Enum=rollback;halt;ignore
	Action string   `json:"action"`
	Notify []string `json:"notify,omitempty"`
}

// PromotionEntry represents an entry in the promotion history.
type PromotionEntry struct {
	Stage            string      `json:"stage"`
	Result           string      `json:"result"`
	ManifestSnapshot string      `json:"manifestSnapshot,omitempty"`
	Timestamp        metav1.Time `json:"timestamp"`
}

// ReleaseSpec defines the specification for a release.
type ReleaseSpec struct {
	Pipeline  string         `json:"pipeline"`
	Target    string         `json:"target"`
	From      string         `json:"from,omitempty"`
	Verify    []GateConfig   `json:"verify,omitempty"`
	OnFailure *FailureAction `json:"onFailure,omitempty"`
	// Feature flag overrides passed as Helm --set values
	Parameters map[string]string `json:"parameters,omitempty"`
}

// ReleaseStatus represents the status of a release.
type ReleaseStatus struct {
	// +kubebuilder:validation:Enum=Pending;Promoting;Canarying;Verifying;Complete;Failed;RolledBack;Superseded
	Phase                    ReleasePhase       `json:"phase,omitempty"`
	CurrentStage             string             `json:"currentStage,omitempty"`
	PromotionHistory         []PromotionEntry   `json:"promotionHistory,omitempty"`
	Conditions               []metav1.Condition `json:"conditions,omitempty"`
	RenderedManifestSnapshot string             `json:"renderedManifestSnapshot,omitempty"`
	// Current canary traffic weight (0-100)
	CanaryWeight int `json:"canaryWeight,omitempty"`
	// Index into the canary steps array
	CanaryStepIndex int `json:"canaryStepIndex,omitempty"`
	// When the current canary step started (used to throttle step advancement
	// to the configured intervalSeconds, preventing watch-event-driven fast-forward).
	CanaryStepStartedAt *metav1.Time `json:"canaryStepStartedAt,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// Release represents a deployment release.
type Release struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`
	Spec              ReleaseSpec `json:"spec"`
	// +optional
	Status ReleaseStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// ReleaseList is a list of Releases.
type ReleaseList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Release `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Release{}, &ReleaseList{})
}
