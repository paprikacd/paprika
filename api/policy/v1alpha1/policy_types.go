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

// EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!
// NOTE: json tags are required.  Any new fields you add must have json tags for the fields to be serialized.

type PolicySeverity string

const (
	PolicySeverityCritical PolicySeverity = "critical"
	PolicySeverityWarning  PolicySeverity = "warning"
)

type PolicyAction string

const (
	PolicyActionEnforce PolicyAction = "enforce"
	PolicyActionWarn    PolicyAction = "warn"
)

type PolicyMatch struct {
	APIGroups     []string              `json:"apiGroups,omitempty"`
	Kinds         []string              `json:"kinds,omitempty"`
	Namespaces    []string              `json:"namespaces,omitempty"`
	LabelSelector *metav1.LabelSelector `json:"labelSelector,omitempty"`
}

// PolicySpec defines the desired state of Policy
type PolicySpec struct {
	Description string `json:"description,omitempty"`
	// +kubebuilder:validation:Enum=critical;warning
	Severity PolicySeverity `json:"severity"`
	// +kubebuilder:validation:Enum=enforce;warn
	DefaultAction PolicyAction `json:"defaultAction,omitempty"`
	Match         PolicyMatch  `json:"match"`
	Expression    string       `json:"expression"`
}

// PolicyStatus defines the observed state of Policy.
type PolicyStatus struct{}

// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Cluster
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Severity",type=string,JSONPath=".spec.severity"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// Policy is the Schema for the policies API
type Policy struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Policy
	// +required
	Spec PolicySpec `json:"spec"`

	// status defines the observed state of Policy
	// +optional
	Status PolicyStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// PolicyList contains a list of Policy
type PolicyList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Policy `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Policy{}, &PolicyList{})
}
