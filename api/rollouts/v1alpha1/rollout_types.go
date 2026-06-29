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
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// RolloutPhase represents the phase of a Rollout.
type RolloutPhase string

const (
	// RolloutPhasePending indicates the rollout is waiting to start.
	RolloutPhasePending RolloutPhase = "Pending"
	// RolloutPhaseProgressing indicates the rollout is actively reconciling.
	RolloutPhaseProgressing RolloutPhase = "Progressing"
	// RolloutPhasePaused indicates the rollout is paused by spec.paused or a strategy pause.
	RolloutPhasePaused RolloutPhase = "Paused"
	// RolloutPhaseHealthy indicates the rollout completed successfully.
	RolloutPhaseHealthy RolloutPhase = "Healthy"
	// RolloutPhaseDegraded indicates the rollout is unhealthy but not yet failed.
	RolloutPhaseDegraded RolloutPhase = "Degraded"
	// RolloutPhaseFailed indicates the rollout has failed.
	RolloutPhaseFailed RolloutPhase = "Failed"
	// RolloutPhaseRolledBack indicates the rollout was rolled back.
	RolloutPhaseRolledBack RolloutPhase = "RolledBack"
	// RolloutPhaseAborted indicates the rollout was aborted; stable traffic retained.
	RolloutPhaseAborted RolloutPhase = "Aborted"
)

// RolloutTarget defines the workload targeted by a Rollout.
type RolloutTarget struct {
	// +kubebuilder:validation:Enum=Deployment;""
	// +optional
	Kind string `json:"kind,omitempty"`
	// +optional
	Name string `json:"name,omitempty"`
}

// RolloutStrategy selects one advanced deployment strategy and its configuration.
type RolloutStrategy struct {
	// +kubebuilder:validation:Enum=Rolling;Canary;BlueGreen;ABTest;Mirror
	Type      string             `json:"type"`
	Rolling   *RollingStrategy   `json:"rolling,omitempty"`
	Canary    *CanaryStrategy    `json:"canary,omitempty"`
	BlueGreen *BlueGreenStrategy `json:"blueGreen,omitempty"`
	ABTest    *ABTestStrategy    `json:"abTest,omitempty"`
	Mirror    *MirrorStrategy    `json:"mirror,omitempty"`
}

// RollingStrategy performs a standard rolling update.
type RollingStrategy struct {
	MaxUnavailable *intstr.IntOrString `json:"maxUnavailable,omitempty"`
	MaxSurge       *intstr.IntOrString `json:"maxSurge,omitempty"`
}

// CanaryStrategy progressively shifts traffic to the canary version.
type CanaryStrategy struct {
	Steps         []CanaryStep     `json:"steps"`
	Analysis      *RolloutAnalysis `json:"analysis,omitempty"`
	StableService string           `json:"stableService,omitempty"`
	CanaryService string           `json:"canaryService,omitempty"`
}

// CanaryStep defines a single step in a canary rollout.
type CanaryStep struct {
	SetWeight int32            `json:"setWeight"`
	Duration  *metav1.Duration `json:"duration,omitempty"`
	Analysis  *RolloutAnalysis `json:"analysis,omitempty"`
}

// BlueGreenStrategy runs the new version behind a preview service, then cuts over.
type BlueGreenStrategy struct {
	PreviewService        string           `json:"previewService,omitempty"`
	ActiveService         string           `json:"activeService"`
	AutoPromotionSeconds  *int32           `json:"autoPromotionSeconds,omitempty"`
	ScaleDownDelaySeconds *int32           `json:"scaleDownDelaySeconds,omitempty"`
	Analysis              *RolloutAnalysis `json:"analysis,omitempty"`
	PreviewReplicaCount   *int32           `json:"previewReplicaCount,omitempty"`
}

// ABTestStrategy routes traffic to stable or canary based on headers or cookies.
type ABTestStrategy struct {
	Routes        []ABTestRoute    `json:"routes"`
	StableService string           `json:"stableService,omitempty"`
	CanaryService string           `json:"canaryService,omitempty"`
	Analysis      *RolloutAnalysis `json:"analysis,omitempty"`
}

// ABTestRoute matches a header or cookie and routes to a service.
type ABTestRoute struct {
	Type    string `json:"type"` // Header or Cookie
	Name    string `json:"name"`
	Value   string `json:"value"`
	Service string `json:"service"` // stable or canary
}

// MirrorStrategy mirrors a percentage of traffic to canary.
type MirrorStrategy struct {
	MirrorPercent int32            `json:"mirrorPercent"`
	StableService string           `json:"stableService,omitempty"`
	CanaryService string           `json:"canaryService,omitempty"`
	Duration      *metav1.Duration `json:"duration,omitempty"`
	Analysis      *RolloutAnalysis `json:"analysis,omitempty"`
}

// RolloutAnalysis defines analysis checks for a Rollout.
type RolloutAnalysis struct {
	Checks           []AnalysisCheck  `json:"checks,omitempty"`
	FailedThreshold  *int32           `json:"failedThreshold,omitempty"`
	SuccessThreshold *int32           `json:"successThreshold,omitempty"`
	Interval         *metav1.Duration `json:"interval,omitempty"`
}

