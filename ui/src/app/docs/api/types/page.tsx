export default function APITypesPage() {
  return (
    <div>
      <h1>API Types</h1>
      <p className="lead">
        Paprika defines 6 custom resource types plus supporting configuration structs, all under the <code>pipelines.paprika.io</code> API group.
      </p>

      <hr />

      <h2>API Group &amp; Version</h2>
      <pre><code>apiVersion: pipelines.paprika.io/v1alpha1
kind: &lt;Kind&gt;</code></pre>

      <h2>Resource Summary</h2>
      <table>
        <thead>
          <tr><th>Kind</th><th>Description</th><th>Subresource</th></tr>
        </thead>
        <tbody>
          <tr><td>Application</td><td>Top-level user-facing primitive</td><td>Status</td></tr>
          <tr><td>Template</td><td>Source configuration (Helm/Git/S3)</td><td>Status</td></tr>
          <tr><td>Pipeline</td><td>Build/test step workflow</td><td>Status</td></tr>
          <tr><td>Stage</td><td>Deployment environment</td><td>Status</td></tr>
          <tr><td>Release</td><td>Single promotion lifecycle</td><td>Status</td></tr>
          <tr><td>Artifact</td><td>Build output reference</td><td>Status</td></tr>
        </tbody>
      </table>

      <h2>Application</h2>
      <p><strong>Scope:</strong> Namespaced</p>
      <pre><code>Spec:
  source        ApplicationSource  # Source configuration
  build         BuildSpec          # Optional build pipeline steps
  stages        []StageSpec        # Environment definitions
  strategy      string             # Default strategy (Rolling/Canary)
  syncPolicy    string             # Auto or Manual
  parameters    map[string]string  # Helm values / params

Status:
  phase         string             # Pending, Promoting, Healthy, etc.
  templateRef   string             # Created Template name
  pipelineRef   string             # Created Pipeline name
  releaseRef    string             # Current Release name
  stages        []AppStageStatus   # Per-stage name, phase, ring
  synced        bool               # Desired vs live state match
  resources     []ResourceSync     # Per-resource sync status
  resourceHealth []ResourceHealth  # Per-resource health status
  healthChecks  []HealthCheckResult
  gates         []GateStatus       # Approval gate states
  sourceHash    string
  sourceRevision string
  conditions    []metav1.Condition

TrafficRouter:
  provider      string             # Istio or gateway-api
  istio         IstioRouterConfig
  gateway_api   GatewayAPIRouterConfig

IstioRouterConfig:
  virtual_service string
  routes          []string
  hosts           []string
  stable_service  string
  canary_service  string

GatewayAPIRouterConfig:
  http_route      string
  stable_service  string
  canary_service  string</code></pre>

      <h2>Template</h2>
      <p><strong>Scope:</strong> Namespaced</p>
      <pre><code>Spec:
  type          string             # helm, git, s3, kubernetes, kustomize
  chart         ChartRef           # Helm chart config
  git           GitSourceSpec      # Git repository config
  s3            S3SourceSpec       # S3 bucket config
  namespace     string             # Target namespace override
  valuesFile    string             # Base values content

Status:
  sourceHash    string
  sourceRevision string
  lastRendered  metav1.Time
  lastRenderHash string
  conditions    []metav1.Condition</code></pre>

      <h2>Pipeline</h2>
      <p><strong>Scope:</strong> Namespaced</p>
      <pre><code>Spec:
  sources       []SourceRef        # Input artifacts
  maxParallel   int32
  steps         []Step             # Sequential build steps
  artifacts     []ArtifactRef      # Output artifacts

Status:
  phase         string             # Running, Succeeded, Failed
  stepStatuses  []StepStatus       # Per-step phase and timing
  lastExecutionTime metav1.Time
  lastExecutionID  string
  conditions    []metav1.Condition</code></pre>

      <h2>Stage</h2>
      <p><strong>Scope:</strong> Namespaced</p>
      <pre><code>Spec:
  name          string
  ring          int32
  templates     []string           # Template references
  cluster       ClusterRef         # Optional multi-cluster config
  gates         []Gate             # Approval gates
  canary        CanarySpec         # Canary config + analysis
  trafficRouter TrafficRouter      # Istio or Gateway API

Status:
  phase         string
  lastPromoted  metav1.Time
  currentRelease string
  conditions    []metav1.Condition</code></pre>

      <h2>Release</h2>
      <p><strong>Scope:</strong> Namespaced</p>
      <pre><code>Spec:
  target        string             # Target stage name
  pipeline      string             # Optional pipeline reference
  parameters    map[string]string  # Per-release overrides

Status:
  phase         string             # Pending, Promoting, Complete, etc.
  currentStage  string
  promotionHistory []Promotion
  renderedManifestSnapshot string  # ConfigMap name
  canaryWeight  int32
  canaryStepIndex int32
  canaryStepStartedAt *metav1.Time
  result        string             # Passed, Failed
  conditions    []metav1.Condition</code></pre>

      <h2>Artifact</h2>
      <p><strong>Scope:</strong> Namespaced</p>
      <pre><code>Spec:
  name          string
  type          string             # oci, image, file
  reference     string

Status:
  phase         string
  conditions    []metav1.Condition</code></pre>

      <h2>Common Types</h2>

      <h3>ApplicationSource</h3>
      <pre><code>type:       string   # helm, git, s3
repoUrl:    string
revision:   string
path:       string
chart:      ChartRef
bucket:     string   # S3
key:        string   # S3
region:     string   # S3
endpoint:   string   # S3 custom endpoint
secretRef:  string   # Auth secret
pollInterval: string # Source polling interval</code></pre>

      <h3>ChartRef</h3>
      <pre><code>repo:    string   # Chart repo URL
name:    string   # Chart name
version: string   # Chart version
path:    string   # Local chart path</code></pre>

      <h3>GitSourceSpec</h3>
      <pre><code>repoUrl:   string
revision:  string   # Branch, tag, or commit
path:      string   # Subdirectory within repo
auth:      GitAuth  # SSH key or token</code></pre>

      <h3>S3SourceSpec</h3>
      <pre><code>bucket:    string
key:       string
region:    string
endpoint:  string
auth:      S3Auth  # Access key or IRSA</code></pre>

      <h3>CanarySpec</h3>
      <pre><code>{`steps:           []CanaryStep
intervalSeconds: int32
analysis:        AnalysisSpec`}</code></pre>

      <h3>metav1.Condition</h3>
      <pre><code>type:               string
status:             True | False | Unknown
observedGeneration: int64
lastTransitionTime: metav1.Time
reason:             string
message:            string</code></pre>
    </div>
  )
}
