package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

// ClusterMode defines how the controller connects to a cluster.
type ClusterMode string

const (
	ClusterModeDirect    ClusterMode = "direct"
	ClusterModeAgent     ClusterMode = "agent"
	ClusterModeInCluster ClusterMode = "in-cluster"
)

// ClusterRef references a Kubernetes cluster.
type ClusterRef struct {
	Name             string      `json:"name"`
	Namespace        string      `json:"namespace,omitempty"`
	Mode             ClusterMode `json:"mode,omitempty"`
	AgentAddress     string      `json:"agentAddress,omitempty"`
	KubeconfigSecret string      `json:"kubeconfigSecret,omitempty"`
	ServiceAccount   string      `json:"serviceAccount,omitempty"`
	Server           string      `json:"server,omitempty"`
}

// GateConfig defines a gate for stage promotion.
// GateConfig defines a gate for stage promotion.
type GateConfig struct {
	// +kubebuilder:validation:Enum=smoke-test;duration
	Type     string `json:"type"`
	Endpoint string `json:"endpoint,omitempty"`
	Timeout  int    `json:"timeout,omitempty"`
}

// AnalysisCheck defines a check for canary analysis.
// AnalysisCheck defines a check for canary analysis.
type AnalysisCheck struct {
	// Name of the check.
	// +optional
	Name string `json:"name,omitempty"`
	// +kubebuilder:validation:Enum=http;podMetrics
	Type string `json:"type"`
	// URL to probe (for type=http)
	URL string `json:"url,omitempty"`
	// HTTP headers to send with the request
	HTTPHeaders map[string]string `json:"httpHeaders,omitempty"`
	// Fraction of requests that must succeed as a percentage string (e.g. "99" = 99%)
	SuccessThreshold string `json:"successThreshold,omitempty"`
	// Timeout per request in seconds
	TimeoutSeconds int `json:"timeoutSeconds,omitempty"`
	// Number of requests to make per analysis cycle
	RequestCount int `json:"requestCount,omitempty"`
	// Pod metric to check (for type=podMetrics): errorRate, latencyP99, restartRate
	// +kubebuilder:validation:Enum=errorRate;latencyP99;restartRate
	Metric string `json:"metric,omitempty"`
	// Threshold as a string (errorRate: "0.01" = 1%, latencyP99: "500" = 500ms, restartRate: "3" = count)
	Threshold string `json:"threshold,omitempty"`
	// Time window in seconds to evaluate the metric
	WindowSeconds int `json:"windowSeconds,omitempty"`
}

// AnalysisConfig defines the configuration for canary analysis.
// AnalysisConfig defines the configuration for canary analysis.
type AnalysisConfig struct {
	Checks          []AnalysisCheck `json:"checks,omitempty"`
	RollbackOnFail  bool            `json:"rollbackOnFail,omitempty"`
	IntervalSeconds int             `json:"intervalSeconds,omitempty"`
}

// CanaryConfig defines the configuration for canary deployments.
// CanaryConfig defines the configuration for canary deployments.
type CanaryConfig struct {
	// Traffic weight percentages at each canary step, e.g. [10, 30, 60, 100]
	Steps []int `json:"steps"`
	// Seconds to wait between canary weight steps
	IntervalSeconds int `json:"intervalSeconds,omitempty"`
	// PDV analysis configuration
	Analysis *AnalysisConfig `json:"analysis,omitempty"`
}

// TrafficRouter defines the traffic router configuration for canary rollouts.
type TrafficRouter struct {
	// Provider specifies the traffic router provider ("istio" or "gateway-api").
	// +kubebuilder:validation:Enum=istio;gateway-api
	Provider string `json:"provider"`
	// +optional
	Istio *IstioRouterConfig `json:"istio,omitempty"`
	// +optional
	GatewayAPI *GatewayAPIRouterConfig `json:"gatewayApi,omitempty"`
}

// IstioRouterConfig defines the Istio VirtualService configuration for traffic routing.
type IstioRouterConfig struct {
	// Name of the existing VirtualService to manage. If empty, derived from release name.
	// +optional
	VirtualService string `json:"virtualService,omitempty"`
	// Route names within the VirtualService to patch. If empty, patches the first unnamed route.
	// +optional
	Routes []string `json:"routes,omitempty"`
	// Hosts to match in spec.hosts. If empty, patches all HTTP routes on the VirtualService.
	// +optional
	Hosts []string `json:"hosts,omitempty"`
	// Explicit stable service name. If empty, derived from release name.
	// +optional
	StableService string `json:"stableService,omitempty"`
	// Explicit canary service name. If empty, derived from release name.
	// +optional
	CanaryService string `json:"canaryService,omitempty"`
}

// GatewayAPIRouterConfig defines the Gateway API HTTPRoute configuration for traffic routing.
type GatewayAPIRouterConfig struct {
	// Name of the existing HTTPRoute to manage. If empty, derived from release name.
	// +optional
	HTTPRoute string `json:"httpRoute,omitempty"`
	// Explicit stable service name. If empty, derived from release name.
	// +optional
	StableService string `json:"stableService,omitempty"`
	// Explicit canary service name. If empty, derived from release name.
	// +optional
	CanaryService string `json:"canaryService,omitempty"`
}

// StageSpec defines the specification for a stage.
type StageSpec struct {
	Name      string       `json:"name"`
	Ring      int          `json:"ring"`
	Cluster   ClusterRef   `json:"cluster,omitempty"`
	Templates []string     `json:"templates"`
	Gates     []GateConfig `json:"gates,omitempty"`
	// +optional
	Canary *CanaryConfig `json:"canary,omitempty"`
	// RolloutStrategy is an advanced deployment strategy managed by the Rollout controller.
	// Mutually exclusive with Canary.
	// +optional
	RolloutStrategy *rolloutsv1alpha1.RolloutStrategy `json:"rolloutStrategy,omitempty"`
	// +optional
	TrafficRouter *TrafficRouter `json:"trafficRouter,omitempty"`
}

// StageStatus represents the status of a stage.
type StageStatus struct {
	LastPromotion *metav1.Time `json:"lastPromotion,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// Stage represents a deployment stage.
type Stage struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`
	Spec              StageSpec `json:"spec"`
	// +optional
	Status StageStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// StageList is a list of Stages.
type StageList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Stage `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Stage{}, &StageList{})
}
