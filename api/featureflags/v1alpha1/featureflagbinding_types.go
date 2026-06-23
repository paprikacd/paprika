package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Namespaced,shortName=ffb
// +kubebuilder:subresource:status

type FeatureFlagBinding struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              FeatureFlagBindingSpec   `json:"spec,omitempty"`
	Status            FeatureFlagBindingStatus `json:"status,omitempty"`
}

type FeatureFlagBindingStatus struct {
	// ObservedGeneration is the most recent generation observed by the controller.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Conditions reflect binding readiness.
	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

type FeatureFlagBindingSpec struct {
	FlagRef       string           `json:"flagRef"`
	Target        BindingTarget    `json:"target"`
	OverrideValue FeatureFlagValue `json:"overrideValue"`
}

type BindingTarget struct {
	// +kubebuilder:validation:Enum=Rollout;Deployment;Namespace
	Kind string `json:"kind"`

	// +optional
	Name string `json:"name,omitempty"`

	// +optional
	Selector *metav1.LabelSelector `json:"selector,omitempty"`
}

// +kubebuilder:object:root=true
type FeatureFlagBindingList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []FeatureFlagBinding `json:"items"`
}

func init() {
	SchemeBuilder.Register(&FeatureFlagBinding{}, &FeatureFlagBindingList{})
}
