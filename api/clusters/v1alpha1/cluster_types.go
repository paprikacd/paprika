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

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// ClusterMode aliases the shared cluster mode type.
type ClusterMode = paprikav1.ClusterMode

const (
	ClusterModeDirect    = paprikav1.ClusterModeDirect
	ClusterModeAgent     = paprikav1.ClusterModeAgent
	ClusterModeInCluster = paprikav1.ClusterModeInCluster
)

// ClusterPhase represents the lifecycle phase of a Cluster.
type ClusterPhase string

const (
	ClusterPhasePending   ClusterPhase = "Pending"
	ClusterPhaseHealthy   ClusterPhase = "Healthy"
	ClusterPhaseUnhealthy ClusterPhase = "Unhealthy"
	ClusterPhaseDisabled  ClusterPhase = "Disabled"
)

// SecretRef references a Kubernetes Secret.
type SecretRef struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	Key       string `json:"key,omitempty"`
}

// HealthCheckConfig configures periodic cluster health probes.
type HealthCheckConfig struct {
	// +kubebuilder:default="30s"
	Interval string `json:"interval,omitempty"`
	// +kubebuilder:default="10s"
	Timeout string `json:"timeout,omitempty"`
}

// AgentInfo reports the status of an in-cluster agent.
type AgentInfo struct {
	Version   string       `json:"version,omitempty"`
	Connected *metav1.Time `json:"connected,omitempty"`
	Address   string       `json:"address,omitempty"`
}

// ClusterSpec defines the desired state of a Cluster.
type ClusterSpec struct {
	DisplayName string `json:"displayName,omitempty"`

	// +kubebuilder:validation:Enum=direct;agent;in-cluster
	// +kubebuilder:default="in-cluster"
	Mode ClusterMode `json:"mode"`

	Server string `json:"server,omitempty"`

	KubeconfigSecretRef *SecretRef `json:"kubeconfigSecretRef,omitempty"`

	ServiceAccount string `json:"serviceAccount,omitempty"`

	Labels map[string]string `json:"labels,omitempty"`

	HealthCheck *HealthCheckConfig `json:"healthCheck,omitempty"`

	Disabled bool `json:"disabled,omitempty"`

	// +kubebuilder:default="30s"
	ConnectionTimeout string `json:"connectionTimeout,omitempty"`
}

// ClusterStatus defines the observed state of a Cluster.
type ClusterStatus struct {
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// +kubebuilder:validation:Enum=Pending;Healthy;Unhealthy;Disabled
	Phase ClusterPhase `json:"phase,omitempty"`

	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`

	LastHealthCheckTime *metav1.Time `json:"lastHealthCheckTime,omitempty"`

	Version string `json:"version,omitempty"`

	AgentInfo *AgentInfo `json:"agentInfo,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Mode",type=string,JSONPath=".spec.mode"
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=".status.phase"
// +kubebuilder:printcolumn:name="Server",type=string,JSONPath=".spec.server"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// Cluster registers a Kubernetes cluster for Paprika deployments.
type Cluster struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	Spec ClusterSpec `json:"spec"`
	// +optional
	Status ClusterStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// ClusterList contains a list of Cluster.
type ClusterList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Cluster `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Cluster{}, &ClusterList{})
}
