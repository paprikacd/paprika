# Pipeline Workflows

Paprika's `Pipeline` CRD runs configured container steps as Kubernetes Jobs.
Declare dependencies between steps, bound concurrent execution, and inspect
each step's outcome. A Pipeline is optional for application delivery.

The current executor creates an isolated Job for each step. It does not
automatically check out `spec.sources`, share a filesystem between steps,
inject build variables such as `GIT_SHA` or `TAG`, or upload files declared
as artifacts. The examples below make source checkout and output handling
explicit. These behaviours follow the
[workflow executor](../../internal/engine/workflow.go).

For deployments across environments, see
[Dev → Staging → Production Promotion](environment-promotion.md). Promotion
connects separate Applications through `spec.trigger.from`; it selects a
completed upstream revision and can run verification Pipelines before
admitting a downstream Release.

## Run a dependency example

This complete example checks Job execution, shell commands and a writable
temporary directory. It does not test or deploy an application. The two
checks depend on `prepare`; `finish` waits for both checks.

Save it as `pipeline.yaml`. The namespace must already exist, and the
controller and cluster must be able to pull the selected images.

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Pipeline
metadata:
  name: pipeline-demo
  namespace: paprika-system
spec:
  maxParallel: 2
  steps:
    - name: prepare
      image: alpine:3.19
      script: |
        set -eu
        printf 'Starting dependency checks\n'
      timeout: 30
    - name: check-shell
      image: alpine:3.19
      depends:
        - prepare
      script: |
        set -eu
        test "$(printf '%s' ready)" = ready
      timeout: 30
    - name: check-storage
      image: alpine:3.19
      depends:
        - prepare
      script: |
        set -eu
        paprika_step_dir="$(mktemp -d /tmp/paprika-check.XXXXXX)"
        trap 'rm -rf "$paprika_step_dir"' EXIT
        printf '%s' ready > "$paprika_step_dir/result"
        test "$(cat "$paprika_step_dir/result")" = ready
      timeout: 30
    - name: finish
      image: alpine:3.19
      depends:
        - check-shell
        - check-storage
      script: |
        set -eu
        printf 'Both dependency checks completed\n'
      timeout: 30
```

Review the selected cluster before applying the Pipeline:

```sh
kubectl config current-context
kubectl apply -f pipeline.yaml
kubectl -n paprika-system get pipeline pipeline-demo -w
```

Inspect individual step outcomes:

```sh
kubectl -n paprika-system get pipeline pipeline-demo -o json \
  | jq '{phase: .status.phase, steps: .status.stepStatuses, artifacts: .status.artifactRefs}'
```

## Step fields and execution

| Field | Meaning |
| --- | --- |
| `name` | Unique step name. |
| `image` | Container image containing the required shell and tools. |
| `script` | Commands executed through `sh -c`. |
| `depends` | Step names that must succeed before this step executes. |
| `timeout` | Job deadline in seconds; the executor uses 3,600 when unset or non-positive. |
| `retry` | Additional attempts after a step fails. Each attempt gets a new Job. |
| `outputs` | Declared output references for a standalone Pipeline step; see Artifacts below. |

The executor resolves dependencies into batches and runs up to
`maxParallel` steps concurrently within a batch. It defaults to 10 when
`maxParallel` is unset or non-positive. Dependencies do not transfer files
or environment variables. A failed prerequisite does not qualify a dependent
step to run.

Pipeline phases are `Running`, `Succeeded`, `Failed` and `Cancelled`. Step
statuses additionally include `Pending` and `Skipped`; read the step list
when diagnosing a run rather than relying on the Pipeline phase alone.
The [Pipeline API types](../../api/pipelines/v1alpha1/pipeline_types.go)
define these fields and states.

Jobs run on the management cluster in the operator's configured execution
namespace, which can differ from the Pipeline's namespace. The executor
runs containers as non-root UID 1000 with privilege escalation disabled,
all capabilities dropped and `RuntimeDefault` seccomp. Use images whose
tools work under those settings. Write temporary files under a writable
path such as `/tmp`; do not assume a root-owned image working directory is
writable.

## Check out source explicitly

`spec.sources` exists in the API, but the workflow executor does not consume
it. Setting `sources[].secretRef` therefore does not provision a checkout or
inject Git credentials. There is no automatic `/workspace/<repository>`
directory.

This example explicitly fetches a fixed public Paprika commit and runs its
resource-health tests. It keeps checkout and tests in one Job and puts Go
caches in a writable temporary directory. It requires outbound access to
GitHub, the Go module proxy and any dependency endpoints used by that
revision. Adapt the repository, revision and test command to your project;
select a container image that includes Git and its required toolchain.

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Pipeline
metadata:
  name: paprika-health-tests
  namespace: paprika-system
spec:
  maxParallel: 1
  steps:
    - name: test
      image: golang:1.26.4
      script: |
        set -eu
        paprika_revision=9f6e983269cee72fc7c88ed09cd5a0edc60a3ddb
        paprika_source_dir="$(mktemp -d /tmp/paprika-source.XXXXXX)"
        trap 'rm -rf "$paprika_source_dir"' EXIT
        export GOCACHE="$paprika_source_dir/go-build"
        export GOMODCACHE="$paprika_source_dir/go-mod"
        git init "$paprika_source_dir/source"
        cd "$paprika_source_dir/source"
        git remote add origin https://github.com/paprikacd/paprika.git
        git fetch --depth 1 origin "$paprika_revision"
        git checkout --detach FETCH_HEAD
        test "$(git rev-parse HEAD)" = "$paprika_revision"
        go test ./internal/health -count=1
      timeout: 900
      retry: 1
```

