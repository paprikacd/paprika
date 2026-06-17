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

// SyncOptions controls how manifests are applied and pruned.
type SyncOptions struct {
	// PrunePropagationPolicy selects the deletion propagation policy used when
	// pruning managed resources.
	// +kubebuilder:validation:Enum=Foreground;Background;Orphan
	// +optional
	PrunePropagationPolicy string `json:"prunePropagationPolicy,omitempty"`
	// Replace uses Update instead of server-side apply.
	// +optional
	Replace bool `json:"replace,omitempty"`
	// Force enables force-conflicts for server-side apply.
	// +optional
	Force bool `json:"force,omitempty"`
	// ApplyOutOfSyncOnly skips applying resources whose live state already
	// matches the desired manifest.
	// +optional
	ApplyOutOfSyncOnly bool `json:"applyOutOfSyncOnly,omitempty"`
}

// SelfHealConfig controls automatic remediation behavior.
type SelfHealConfig struct {
	// AutoSyncOnDrift triggers a re-sync when managed resources are out of sync.
	// +optional
	AutoSyncOnDrift bool `json:"autoSyncOnDrift,omitempty"`

	// AutoRevertOnHealthFailure rolls back the current release when the application becomes Degraded.
	// +optional
	AutoRevertOnHealthFailure bool `json:"autoRevertOnHealthFailure,omitempty"`

	// Cooldown between self-heal actions. Defaults to 5m.
	// +kubebuilder:default="5m"
	// +optional
	Cooldown string `json:"cooldown,omitempty"`
}

// SyncWindowKind selects whether a window permits or denies sync.
// +kubebuilder:validation:Enum=Allow;Block
type SyncWindowKind string

const (
	// SyncWindowAllow permits automatic sync during the window.
	SyncWindowAllow SyncWindowKind = "Allow"
	// SyncWindowBlock denies automatic sync during the window.
	SyncWindowBlock SyncWindowKind = "Block"
)

// SyncWindow defines a cron-based time window that controls automatic sync.
type SyncWindow struct {
	// Kind is whether this window allows or blocks sync.
	// +kubebuilder:validation:Required
	Kind SyncWindowKind `json:"kind"`

	// Schedule is a standard 5-field cron expression:
	//   MIN HOUR DOM MONTH DOW
	// Example: "0 9 * * MON-FRI" for 09:00 on weekdays.
	// +kubebuilder:validation:Required
	Schedule string `json:"schedule"`

	// Duration is how long the window stays active after each scheduled start.
	// Parsed with time.ParseDuration, e.g. "8h".
	// +kubebuilder:validation:Required
	Duration string `json:"duration"`

	// Timezone is an IANA timezone name (e.g. "America/New_York"). Defaults to
	// UTC when empty.
	// +optional
	Timezone string `json:"timezone,omitempty"`

	// Stages limits the window to the named stages. Empty means all stages.
	// +optional
	Stages []string `json:"stages,omitempty"`
}

// Source type constants.
const (
	SourceTypeGit       = "git"
	SourceTypeHelm      = "helm"
	SourceTypeKustomize = "kustomize"
	SourceTypeS3        = "s3"
	SourceTypeOCI       = "oci"
	SourceTypeInline    = "inline"
)

// InlineSourceSpec references a manifest snapshot ConfigMap for inline sources.
type InlineSourceSpec struct {
	// ConfigMapRef is the name of the ConfigMap containing the rendered manifest bundle.
	// +optional
	ConfigMapRef string `json:"configMapRef,omitempty"`
}

// ApplicationSource defines the source of an application.
// ApplicationSource defines the source of an application.
type ApplicationSource struct {
	// +kubebuilder:validation:Enum=git;helm;kustomize;s3;oci;inline
	Type string `json:"type"`
	// RepoRef references a core.paprika.io Repository by name. When set, takes
	// precedence over inline URL/credentials fields.
	// +optional
	RepoRef string `json:"repoRef,omitempty"`
	// Git repository URL (for type=git)
	RepoURL string `json:"repoUrl,omitempty"`
	// Git branch, tag, or commit (for type=git)
	Revision string `json:"revision,omitempty"`
	// Path within the repo to the chart/source (for type=git or type=s3)
	Path string `json:"path,omitempty"`
	// Helm chart reference (for type=helm)
	Chart ChartRef `json:"chart,omitempty"`
	// OCI image reference (for type=oci), e.g. ghcr.io/org/app:1.2.3
	Image string `json:"image,omitempty"`
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
	// Insecure allows plain HTTP for OCI registries (type=oci)
	// +optional
	Insecure bool `json:"insecure,omitempty"`
	// Poll interval for change detection (default 30s)
	// +kubebuilder:default="30s"
	PollInterval string `json:"pollInterval,omitempty"`
	// Inline references a manifest snapshot ConfigMap (for type=inline).
	// +optional
	Inline *InlineSourceSpec `json:"inline,omitempty"`
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
	// Project references the AppProject that governs this application.
	// +optional
	// +kubebuilder:default:=default
	Project string `json:"project,omitempty"`

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

	// SyncOptions fine-tunes how manifests are applied and pruned.
	// +optional
	SyncOptions *SyncOptions `json:"syncOptions,omitempty"`

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

	// SelfHeal controls automatic remediation when drift or health failures are detected.
	// +optional
	SelfHeal *SelfHealConfig `json:"selfHeal,omitempty"`

	// SyncWindows restrict when automatic sync may run.
	// +optional
	SyncWindows []SyncWindow `json:"syncWindows,omitempty"`
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
	// ObservedGeneration is the last observed generation of the spec.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

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

	// LastSelfHealTime records the last time a self-heal action was taken.
	// +optional
	LastSelfHealTime *metav1.Time `json:"lastSelfHealTime,omitempty"`
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
