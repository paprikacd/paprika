export default function MultiClusterGuidePage() {
  return (
    <div>
      <h1>Multi-Cluster Deployments</h1>
      <p className="lead">
        Deploy applications to multiple Kubernetes clusters by referencing cluster credentials in stage definitions.
      </p>

      <hr />

      <h2>Cluster credentials</h2>
      <p>
        Store a kubeconfig for the target cluster in a Kubernetes Secret in the same namespace as the Application. Paprika uses the secret to apply manifests remotely.
      </p>
      <pre><code>{`kubectl create secret generic prod-kubeconfig \\
  --from-file=kubeconfig=./prod.kubeconfig \\
  -n paprika-system`}</code></pre>

      <h2>Stage configuration</h2>
      <p>Reference the secret in the stage's <code>clusterRef</code> field. If no clusterRef is supplied, Paprika deploys to the local cluster.</p>
      <pre><code>{`apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: multi-cluster-app
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
      clusterRef:
        name: dev-kubeconfig
        key: kubeconfig
    - name: production
      ring: 2
      clusterRef:
        name: prod-kubeconfig
        key: kubeconfig
      strategy: Canary
      canary:
        steps:
          - weight: 25
          - weight: 100
  syncPolicy: Auto`}</code></pre>

      <h2>Security considerations</h2>
      <p>
        Use RBAC to restrict access to kubeconfig secrets. Prefer short-lived tokens or credential plugins rather than static certificates where possible.
      </p>
    </div>
  )
}
