package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// PipelinePhase represents the phase of a pipeline.
// PipelinePhase represents the phase of a pipeline.
type PipelinePhase string

const (
	// PipelineRunning indicates the pipeline is running.
	PipelineRunning PipelinePhase = "Running"
	// PipelineSucceeded indicates the pipeline succeeded.
	PipelineSucceeded PipelinePhase = "Succeeded"
	// PipelineFailed indicates the pipeline failed.
	PipelineFailed PipelinePhase = "Failed"
)

// StepPhase represents the phase of a pipeline step.
type StepPhase string

const (
	// StepPending indicates the step is pending execution.
	StepPending StepPhase = "Pending"
	// StepRunning indicates the step is running.
	StepRunning StepPhase = "Running"
	// StepSucceeded indicates the step succeeded.
	StepSucceeded StepPhase = "Succeeded"
	// StepFailed indicates the step failed.
	StepFailed StepPhase = "Failed"
	// StepSkipped indicates the step was skipped.
	StepSkipped StepPhase = "Skipped"
)

// Source defines a source for the pipeline.
type Source struct {
	// +kubebuilder:validation:Enum=git
	Type string `json:"type"`
	URL  string `json:"url,omitempty"`
	// +optional
	SecretRef string `json:"secretRef,omitempty"`
}

// PipelineStep defines a step in a pipeline.
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

// PipelineOutput defines an output artifact of a pipeline.
type PipelineOutput struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

// StepStatus represents the status of a pipeline step.
type StepStatus struct {
	Name string `json:"name"`
	// +kubebuilder:validation:Enum=Pending;Running;Succeeded;Failed;Skipped
	Phase       StepPhase    `json:"phase"`
	LogRef      string       `json:"logRef,omitempty"`
	StartedAt   *metav1.Time `json:"startedAt,omitempty"`
	CompletedAt *metav1.Time `json:"completedAt,omitempty"`
}

// PipelineSpec defines the specification for a pipeline.
type PipelineSpec struct {
	// +optional
	MaxParallel int `json:"maxParallel,omitempty"`
	// +optional
	Sources []Source       `json:"sources,omitempty"`
	Steps   []PipelineStep `json:"steps"`
	// +optional
	Artifacts []PipelineOutput `json:"artifacts,omitempty"`
}

// PipelineStatus represents the status of a pipeline.
type PipelineStatus struct {
	// ObservedGeneration is the last observed generation of the spec.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// +kubebuilder:validation:Enum=Running;Succeeded;Failed
	Phase             PipelinePhase `json:"phase,omitempty"`
	StepStatuses      []StepStatus  `json:"stepStatuses,omitempty"`
	LastExecutionTime *metav1.Time  `json:"lastExecutionTime,omitempty"`
	LastExecutionID   string        `json:"lastExecutionId,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// Pipeline represents a CI/CD pipeline.
type Pipeline struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`
	Spec              PipelineSpec `json:"spec"`
	// +optional
	Status PipelineStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// PipelineList is a list of Pipelines.
type PipelineList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Pipeline `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Pipeline{}, &PipelineList{})
}