The commit pins the source used by this example; it is not a moving
recommendation for the latest Paprika release. Review the
[referenced source](https://github.com/paprikacd/paprika/tree/9f6e983269cee72fc7c88ed09cd5a0edc60a3ddb)
when reproducing it. For a private repository, the execution environment
needs an explicitly supported authentication mechanism; do not put tokens
in the script or assume `sources[].secretRef` is connected to the Job.

For promotion verification, Paprika supplies `PAPRIKA_PROMOTION_REVISION`
and the source Application/Release identity to the verification scripts.
Those are specific to the promotion flow, not generic build variables.
See [promotion verification](environment-promotion.md#tests-before-promotion-and-verification-after-deployment)
for its supported inputs.

## Artifacts

Output declarations are references to artifacts that your configured tools
must produce. The Pipeline controller creates corresponding `Artifact`
records and reports their verification state in `status.artifactRefs`.
Declaring an OCI path does not build or push a container image, and an
`/out` file in one Job does not appear in another Job.

The supported reference forms are:

| Form | Meaning |
| --- | --- |
| `oci://<registry>/<repository>:<tag>` | An OCI artifact reference. Use a controlled immutable tag or digest for reproducibility. |
| `oci://<registry>/<repository>@sha256:<digest>` | A digest-pinned OCI artifact reference. |
| `configmap://<name>[/<key>]` | A ConfigMap reference handled by the artifact controller. |

For example, after a publishing step produces an image, declare its exact
reference. This is a spec fragment; replace the repository and digest with
the output of your own publishing process before use:

```yaml
spec:
  artifacts:
    - name: image
      step: build-and-publish
      path: oci://registry.example.com/team/checkout@sha256:<actual-image-digest>
```

The `path` field is stored as a literal reference. A string containing
`$TAG` is not expanded from a step's shell environment. Supply the resolved
reference when constructing the Pipeline, and inspect the resulting
`Artifact` and `status.artifactRefs`. The
[Pipeline artifact reconciliation](../../internal/controller/pipelines/pipeline_controller.go)
is the source of truth for this behaviour.

If another step needs a build output, explicitly publish it to an appropriate
store and fetch it in that step, or keep the dependent commands together in
one script. Authentication and permissions for those tools must be configured
for the actual Job environment. The current `PipelineStep` API does not
expose per-step environment or volume-mount fields.

## Inspect Jobs and logs

Use the configured execution namespace, not automatically the Pipeline
namespace. In this example both happen to be `paprika-system`:

```sh
kubectl -n paprika-system get jobs \
  -l paprika.io/pipeline=pipeline-demo,paprika.io/pipeline-namespace=paprika-system
kubectl -n paprika-system get pods \
  -l paprika.io/pipeline=pipeline-demo,paprika.io/pipeline-namespace=paprika-system
```

Select a returned Job name and read its logs:

```sh
kubectl -n paprika-system logs job/REPLACE_WITH_RETURNED_JOB_NAME
```

A retry creates a fresh Job. Inspect the attempt relevant to the failing
step; several Jobs can share the same Pipeline and step labels.

## Add a build to an Application

An Application's `spec.build` defines steps for its owned Pipeline. Include
the complete source preparation in the script, as in the explicit checkout
example above. Set `build.maxParallel` and `build.artifacts` when needed.
Paprika records the owned Pipeline name in `status.pipelineRef` and checks
its outcome during the Application lifecycle.

There is no general `spec.pipeline` field on a Release for attaching an
arbitrary existing Pipeline. Use the supported Application build or
promotion verification configuration. The
[Application controller](../../internal/controller/pipelines/application_controller.go)
and [Application API](../../api/pipelines/v1alpha1/application_types.go)
define that contract.
