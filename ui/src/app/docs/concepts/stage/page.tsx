export default function StagePage() {
  return (
    <div>
      <h1>Stage CRD</h1>
      <p className="lead">
        The <code>Stage</code> resource defines a deployment environment. Each Stage belongs to an Application and represents a target for promotion, with optional canary configuration, traffic routing, and multi-cluster support.
      </p>

      <hr />

      <h2>Overview</h2>
      <p>
        Stages are created automatically by the Application controller from the <code>spec.stages</code> list. Each Stage references one or more Templates and can optionally configure canary rollout parameters, traffic routing, approval gates, and a target cluster.
      </p>

      <h2>Spec</h2>
      <pre><code>apiVersion: pipelines.paprika.io/v1alpha1
kind: Stage
metadata:
  name: my-app-production
spec:
  name: production                  # Logical name
  ring: 3                           # Deployment ring number

  # Templates to render for this stage
  templates:
    - my-app-template

  # Multi-cluster support (optional)
  cluster:
    name: prod-cluster
    kubeconfigSecret: prod-kubeconfig

  # Approval gates (optional)
  gates:
    - name: qa-approval
      type: manual

  # Canary configuration (optional)
  canary:
    steps:                         # Traffic weight steps
      - weight: 5
      - weight: 25
      - weight: 50
      - weight: 100
    intervalSeconds: 120           # Wait time between steps
    analysis:
      metrics:
        - name: error-rate
          interval: 60
          successCondition: result &lt;= 0.01

  # Traffic router (required for canary)
  trafficRouter:
    provider: Istio                # istio or gateway-api
    istio:
      host: app.example.com
      gateways:
        - istio-system/main-gateway</code></pre>

      <h2>Traffic Routing</h2>
      <p>Paprika supports two traffic router providers for canary deployments:</p>

      <h3>Istio</h3>
      <p>The Istio router patches <code>VirtualService</code> <code>spec.http[].route[].destination.weight</code> fields. It identifies the correct route by matching the destination host or route name. The <code>servicePrefix</code> helper strips <code>-stable</code>/<code>-canary</code> suffixes to match the base service name.</p>

      <h3>Gateway API</h3>
      <p>The Gateway API router patches <code>HTTPRoute</code> <code>spec.rules[].backendRefs[].weight</code> fields. It assumes exactly two backends (stable + canary) and preserves other backends' original weights.</p>

      <h2>Canary Step Throttling</h2>
      <p>
        Canary steps are throttled using a <code>CanaryStepStartedAt</code> timestamp in the Release status. Steps only advance when the elapsed time since the step started exceeds the configured interval. This prevents watch-event-driven fast-forward through all canary steps in under a second.
      </p>
    </div>
  )
}
