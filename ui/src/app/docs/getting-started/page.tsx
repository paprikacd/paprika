export default function GettingStartedPage() {
  return (
    <div>
      <h1>Getting Started</h1>
      <p className="lead">
        Install Paprika on a Kubernetes cluster and deploy your first application in under 5 minutes.
      </p>

      <hr />

      <h2>Prerequisites</h2>
      <ul>
        <li>Kubernetes cluster v1.29+</li>
        <li><a href="https://cert-manager.io/docs/installation/">cert-manager</a> installed (webhook TLS certificates)</li>
        <li><code>kubectl</code> configured for your cluster</li>
        <li>Docker (for building the operator image)</li>
      </ul>

      <h2>Installation Options</h2>

      <h3>Option 1: Deploy from Source</h3>
      <pre><code>git clone https://github.com/benebsworth/paprika.git
cd paprika

# Install CRDs
make install

# Build and push to your registry
export IMG=ghcr.io/YOUR_USER/paprika:latest
make docker-build docker-push IMG=$IMG

# Deploy the operator
make deploy IMG=$IMG

# Verify
kubectl get pods -n paprika-system</code></pre>

      <h3>Option 2: Single YAML Bundle</h3>
      <pre><code>make build-installer IMG=ghcr.io/YOUR_USER/paprika:latest
kubectl apply -f dist/install.yaml</code></pre>

      <h3>Option 3: Helm Chart</h3>
      <pre><code>make helm-generate
helm install paprika charts/chart --namespace paprika-system --create-namespace</code></pre>

      <h2>Deploy a Sample Application</h2>
      <p>Create an Application resource:</p>
      <pre><code>kubectl apply -f - &lt;&lt;EOF
apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: my-app
  namespace: paprika-system
spec:
  source:
    type: helm
    chart:
      repo: https://charts.bitnami.com/bitnami
      name: nginx
      version: 18.2.2
  stages:
    - name: dev
      ring: 1
  strategy: Rolling
  syncPolicy: Auto
EOF</code></pre>

      <h3>What Happens</h3>
      <p>When you create the Application, Paprika&apos;s controllers automatically:</p>
      <ol>
        <li><strong>Template Created</strong> — A <code>Template</code> resource is created from the <code>source</code> field</li>
        <li><strong>Stage Created</strong> — A <code>Stage</code> resource is created for each stage entry</li>
        <li><strong>Release Created</strong> — A <code>Release</code> promotes the rendered manifests through the stage lifecycle</li>
        <li><strong>Manifests Rendered</strong> — The Helm chart is rendered using the Helm SDK</li>
        <li><strong>Manifests Applied</strong> — Rendered resources are applied to the cluster</li>
        <li><strong>Health Verified</strong> — The operator monitors resource health via CEL expressions</li>
      </ol>

      <h3>Check Status</h3>
      <pre><code>kubectl get application my-app -n paprika-system -o yaml

# Watch the phase transition: Pending → Promoting → Healthy
kubectl get application my-app -n paprika-system -w</code></pre>

      <h2>Access the Dashboard</h2>
      <p>The dashboard is served by the operator on port 3000:</p>
      <pre><code>kubectl port-forward -n paprika-system deployment/paprika-controller-manager 3000:3000
# Open http://localhost:3000</code></pre>

      <h2>Run Locally (Development)</h2>
      <pre><code>ENABLE_WEBHOOKS=false make run</code></pre>
      <p>This runs the operator on your host machine using your current kubeconfig context. Webhooks are disabled for local development.</p>

      <h2>Run Tests</h2>
      <pre><code># Unit tests with envtest
make test

# Lint
make lint

# E2E tests (creates an isolated Kind cluster)
make test-e2e</code></pre>

      <h2>Clean Up</h2>
      <pre><code># Delete your application
kubectl delete application my-app

# Uninstall the operator
make undeploy

# Remove CRDs
make uninstall</code></pre>

      <h2>Next Steps</h2>
      <ul>
        <li>Learn about the <a href="/docs/concepts/application">Application CRD</a></li>
        <li>Explore <a href="/docs/concepts/stage">stages and canary deployments</a></li>
        <li>Read the <a href="/docs/api/types">API reference</a></li>
      </ul>
    </div>
  )
}
