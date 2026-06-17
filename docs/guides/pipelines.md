# Pipeline Workflows

Paprika's `Pipeline` CRD models CI-style workflows as Kubernetes resources. Pipelines run as a sequence of container steps, support dependencies and parallel execution, and can produce artifacts.

## Pipeline CRD

A minimal pipeline:

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Pipeline
metadata:
  name: my-app-build
  namespace: paprika-system
spec:
  maxParallel: 2
  steps:
    - name: build
      image: gcr.io/kaniko-project/executor:latest
      script: |
        /kaniko/executor --context . --destination my-registry/my-app:$TAG
    - name: test
      image: golang:1.23
      script: |
        go test ./...
      depends:
        - build
      timeout: 600
      retry: 2
    - name: sign
      image: cosign
      script: |
        cosign sign --key env://COSIGN_KEY my-registry/my-app:$TAG
      depends:
        - build
  artifacts:
    - name: binaries
      path: /out/bin
```

## Step Fields

| Field | Description |
|-------|-------------|
| `name` | Unique step name |
| `image` | Container image to run |
| `script` | Shell script executed inside the container |
| `depends` | List of step names that must complete before this step runs |
| `timeout` | Step timeout in seconds |
| `retry` | Number of retries on failure |

## Pipeline Execution

- Steps with no `depends` start immediately.
- Steps with dependencies run once all dependencies succeed.
- Up to `maxParallel` steps run concurrently.
- Failed steps can be retried up to `retry` times.
- Pipeline phase transitions: `Pending` → `Running` → `Succeeded` or `Failed`.

## Sources

Pipelines can checkout source repositories before running steps:

```yaml
spec:
  sources:
    - type: git
      url: https://github.com/example/my-app.git
      secretRef: git-creds
  steps:
    - name: build
      image: golang:1.23
      script: |
        cd /workspace/my-app
        go build ./cmd/my-app
```

## Artifacts

Artifacts are declared outputs that steps can write to a shared path:

```yaml
spec:
  steps:
    - name: build
      image: golang:1.23
      script: |
        go build -o /out/bin/my-app ./cmd/my-app
  artifacts:
    - name: binaries
      path: /out/bin
```

The operator captures the artifact path for downstream releases or pipelines.

## Full Example

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Pipeline
metadata:
  name: my-app-pipeline
  namespace: paprika-system
spec:
  maxParallel: 2
  sources:
    - type: git
      url: https://github.com/example/my-app.git
      secretRef: github-token
  steps:
    - name: lint
      image: golangci/golangci-lint:v1.60
      script: |
        golangci-lint run ./...

    - name: test
      image: golang:1.23
      script: |
        go test ./...
      depends:
        - lint
      timeout: 300
      retry: 1

    - name: build
      image: golang:1.23
      script: |
        CGO_ENABLED=0 go build -o /out/bin/my-app ./cmd/my-app
      depends:
        - test

    - name: push
      image: gcr.io/kaniko-project/executor:latest
      script: |
        /kaniko/executor --context . --destination my-registry/my-app:$GIT_SHA
      depends:
        - build
      timeout: 600

  artifacts:
    - name: binaries
      path: /out/bin
```

Apply and watch:

```sh
kubectl apply -f pipeline.yaml
kubectl get pipeline my-app-pipeline -n paprika-system -w
```

Inspect step statuses:

```sh
kubectl get pipeline my-app-pipeline -n paprika-system -o yaml
```

## Linking to an Application

Reference a pipeline from an `Application` or `Release` so promotions trigger or wait on pipeline completion:

```yaml
spec:
  build:
    steps:
      - name: build
        image: golang:1.23
        script: go build ./cmd/my-app
```

For reusable pipelines, set `spec.pipeline` on a `Release` or reference it from your Application logic as supported by the release controller.
