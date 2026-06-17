package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// AnalysisRunPhase represents the phase of an analysis run.
type AnalysisRunPhase string

const (
	// AnalysisRunPending indicates the run is waiting for the template.
	AnalysisRunPending AnalysisRunPhase = "Pending"
	// AnalysisRunRunning indicates the run is actively executing checks.
	AnalysisRunRunning AnalysisRunPhase = "Running"
	// AnalysisRunSuccessful indicates the latest cycle passed.
	AnalysisRunSuccessful AnalysisRunPhase = "Successful"
	// AnalysisRunFailed indicates the latest cycle failed.
	AnalysisRunFailed AnalysisRunPhase = "Failed"
	// AnalysisRunError indicates the run could not execute (template missing, etc.).
	AnalysisRunError AnalysisRunPhase = "Error"
	// AnalysisRunCompleted indicates the run reached its configured count.
	AnalysisRunCompleted AnalysisRunPhase = "Completed"
)

// AnalysisRunResult records the outcome of a single check execution.
type AnalysisRunResult struct {
	Name      string       `json:"name"`
	Passed    bool         `json:"passed"`
	Message   string       `json:"message,omitempty"`
	Detail    string       `json:"detail,omitempty"`
	CheckedAt *metav1.Time `json:"checkedAt,omitempty"`
}

// AnalysisRunSpec defines the desired state of an AnalysisRun.
type AnalysisRunSpec struct {
	// TemplateRef references the AnalysisTemplate to execute.
	TemplateRef string `json:"templateRef"`
	// ApplicationRef references the Application that owns this run.
	ApplicationRef string `json:"applicationRef"`
	// Args override template arguments.
	// +optional
	Args map[string]string `json:"args,omitempty"`
	// IntervalSeconds between consecutive analysis cycles (default 60).
	// +kubebuilder:default=60
	// +optional
	IntervalSeconds int `json:"intervalSeconds,omitempty"`
	// Count limits the number of analysis cycles. 0 or unset means indefinite.
	// +optional
	Count int `json:"count,omitempty"`
	// TerminateOnFailure stops the run after the first failed cycle.
	// +optional
	TerminateOnFailure bool `json:"terminateOnFailure,omitempty"`
}

// AnalysisRunStatus defines the observed state of an AnalysisRun.
type AnalysisRunStatus struct {
	// ObservedGeneration is the last observed generation of the spec.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// +kubebuilder:validation:Enum=Pending;Running;Successful;Failed;Error;Completed
	Phase AnalysisRunPhase `json:"phase,omitempty"`
	// CyclesExecuted is the number of completed analysis cycles.
	// +optional
	CyclesExecuted int `json:"cyclesExecuted,omitempty"`
	// Results are the latest check results from the most recent cycle.
	// +optional
	Results []AnalysisRunResult `json:"results,omitempty"`
	// +optional
	StartedAt *metav1.Time `json:"startedAt,omitempty"`
	// +optional
	CompletedAt *metav1.Time `json:"completedAt,omitempty"`
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=".status.phase"
// +kubebuilder:printcolumn:name="Template",type=string,JSONPath=".spec.templateRef"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// AnalysisRun represents an instance of an AnalysisTemplate executing for an Application.
type AnalysisRun struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	Spec AnalysisRunSpec `json:"spec"`
	// +optional
	Status AnalysisRunStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// AnalysisRunList contains a list of AnalysisRuns.
type AnalysisRunList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []AnalysisRun `json:"items"`
}

func init() {
	SchemeBuilder.Register(&AnalysisRun{}, &AnalysisRunList{})
}
