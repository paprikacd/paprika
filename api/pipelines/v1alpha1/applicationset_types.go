package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ApplicationSetGenerator is a union of supported generator types.
// Only one field should be set at a time.
type ApplicationSetGenerator struct {
	// List generates parameters from a static list of maps.
	// +optional
	List *ListGenerator `json:"list,omitempty"`
	// GitDirectories discovers directories in a Git repository.
	// +optional
	GitDirectories *GitDirectoriesGenerator `json:"gitDirectories,omitempty"`
	// Clusters generates parameters from registered clusters.
	// +optional
	Clusters *ClustersGenerator `json:"clusters,omitempty"`
	// Matrix combines two generators using a Cartesian product.
	// +optional
	Matrix *MatrixGenerator `json:"matrix,omitempty"`
}

// ListGenerator generates a set of parameters from a static list.
type ListGenerator struct {
	// Items is the list of parameter maps.
	Items []map[string]string `json:"items"`
}

// GitDirectoriesGenerator discovers directories inside a Git repository.
type GitDirectoriesGenerator struct {
	// RepoURL is the Git repository URL or local path.
	RepoURL string `json:"repoUrl"`
	// Revision is the branch, tag, or commit to checkout.
	// +optional
	Revision string `json:"revision,omitempty"`
	// Path is the subdirectory within the repository to scan.
	// +optional
	Path string `json:"path,omitempty"`
}

// ClustersGenerator generates parameters from cluster names or a label selector.
type ClustersGenerator struct {
	// Names is a static list of cluster names.
	// +optional
	Names []string `json:"names,omitempty"`
	// Selector filters Cluster resources by labels.
	// +optional
	Selector *metav1.LabelSelector `json:"selector,omitempty"`
}

// NestedApplicationSetGenerator is a generator that can be used inside a Matrix.
// It does not support nested Matrix generators.
type NestedApplicationSetGenerator struct {
	// List generates parameters from a static list.
	// +optional
	List *ListGenerator `json:"list,omitempty"`
	// GitDirectories discovers directories in a Git repository.
	// +optional
	GitDirectories *GitDirectoriesGenerator `json:"gitDirectories,omitempty"`
	// Clusters generates parameters from registered clusters.
	// +optional
	Clusters *ClustersGenerator `json:"clusters,omitempty"`
}

// MatrixGenerator combines two generators using a Cartesian product.
type MatrixGenerator struct {
	// First is the first generator to combine.
	First NestedApplicationSetGenerator `json:"first"`
	// Second is the second generator to combine.
	Second NestedApplicationSetGenerator `json:"second"`
}

// ApplicationTemplateSpec defines the template used to render Applications.
// It embeds ApplicationSpec so that all source, strategy, stage, sync and
// parameter fields can be templated.
type ApplicationTemplateSpec struct {
	ApplicationSpec `json:",inline"`
}

// ApplicationSetSpec defines the desired state of an ApplicationSet.
type ApplicationSetSpec struct {
	// Generators produce the parameter maps used to render Applications.
	Generators []ApplicationSetGenerator `json:"generators"`
	// Template is the Application template to render for each parameter set.
	Template ApplicationTemplateSpec `json:"template"`
}

// ApplicationSetStatus defines the observed state of an ApplicationSet.
type ApplicationSetStatus struct {
	// ObservedGeneration is the last observed generation of the spec.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// Applications is the number of Applications currently owned by this set.
	// +optional
	Applications int `json:"applications,omitempty"`
	// Conditions represent the current state of the ApplicationSet.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Applications",type=integer,JSONPath=".status.applications"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// ApplicationSet represents a templated set of Paprika Applications.
type ApplicationSet struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	Spec ApplicationSetSpec `json:"spec"`
	// +optional
	Status ApplicationSetStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// ApplicationSetList contains a list of ApplicationSets.
type ApplicationSetList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []ApplicationSet `json:"items"`
}

func init() {
	SchemeBuilder.Register(&ApplicationSet{}, &ApplicationSetList{})
}
