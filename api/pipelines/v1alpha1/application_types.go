package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ApplicationPhase represents the phase of an application.
// ApplicationPhase represents the phase of an application.
type ApplicationPhase string

const (
	// ApplicationPending indicates the application is pending.
	ApplicationPending ApplicationPhase = "Pending"
	// ApplicationBuilding indicates the application is building.
	ApplicationBuilding ApplicationPhase = "Building"
	// ApplicationPromoting indicates the application is promoting.
	ApplicationPromoting ApplicationPhase = "Promoting"
	// ApplicationCanarying indicates the application is canarying.
	ApplicationCanarying ApplicationPhase = "Canarying"
	// ApplicationVerifying indicates the application is verifying.
	ApplicationVerifying ApplicationPhase = "Verifying"
	// ApplicationHealthy indicates the application is healthy.
	ApplicationHealthy ApplicationPhase = "Healthy"
	// ApplicationDegraded indicates the application is degraded.
	ApplicationDegraded ApplicationPhase = "Degraded"
	// ApplicationFailed indicates the application has failed.
	ApplicationFailed ApplicationPhase = "Failed"
	// ApplicationRolledBack indicates the application has been rolled back.
	ApplicationRolledBack ApplicationPhase = "RolledBack"
)

// SyncPolicy defines how the application syncs.
// SyncPolicy defines how the application syncs.
type SyncPolicy string

const (
	// SyncAuto enables automatic syncing of changes.
	SyncAuto SyncPolicy = "Auto"
	// SyncManual requires manual approval to sync changes.
	SyncManual SyncPolicy = "Manual"
)

// DeliveryStrategy defines the deployment strategy.
// DeliveryStrategy defines the deployment strategy.
type DeliveryStrategy string

const (
	// StrategyRolling performs a rolling update deployment.
	StrategyRolling DeliveryStrategy = "Rolling"
	// StrategyCanary performs a canary deployment.
	StrategyCanary DeliveryStrategy = "Canary"
	// StrategyBlueGreen performs a blue-green deployment.
	StrategyBlueGreen DeliveryStrategy = "BlueGreen"
)

// Source type constants.
const (
	SourceTypeGit  = "git"
	SourceTypeHelm = "helm"
	SourceTypeS3   = "s3"
)

// ApplicationSource defines the source of an application.
// ApplicationSource defines the source of an application.
type ApplicationSource struct {
	// +kubebuilder:validation:Enum=git;helm;s3
	Type string `json:"type"`
	// Git repository URL (for type=git)
	RepoURL string `json:"repoUrl,omitempty"`
	// Git branch, tag, or commit (for type=git)
	Revision string `json:"revision,omitempty"`
	// Path within the repo to the chart/source (for type=git or type=s3)
	Path string `json:"path,omitempty"`
	// Helm chart reference (for type=helm)
	Chart ChartRef `json:"chart,omitempty"`
	// S3 bucket (for type=s3)
	Bucket string `json:"bucket,omitempty"`
	// S3 object key (for type=s3)
	Key string `json:"key,omitempty"`
	// S3 region (for type=s3)
	Region string `json:"region,omitempty"`
	// S3 endpoint URL (for type=s3, use LocalStack endpoint for testing)
	Endpoint string `json:"endpoint,omitempty"`
	// Secret reference for private repos or S3 credentials
	SecretRef string `json:"secretRef,omitempty"`
	// Poll interval for change detection (default 30s)
	// +kubebuilder:default="30s"
	PollInterval string `json:"pollInterval,omitempty"`
}

// ApplicationBuildStep defines a step in the build pipeline.
// ApplicationBuildStep defines a step in the build pipeline.
type ApplicationBuildStep struct {
	Name    string   `json:"name"`
	Image   string   `json:"image"`
	Script  string   `json:"script"`
	Depends []string `json:"depends,omitempty"`
	// +optional
	Timeout int `json:"timeout,omitempty"`
	// +optional
	Retry int `json:"retry,omitempty"`
}

// ApplicationBuildSpec defines the build specification.
// ApplicationBuildSpec defines the build specification.
type ApplicationBuildSpec struct {
	Steps []ApplicationBuildStep `json:"steps"`
	// +optional
	Sources []Source `json:"sources,omitempty"`
	// +optional
	MaxParallel int `json:"maxParallel,omitempty"`
	// +optional
	Artifacts []PipelineOutput `json:"artifacts,omitempty"`
}

