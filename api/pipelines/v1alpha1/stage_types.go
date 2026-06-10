package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ClusterRef struct {
	Name string `json:"name"`
}

type GateConfig struct {
	// +kubebuilder:validation:Enum=smoke-test;duration
	Type     string `json:"type"`
	Endpoint string `json:"endpoint,omitempty"`
	Timeout  int    `json:"timeout,omitempty"`
}

type StageSpec struct {
	Name      string       `json:"name"`
	Ring      int          `json:"ring"`
	Cluster   ClusterRef   `json:"cluster,omitempty"`
	Templates []string     `json:"templates"`
	Gates     []GateConfig `json:"gates,omitempty"`
}

type StageStatus struct {
	LastPromotion *metav1.Time `json:"lastPromotion,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

type Stage struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`
	Spec              StageSpec `json:"spec"`
	// +optional
	Status StageStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

type StageList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Stage `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Stage{}, &StageList{})
}
