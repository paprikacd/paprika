import Link from "next/link"

export default function DocsPage() {
  return (
    <div>
      <h1>Paprika Documentation</h1>
      <p className="lead">
        Paprika is a Kubernetes-native application delivery platform. This documentation covers installation, core concepts, and API reference.
      </p>

      <hr />

      <h2>Getting Started</h2>
      <p>
        New to Paprika? Start here to install the operator and deploy your first application.
      </p>
      <ul>
        <li><Link href="/docs/getting-started">Quickstart Guide</Link> — Install the operator and create an Application in under 5 minutes</li>
      </ul>

      <h2>Core Concepts</h2>
      <p>Paprika extends Kubernetes with six Custom Resource Definitions (CRDs) that model the application delivery lifecycle.</p>
      <ul>
        <li><Link href="/docs/concepts/application">Application</Link> — The top-level resource that owns everything</li>
        <li><Link href="/docs/concepts/template">Template</Link> — Source configuration for rendering manifests (Helm, Git, S3)</li>
        <li><Link href="/docs/concepts/pipeline">Pipeline</Link> — Sequential build/test/deploy steps as Kubernetes Jobs</li>
        <li><Link href="/docs/concepts/stage">Stage</Link> — Environment definitions with cluster refs, canary config, and traffic routing</li>
        <li><Link href="/docs/concepts/release">Release</Link> — Promotion lifecycle through stages with verification</li>
      </ul>

      <h2>API Reference</h2>
      <ul>
        <li><Link href="/docs/api/types">CRD Types</Link> — Complete reference for all Custom Resource types</li>
        <li><Link href="/docs/api/rpc">RPC Methods</Link> — Connect-RPC API methods for the dashboard and programmatic access</li>
      </ul>

      <h2>Architecture Overview</h2>
      <p>
        Paprika runs as a Kubernetes operator using the controller-runtime framework. It watches custom resources and reconciles the desired state.
        The project follows a multi-group layout, with controllers organized by API group under <code>internal/controller/</code>.
      </p>
      <p>
        The operator binary has two modes: <strong>operator</strong> (full controller + webhook deployment) and <strong>API server</strong> (lightweight dashboard backend).
        Both modes share the same Go binary, selected via the <code>--mode</code> flag.
      </p>

      <h3>Project Layout</h3>
      <pre><code>api/pipelines/v1alpha1/     CRD type definitions with kubebuilder markers
cmd/main.go                 Entrypoint (operator + API server modes)
internal/controller/        Reconciliation controllers by group
internal/webhook/           Admission webhooks by group
engine/                     Template rendering, diff engine, workflow execution
traffic/                    Traffic router providers (Istio, Gateway API)
health/                     CEL health evaluation and resource health checks
source/                     Git/S3 source resolution
charts/                     Helm charts (demo app, operator chart)
ui/                         Next.js dashboard with shadcn/ui</code></pre>
    </div>
  )
}
