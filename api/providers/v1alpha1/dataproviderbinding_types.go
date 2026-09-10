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

// ScopeKind names a level of the binding precedence chain.
// +kubebuilder:validation:Enum=Namespace;Cluster;Project;Global
type ScopeKind string

const (
	ScopeNamespace ScopeKind = "Namespace"
	ScopeCluster   ScopeKind = "Cluster"
	ScopeProject   ScopeKind = "Project"
	ScopeGlobal    ScopeKind = "Global"
)

// ScopeKindsBySpecificity returns the precedence chain, most specific first.
//
// Paprika has no organisation or tenant type today, so no Org level exists. If
// one arrives, it is one constant and one entry here — nothing already bound
// changes meaning.
func ScopeKindsBySpecificity() []ScopeKind {
	return []ScopeKind{ScopeNamespace, ScopeCluster, ScopeProject, ScopeGlobal}
}

// ProviderReference identifies the CapacityProvider a binding resolves to.
type ProviderReference struct {
	// Kind is the referenced provider kind, e.g. "CapacityProvider".
	// +kubebuilder:validation:Required
	Kind string `json:"kind"`

	// Name is the name of the referenced object.
	// +kubebuilder:validation:Required
	Name string `json:"name"`
}

// BindingScope describes the level and target this binding applies to.
type BindingScope struct {
	// Kind is the scope level this binding applies at.
	// +kubebuilder:validation:Required
	Kind ScopeKind `json:"kind"`

	// Name is the name of the scoped object, e.g. a namespace or cluster name.
	// +optional
	Name string `json:"name,omitempty"`

	// Selector optionally narrows the scope to matching objects.
	// +optional
	Selector *metav1.LabelSelector `json:"selector,omitempty"`
}

// DataProviderBindingSpec defines the desired state of a DataProviderBinding.
type DataProviderBindingSpec struct {
	// ProviderRef identifies the CapacityProvider this binding resolves to.
	// +kubebuilder:validation:Required
	ProviderRef ProviderReference `json:"providerRef"`

	// Scope describes the level and target this binding applies to.
	// +kubebuilder:validation:Required
	Scope BindingScope `json:"scope"`
}

// DataProviderBindingStatus defines the observed state of a DataProviderBinding.
type DataProviderBindingStatus struct {
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Provider",type=string,JSONPath=".spec.providerRef.name"
// +kubebuilder:printcolumn:name="Scope",type=string,JSONPath=".spec.scope.kind"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// DataProviderBinding binds a CapacityProvider to a scope in the precedence chain.
type DataProviderBinding struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	Spec   DataProviderBindingSpec   `json:"spec"`
	Status DataProviderBindingStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// DataProviderBindingList contains a list of DataProviderBinding.
type DataProviderBindingList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []DataProviderBinding `json:"items"`
}

func init() {
	SchemeBuilder.Register(&DataProviderBinding{}, &DataProviderBindingList{})
}
