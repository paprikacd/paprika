import Link from "next/link"

export default function ConceptsPage() {
  return (
    <div>
      <h1>Core Concepts</h1>
      <p className="lead">
        Paprika models application delivery as a graph of Kubernetes custom resources. Each resource handles one aspect of the lifecycle: source, build, environment, or promotion.
      </p>

      <hr />

      <h2>Resource Hierarchy</h2>
      <pre><code>Application (top-level)
├── Template      — source configuration (Helm/Git/S3)
├── Pipeline      — build/test/deploy steps (optional)
├── Stage(s)      — environment definitions
│   └── Release   — promotion through a stage lifecycle</code></pre>

      <p>
        The <Link href="/docs/concepts/application">Application</Link> resource is the primary user-facing primitive.
        It references a source, defines stages (environments), and optionally includes a build pipeline.
        Paprika's controllers automatically create and manage the subordinate resources.
      </p>

      <h2>Lifecycle</h2>
      <ol>
        <li><strong>Create Application</strong> — User defines the Application manifest</li>
        <li><strong>Resolve Source</strong> — Template controller resolves the source (clone git, fetch chart, etc.)</li>
        <li><strong>Build (optional)</strong> — Pipeline controller executes build/test steps</li>
        <li><strong>Promote</strong> — Release controller renders manifests and applies them to the target stage</li>
        <li><strong>Verify</strong> — Health checks and analysis gates validate the deployment</li>
        <li><strong>Complete</strong> — Release reaches terminal phase (Complete, Failed, or RolledBack)</li>
      </ol>

      <h2>Key Design Decisions</h2>
      <ul>
        <li><strong>Idempotent reconciliation</strong> — All controllers are safe to run multiple times; they re-fetch before updates to avoid conflicts</li>
        <li><strong>Status conditions</strong> — Standard <code>metav1.Condition</code> for all status reporting (not custom string fields)</li>
        <li><strong>Finalizers</strong> — Automatic cleanup of created resources when parent resources are deleted</li>
        <li><strong>Owner references</strong> — Enable automatic garbage collection of child resources</li>
        <li><strong>Interfaces + mocks</strong> — Package boundaries use Go interfaces with gomock mocks for testability</li>
      </ul>

      <h2>Supported Source Types</h2>
      <table>
        <thead>
          <tr>
            <th>Type</th>
            <th>Resolution</th>
            <th>Use Case</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>helm</code></td>
            <td>Local path or remote repo</td>
            <td>Helm chart deployment</td>
          </tr>
          <tr>
            <td><code>git</code></td>
            <td>go-git clone + checkout</td>
            <td>Plain Kubernetes YAML or Kustomize</td>
          </tr>
          <tr>
            <td><code>s3</code></td>
            <td>AWS SDK v2 download</td>
            <td>Manifests stored in S3 buckets</td>
          </tr>
        </tbody>
      </table>

      <h2>Deployment Strategies</h2>
      <table>
        <thead>
          <tr>
            <th>Strategy</th>
            <th>Description</th>
            <th>Traffic Router</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><code>Rolling</code></td>
            <td>Direct update, no traffic splitting</td>
            <td>None required</td>
          </tr>
          <tr>
            <td><code>Canary</code></td>
            <td>Gradual traffic shift with step weights</td>
            <td>Istio or Gateway API</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}
