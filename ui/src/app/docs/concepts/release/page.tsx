export default function ReleasePage() {
  return (
    <div>
      <h1>Release CRD</h1>
      <p className="lead">
        The <code>Release</code> resource manages the lifecycle of a single promotion through a stage. It handles rendering manifests, applying them to the target cluster, and verifying the deployment.
      </p>

      <hr />

      <h2>Overview</h2>
      <p>
        A Release is created by the Application controller whenever the source changes (Auto sync) or on manual trigger. It progresses through defined phases: from initial promotion to verification to a terminal state. Each Release is scoped to a single Stage.
      </p>

      <h2>Spec</h2>
      <pre><code>apiVersion: pipelines.paprika.io/v1alpha1
kind: Release
metadata:
  name: my-app-production-release
spec:
  target: my-app-production         # Target stage
  pipeline: my-app-pipeline         # Optional pipeline reference
  parameters:                       # Per-release parameter overrides
    replicaCount: "5"
    image.tag: "v2.0.0"</code></pre>

      <h2>Status</h2>
      <table>
        <thead>
          <tr><th>Field</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>phase</code></td><td>Pending, Promoting, Canarying, Verifying, Complete, Failed, RolledBack, Superseded</td></tr>
          <tr><td><code>currentStage</code></td><td>Name of the target stage</td></tr>
          <tr><td><code>promotionHistory[]</code></td><td>History entries with stage name, result (Passed/Failed), and timestamp</td></tr>
          <tr><td><code>renderedManifestSnapshot</code></td><td>ConfigMap name containing the rendered manifest snapshot</td></tr>
          <tr><td><code>canaryWeight</code></td><td>Current canary traffic weight (0-100)</td></tr>
          <tr><td><code>canaryStepIndex</code></td><td>Current canary step index</td></tr>
        </tbody>
      </table>

      <h2>Phases</h2>
      <table>
        <thead>
          <tr><th>Phase</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>Pending</code></td><td>Release created, initializing</td></tr>
          <tr><td><code>Promoting</code></td><td>Rendering manifests, applying to cluster, creating snapshot</td></tr>
          <tr><td><code>Canarying</code></td><td>Canary deployment active with traffic weight management</td></tr>
          <tr><td><code>Verifying</code></td><td>Running health checks and analysis after promotion</td></tr>
          <tr><td><code>Complete</code></td><td>Promotion succeeded and verified</td></tr>
          <tr><td><code>Failed</code></td><td>Promotion or verification failed</td></tr>
          <tr><td><code>RolledBack</code></td><td>Release was rolled back</td></tr>
          <tr><td><code>Superseded</code></td><td>Another Release has replaced this one</td></tr>
        </tbody>
      </table>

      <h2>Promotion Process</h2>
      <ol>
        <li><strong>Fetch stage</strong> — Get the target Stage and its referenced Templates</li>
        <li><strong>Build params</strong> — Merge release parameters with stage and application parameters</li>
        <li><strong>Render templates</strong> — Render all referenced Templates with the merged parameters</li>
        <li><strong>Store snapshot</strong> — Save rendered manifests to a ConfigMap for rollback</li>
        <li><strong>Apply manifests</strong> — Create or update resources on the target cluster via the dynamic client</li>
        <li><strong>Configure traffic</strong> — Set up canary traffic routing if configured</li>
        <li><strong>Verify</strong> — Run health checks and analysis to validate the deployment</li>
        <li><strong>Complete or fail</strong> — Transition to terminal phase based on verification results</li>
      </ol>

      <h2>Finalizer Cleanup</h2>
      <p>
        When a Release is deleted, the finalizer removes created resources (Deployments, Services, Ingresses) that are labeled with <code>paprika.io/release=&lt;release-name&gt;</code>. It also deletes the manifest snapshot ConfigMap.
      </p>
    </div>
  )
}
