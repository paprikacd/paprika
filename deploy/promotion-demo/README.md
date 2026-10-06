# Live promotion demo on the Vultr management cluster

This creates only `paprika-promotion-dev`, `paprika-promotion-stg`, and
`paprika-promotion-prod`. Each namespace owns one public Repository reference,
a Project restricted to that namespace and three workload kinds, and one
Application. Dev discovers the immutable `v0.3.0` tag through GitOps. Staging
runs two real HTTP verification Jobs against dev, then promotes automatically.
Production verifies staging and waits for approval of its exact Release UID.
Both downstream environments also use controller HTTP and five-second duration
gates. Every deployed environment has its own HTTP health check and stage gate.
Each local stage waits 30 seconds before its HTTP gate, allowing the new Service
DNS record and small workload to start. The HTTP gate still fails closed.

The chart path is `config/samples/promotion-demo` in the public
`https://github.com/paprikacd/paprika.git` repository. Each environment overrides
its own Helm values and target namespace. All workloads use the same pinned
amd64 image, request 10m CPU / 8Mi memory, and expose only a ClusterIP Service.
No public DNS, Ingress, NodePort, credentials, or production workload edits are
needed. Pipeline Jobs use the same tiny image, run serially with 30-second step
timeouts, and execute in Paprika's configured operator namespace. The Pipeline
step API does not support per-step resource requests; existing operator-namespace
LimitRanges apply. The Application/Pipeline CRs remain in their environment
namespaces.

## Prepare and apply

Run from this repository root after upgrading the Vultr Paprika installation
to official `v0.3.1`, including its CRDs and API server. The demo workload source
remains pinned to `v0.3.0` to test operator recovery without changing its payload.
The operator and its Job namespace must be able to reach the internal Service
HTTP endpoints and the public Git/image registries. If the optional Paprika
NetworkPolicy is enabled, check that it permits this namespace traffic first.

Set the two variables from the inspected live installation; the verifier refuses
to run against a different current context. Use the namespace configured for
Pipeline Job execution, which can differ from the Application namespaces.

```sh
export PAPRIKA_DEMO_CONTEXT='<confirmed omega-ha Vultr context>'
export PAPRIKA_OPERATOR_NAMESPACE='<Paprika operator Job execution namespace>'
paprika_demo_sha="$(git ls-remote https://github.com/paprikacd/paprika.git \
  refs/tags/v0.3.0 'refs/tags/v0.3.0^{}' | awk '/\^\{\}$/ {peeled=$1} !/\^\{\}$/ {tag=$1} END {print peeled ? peeled : tag}')"
test "${#paprika_demo_sha}" -eq 40
helm lint config/samples/promotion-demo
helm template promotion-demo config/samples/promotion-demo \
  --namespace paprika-promotion-dev --set environment=dev
kubectl config current-context
test "$(kubectl config current-context)" = "$PAPRIKA_DEMO_CONTEXT"
kubectl apply -f deploy/promotion-demo/bootstrap.yaml
kubectl get namespace paprika-promotion-dev paprika-promotion-stg paprika-promotion-prod
kubectl config current-context
test "$(kubectl config current-context)" = "$PAPRIKA_DEMO_CONTEXT"
kubectl apply -f deploy/promotion-demo/applications.yaml
kubectl -n paprika-promotion-dev get application promotion-demo -o yaml
```

Allow dev to become Healthy, staging to pass its Jobs and become Healthy, and
production to reach `AwaitingApproval`. Run the read-only assertion script;
retry while the chain is still converging:

```sh
deploy/promotion-demo/verify.sh awaiting-approval "$paprika_demo_sha"
```

It verifies both upstream Release/Application UID references, identical Git SHA,
completed owned Releases, fresh live resource observations, resource/HTTP health,
zero drift, two successful Pipeline steps and their real Jobs, and absence of
production workloads. Inspect step logs in the operator execution namespace:

```sh
paprika_demo_pipeline="$(kubectl -n paprika-promotion-prod get application promotion-demo \
  -o jsonpath='{.status.promotion.verificationPipelineRef}')"
kubectl -n "$PAPRIKA_OPERATOR_NAMESPACE" get jobs,pods \
  -l "paprika.io/pipeline=$paprika_demo_pipeline"
# Use a Job name from that list:
kubectl -n "$PAPRIKA_OPERATOR_NAMESPACE" logs job/<job-name>
```

## Approve production and verify

