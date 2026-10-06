# Dev → Staging → Production Promotion

Use a separate `Application` for each environment, then connect them through
`spec.trigger.from`. Dev discovers changes through GitOps. Staging takes a
completed dev release, runs tests against dev, and deploys that release's Git
commit to its own cluster. Production takes a completed staging release and
waits for approval before deploying the same commit.

```text
Git change → dev Application → dev health + tests
                           → stg Application → stg health + approval
                                             → prod Application
```

All three Application records live on the Paprika management cluster. Each
Application has exactly one stage, whose `cluster` reference determines its
deployment target. The Applications can live in different management
namespaces and deploy to different workload namespaces or clusters. An
Application reference identifies another management-cluster Application;
it does not address a CR installed on a remote cluster.

## Choose a Trigger for Each Environment

`spec.trigger` controls how Paprika selects a deployment candidate.
`spec.syncPolicy` controls whether the selected candidate can deploy
automatically.

| Trigger | Candidate selection |
| --- | --- |
| `GitOps` | Discover changes from the configured source. |
| `Promotion` | Select the exact Git SHA from the referenced Application's completed release after upstream health, sync, and verification pass. |
| `Manual` | Discover a source candidate when an operator requests a sync. |

Omitting `spec.trigger` retains existing Application behavior. A promotion
chain uses `GitOps` plus `syncPolicy: Auto` in dev, `Promotion` plus
`syncPolicy: Auto` in staging, and `Promotion` plus `syncPolicy: Manual` in
production. Using `Manual` as the trigger chooses source-driven manual
deployment; use `Promotion` with manual sync policy when approval must remain
bound to an upstream release.

For a Promotion trigger, `from.name` is required. `from.namespace` defaults to
the downstream Application's namespace. Specify it explicitly for a reference
across namespaces:

```yaml
trigger:
  type: Promotion
  from:
    name: checkout
    namespace: pipeline-dev
```

Promotion initially supports `source.type: git`. The upstream and downstream
Applications must resolve to the same repository. They can use different
paths, inline Helm values, parameters, and target namespaces. Every downstream
render pins the upstream completed release's immutable commit SHA instead of
resolving its configured branch again. Keep that commit reachable in the
repository until dependent releases no longer need it.

Git pushes alone do not deploy a Promotion Application. A new candidate must
come from its upstream Application, and upstream progress or failed health,
sync, tests, or gates blocks that candidate. Drift detection and configured
self-healing operate against the accepted release's source identity, so a
repair does not silently deploy a newer branch head.

Paprika retains the accepted deployment settings in
`status.acceptedDeployment`. Changes to a downstream source path, values,
parameters, or cluster wait for the next promotion. An approved candidate
waiting on a sync window cannot redirect repairs of the existing release.
Editing a pending candidate's settings invalidates verification and expires
its manual approval, so review and approve the revised settings again.

Promotion requires a recent desired/live resource observation tied to the
exact upstream Release UID and revision. Custom health checks and analyses
must also pass after that deployment became Healthy. Missing or stale target
observations block promotion, including agent-only clusters without a direct
read transport.

Step retries run within the verification Pipeline. Once tests or an upstream
gate fail, that candidate stays failed; the currently accepted downstream
release remains in place. A different completed upstream release starts a
fresh candidate and verification run.

For cleanup, delete Applications with the default background cascade and wait
for their Releases to disappear before deleting their namespaces or cluster
credentials. An Application finalizer keeps its Stages available while Release
cleanup removes deployed workloads. Foreground cascades and namespace deletion
can remove Stage routing independently and leave Release cleanup waiting; durable
target routing in Releases is not yet recorded.

## Tests Before Promotion and Verification After Deployment

Put tests that qualify the upstream environment under `trigger.tests`. This
uses the same step definition as `spec.build`: container `image`, shell
`script`, step `depends`, `timeout` in seconds, and retry count. Paprika creates
a verification Pipeline for each upstream release. The Pipeline CR lives in
the downstream Application's namespace. Its Jobs run on the management cluster
in the operator's configured execution namespace, which can differ from the
Application namespace.

For staging, these tests run against dev before staging receives a release:

