package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ChartRef struct {
	Repo    string `json:"repo"`
	Name    string `json:"name"`
	Version string `json:"version"`
}

type TemplateSpec struct {
	// +kubebuilder:validation:Enum=helm
	Type  string   `json:"type"`
	Chart ChartRef `json:"chart,omitempty"`
}

type TemplateStatus struct {
	LastRendered   *metav1.Time `json:"lastRendered,omitempty"`
	LastRenderHash string       `json:"lastRenderHash,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

type Template struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`
	Spec              TemplateSpec `json:"spec"`
	// +optional
	Status TemplateStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

type TemplateList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Template `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Template{}, &TemplateList{})
}
