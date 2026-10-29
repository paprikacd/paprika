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

// SatelliteSpec authorizes outbound inventory reports from one remote cluster.
// The credential is distinct from kubeconfig and provider credentials.
type SatelliteSpec struct {
	TokenSecretRef SecretRef `json:"tokenSecretRef"`

	// Autonomy selects what the satellite does while it cannot reach the
	// control plane. ObserveOnly keeps it a pure reporter; Failover hands
	// reconciliation over after FailoverTimeout; Delegated always reconciles
	// locally.
	// +optional
	// +kubebuilder:validation:Enum=ObserveOnly;Failover;Delegated
	// +kubebuilder:default="Failover"
	Autonomy AutonomyMode `json:"autonomy,omitempty"`

	// FailoverTimeout is how long a satellite in Failover mode waits without
	// control-plane contact before taking over reconciliation. Ignored in the
	// other modes.
	// +optional
	// +kubebuilder:default="2m"
	// +kubebuilder:validation:Pattern=`^([0-9]+(\.[0-9]+)?(ns|us|µs|ms|s|m|h))+$`
	FailoverTimeout string `json:"failoverTimeout,omitempty"`
}

// SatelliteResourceUsage is one resource dimension as the satellite measured
// it. Used is only meaningful when UsedKnown is true: a cluster without
// metrics.k8s.io reports requests and allocatable, and says so rather than
// claiming zero usage.
type SatelliteResourceUsage struct {
	Used        int64 `json:"used,omitempty"`
	Requested   int64 `json:"requested,omitempty"`
	Allocatable int64 `json:"allocatable,omitempty"`
	// UsedKnown reports whether the cluster served metrics.k8s.io. When false,
	// Used is zero because nothing was measured, not because nothing is running.
	UsedKnown bool `json:"usedKnown,omitempty"`
}

// SatelliteCapacity is the satellite's own resource accounting for its cluster.
// It exists because a satellite is the only observer a control plane may have of
// a cluster it cannot dial: without this, capacity meters for those clusters
// would stay NOT_CONFIGURED forever.
type SatelliteCapacity struct {
	CPUMillicores SatelliteResourceUsage `json:"cpuMillicores,omitempty"`
	MemoryBytes   SatelliteResourceUsage `json:"memoryBytes,omitempty"`
	ObservedAt    *metav1.Time           `json:"observedAt,omitempty"`
}

// SatelliteApplication is an observation, not a desired-state Application.
// Namespace and logical identity keep deployments in different tenants apart.
type SatelliteApplication struct {
	Namespace      string `json:"namespace"`
	Name           string `json:"name"`
	Identity       string `json:"identity,omitempty"`
	Project        string `json:"project,omitempty"`
	Health         string `json:"health,omitempty"`
	Phase          string `json:"phase,omitempty"`
	OutOfSync      uint32 `json:"outOfSync,omitempty"`
	SyncKnown      bool   `json:"syncKnown,omitempty"`
	ResourceCount  uint32 `json:"resourceCount,omitempty"`
	SourceRevision string `json:"sourceRevision,omitempty"`
}