// AnalysisCheck defines a single analysis check.
type AnalysisCheck struct {
	// +kubebuilder:validation:Enum=http;podMetrics
	Type string `json:"type"`
	// URL to probe (for type=http)
	URL string `json:"url,omitempty"`
	// HTTP headers to send with the request
	HTTPHeaders map[string]string `json:"httpHeaders,omitempty"`
	// Fraction of requests that must succeed as a percentage string
	SuccessThreshold string `json:"successThreshold,omitempty"`
	// Timeout per request in seconds
	TimeoutSeconds int `json:"timeoutSeconds,omitempty"`
	// Number of requests to make per analysis cycle
	RequestCount int `json:"requestCount,omitempty"`
	// Pod metric to check (for type=podMetrics)
	// +kubebuilder:validation:Enum=errorRate;latencyP99;restartRate
	Metric string `json:"metric,omitempty"`
	// Threshold as a string
	Threshold string `json:"threshold,omitempty"`
	// Time window in seconds to evaluate the metric
	WindowSeconds int `json:"windowSeconds,omitempty"`
}

// RollbackPolicy controls automatic rollback behaviour.
type RollbackPolicy struct {
	Auto       *bool  `json:"auto,omitempty"`
	MaxRetries *int32 `json:"maxRetries,omitempty"`
}

// TrafficRouter selects a traffic provider for a Rollout.
type TrafficRouter struct {
	// Provider specifies the traffic router provider ("istio" or "gateway-api").
	// +kubebuilder:validation:Enum=istio;gateway-api
	Provider string `json:"provider"`
	// +optional
	Istio *IstioRouterConfig `json:"istio,omitempty"`
	// +optional
	GatewayAPI *GatewayAPIRouterConfig `json:"gatewayApi,omitempty"`
}

// IstioRouterConfig manages an Istio VirtualService.
type IstioRouterConfig struct {
	// +optional
	VirtualService string `json:"virtualService,omitempty"`
	// +optional
	Routes []string `json:"routes,omitempty"`
	// +optional
	Hosts []string `json:"hosts,omitempty"`
	// +optional
	StableService string `json:"stableService,omitempty"`
	// +optional
	CanaryService string `json:"canaryService,omitempty"`
}

// GatewayAPIRouterConfig manages a Gateway API HTTPRoute.
type GatewayAPIRouterConfig struct {
	// +optional
	HTTPRoute string `json:"httpRoute,omitempty"`
	// +optional
	StableService string `json:"stableService,omitempty"`
	// +optional
	CanaryService string `json:"canaryService,omitempty"`
}

// RolloutSpec defines the desired state of a Rollout.
type RolloutSpec struct {
	Target               RolloutTarget          `json:"target"`
	Strategy             RolloutStrategy        `json:"strategy"`
	Template             corev1.PodTemplateSpec `json:"template,omitempty"`
	Replicas             *int32                 `json:"replicas,omitempty"`
	RevisionHistoryLimit *int32                 `json:"revisionHistoryLimit,omitempty"`
	Paused               bool                   `json:"paused,omitempty"`
	RollbackPolicy       *RollbackPolicy        `json:"rollbackPolicy,omitempty"`
	TrafficRouter        *TrafficRouter         `json:"trafficRouter,omitempty"`
}

// RolloutStatus defines the observed state of a Rollout.
type RolloutStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	Phase              RolloutPhase       `json:"phase,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
	CurrentStepIndex   int32              `json:"currentStepIndex,omitempty"`
	CurrentStepWeight  int32              `json:"currentStepWeight,omitempty"`
	// CurrentStepStartedAt is the baseline for CanaryStep.Duration accounting.
	// +optional
	CurrentStepStartedAt *metav1.Time `json:"currentStepStartedAt,omitempty"`
	StableRS             string       `json:"stableRs,omitempty"`
	CanaryRS             string       `json:"canaryRs,omitempty"`
	ActiveService        string       `json:"activeService,omitempty"`
	PreviewService       string       `json:"previewService,omitempty"`
	// PromotedAt is set when a BlueGreen rollout promotes preview to active.
	// +optional
	PromotedAt *metav1.Time `json:"promotedAt,omitempty"`
	// PreviewHealthyAt is the time the preview ReplicaSet first became fully ready.
	// +optional
	PreviewHealthyAt *metav1.Time `json:"previewHealthyAt,omitempty"`
	// Abort is set to true when the rollout has been aborted; cleared on resume.
	// +optional
	Abort bool `json:"abort,omitempty"`
	// CurrentPodHash is the hash of the most recently reconciled pod template.
	// +optional
	CurrentPodHash string `json:"currentPodHash,omitempty"`
	// StableReadyReplicas is the observed ready replica count of the stable ReplicaSet.
	// +optional
	StableReadyReplicas int32 `json:"stableReadyReplicas,omitempty"`
	// CanaryReadyReplicas is the observed ready replica count of the canary/preview ReplicaSet.
	// +optional
	CanaryReadyReplicas int32 `json:"canaryReadyReplicas,omitempty"`
	// PreviousActiveRS is set by the BlueGreen strategy after promotion. It
	// names the ReplicaSet that was active before the current active RS. The
	// controller uses it to drain (scale to 0) the previous active RS after
	// ScaleDownDelaySeconds, then clears it.
	// +optional
	PreviousActiveRS string `json:"previousActiveRs,omitempty"`
	Message          string `json:"message,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=ro
// +kubebuilder:printcolumn:name="Strategy",type=string,JSONPath=".spec.strategy.type"
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=".status.phase"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// Rollout manages an advanced deployment strategy for a workload.
type Rollout struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              RolloutSpec   `json:"spec,omitempty"`
	Status            RolloutStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// RolloutList is a list of Rollouts.
type RolloutList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Rollout `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Rollout{}, &RolloutList{})
}