```sh
paprika_demo_candidate="$(kubectl -n paprika-promotion-prod get application promotion-demo \
  -o jsonpath='{.status.promotion.sourceReleaseUID}')"
test -n "$paprika_demo_candidate"
test "$(kubectl -n paprika-promotion-prod get application promotion-demo \
  -o jsonpath='{.status.promotion.phase}')" = AwaitingApproval
kubectl config current-context
test "$(kubectl config current-context)" = "$PAPRIKA_DEMO_CONTEXT"
kubectl -n paprika-promotion-prod annotate application promotion-demo \
  "paprika.io/promote=$paprika_demo_candidate" --overwrite
kubectl -n paprika-promotion-prod get application promotion-demo -o yaml
# Retry while production is deploying:
deploy/promotion-demo/verify.sh complete "$paprika_demo_sha"
```

For a direct final HTTP check without exposing a public endpoint, run
`kubectl -n paprika-promotion-prod port-forward service/promotion-demo 19080:80`,
then in another terminal run:

```sh
test "$(curl -fsS http://127.0.0.1:19080/healthz)" = ok
test "$(curl -fsS http://127.0.0.1:19080/environment)" = prod
test "$(curl -fsS http://127.0.0.1:19080/version)" = v0.3.0
```

Keep the `v0.3.0` tag immutable. The resolved commit SHA is pinned into promoted
Templates; environment values stay independent. A later release can be tested
by changing dev's source revision to another immutable tag that contains this
chart, then reviewing and approving the resulting new production candidate.

## Retry a failed promotion attempt

If deployment-stage verification fails after admission, retry the already
accepted Release with manual sync. Paprika v0.3.1 tracks that same Release back
to `Promoting` and `Complete` after checking its ownership and promotion
provenance. Pending desired edits remain frozen until a new verified promotion.
The consumed exact-UID approval still authorizes this accepted deployment.

```sh
kubectl config current-context
test "$(kubectl config current-context)" = "$PAPRIKA_DEMO_CONTEXT"
paprika_demo_retry="$(date +%s)"
kubectl -n paprika-promotion-stg annotate application promotion-demo \
  "paprika.io/sync=$paprika_demo_retry" "paprika.io/manual-sync=$paprika_demo_retry" --overwrite
kubectl -n paprika-promotion-stg get application promotion-demo -o yaml
```

A failure before admission, such as a failed upstream verification Job, remains
latched for that candidate. Advance to a new upstream Release UID to start a
fresh verified attempt. Do not patch promotion status or reuse an old approval.

For this demo, select a previously unused `promotionAttempt` parameter on dev.
The demo chart ignores this Helm value, so workload manifests and the pinned
Git commit stay the same; Paprika creates a new owned Release identity. The
example uses `2`; choose another unused value for subsequent attempts.

```sh
kubectl config current-context
test "$(kubectl config current-context)" = "$PAPRIKA_DEMO_CONTEXT"
kubectl -n paprika-promotion-dev patch applications.pipelines.paprika.io promotion-demo \
  --type=merge -p '{"spec":{"parameters":{"promotionAttempt":"2"}}}'
kubectl -n paprika-promotion-dev get applications.pipelines.paprika.io promotion-demo -o yaml
# Wait for fresh dev and staging Releases, then repeat the pre-approval checks:
deploy/promotion-demo/verify.sh awaiting-approval "$paprika_demo_sha"
```

Approve the new staging Release UID using the earlier commands. Staging reruns
its HTTP verification Jobs, and production requires a new exact-UID approval.

## Scoped cleanup

Delete each Application with background cascade and wait for it to disappear
before removing its namespace. This retains Stage routing until Release cleanup
finishes. Do not strip finalizers or begin with namespace deletion.

```sh
for paprika_demo_env in prod stg dev; do
  kubectl config current-context
  test "$(kubectl config current-context)" = "$PAPRIKA_DEMO_CONTEXT"
  kubectl -n "paprika-promotion-$paprika_demo_env" delete application promotion-demo \
    --cascade=background --wait=true --timeout=180s
  kubectl -n "paprika-promotion-$paprika_demo_env" get releases.pipelines.paprika.io,deployments,services,configmaps
  # Confirm owned Releases and demo workloads are gone before the namespace write.
  kubectl config current-context
  test "$(kubectl config current-context)" = "$PAPRIKA_DEMO_CONTEXT"
  kubectl delete namespace "paprika-promotion-$paprika_demo_env" --wait=true --timeout=180s
done
```

Verification Jobs execute in the operator namespace and are not collected with
the environment namespace. Remove only Jobs selected by the recorded demo
Pipeline names after retaining their logs, and inspect the result of each write.
