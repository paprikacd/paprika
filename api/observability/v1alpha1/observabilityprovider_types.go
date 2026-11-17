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

// CredentialsSecretLabel marks a Secret as an observability provider
// credential. The gateway reads only Secrets carrying it with the value
// "true", so a provider can never point the gateway's service account at an
// unrelated Secret — whoever labels a Secret opts it in.
const CredentialsSecretLabel = "observability.paprika.io/credentials" //nolint:gosec // G101: a label key, not a credential.

// CredentialsSecretRef references a Secret holding the credential the
// connector uses to reach its backend. The referenced key contains a
// type-specific document (an API key, a basic-auth pair, a client
// credentials JSON — the connector for spec.type defines which).
// A nil ref means the provider carries no credentials, which is not an
// error: backends that accept ambient or anonymous access need none.
// The Secret must carry the label observability.paprika.io/credentials=true;
// the gateway refuses any other Secret.
type CredentialsSecretRef struct {
	// Name of the Secret.
	Name string `json:"name"`

	// Namespace of the Secret. Defaults to the provider's own namespace
	// when empty. A Secret in another namespace is read only for a caller
	// authorized for providers in that namespace; the status prober, which
	// acts for no caller, reports such a provider NotConfigured.
	// +optional
	Namespace string `json:"namespace,omitempty"`

	// Key within the Secret holding the credential document. Defaults to
	// "credentials" when empty.
	// +optional
	Key string `json:"key,omitempty"`
}

// ObservabilityProviderSpec defines the desired state of an ObservabilityProvider.
type ObservabilityProviderSpec struct {
	// Type is the kind of backend this provider connects to. Each type has
	// a connector in the observability gateway that knows how to reach and
	// authenticate against it.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:Enum=prometheus;loki;tempo;otlp;gcp-cloudlogging;gcp-cloudmonitoring;gcp-cloudtrace;aws-cloudwatch-logs;aws-cloudwatch-metrics;aws-xray;aws-cloudtrail;vultr-monitoring;mock;shorted;uptime;postgresql
	Type string `json:"type"`

	// Config is the connector's own configuration. Each connector supplies
	// its schema and validates this at admission, so the CRD does not
	// become a union of every implementation's fields.
	// +optional
	// +kubebuilder:pruning:PreserveUnknownFields
	Config runtime.RawExtension `json:"config,omitempty"`

	// CredentialsSecretRef references the Secret holding the credential
	// used to authenticate against the backend. Nil means no credentials,
	// which is not an error — connectors that reach anonymous or ambient-
	// identity backends work without one. The Secret must carry the label
	// observability.paprika.io/credentials=true; the gateway refuses any
	// other Secret.
	// +optional
	CredentialsSecretRef *CredentialsSecretRef `json:"credentialsSecretRef,omitempty"`
}

// ObservabilityProviderStatus defines the observed state of an ObservabilityProvider.
type ObservabilityProviderStatus struct {
	// State is the connector's current reachability verdict. One of OK,
	// NotConfigured, NotAvailable, Error, Forbidden.
	// +optional
	// +kubebuilder:validation:Enum=OK;NotConfigured;NotAvailable;Error;Forbidden
	State string `json:"state,omitempty"`

	// Reason is a fixed sentence describing the current state, chosen from
	// a closed set by the connector. Reasons never carry credential or
	// endpoint detail — a provider that fails must say why in words an
	// operator can act on without leaking what it authenticates with.
	// +optional
	Reason string `json:"reason,omitempty"`

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
// +kubebuilder:printcolumn:name="Type",type=string,JSONPath=".spec.type"
// +kubebuilder:printcolumn:name="State",type=string,JSONPath=".status.state"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// ObservabilityProvider registers a backend the observability gateway
// connects to — a Prometheus, Loki, Tempo, or OTLP endpoint — so the rest
// of Paprika can read metrics, logs, and traces through one door instead
// of one credential copy per consumer.
type ObservabilityProvider struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	Spec   ObservabilityProviderSpec   `json:"spec"`
	Status ObservabilityProviderStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// ObservabilityProviderList contains a list of ObservabilityProvider.
type ObservabilityProviderList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []ObservabilityProvider `json:"items"`
}

func init() {
	SchemeBuilder.Register(&ObservabilityProvider{}, &ObservabilityProviderList{})
}
