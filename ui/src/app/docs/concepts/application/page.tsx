export default function ApplicationPage() {
  return (
    <div>
      <h1>Application CRD</h1>
      <p className="lead">
        The <code>Application</code> resource is the primary user-facing primitive. It models an entire application deployment in a single manifest.
      </p>

      <hr />

      <h2>Overview</h2>
      <p>
        The Application controller acts as an orchestrator. When you create or update an Application, it reconciles by managing subordinate resources: Template, Stage(s), Pipeline, and Release. This means you define your application once, and Paprika handles the rest.
      </p>

      <h2>Spec</h2>
      <pre><code>apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: my-app
spec:
  # Source configuration (required)
  source:
    type: helm                     # helm, git, or s3
    chart:
      path: /charts/my-app         # local chart path
      # OR
      repo: https://charts.example.com
      name: my-app
      version: 1.0.0
    # Git source (when type=git)
    git:
      repoUrl: https://github.com/org/repo.git
      revision: main
      path: deploy/
    # S3 source (when type=s3)
    s3:
      bucket: my-bucket
      key: manifests/
      region: us-east-1

  # Optional build pipeline
  build:
    maxParallel: 1
    steps:
      - name: build-image
        image: docker:latest
        script: |
          docker build -t my-app .
      - name: run-tests
        image: golang:1.25
        script: go test ./...

  # Stages (environments)
  stages:
    - name: dev
      ring: 1
      strategy: Rolling
    - name: staging
      ring: 2
      strategy: Canary
      canary:
        steps:
          - weight: 10
          - weight: 50
          - weight: 100
        intervalSeconds: 60
      approvalGates:
        - name: qa-approval
          description: &quot;QA sign-off required&quot;
    - name: production
      ring: 3
      strategy: Canary
      trafficRouter:
        provider: Istio
        istio:
          host: app.example.com
          gateways:
            - istio-system/main-gateway

  # Global settings
  strategy: Rolling                # default strategy per-stage
  syncPolicy: Auto                 # Auto or Manual
  parameters:                      # Helm values
    replicaCount: &quot;3&quot;
    image.tag: &quot;latest&quot;</code></pre>

      <h2>Status</h2>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr><td><code>phase</code></td><td>Current state: Pending, Building, Promoting, Canarying, Verifying, Healthy, Degraded, Failed, RolledBack</td></tr>
          <tr><td><code>stages[]</code></td><td>Per-stage status with name, phase, ring, last updated time</td></tr>
          <tr><td><code>synced</code></td><td>Whether the desired state matches the live cluster state</td></tr>
          <tr><td><code>templateRef</code></td><td>Reference to the created Template resource</td></tr>
          <tr><td><code>pipelineRef</code></td><td>Reference to the created Pipeline resource (if build steps defined)</td></tr>
          <tr><td><code>stageRefs[]</code></td><td>References to the created Stage resources</td></tr>
          <tr><td><code>releaseRef</code></td><td>Reference to the current Release</td></tr>
          <tr><td><code>resources[]</code></td><td>Diff status of managed resources (Synced, OutOfSync, Missing, Pruned)</td></tr>
          <tr><td><code>resourceHealth[]</code></td><td>Health status of managed resources</td></tr>
          <tr><td><code>healthChecks[]</code></td><td>Results of CEL health evaluations</td></tr>
          <tr><td><code>gates[]</code></td><td>Approval gate states</td></tr>
        </tbody>
      </table>

      <h2>Phases</h2>
      <table>
        <thead>
          <tr><th>Phase</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>Pending</code></td><td>Application created, initial reconciliation</td></tr>
          <tr><td><code>Building</code></td><td>Pipeline is executing build/test steps</td></tr>
          <tr><td><code>Promoting</code></td><td>Release is being promoted to a stage</td></tr>
          <tr><td><code>Canarying</code></td><td>Canary deployment in progress with traffic shifting</td></tr>
          <tr><td><code>Verifying</code></td><td>Health checks and analysis running</td></tr>
          <tr><td><code>Healthy</code></td><td>All stages deployed and healthy</td></tr>
          <tr><td><code>Degraded</code></td><td>Some stages are not healthy</td></tr>
          <tr><td><code>Failed</code></td><td>Release or pipeline failed</td></tr>
          <tr><td><code>RolledBack</code></td><td>Release was rolled back</td></tr>
        </tbody>
      </table>

      <h2>Sync Policy</h2>
      <ul>
        <li><strong>Auto</strong> — Paprika automatically creates Releases for each stage when the source changes</li>
        <li><strong>Manual</strong> — You must manually trigger promotion (via the API or kubectl)</li>
      </ul>

      <h2>Health Checks</h2>
      <p>Paprika supports two types of health checks:</p>
      <ul>
        <li><strong>CEL expressions</strong> — Evaluate conditions on cluster resources using the Common Expression Language. Built-in variables: <code>app</code>, <code>status</code>, <code>http</code></li>
        <li><strong>HTTP probes</strong> — Simple HTTP GET checks against provided URLs</li>
      </ul>

      <h2>Approval Gates</h2>
      <p>Gates block promotion to a stage until explicitly approved. Gates can be manual (approved via the API) or automated. Gate state is stored in <code>status.gates</code>.</p>
    </div>
  )
}
