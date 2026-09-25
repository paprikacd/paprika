package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
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
	// Metadata sets labels and annotations on generated Applications.
	// Generator params interpolate ("{{region}}") — labels are what
	// rollingSync step matchLabels select on.
	// +optional
	Metadata        *ApplicationTemplateMetadata `json:"metadata,omitempty"`
	ApplicationSpec `json:",inline"`
}

// ApplicationTemplateMetadata carries labels/annotations for generated apps.
type ApplicationTemplateMetadata struct {
	// +optional
	Labels map[string]string `json:"labels,omitempty"`
	// +optional
	Annotations map[string]string `json:"annotations,omitempty"`
}

// ApplicationSetSpec defines the desired state of an ApplicationSet.
type ApplicationSetSpec struct {
	// Generators produce the parameter maps used to render Applications.
	Generators []ApplicationSetGenerator `json:"generators"`
	// Template is the Application template to render for each parameter set.
	Template ApplicationTemplateSpec `json:"template"`
	// Strategy controls how template changes roll out across generated
	// Applications. Absent or type "All" updates every app immediately;
	// "RollingSync" batches updates by step, health-gated between steps
	// (Argo CD ApplicationSet progressive sync semantics).
	// +optional
	Strategy *ApplicationSetStrategy `json:"strategy,omitempty"`
}

// ApplicationSetStrategy selects the application update strategy.
type ApplicationSetStrategy struct {
	// +kubebuilder:validation:Enum=All;RollingSync
	// +optional
	Type string `json:"type,omitempty"`
	// +optional
	RollingSync *RollingSyncStrategy `json:"rollingSync,omitempty"`
}

// RollingSyncStrategy updates generated Applications in ordered batches.
// Each step matches generated apps by labels (template labels may interpolate
// generator params) and applies at most maxUpdate spec updates. A step starts
// only once every app matched by earlier steps is at desired state and
// Healthy. Apps matched by no step update last, after all steps pass.
type RollingSyncStrategy struct {
	// +kubebuilder:validation:MinItems=1
	Steps []RollingSyncStep `json:"steps"`
}

// RollingSyncStep is one batch in a rolling sync.
type RollingSyncStep struct {
	// MatchLabels selects generated Applications by label equality.
	// +optional
	MatchLabels map[string]string `json:"matchLabels,omitempty"`
	// MaxUpdate caps how many apps in this step may be updated per reconcile
	// pass. Accepts an int or a percentage of matched apps ("25%").
	// Default (unset) is 100% — the step is a pure ordering/health gate.
	// +optional
	MaxUpdate *intstr.IntOrString `json:"maxUpdate,omitempty"`
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