// ApplicationPromotionStage defines a promotion stage.
// ApplicationPromotionStage defines a promotion stage.
type ApplicationPromotionStage struct {
	Name string `json:"name"`
	// Ring number (lower = earlier environment)
	Ring int `json:"ring"`
	// Cluster to deploy to (defaults to same cluster)
	// +optional
	Cluster ClusterRef `json:"cluster,omitempty"`
	// Delivery strategy for this stage (overrides spec.strategy if set)
	// +optional
	Strategy *DeliveryStrategy `json:"strategy,omitempty"`
	// Canary config for this stage (overrides spec.canary if set)
	// +optional
	Canary *CanaryConfig `json:"canary,omitempty"`
	// Verification gates to run after promotion
	// +optional
	Gates []GateConfig `json:"gates,omitempty"`
	// Feature flag / parameter overrides for this stage
	// +optional
	Parameters map[string]string `json:"parameters,omitempty"`
	// Auto-promote to the next ring after this stage is healthy
	// +optional
	AutoPromote bool `json:"autoPromote,omitempty"`
}

// HealthStatus represents the health status of an application or resource.
type HealthStatus string

const (
	// HealthHealthy indicates the resource is healthy.
	HealthHealthy HealthStatus = "Healthy"
	// HealthDegraded indicates the resource is degraded.
	HealthDegraded HealthStatus = "Degraded"
	// HealthUnknown indicates the resource health is unknown.
	HealthUnknown HealthStatus = "Unknown"
	// HealthProgressing indicates the resource is progressing toward healthy.
	HealthProgressing HealthStatus = "Progressing"
)

// HTTPProbe defines an HTTP probe for health checks.
// HTTPProbe defines an HTTP probe for health checks.
type HTTPProbe struct {
	// URL to probe
	URL string `json:"url"`
	// HTTP method (GET, POST, PUT, DELETE, HEAD)
	// +kubebuilder:default=GET
	Method string `json:"method,omitempty"`
	// Request headers
	Headers map[string]string `json:"headers,omitempty"`
	// Request body (for POST/PUT)
	Body string `json:"body,omitempty"`
	// Expected HTTP status code (default 200)
	ExpectedStatus int `json:"expectedStatus,omitempty"`
	// Timeout in seconds (default 5)
	// +kubebuilder:default=5
	Timeout int `json:"timeout,omitempty"`
}

// HealthCheck defines a health check.
// HealthCheck defines a health check.
type HealthCheck struct {
	// Name of the health check
	Name string `json:"name"`
	// CEL expression to evaluate. Available variables:
	//   app (Application spec), status (Application status), http (HTTP probe results).
	// Expression must return a boolean or a string matching HealthStatus.
	Expression string `json:"expression"`
	// Optional HTTP probe to run before evaluating the expression.
	// Results available in CEL as http.status, http.body, http.headers.
	// +optional
	HTTPProbe *HTTPProbe `json:"httpProbe,omitempty"`
	// How often to run this check (default 30s)
	// +kubebuilder:default="30s"
	Interval string `json:"interval,omitempty"`
}

// ApprovalGate defines a manual or automated approval gate for stage transitions.
type ApprovalGate struct {
	// Name of the gate
	Name string `json:"name"`
	// Stage at which this gate applies (e.g., "prod")
	Stage string `json:"stage"`
	// Type of gate: manual, webhook, slack
	// +kubebuilder:validation:Enum=manual;webhook;slack
	Type string `json:"type"`
	// Whether the gate is required (default true)
	// +kubebuilder:default=true
	Required bool `json:"required,omitempty"`
}

// GateStatus represents the current status of an approval gate.
type GateStatus struct {
	Name       string `json:"name"`
	Stage      string `json:"stage"`
	Status     string `json:"status"` // Pending, Approved, Rejected
	ApprovedBy string `json:"approvedBy,omitempty"`
}

// HealthCheckResult contains the result of a single health check evaluation.
type HealthCheckResult struct {
	Name      string       `json:"name"`
	Status    HealthStatus `json:"status"`
	Message   string       `json:"message,omitempty"`
	CheckedAt *metav1.Time `json:"checkedAt,omitempty"`
	// HTTP probe results
	HTTPStatusCode int    `json:"httpStatusCode,omitempty"`
	HTTPBody       string `json:"httpBody,omitempty"`
}

