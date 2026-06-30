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
	// ReleaseAwaitingApproval indicates the release is waiting for approval gates.
	ReleaseAwaitingApproval ReleasePhase = "AwaitingApproval"
)

// FailureAction defines the action to take on failure.
type FailureAction struct {
	// +kubebuilder:validation:Enum=rollback;halt;ignore
	Action string   `json:"action"`
	Notify []string `json:"notify,omitempty"`
}

// ManifestSource references a manifest snapshot ConfigMap owned by a Release.
type ManifestSource struct {
	// ConfigMapRef is the name of the snapshot ConfigMap.
	// +optional
	ConfigMapRef string `json:"configMapRef,omitempty"`
}

// ReleasePolicyResult records the outcome of a single policy evaluation for a release.
type ReleasePolicyResult struct {
	Name     string `json:"name"`
	Severity string `json:"severity"`
	Action   string `json:"action"`
	Passed   bool   `json:"passed"`
	Message  string `json:"message,omitempty"`
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
	// ManifestSource references a pre-rendered inline manifest snapshot ConfigMap.
	// When set, the controller skips template rendering and applies manifests from the ConfigMap.
	// +optional
	ManifestSource *ManifestSource `json:"manifestSource,omitempty"`
	// SyncOptions fine-tunes how manifests are applied and pruned for this release.
	// +optional
	SyncOptions *SyncOptions `json:"syncOptions,omitempty"`
}

// HookStatus is the observed state of a single hook resource.
type HookStatus struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	// Phase is the hook phase: PreSync, Sync, PostSync, or SyncFail.
	// +kubebuilder:validation:Enum=PreSync;Sync;PostSync;SyncFail
	Phase string `json:"phase"`
	// Status is the execution state: Running, Succeeded, Failed, or Terminated.
	// +kubebuilder:validation:Enum=Running;Succeeded;Failed;Terminated
	Status      string       `json:"status"`
	StartedAt   *metav1.Time `json:"startedAt,omitempty"`
	CompletedAt *metav1.Time `json:"completedAt,omitempty"`
	Message     string       `json:"message,omitempty"`
}

// ReleaseStatus represents the status of a release.
type ReleaseStatus struct {
	// ObservedGeneration is the last observed generation of the spec.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// +kubebuilder:validation:Enum=Pending;Promoting;Canarying;Verifying;Complete;Failed;RolledBack;Superseded;AwaitingApproval
	Phase                    ReleasePhase       `json:"phase,omitempty"`
	CurrentStage             string             `json:"currentStage,omitempty"`
	PromotionHistory         []PromotionEntry   `json:"promotionHistory,omitempty"`
	Conditions               []metav1.Condition `json:"conditions,omitempty"`
	RenderedManifestSnapshot string             `json:"renderedManifestSnapshot,omitempty"`
	// PolicyResults records the outcome of policy evaluation for this release.
	// +optional
	PolicyResults []ReleasePolicyResult `json:"policyResults,omitempty"`
	// RolledBackTo records the release name that a rolled-back release re-applied.
	// +optional
	RolledBackTo string `json:"rolledBackTo,omitempty"`
	// Current canary traffic weight (0-100)
	CanaryWeight int `json:"canaryWeight,omitempty"`
	// Index into the canary steps array
	CanaryStepIndex int `json:"canaryStepIndex,omitempty"`
	// When the current canary step started (used to throttle step advancement
	// to the configured intervalSeconds, preventing watch-event-driven fast-forward).
	CanaryStepStartedAt *metav1.Time `json:"canaryStepStartedAt,omitempty"`
	// RolloutRef references the Rollout child when the stage uses an advanced strategy.
	// +optional
	RolloutRef string `json:"rolloutRef,omitempty"`
	// HookStatuses tracks per-hook execution state across the four phases.
	// Cleared at the start of each promote. Populated as hooks run.
	// +optional
	HookStatuses []HookStatus `json:"hookStatuses,omitempty"`
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
