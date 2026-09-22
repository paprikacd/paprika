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

// ScopeIsPermitted reports whether the namespace this binding lives in is
// allowed to declare the scope the binding declares.
//
// Two levels are guarded, and for the same reason: a binding must not be able
// to speak for a scope its own namespace has no claim on.
//
// A Namespace-scoped binding is the MOST specific level in the chain, so it
// beats every other binding for the namespace it names. Left unguarded, any
// tenant could name another tenant's namespace and win there — blanking or
// misdirecting that tenant's meters from outside it. So scope.name must equal
// the binding's own metadata.namespace: a tenant may bind its own namespace and
// nothing else.
//
// A Global-scoped binding is the other end of the same problem. It applies to
// every scope in the fleet, so a binding created in one tenant's namespace
// would silently repoint the capacity source every other tenant sees — no data
// crosses the boundary, but one namespace could blank or misdirect the whole
// fleet's meters. Only the control plane's own namespace, which an operator
// already controls, may host one.
//
// An empty controlPlaneNamespace permits no Global binding at all. A namespaced
// object always has a namespace, so nothing can match it: a deployment that has
// not been told where its control plane runs fails closed rather than honouring
// a Global binding from wherever it happens to find one.
//
// Cluster and Project scopes stay unguarded: neither a cluster nor a project is
// owned by a namespace, so there is no "own" one to compare against. Guarding
// them is a question for whenever Paprika grows an ownership model for either.
//
// This is the single predicate both the admission webhook and the resolver
// consult, so what admission rejects is exactly what resolution ignores. Two
// copies of the rule would eventually disagree, and an operator would get a
// binding that applies but cannot be re-applied, or the reverse.
func (b *DataProviderBinding) ScopeIsPermitted(controlPlaneNamespace string) bool {
	switch b.Spec.Scope.Kind {
	case ScopeNamespace:
		return b.Spec.Scope.Name == b.Namespace
	case ScopeGlobal:
		return controlPlaneNamespace != "" && b.Namespace == controlPlaneNamespace
	case ScopeCluster, ScopeProject:
		return true
	default:
		// An unknown scope kind cannot be reasoned about, so it is refused
		// rather than admitted. The CRD enum keeps this unreachable in
		// practice; it is here so that adding a kind without deciding its rule
		// fails closed instead of granting the widest reach by default.
		return false
	}
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
