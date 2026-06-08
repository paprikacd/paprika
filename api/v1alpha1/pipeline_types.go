package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type PipelinePhase string

const (
	PipelineRunning   PipelinePhase = "Running"
	PipelineSucceeded PipelinePhase = "Succeeded"
	PipelineFailed    PipelinePhase = "Failed"
)

type StepPhase string

const (
	StepPending   StepPhase = "Pending"
	StepRunning   StepPhase = "Running"
	StepSucceeded StepPhase = "Succeeded"
	StepFailed    StepPhase = "Failed"
	StepSkipped   StepPhase = "Skipped"
)

type Source struct {
	// +kubebuilder:validation:Enum=git
	Type string `json:"type"`
	URL  string `json:"url,omitempty"`
	// +optional
	SecretRef string `json:"secretRef,omitempty"`
}

type PipelineStep struct {
	Name    string   `json:"name"`
	Depends []string `json:"depends,omitempty"`
	Image   string   `json:"image"`
	Script  string   `json:"script"`
	// +optional
	Timeout int `json:"timeout,omitempty"`
	// +optional
	Retry int `json:"retry,omitempty"`
}

type PipelineOutput struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

type StepStatus struct {
	Name string `json:"name"`
	// +kubebuilder:validation:Enum=Pending;Running;Succeeded;Failed;Skipped
	Phase       StepPhase    `json:"phase"`
	LogRef      string       `json:"logRef,omitempty"`
	StartedAt   *metav1.Time `json:"startedAt,omitempty"`
	CompletedAt *metav1.Time `json:"completedAt,omitempty"`
}

type PipelineSpec struct {
	// +optional
	MaxParallel int `json:"maxParallel,omitempty"`
	// +optional
	Sources []Source       `json:"sources,omitempty"`
	Steps   []PipelineStep `json:"steps"`
	// +optional
	Artifacts []PipelineOutput `json:"artifacts,omitempty"`
}

type PipelineStatus struct {
	// +kubebuilder:validation:Enum=Running;Succeeded;Failed
	Phase             PipelinePhase `json:"phase,omitempty"`
	StepStatuses      []StepStatus  `json:"stepStatuses,omitempty"`
	LastExecutionTime *metav1.Time  `json:"lastExecutionTime,omitempty"`
	LastExecutionID   string        `json:"lastExecutionID,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

type Pipeline struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`
	Spec              PipelineSpec `json:"spec"`
	// +optional
	Status PipelineStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

type PipelineList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Pipeline `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Pipeline{}, &PipelineList{})
}
