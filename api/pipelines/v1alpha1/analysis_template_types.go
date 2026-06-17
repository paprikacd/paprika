package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// AnalysisTemplateArg declares a parameter that can be supplied by referencing resources.
type AnalysisTemplateArg struct {
	Name string `json:"name"`
	// +optional
	Default string `json:"default,omitempty"`
}

// AnalysisTemplateSpec defines a reusable set of analysis checks.
type AnalysisTemplateSpec struct {
	// Args are the named parameters accepted by this template.
	// +optional
	Args []AnalysisTemplateArg `json:"args,omitempty"`
	// Checks are the analysis checks to run.
	// +optional
	Checks []AnalysisCheck `json:"checks,omitempty"`
}

// AnalysisTemplateStatus defines the observed state of an AnalysisTemplate.
type AnalysisTemplateStatus struct {
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Checks",type=integer,JSONPath=".spec.checks"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// AnalysisTemplate represents a reusable set of analysis checks.
type AnalysisTemplate struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	Spec AnalysisTemplateSpec `json:"spec"`
	// +optional
	Status AnalysisTemplateStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// AnalysisTemplateList contains a list of AnalysisTemplates.
type AnalysisTemplateList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []AnalysisTemplate `json:"items"`
}

func init() {
	SchemeBuilder.Register(&AnalysisTemplate{}, &AnalysisTemplateList{})
}
