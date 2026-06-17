package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=ff
// +kubebuilder:printcolumn:name="Type",type=string,JSONPath=".spec.type"
// +kubebuilder:printcolumn:name="Disabled",type=boolean,JSONPath=".spec.disabled"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"
type FeatureFlag struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              FeatureFlagSpec   `json:"spec,omitempty"`
	Status            FeatureFlagStatus `json:"status,omitempty"`
}

type FeatureFlagSpec struct {
	// +kubebuilder:validation:Enum=boolean;string;int;float
	Type string `json:"type"`

	DefaultValue FeatureFlagValue `json:"defaultValue"`

	// +optional
	Rules []TargetingRule `json:"rules,omitempty"`

	// +optional
	Description string `json:"description,omitempty"`

	// +optional
	Tags []string `json:"tags,omitempty"`

	// +optional
	Disabled bool `json:"disabled,omitempty"`
}

type FeatureFlagValue struct {
	// +optional
	BoolValue *bool `json:"boolValue,omitempty"`
	// +optional
	StringValue *string `json:"stringValue,omitempty"`
	// +optional
	IntValue *int64 `json:"intValue,omitempty"`
	// +optional
	FloatValue *float64 `json:"floatValue,omitempty"`
}

type TargetingRule struct {
	// +optional
	Name      string           `json:"name,omitempty"`
	Condition string           `json:"condition"`
	Value     FeatureFlagValue `json:"value"`
}

type FeatureFlagStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
type FeatureFlagList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []FeatureFlag `json:"items"`
}

func init() {
	SchemeBuilder.Register(&FeatureFlag{}, &FeatureFlagList{})
}
