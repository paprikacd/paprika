export default function TemplatePage() {
  return (
    <div>
      <h1>Template CRD</h1>
      <p className="lead">
        The <code>Template</code> resource defines where Kubernetes manifests come from. It supports three source types: Helm charts, Git repositories, and S3 buckets.
      </p>

      <hr />

      <h2>Overview</h2>
      <p>
        Templates are created automatically by the Application controller based on the <code>spec.source</code> field. They reference a source location and configuration for rendering manifests. Behind the scenes, Paprika uses the Helm SDK to render charts in-process (no subprocess spawning).
      </p>

      <h2>Spec</h2>
      <pre><code>apiVersion: pipelines.paprika.io/v1alpha1
kind: Template
metadata:
  name: my-app-template
spec:
  # Source type: helm, git, s3, kubernetes, kustomize
  type: helm

  # Helm chart configuration
  chart:
    path: /charts/my-app          # Local chart path (in-image)
    # OR remote chart:
    repo: https://charts.bitnami.com/bitnami
    name: nginx
    version: 18.2.2

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
    endpoint: https://s3.custom.com

  # Optional namespace override
  namespace: my-namespace

  # Optional base values file content
  valuesFile: |
    global:
      environment: production</code></pre>

      <h2>Status</h2>
      <table>
        <thead>
          <tr><th>Field</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>sourceHash</code></td><td>Hash of the source content (commit hash, ETag, etc.)</td></tr>
          <tr><td><code>sourceRevision</code></td><td>Revision identifier from the source</td></tr>
          <tr><td><code>lastRendered</code></td><td>Timestamp of last successful render</td></tr>
          <tr><td><code>lastRenderHash</code></td><td>Hash of the last rendered output</td></tr>
        </tbody>
      </table>

      <h2>Rendering</h2>
      <p>
        Templates are rendered by the <code>HelmSDKRenderer</code>, which uses the Helm v3 SDK directly in-process. Parameters from the Application or Release are passed as values. The renderer also supports:
      </p>
      <ul>
        <li><strong>Cached rendering</strong> — Rendered output is cached keyed by source revision + params hash to avoid redundant work</li>
        <li><strong>Multi-source aggregation</strong> — A Stage can reference multiple Templates; their outputs are joined with <code>---</code> separators</li>
        <li><strong>Git/S3 source resolution</strong> — Sources are cloned/downloaded to a working directory before rendering</li>
      </ul>
    </div>
  )
}