```yaml
trigger:
  type: Promotion
  from:
    name: checkout
    namespace: pipeline-dev
  tests:
    maxParallel: 1
    steps:
      - name: dev-smoke
        image: curlimages/curl:8.12.1
        script: |
          set -eu
          printf 'Verifying %s/%s release %s at %s\n' \
            "$PAPRIKA_PROMOTION_SOURCE_NAMESPACE" \
            "$PAPRIKA_PROMOTION_SOURCE_APPLICATION" \
            "$PAPRIKA_PROMOTION_SOURCE_RELEASE" \
            "$PAPRIKA_PROMOTION_REVISION"
          curl --fail --silent --show-error --max-time 10 \
            https://checkout-dev.example.com/healthz
        timeout: 60
        retry: 2
```

Each verification step receives these environment variables:

| Variable | Value |
| --- | --- |
| `PAPRIKA_PROMOTION_REVISION` | Exact upstream release Git commit SHA. |
| `PAPRIKA_PROMOTION_SOURCE_APPLICATION` | Upstream Application name. |
| `PAPRIKA_PROMOTION_SOURCE_NAMESPACE` | Upstream Application's management-cluster namespace. |
| `PAPRIKA_PROMOTION_SOURCE_RELEASE` | Upstream Release name. |

These describe the candidate and contain no credentials. The workflow engine
currently does not check out `tests.sources`. Probe the deployed upstream
environment, as this example does, or have the test script explicitly clone
the repository and check out `PAPRIKA_PROMOTION_REVISION`. Choose a container
image with Git and the required test tools when running source-based tests.

Use `trigger.gates` for controller-executed checks of the upstream environment.
`smoke-test` performs an HTTP GET and requires a 2xx response; `timeout` is its
request timeout in seconds. `duration` waits for `timeout` seconds. These
checks must be reachable from the management cluster. A remote cluster's
`*.svc.cluster.local` address normally cannot be used from the management
cluster; use an appropriate reachable endpoint.

After deployment, the target Application retains its normal stage strategy,
canary analysis, approval gates, and verification gates. Put checks of the
newly deployed environment in `stages[].gates`. For tests that must execute
inside the target cluster, include a Job annotated
`argocd.argoproj.io/hook: PostSync` in its source manifests. PostSync hook Jobs
run through the target stage's deployment transport, and a failed hook prevents
that release from qualifying for downstream promotion. See
[operations](operations.md) for hook behavior and
[multi-cluster orchestration](multi-cluster.md) for target transport support.

## Complete Example

The [sample manifest](../../config/samples/pipelines_v1alpha1_environment_promotion.yaml)
defines `checkout` Applications in `pipeline-dev`, `pipeline-stg`, and
`pipeline-prod`. Each has one inline stage referencing its own Cluster:
`dev-cluster`, `stg-cluster`, and `prod-cluster` in `paprika-system`.
Paprika creates the corresponding Stage and Release resources; no separate
Stage manifest is needed.

Before applying it:

- Install CRDs and a controller containing Application trigger support.
- Register the three Cluster resources. For remote clusters, provide direct
  deployment credentials with the permissions needed by the application and
  hooks. See [multi-cluster orchestration](multi-cluster.md).
- Provision the workload namespaces `checkout-dev`, `checkout-stg`, and
  `checkout-prod` on their respective target clusters.
- Replace the sample repository and paths with Helm charts in one repository.
  Ensure all three paths exist at each commit that dev can promote.
- Replace the example HTTP endpoints with endpoints reachable by the
  management cluster, and supply namespace-local Git credentials if needed.

Render or review the customized manifests, then apply them to the intended
management cluster. Confirm the context before the write and inspect its
result:

```sh
kubectl config current-context
kubectl apply -f config/samples/pipelines_v1alpha1_environment_promotion.yaml
kubectl get application -n pipeline-dev checkout -o yaml
kubectl get application -n pipeline-stg checkout -o yaml
kubectl get application -n pipeline-prod checkout -o yaml
```

Dev deploys from its Git branch. When dev's release completes and is healthy
and synced, staging verifies it and deploys that commit. Production verifies
the completed staging candidate and waits for approval.

Inspect promotion state and the test Pipeline:

```sh
kubectl -n pipeline-stg get application checkout -o json \
  | jq '{phase: .status.phase, health: .status.health, promotion: .status.promotion}'
kubectl -n pipeline-stg get pipelines
kubectl -n pipeline-prod get application checkout -o json \
  | jq '.status.promotion'
```