// SatelliteStatus persists the accepted baseline across API replica restarts.
// A kube-system UID binds a registration to the physical cluster; sessions and
// sequences protect delta application against gaps and duplicate deliveries.
type SatelliteStatus struct {
	ClusterUID string `json:"clusterUid"`
	SessionID  string `json:"sessionId"`
	// +kubebuilder:validation:Minimum=1
	Sequence     int64  `json:"sequence"`
	ReportDigest string `json:"reportDigest,omitempty"`
	// +kubebuilder:validation:MaxItems=16
	RetiredSessions []string     `json:"retiredSessions,omitempty"`
	LastSeen        *metav1.Time `json:"lastSeen,omitempty"`
	// +kubebuilder:validation:MaxItems=2000
	// +listType=map
	// +listMapKey=namespace
	// +listMapKey=name
	Applications []SatelliteApplication `json:"applications,omitempty"`

	// OperatingState is what the satellite is doing right now. It follows
	// spec.satellite.autonomy, but records which branch the satellite is in
	// rather than what the operator asked for.
	// +optional
	// +kubebuilder:validation:Enum=Connecting;Connected;Autonomous;OverrideHeld;Disabled
	OperatingState SatelliteOperatingState `json:"operatingState,omitempty"`

	// ReportedPolicies is the latest policy claim received from the satellite.
	// An absent field means that no claim has been recorded yet; an explicit
	// empty list claims no actions. A legacy report with no policies means the
	// default wildcard. This is an observation, not a permission grant.
	// +optional
	// +kubebuilder:validation:MaxItems=8
	ReportedPolicies *[]ManagementPolicy `json:"reportedPolicies,omitempty"`

	// EffectivePolicies is the intersection of the latest satellite claim and
	// the Cluster ceiling, with the wildcard expanded. It describes the
	// satellite transport, not direct-transport permissions. It is unknown
	// until a claim is recorded. An empty list indicates no claimed actions.
	// +optional
	// +kubebuilder:validation:MaxItems=8
	EffectivePolicies []ManagementPolicy `json:"effectivePolicies,omitempty"`

	// AutonomousSince records when the satellite last took over
	// reconciliation. Cleared when the control plane resumes authority.
	// +optional
	AutonomousSince *metav1.Time `json:"autonomousSince,omitempty"`

	// ActiveOverrides counts local actions taken during an outage that the
	// control plane has not acknowledged. Non-zero puts the cluster in
	// OverrideHeld so an operator sees it before the next push overwrites it.
	// +optional
	ActiveOverrides int32 `json:"activeOverrides,omitempty"`

	// Capacity is the satellite's resource accounting. Nil until a report
	// carries it, and never synthesized from the control plane's own cluster.
	// +optional
	Capacity *SatelliteCapacity `json:"capacity,omitempty"`

	// ProviderType is the cloud provider the satellite detected from node
	// providerID prefixes. Empty when detection found nothing.
	// +optional
	ProviderType string `json:"providerType,omitempty"`

	// NodePools is the pool shape the satellite derived from node labels. It is
	// present without any provider credential, which is what makes node pools
	// visible for clusters the control plane cannot dial.
	// +optional
	// +listType=map
	// +listMapKey=name
	NodePools []ClusterNodePool `json:"nodePools,omitempty"`
}

// ClusterProviderSpec selects and configures the cloud-provider integration
// for a Cluster. The provider API reports infrastructure details Kubernetes
// itself does not carry — managed-cluster identity, node pools and their
// autoscaler bounds, plan sizes, and the control-plane region.
type ClusterProviderSpec struct {
	// Type selects the integration. "auto" detects the provider from node
	// providerID prefixes (vultr://, gce://, aws://, azure://).
	// +kubebuilder:validation:Enum=auto;vultr;gke;eks;aks
	// +kubebuilder:default="auto"
	Type string `json:"type,omitempty"`

	// ClusterID is the provider's own identifier for the cluster — the VKE
	// cluster UUID, the EKS cluster name, the GKE cluster name, or the AKS
	// resource name. When empty the enricher matches the cluster by API
	// endpoint where the provider supports it.
	ClusterID string `json:"clusterId,omitempty"`

	// Region narrows provider lookups: the EKS region, the GKE location, or
	// the AKS location. Vultr does not require it.
	Region string `json:"region,omitempty"`

	// Project is the GCP project for GKE or the Azure resource group for AKS.
	// Ignored by other providers.
	Project string `json:"project,omitempty"`

	// SubscriptionID is the Azure subscription the AKS cluster lives in.
	// Ignored by other providers.
	SubscriptionID string `json:"subscriptionId,omitempty"`

	// CredentialsSecretRef references a Secret holding the provider
	// credential. The referenced key contains a provider-specific document:
	//
	//   vultr — the API key, as a plain string.
	//   eks   — optional; ambient identity (IRSA, pod identity, node role) is
	//           used when absent. When set, JSON with access_key_id and
	//           secret_access_key (session_token optional).
	//   gke   — a Google credential JSON document: either a workload identity
	//           federation external_account configuration or a service-account
	//           key. When absent, application default credentials are used.
	//   aks   — JSON with tenant_id, client_id and either client_secret or
	//           federated_token_file. When absent, the AZURE_* workload
	//           identity environment is used.
	CredentialsSecretRef *SecretRef `json:"credentialsSecretRef,omitempty"`
}

