export default function CanaryGuidePage() {
  return (
    <div>
      <h1>Canary Deployments</h1>
      <p className="lead">
        Canary deployments gradually shift traffic to a new version while health checks verify behavior. Paprika automates the steps and can roll back automatically on failure.
      </p>

      <hr />

      <h2>How it works</h2>
      <p>
        Define a stage with strategy <code>Canary</code> and a list of weight steps. Paprika creates the canary resources, shifts traffic at each interval, runs health checks, and either promotes to 100% or rolls back.
      </p>

      <h2>Example</h2>
      <pre><code>{`apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: canary-demo
  namespace: paprika-system
spec:
  source:
    type: helm
    chart:
      repo: https://charts.bitnami.com/bitnami
      name: nginx
      version: 18.2.2
  parameters:
    image.tag: "2.0"
  stages:
    - name: production
      ring: 1
      strategy: Canary
      canary:
        steps:
          - weight: 10
          - weight: 50
          - weight: 100
        intervalSeconds: 120
      trafficRouter:
        provider: Istio
        istio:
          host: canary-demo.example.com
          gateways:
            - istio-system/main-gateway
      healthChecks:
        - name: http-200
          http:
            url: http://canary-demo.example.com/health
            expectedStatus: 200
  syncPolicy: Auto`}</code></pre>

      <h2>Observing the rollout</h2>
      <p>
        Watch the application phase and weights in the dashboard or with <code>kubectl get application canary-demo -w</code>. Each step waits for the configured interval before advancing, and a failing health check aborts the rollout.
      </p>
    </div>
  )
}
