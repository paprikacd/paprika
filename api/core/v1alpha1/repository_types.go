/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// RepositoryType identifies the kind of external source a Repository refers to.
type RepositoryType string

const (
	// RepositoryTypeGit is a Git repository source.
	RepositoryTypeGit RepositoryType = "git"
	// RepositoryTypeHelm is a traditional Helm chart repository (HTTP).
	RepositoryTypeHelm RepositoryType = "helm"
	// RepositoryTypeOCI is an OCI registry (for Helm charts or container images).
	RepositoryTypeOCI RepositoryType = "oci"
)

// ConnectionStatus represents the health of a Repository's last connection attempt.
type ConnectionStatus string

const (
	// ConnectionStatusUnknown means the Repository has not been tested yet.
	ConnectionStatusUnknown ConnectionStatus = "Unknown"
	// ConnectionStatusSuccessful means the last connection attempt succeeded.
	ConnectionStatusSuccessful ConnectionStatus = "Successful"
	// ConnectionStatusFailed means the last connection attempt failed.
	ConnectionStatusFailed ConnectionStatus = "Failed"
)

// SecretRef references a Secret in the Repository's namespace.
type SecretRef struct {
	// Name of the Secret in the same namespace.
	Name string `json:"name"`
}

// GitHubAppCreds holds GitHub App authentication parameters for git repositories.
type GitHubAppCreds struct {
	// AppID is the GitHub App ID.
	AppID string `json:"appId,omitempty"`
	// InstallationID is the GitHub App installation ID.
	InstallationID string `json:"installationId,omitempty"`
	// EnterpriseURL is the base URL for GitHub Enterprise (e.g. https://github.example.com).
	EnterpriseURL string `json:"enterpriseUrl,omitempty"`
}

// RepositorySpec defines the specification for a Repository.
type RepositorySpec struct {
	// Type of repository: git, helm, or oci.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Enum=git;helm;oci
	Type RepositoryType `json:"type"`
	// URL of the repository. Examples:
	//   git:  https://github.com/org/repo, git@github.com:org/repo.git
	//   helm: https://charts.example.com
	//   oci:  oci://registry.example.com/charts
	// +kubebuilder:validation:Required
	URL string `json:"url"`
	// Insecure allows plain HTTP/registry (no TLS) for oci and helm types.
	// +optional
	Insecure bool `json:"insecure,omitempty"`
	// EnableLFS enables Git Large File Storage fetch (git type).
	// +optional
	EnableLFS bool `json:"enableLfs,omitempty"`
	// SecretRef references credentials for the repository.
	// +optional
	SecretRef *SecretRef `json:"secretRef,omitempty"`
	// GitHubApp credentials (git type only).
	// +optional
	GitHubApp *GitHubAppCreds `json:"githubApp,omitempty"`
	// ForceHTTPBasicAuth forces HTTP basic auth even if credentials look like a token.
	// +optional
	ForceHTTPBasicAuth bool `json:"forceHttpBasicAuth,omitempty"`
	// NoProxy disables proxy usage for this repository.
	// +optional
	NoProxy bool `json:"noProxy,omitempty"`
}

// ConnectionState describes the result of the most recent connection attempt.
type ConnectionState struct {
	Status       ConnectionStatus `json:"status,omitempty"`
	Message      string           `json:"message,omitempty"`
	AttemptedAt  *metav1.Time     `json:"attemptedAt,omitempty"`
	ResponseTime string           `json:"responseTime,omitempty"`
	Revision     string           `json:"revision,omitempty"`
}

// RepositoryStatus defines the observed state of Repository.
type RepositoryStatus struct {
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
	// +optional
	ConnectionState *ConnectionState `json:"connectionState,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Type",type=string,JSONPath=".spec.type"
// +kubebuilder:printcolumn:name="URL",type=string,JSONPath=".spec.url"
// +kubebuilder:printcolumn:name="Status",type=string,JSONPath=".status.connectionState.status"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// Repository is a named, reusable configuration for an external source (git, helm, or OCI).
// Applications and Templates can reference a Repository by name instead of inlining URLs
// and credentials, and AppProjects can constrain which Repositories are allowed.
type Repository struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	Spec   RepositorySpec   `json:"spec"`
	Status RepositoryStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// RepositoryList contains a list of Repository.
type RepositoryList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Repository `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Repository{}, &RepositoryList{})
}