// ApplicationSpec defines the specification for an application.
// ApplicationSpec defines the specification for an application.
type ApplicationSpec struct {
	// Source defines where the application code/chart lives.
	Source ApplicationSource `json:"source"`

	// Build defines the CI pipeline steps (optional — skip if no build needed).
	// +optional
	Build *ApplicationBuildSpec `json:"build,omitempty"`

	// Stages defines the promotion environments (dev, staging, prod, etc.).
	Stages []ApplicationPromotionStage `json:"stages"`

	// Strategy is the default delivery strategy for all stages.
	// Can be overridden per-stage.
	// +kubebuilder:validation:Enum=Rolling;Canary;BlueGreen
	// +kubebuilder:default=Rolling
	Strategy DeliveryStrategy `json:"strategy,omitempty"`

	// Canary defines the default canary configuration.
	// Overridden by per-stage canary config.
	// +optional
	Canary *CanaryConfig `json:"canary,omitempty"`

	// SyncPolicy controls whether changes are applied automatically.
	// +kubebuilder:validation:Enum=Auto;Manual
	// +kubebuilder:default=Auto
	SyncPolicy SyncPolicy `json:"syncPolicy,omitempty"`

	// Parameters are Helm value overrides passed to all releases.
	// +optional
	Parameters map[string]string `json:"parameters,omitempty"`

	// OnFailure defines the action when a promotion fails.
	// +optional
	OnFailure *FailureAction `json:"onFailure,omitempty"`

	// HealthChecks define custom CEL-based health checks for the application.
	// +optional
	HealthChecks []HealthCheck `json:"healthChecks,omitempty"`

	// ApprovalGates define manual approval gates for stage transitions.
	// +optional
	ApprovalGates []ApprovalGate `json:"approvalGates,omitempty"`
}

// ResourceSync tracks the sync status of a managed Kubernetes resource.
type ResourceSync struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	// +kubebuilder:validation:Enum=Synced;OutOfSync;Missing;Pruned
	Status string `json:"status"`
}

// ResourceHealth tracks the health status of a deployed Kubernetes resource.
type ResourceHealth struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	// +kubebuilder:validation:Enum=Healthy;Degraded;Progressing;Unknown;Missing
	Health  string `json:"health"`
	Message string `json:"message,omitempty"`
}

// ApplicationStageStatus represents the status of an application stage.
// ApplicationStageStatus represents the status of an application stage.
type ApplicationStageStatus struct {
	Name      string       `json:"name"`
	Ring      int          `json:"ring"`
	Phase     string       `json:"phase,omitempty"`
	Release   string       `json:"release,omitempty"`
	Revision  string       `json:"revision,omitempty"`
	UpdatedAt *metav1.Time `json:"updatedAt,omitempty"`
}

// ApplicationStatus represents the status of an application.
// ApplicationStatus represents the status of an application.
type ApplicationStatus struct {
	// +kubebuilder:validation:Enum=Pending;Building;Promoting;Canarying;Verifying;Healthy;Degraded;Failed;RolledBack
	Phase ApplicationPhase `json:"phase,omitempty"`

	// Current stage being promoted/verified
	CurrentStage string `json:"currentStage,omitempty"`

	// Per-stage status
	Stages []ApplicationStageStatus `json:"stages,omitempty"`

	// Whether the source has been synced
	Synced bool `json:"synced,omitempty"`

	// Last deployed revision (git commit hash or chart version)
	Revision string `json:"revision,omitempty"`

	// Owned resource references
	SourceHash     string   `json:"sourceHash,omitempty"`
	SourceRevision string   `json:"sourceRevision,omitempty"`
	TemplateRef    string   `json:"templateRef,omitempty"`
	PipelineRef    string   `json:"pipelineRef,omitempty"`
	StageRefs      []string `json:"stageRefs,omitempty"`
	ReleaseRef     string   `json:"releaseRef,omitempty"`

	Conditions []metav1.Condition `json:"conditions,omitempty"`

	// Canary weight if currently canarying
	CanaryWeight int `json:"canaryWeight,omitempty"`
	// Index into the canary steps array
	CanaryStepIndex int `json:"canaryStepIndex,omitempty"`
	// Overall health status computed from health checks
	Health HealthStatus `json:"health,omitempty"`
	// Results of health check evaluations
	HealthChecks []HealthCheckResult `json:"healthChecks,omitempty"`

	// ResourceSync tracks the diff status of each managed resource
	// +optional
	Resources []ResourceSync `json:"resources,omitempty"`

	// ResourceHealth tracks the health status of each deployed resource
	// +optional
	ResourceHealth []ResourceHealth `json:"resourceHealth,omitempty"`

	// Pruned resources count
	// +optional
	PrunedResources int `json:"prunedResources,omitempty"`

	// OutOfSync resources count
	// +optional
	OutOfSync int `json:"outOfSync,omitempty"`

	// Approval gate status
	// +optional
	Gates []GateStatus `json:"gates,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=".status.phase"
// +kubebuilder:printcolumn:name="Stage",type=string,JSONPath=".status.currentStage"
// +kubebuilder:printcolumn:name="Revision",type=string,JSONPath=".status.revision"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// Application represents a Paprika application.
// Application represents a Paprika application.
type Application struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	Spec ApplicationSpec `json:"spec"`
	// +optional
	Status ApplicationStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// ApplicationList is a list of Applications.
// ApplicationList is a list of Applications.
type ApplicationList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Application `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Application{}, &ApplicationList{})
}
