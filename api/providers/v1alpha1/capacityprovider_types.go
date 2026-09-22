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
	"k8s.io/apimachinery/pkg/runtime"
)

// CapacityProviderSpec defines the desired state of a CapacityProvider.
type CapacityProviderSpec struct {
	// Provider is the registry key of the implementation, e.g.
	// "KubernetesCapacity". Unknown keys are rejected at admission.
	// +kubebuilder:validation:Required
	Provider string `json:"provider"`

	// Config is the implementation's own configuration. Each implementation
	// supplies its schema and validates this at admission, so the CRD does not
	// become a union of every implementation's fields.
	// +optional
	// +kubebuilder:pruning:PreserveUnknownFields
	Config runtime.RawExtension `json:"config,omitempty"`

	// StaleAfter is the age past which a reading is reported STALE rather than
	// current. Defaults to 90s.
	// +optional
	StaleAfter *metav1.Duration `json:"staleAfter,omitempty"`
}

// CapacityProviderStatus defines the observed state of a CapacityProvider.
type CapacityProviderStatus struct {
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
// +kubebuilder:printcolumn:name="Provider",type=string,JSONPath=".spec.provider"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// CapacityProvider registers an implementation that supplies capacity readings.
type CapacityProvider struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	Spec   CapacityProviderSpec   `json:"spec"`
	Status CapacityProviderStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// CapacityProviderList contains a list of CapacityProvider.
type CapacityProviderList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []CapacityProvider `json:"items"`
}

func init() {
	SchemeBuilder.Register(&CapacityProvider{}, &CapacityProviderList{})
}
