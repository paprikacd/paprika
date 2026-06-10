package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ChartRef references a Helm chart.
type ChartRef struct {
	Repo    string `json:"repo,omitempty"`
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
	// Path to a local Helm chart directory (alternative to Repo+Name)
	Path string `json:"path,omitempty"`
}

// GitSourceSpec defines a git source specification.
type GitSourceSpec struct {
	RepoURL   string `json:"repoUrl"`
	Revision  string `json:"revision,omitempty"`
	Path      string `json:"path,omitempty"`
	SecretRef string `json:"secretRef,omitempty"`
}

// S3SourceSpec defines an S3 source specification.
type S3SourceSpec struct {
	Bucket    string `json:"bucket"`
	Key       string `json:"key"`
	Region    string `json:"region,omitempty"`
	Endpoint  string `json:"endpoint,omitempty"`
	Path      string `json:"path,omitempty"`
	SecretRef string `json:"secretRef,omitempty"`
}

// TemplateSpec defines the specification for a template.
type TemplateSpec struct {
	// +kubebuilder:validation:Enum=helm;kubernetes;kustomize;git;s3
	Type  string         `json:"type"`
	Chart ChartRef       `json:"chart,omitempty"`
	Git   *GitSourceSpec `json:"git,omitempty"`
	S3    *S3SourceSpec  `json:"s3,omitempty"`
	// Namespace to pass to helm --namespace
	Namespace string `json:"namespace,omitempty"`
	// Inline YAML values file content (merged with Release parameters)
	ValuesFile string `json:"valuesFile,omitempty"`
}

// TemplateStatus represents the status of a template.
type TemplateStatus struct {
	LastRendered   *metav1.Time `json:"lastRendered,omitempty"`
	LastRenderHash string       `json:"lastRenderHash,omitempty"`
	SourceHash     string       `json:"sourceHash,omitempty"`
	SourceRevision string       `json:"sourceRevision,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// Template represents a renderable template.
type Template struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`
	Spec              TemplateSpec `json:"spec"`
	// +optional
	Status TemplateStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// TemplateList is a list of Templates.
type TemplateList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Template `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Template{}, &TemplateList{})
}