// ClusterInventory is the cluster's workload surface as the Kubernetes API
// reports it: node and pod counts, and the topology labels that describe
// where the fleet actually runs.
type ClusterInventory struct {
	NodeCount       int32    `json:"nodeCount,omitempty"`
	ReadyNodeCount  int32    `json:"readyNodeCount,omitempty"`
	PodCount        int32    `json:"podCount,omitempty"`
	RunningPodCount int32    `json:"runningPodCount,omitempty"`
	NamespaceCount  int32    `json:"namespaceCount,omitempty"`
	Regions         []string `json:"regions,omitempty"`
	Zones           []string `json:"zones,omitempty"`
	KubeletVersions []string `json:"kubeletVersions,omitempty"`
}

// ClusterNodePool describes one node pool as reported by the cloud provider
// (or derived from node labels when no provider credential is configured).
type ClusterNodePool struct {
	Name        string `json:"name"`
	NodeCount   int32  `json:"nodeCount"`
	MachineType string `json:"machineType,omitempty"`
	// MinNodes and MaxNodes are the autoscaler bounds. Zero when the pool is
	// not autoscaled or the bound is unknown.
	MinNodes int32 `json:"minNodes,omitempty"`
	MaxNodes int32 `json:"maxNodes,omitempty"`
	// AutoScaled reports whether the provider has the pool under autoscaler
	// control. Derived pools leave it false.
	AutoScaled bool `json:"autoScaled,omitempty"`
	// AllocatableCPUMillis and AllocatableMemoryBytes sum the pool nodes'
	// status.allocatable: the CPU and memory workloads can actually draw on.
	// Derived pools always carry them; API-enriched pools inherit them from
	// the derived set when the provider does not report a figure.
	AllocatableCPUMillis   int64 `json:"allocatableCpuMillis,omitempty"`
	AllocatableMemoryBytes int64 `json:"allocatableMemoryBytes,omitempty"`
}

// ClusterProviderStatus reports what the cloud-provider integration observed.
// State follows the data-provider contract: OK when the provider API answered,
// NotConfigured when no credential is available, Forbidden when the credential
// was refused, NotAvailable when the cluster could not be matched, Error for
// every other failure.
type ClusterProviderStatus struct {
	// Type is the provider the controller resolved, e.g. "vultr".
	Type string `json:"type,omitempty"`

	// +kubebuilder:validation:Enum=OK;NotConfigured;NotAvailable;Error;Forbidden
	State string `json:"state,omitempty"`

	// Reason is a sanitized explanation for a non-OK state; it never carries
	// credential material or endpoint details.
	Reason string `json:"reason,omitempty"`

	ClusterID string `json:"clusterId,omitempty"`
	Region    string `json:"region,omitempty"`

	// +listType=map
	// +listMapKey=name
	NodePools []ClusterNodePool `json:"nodePools,omitempty"`

	ObservedAt *metav1.Time `json:"observedAt,omitempty"`
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

	// Provider configures cloud-provider enrichment. Nil disables enrichment;
	// a non-nil provider with type "auto" still runs detection-only inventory.
	Provider *ClusterProviderSpec `json:"provider,omitempty"`

	// Satellite configures outbound state reporting. Direct clusters may keep
	// their kubeconfig deployment connection while reporting via a satellite.
	Satellite *SatelliteSpec `json:"satellite,omitempty"`

	// ManagementPolicies is this cluster's ceiling: the most any placement
	// targeting it may do, whether the control plane dials it directly or drives
	// it through a satellite. Unset means full management; an explicitly empty
	// list makes the whole cluster read-only. A Stage's own policies are
	// intersected with this ceiling, never added to it.
	// +optional
	// +kubebuilder:validation:MaxItems=8
	ManagementPolicies []ManagementPolicy `json:"managementPolicies,omitempty"`
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

	Satellite *SatelliteStatus `json:"satellite,omitempty"`

	// Inventory is what the Kubernetes API reports about the cluster itself.
	// Populated on each successful health check; nil until the first one
	// completes.
	Inventory *ClusterInventory `json:"inventory,omitempty"`

	// Provider is what the cloud-provider integration observed. Detection
	// from node providerIDs always runs; the API-level fields (clusterID,
	// autoscaler bounds) only populate when the provider answered.
	Provider *ClusterProviderStatus `json:"provider,omitempty"`
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
