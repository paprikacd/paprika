export default function PipelinesGuidePage() {
  return (
    <div>
      <h1>Pipelines</h1>
      <p className="lead">
        Pipelines run build, test, or verification steps as Kubernetes Jobs before an application is promoted. They are defined inline in the Application spec.
      </p>

      <hr />

      <h2>Pipeline lifecycle</h2>
      <p>
        When an Application changes, Paprika creates a Pipeline resource. The Pipeline controller runs each step as a Job, respecting dependencies and parallelism. A failed step blocks promotion.
      </p>

      <h2>Example</h2>
      <pre><code>{`apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: pipelined-app
  namespace: paprika-system
spec:
  source:
    type: git
    git:
      repoUrl: https://github.com/example/app.git
      revision: main
      path: deploy/
  build:
    maxParallel: 2
    steps:
      - name: unit-tests
        image: golang:1.25
        script: |
          go test ./...
      - name: build-image
        image: gcr.io/kaniko-project/executor:latest
        script: |
          /kaniko/executor --context . --destination my-registry/app:latest
        dependsOn:
          - unit-tests
      - name: security-scan
        image: aquasec/trivy:latest
        script: |
          trivy image my-registry/app:latest
        dependsOn:
          - build-image
  stages:
    - name: staging
      ring: 1
    - name: production
      ring: 2
      approvalGates:
        - name: release-approval
  syncPolicy: Auto`}</code></pre>

      <h2>Artifacts</h2>
      <p>
        Steps can produce artifacts by writing to shared volumes. Later steps reference artifacts by name. See the <a href="/docs/api/types">CRD Types</a> reference for the artifact schema.
      </p>
    </div>
  )
}