Inspect test Jobs and their logs in the operator's configured execution
namespace; listing Pods in `pipeline-stg` will not find Jobs that execute in a
different namespace.

Promotion status records the upstream Application and Release identities, the
Git revision, verification Pipeline reference, phase, and diagnostic message.
Use the candidate's `sourceReleaseUID` to approve production after reviewing
the upstream release and verification results:

```sh
paprika_candidate_uid="$(kubectl -n pipeline-prod get application checkout \
  -o jsonpath='{.status.promotion.sourceReleaseUID}')"
test -n "$paprika_candidate_uid"
kubectl config current-context
kubectl -n pipeline-prod annotate application checkout \
  "paprika.io/promote=$paprika_candidate_uid" --overwrite
kubectl -n pipeline-prod get application checkout -o yaml
```

The annotation approves only that upstream Release UID. A replacement
candidate needs its own approval; a generic sync annotation does not approve
an unreviewed upstream version. Promotion verification and the target's native
release approval gates still apply.

## Keep Environment Configuration Explicit

Promotion carries a Git revision, not upstream Helm overrides or build output.
Each downstream Application keeps its own `source.path`, `source.valuesFile`,
`source.targetNamespace`, `parameters`, and stage parameters. This allows
environment-specific replica counts, secrets, ingress, and delivery strategy
without copying dev settings into production.

Commit shared immutable image digests into the promoted Git source, or supply
explicit per-environment image parameters. Promoting a Git SHA does not
automatically promote an image built by `spec.build` or a Pipeline artifact,
and a mutable image tag can refer to different bytes in each environment even
when the Git revision is identical.

## Focused Kind Validation

The [ApplicationPromotion E2E spec](../../test/e2e/promotion_test.go) exercises
the dev → staging → production chain against a real Git HTTP backend and an
additional Kind deployment target. Use the dedicated `paprika-test-e2e`
management cluster and `paprika-promotion-target` workload cluster.
Docker, Kind, kubectl, Go, and
Helm must be installed; run these commands from the repository root.

It covers cross-namespace and cross-cluster promotion, real verification Jobs,
HTTP gates, fresh candidate-specific approval for each new upstream release,
failed verification, and pinned downstream renders as Git advances. It also
verifies normal background Application deletion drains remote Releases and
workloads while Stage routing and cluster credentials remain available.

The suite installs cert-manager when absent so admission webhooks are tested.
It also deploys and later removes Paprika and its CRDs on the management
cluster. Keep these clusters dedicated to tests. Existing Kind clusters are
reused, so no cluster creation is needed on a second run.

Use separate temporary kubeconfigs for the two clusters. The target's internal
kubeconfig addresses its control-plane container from the management cluster;
the host kubeconfig addresses the published API port for test assertions:

