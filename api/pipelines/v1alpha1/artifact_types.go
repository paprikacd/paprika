package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

type ArtifactProvenance struct {
	Pipeline string `json:"pipeline,omitempty"`
	Build    string `json:"build,omitempty"`
}

type ArtifactSpec struct {
	// +kubebuilder:validation:Enum=oci
	Type       string             `json:"type"`
	Reference  string             `json:"reference"`
	Digest     string             `json:"digest,omitempty"`
	Provenance ArtifactProvenance `json:"provenance,omitempty"`
}

type ArtifactStatus struct {
	Verified bool `json:"verified,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

type Artifact struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`
	Spec              ArtifactSpec `json:"spec"`
	// +optional
	Status ArtifactStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

type ArtifactList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Artifact `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Artifact{}, &ArtifactList{})
}
