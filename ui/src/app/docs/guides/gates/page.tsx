export default function GatesGuidePage() {
  return (
    <div>
      <h1>Approval Gates</h1>
      <p className="lead">
        Approval gates pause promotion before a stage until the gate is approved. Gates are useful for production sign-offs, compliance checks, or waiting for external systems.
      </p>

      <hr />

      <h2>Defining gates</h2>
      <p>
        Add <code>approvalGates</code> to a stage. Each gate has a name and an optional description. When a release reaches the stage, the phase moves to <code>WaitingForApproval</code>.
      </p>

      <h2>Example</h2>
      <pre><code>{`apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: gated-app
  namespace: paprika-system
spec:
  source:
    type: helm
    chart:
      repo: https://charts.bitnami.com/bitnami
      name: nginx
      version: 18.2.2
  stages:
    - name: staging
      ring: 1
    - name: production
      ring: 2
      approvalGates:
        - name: qa-approval
          description: QA must verify the release
        - name: security-approval
          description: Security scan must pass
  syncPolicy: Auto`}</code></pre>

      <h2>Approving a gate</h2>
      <p>Approve via the dashboard, CLI, or API:</p>
      <pre><code>{`paprika gates approve gated-app --namespace paprika-system --gate qa-approval`}</code></pre>
      <p>After all gates are approved, the release continues to the next stage or completes.</p>
    </div>
  )
}