```sh
(
  set -eu
  paprika_promotion_work="$(mktemp -d)"
  chmod 700 "$paprika_promotion_work"
  trap 'rm -rf "$paprika_promotion_work"' EXIT
  export KUBECONFIG="$paprika_promotion_work/management.yaml"

  paprika_kind_clusters="$(kind get clusters)"
  if ! printf '%s\n' "$paprika_kind_clusters" | rg -qx paprika-test-e2e; then
    kind create cluster --name paprika-test-e2e --kubeconfig "$KUBECONFIG"
  else
    kind get kubeconfig --name paprika-test-e2e > "$KUBECONFIG"
  fi
  kubectl config current-context
  test "$(kubectl config current-context)" = kind-paprika-test-e2e

  if ! printf '%s\n' "$paprika_kind_clusters" | rg -qx paprika-promotion-target; then
    kind create cluster --name paprika-promotion-target \
      --kubeconfig "$paprika_promotion_work/target-host.yaml"
  else
    kind get kubeconfig --name paprika-promotion-target \
      > "$paprika_promotion_work/target-host.yaml"
  fi
  kind get kubeconfig --name paprika-promotion-target --internal \
    > "$paprika_promotion_work/target-internal.yaml"
  chmod 600 "$paprika_promotion_work/"*.yaml
  kubectl --kubeconfig "$paprika_promotion_work/target-host.yaml" config current-context
  test "$(kubectl --kubeconfig "$paprika_promotion_work/target-host.yaml" config current-context)" \
    = kind-paprika-promotion-target

  # Match the native Kind node architecture; VKE images remain linux/amd64.
  paprika_e2e_arch="$(kubectl get nodes \
    -o jsonpath='{.items[0].status.nodeInfo.architecture}')"
  paprika_e2e_platform="linux/$paprika_e2e_arch"
  paprika_e2e_image="paprika-local:promotion-$(date -u +%Y%m%dT%H%M%SZ)"
  docker buildx build -f Dockerfile.fast --platform "$paprika_e2e_platform" \
    --load -t "$paprika_e2e_image" \
    --build-arg VERSION="$(git describe --tags --always --dirty)" \
    --build-arg GIT_COMMIT="$(git rev-parse HEAD)" \
    --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" .

  # Export only the node's platform; Docker Desktop image indexes can contain
  # attestations or other platforms that Kind's containerd import cannot find.
  docker save --platform "$paprika_e2e_platform" "$paprika_e2e_image" \
    -o "$paprika_promotion_work/manager.tar"
  kind load image-archive "$paprika_promotion_work/manager.tar" \
    --name paprika-test-e2e

  # The fixture deploys the demo workload to both clusters and runs tests in Alpine.
  docker buildx build --platform "$paprika_e2e_platform" --load \
    -t localhost/paprika-demo:latest -f demo/Dockerfile demo
  docker save --platform "$paprika_e2e_platform" localhost/paprika-demo:latest \
    -o "$paprika_promotion_work/demo.tar"
  kind load image-archive "$paprika_promotion_work/demo.tar" --name paprika-test-e2e
  kind load image-archive "$paprika_promotion_work/demo.tar" --name paprika-promotion-target
  docker pull --platform "$paprika_e2e_platform" alpine:3.19
  docker save --platform "$paprika_e2e_platform" alpine:3.19 \
    -o "$paprika_promotion_work/alpine.tar"
  kind load image-archive "$paprika_promotion_work/alpine.tar" --name paprika-test-e2e
  docker pull --platform "$paprika_e2e_platform" castlemilk/git-http-backend

  E2E_MANAGER_IMAGE="$paprika_e2e_image" \
  E2E_EXPECTED_CONTEXT=kind-paprika-test-e2e \
  E2E_TARGET_EXPECTED_CONTEXT=kind-paprika-promotion-target \
  E2E_SKIP_IMAGE_BUILD=true E2E_SKIP_IMAGE_LOAD=true \
  E2E_SKIP_METRICS_SERVER=true \
  E2E_PROMOTION_REMOTE_KUBECONFIG="$paprika_promotion_work/target-internal.yaml" \
  E2E_PROMOTION_REMOTE_KUBECTL_KUBECONFIG="$paprika_promotion_work/target-host.yaml" \
  go test -tags=e2e ./test/e2e/ -run '^TestE2E$' -count=1 \
    -v -ginkgo.v -ginkgo.focus=ApplicationPromotion -ginkgo.fail-on-empty \
    -timeout=30m
)
```

The fixture imports the Git backend through a platform-limited image archive.
Verification Jobs run on the management cluster in `alpine:3.19`. The demo
image must be loaded into both clusters. The image skip flags avoid rebuilding
the full UI image and repeating the suite's image imports after the explicit
platform-limited imports above. The suite still installs the current generated
CRDs and deploys the selected `E2E_MANAGER_IMAGE`, so the focused run verifies
the code under development. Metrics-server is optional for this focused spec;
remove `E2E_SKIP_METRICS_SERVER=true` when running specs that require metrics.

Both target kubeconfig variables are needed on Docker Desktop: the internal
address is reachable by Paprika's controller, while the host address is
reachable by the test process. Supplying only
`E2E_PROMOTION_REMOTE_KUBECONFIG` makes the fixture also use that file for host
CLI operations, which is suitable only when that endpoint is reachable from
both places. The context guard refuses mutations outside the dedicated Kind
contexts, including `kind-deephost`.

The fixture reaches remote staging and production probes through the target
node's InternalIP and NodePorts 30587 and 30588 on the shared Docker Kind
network. If that staging address requires a different route in your local
setup, set `E2E_PROMOTION_REMOTE_PROBE_URL` to an equivalent endpoint reachable
by the management cluster.

The fixture removes its resources, and the suite removes Paprika from the
management cluster. Pre-existing clusters remain available for another run;
delete only these dedicated clusters when they are no longer needed:

```sh
kind delete cluster --name paprika-promotion-target
kind delete cluster --name paprika-test-e2e
```
