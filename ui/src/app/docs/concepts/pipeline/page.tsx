export default function PipelinePage() {
  return (
    <div>
      <h1>Pipeline CRD</h1>
      <p className="lead">
        The <code>Pipeline</code> resource defines a sequential build workflow with steps backed by Kubernetes Jobs. Pipelines are optional — you can deploy directly without a build step.
      </p>

      <hr />

      <h2>Overview</h2>
      <p>
        Pipelines model the build portion of CI/CD. Each step runs as a Kubernetes Job in the operator&apos;s namespace. Steps can depend on previous steps, creating a DAG execution graph. Pipelines are created automatically by the Application controller when <code>spec.build</code> is defined.
      </p>

      <h2>Spec</h2>
      <pre><code>apiVersion: pipelines.paprika.io/v1alpha1
kind: Pipeline
metadata:
  name: my-app-pipeline
spec:
  sources:                          # Input artifacts
    - type: git
      name: source
      url: https://github.com/org/repo.git
  maxParallel: 2                    # Max concurrent steps
  steps:                            # Sequential build steps
    - name: build-image
      image: docker:latest
      script: |
        docker build -t my-app .
      timeout: 300
      retry: 2
    - name: run-tests
      image: golang:1.25
      script: go test ./...
      depends:                      # Wait for build-image
        - build-image
      timeout: 120
    - name: push-image
      image: docker:latest
      script: docker push my-app
      depends:
        - run-tests
  artifacts:                        # Output artifacts
    - name: image
      type: oci
      reference: my-app:latest</code></pre>

      <h2>Status</h2>
      <table>
        <thead>
          <tr><th>Field</th><th>Description</th></tr>
        </thead>
        <tbody>
          <tr><td><code>phase</code></td><td>Running, Succeeded, Failed</td></tr>
          <tr><td><code>stepStatuses[]</code></td><td>Per-step status (Pending, Running, Succeeded, Failed, Skipped), log reference, timing</td></tr>
          <tr><td><code>lastExecutionTime</code></td><td>Timestamp of last execution</td></tr>
          <tr><td><code>lastExecutionID</code></td><td>Unique ID for the last execution</td></tr>
        </tbody>
      </table>

      <h2>Step Lifecycle</h2>
      <ol>
        <li><strong>Pending</strong> — Step is queued, waiting for dependencies</li>
        <li><strong>Running</strong> — Kubernetes Job has been created and is running</li>
        <li><strong>Succeeded</strong> — Job completed with exit code 0</li>
        <li><strong>Failed</strong> — Job failed or timed out</li>
        <li><strong>Skipped</strong> — Step was skipped due to a dependency failure</li>
      </ol>
    </div>
  )
}
