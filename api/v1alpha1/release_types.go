package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ReleasePhase string

const (
	ReleasePending    ReleasePhase = "Pending"
	ReleasePromoting  ReleasePhase = "Promoting"
	ReleaseVerifying  ReleasePhase = "Verifying"
	ReleaseComplete   ReleasePhase = "Complete"
	ReleaseFailed     ReleasePhase = "Failed"
	ReleaseRolledBack ReleasePhase = "RolledBack"
	ReleaseSuperseded ReleasePhase = "Superseded"
)

type FailureAction struct {
	// +kubebuilder:validation:Enum=rollback;halt;ignore
	Action string   `json:"action"`
	Notify []string `json:"notify,omitempty"`
}

type PromotionEntry struct {
	Stage            string      `json:"stage"`
	Result           string      `json:"result"`
	ManifestSnapshot string      `json:"manifestSnapshot,omitempty"`
	Timestamp        metav1.Time `json:"timestamp"`
}

type ReleaseSpec struct {
	Pipeline  string         `json:"pipeline"`
	Target    string         `json:"target"`
	From      string         `json:"from,omitempty"`
	Verify    []GateConfig   `json:"verify,omitempty"`
	OnFailure *FailureAction `json:"on_failure,omitempty"`
}

type ReleaseStatus struct {
	// +kubebuilder:validation:Enum=Pending;Promoting;Verifying;Complete;Failed;RolledBack;Superseded
	Phase                    ReleasePhase       `json:"phase,omitempty"`
	CurrentStage             string             `json:"currentStage,omitempty"`
	PromotionHistory         []PromotionEntry   `json:"promotionHistory,omitempty"`
	Conditions               []metav1.Condition `json:"conditions,omitempty"`
	RenderedManifestSnapshot string             `json:"renderedManifestSnapshot,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

type Release struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`
	Spec              ReleaseSpec `json:"spec"`
	// +optional
	Status ReleaseStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

type ReleaseList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Release `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Release{}, &ReleaseList{})
}
