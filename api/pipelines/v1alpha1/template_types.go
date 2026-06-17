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

// OCISourceSpec defines an OCI registry source (for Helm charts or artifacts).
type OCISourceSpec struct {
	// URL of the OCI artifact, e.g. oci://registry.example.com/charts/mychart
	URL string `json:"url"`
	// Tag or digest of the artifact (e.g. "1.2.3", "@sha256:...")
	Tag string `json:"tag,omitempty"`
	// Insecure allows plain HTTP for the OCI registry
	// +optional
	Insecure bool `json:"insecure,omitempty"`
	// SecretRef references a Secret with dockerconfigjson or .dockerconfigjson
	SecretRef string `json:"secretRef,omitempty"`
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

// KustomizeImage defines an image transformation for Kustomize.
type KustomizeImage struct {
	// Name of the existing image to replace
	Name string `json:"name"`
	// NewName is the replacement image name
	NewName string `json:"newName,omitempty"`
	// NewTag is the replacement tag
	NewTag string `json:"newTag,omitempty"`
	// Digest is the replacement digest (mutually exclusive with NewTag)
	Digest string `json:"digest,omitempty"`
}

// KustomizeSourceSpec defines a Kustomize source specification.
type KustomizeSourceSpec struct {
	// Path to a directory containing a kustomization.yaml. Ignored when InputFromPrevious is true.
	Path string `json:"path,omitempty"`
	// NamePrefix sets the resources name prefix
	NamePrefix string `json:"namePrefix,omitempty"`
	// NameSuffix sets the resources name suffix
	NameSuffix string `json:"nameSuffix,omitempty"`
	// Namespace sets the resources namespace
	Namespace string `json:"namespace,omitempty"`
	// Images sets image transformations
	Images []KustomizeImage `json:"images,omitempty"`
	// CommonLabels adds labels to all resources
	CommonLabels map[string]string `json:"commonLabels,omitempty"`
	// CommonAnnotations adds annotations to all resources
	CommonAnnotations map[string]string `json:"commonAnnotations,omitempty"`
	// InputFromPrevious uses the output of the previous rendering step as the Kustomize base.
	// When true, a temporary kustomization directory is created that includes the previous output.
	InputFromPrevious bool `json:"inputFromPrevious,omitempty"`
}

// TemplateSpec defines the specification for a template.
type TemplateSpec struct {
	// +kubebuilder:validation:Enum=helm;kustomize;git;s3;oci
	Type      string               `json:"type"`
	Chart     ChartRef             `json:"chart,omitempty"`
	Git       *GitSourceSpec       `json:"git,omitempty"`
	S3        *S3SourceSpec        `json:"s3,omitempty"`
	OCI       *OCISourceSpec       `json:"oci,omitempty"`
	Kustomize *KustomizeSourceSpec `json:"kustomize,omitempty"`
	// RepoRef references a core.paprika.io Repository by name. When set, takes
	// precedence over the inline source spec fields.
	// +optional
	RepoRef string `json:"repoRef,omitempty"`
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
