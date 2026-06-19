package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ConftestEnforcementMode controls how violations from this policy affect promotion.
// +kubebuilder:validation:Enum=enforce;warn
type ConftestEnforcementMode string

const (
	// ConftestEnforce blocks promotion on any deny/violation result.
	ConftestEnforce ConftestEnforcementMode = "enforce"
	// ConftestWarn records violations as warnings but does not block promotion.
	ConftestWarn ConftestEnforcementMode = "warn"
)

// ConftestPolicySpec defines a user-authored Rego policy evaluated against rendered
// manifests before promotion. The Rego source must declare a package and define rule
// sets named `deny`, `warn`, and/or `violation` (conftest convention); `violation` is
// treated as `deny`.
type ConftestPolicySpec struct {
	// Rego is the policy source. Must declare a package and define `deny`, `warn`,
	// and/or `violation` rule sets that return string messages.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Rego string `json:"rego"`

	// Enforcement controls whether violations block promotion (enforce) or only warn.
	// +kubebuilder:default=enforce
	// +optional
	Enforcement ConftestEnforcementMode `json:"enforcement,omitempty"`
}

// ConftestPolicyStatus reports the last compilation outcome for operator UX.
type ConftestPolicyStatus struct {
	// ObservedGeneration is the most recent generation observed.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Conditions reflect compile readiness. Type "Ready": True = compiled, False = error.
	// +optional
	// +patchMergeKey=type
	// +patchStrategy=merge
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Enforce",type=string,JSONPath=".spec.enforcement"
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"
type ConftestPolicy struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   ConftestPolicySpec   `json:"spec,omitempty"`
	Status ConftestPolicyStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type ConftestPolicyList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []ConftestPolicy `json:"items"`
}

func init() {
	SchemeBuilder.Register(&ConftestPolicy{}, &ConftestPolicyList{})
}
