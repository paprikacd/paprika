package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ArtifactProvenance tracks the origin of an artifact.
// ArtifactProvenance tracks the origin of an artifact.
type ArtifactProvenance struct {
	Pipeline string `json:"pipeline,omitempty"`
	Build    string `json:"build,omitempty"`
	// +optional
	Step string `json:"step,omitempty"`
}

// ArtifactSpec defines the specification for an artifact.
type ArtifactSpec struct {
	// +kubebuilder:validation:Enum=oci;configmap
	Type       string             `json:"type"`
	Reference  string             `json:"reference"`
	Digest     string             `json:"digest,omitempty"`
	Provenance ArtifactProvenance `json:"provenance,omitempty"`
}

// ArtifactStatus represents the status of an artifact.
type ArtifactStatus struct {
	// ObservedGeneration is the most recent generation observed by the controller.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Verified reports whether the artifact reference was resolved successfully.
	// +optional
	Verified bool `json:"verified,omitempty"`

	// ResolvedDigest is the digest returned by the registry for the reference.
	// +optional
	ResolvedDigest string `json:"resolvedDigest,omitempty"`

	// Conditions reflect artifact verification readiness.
	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// Artifact represents a build artifact.
type Artifact struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`
	Spec              ArtifactSpec `json:"spec"`
	// +optional
	Status ArtifactStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// ArtifactList is a list of Artifacts.
type ArtifactList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Artifact `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Artifact{}, &ArtifactList{})
}
