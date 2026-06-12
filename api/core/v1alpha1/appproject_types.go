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

// AppProjectSpec defines tenant boundaries and resource constraints for applications.
type AppProjectSpec struct {
	Description string `json:"description,omitempty"`

	// SourceRepos restricts which repository URLs are allowed. Empty means all.
	SourceRepos []string `json:"sourceRepos,omitempty"`

	// SourceReposDeny denies matching repository URLs.
	SourceReposDeny []string `json:"sourceReposDeny,omitempty"`

	// Repositories restricts which core.paprika.io Repository names are allowed.
	// Applications/Templates referencing a Repository must use one of these names.
	// +optional
	Repositories []string `json:"repositories,omitempty"`

	// Destinations restricts target cluster/server and namespace combinations.
	Destinations []AppProjectDestination `json:"destinations,omitempty"`

	// Kinds restricts which Kubernetes kinds may be deployed. Empty means all.
	Kinds []string `json:"kinds,omitempty"`

	// KindsDeny denies matching kinds.
	KindsDeny []string `json:"kindsDeny,omitempty"`

	// ClusterResourceWhitelist permits cluster-scoped resources.
	ClusterResourceWhitelist []string `json:"clusterResourceWhitelist,omitempty"`

	// ClusterResourceBlacklist denies cluster-scoped resources.
	ClusterResourceBlacklist []string `json:"clusterResourceBlacklist,omitempty"`

	// Roles define project-level RBAC subjects.
	Roles []AppProjectRole `json:"roles,omitempty"`
}

// AppProjectDestination restricts where applications may deploy.
type AppProjectDestination struct {
	Server    string `json:"server,omitempty"`
	Namespace string `json:"namespace,omitempty"`
	Name      string `json:"name,omitempty"`
}

// AppProjectRole defines project-level access.
type AppProjectRole struct {
	Name     string   `json:"name"`
	Subjects []string `json:"subjects,omitempty"`
	Actions  []string `json:"actions,omitempty"`
}

// AppProjectStatus defines the observed state of AppProject.
type AppProjectStatus struct {
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// AppProject groups applications into a multi-tenant project with source, destination, and resource constraints.
type AppProject struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	Spec   AppProjectSpec   `json:"spec"`
	Status AppProjectStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// AppProjectList contains a list of AppProject.
type AppProjectList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []AppProject `json:"items"`
}

func init() {
	SchemeBuilder.Register(&AppProject{}, &AppProjectList{})
}
