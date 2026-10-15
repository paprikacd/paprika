# Gateway-only Helm add-on

Use a separate add-on release when the existing Paprika release is newer than
the source chart being reviewed. Upgrading that main release from an older
checkout could remove resources or downgrade controllers. The add-on preserves
the existing main release and has its own Helm history and rollback path.

`hack/render-observability-addon.sh` performs local rendering only. It reads the
existing gateway Deployment, Service, NetworkPolicy and shared Helm helpers from
`charts/chart`, then freezes their rendered bytes into a standalone chart. There
is no second maintained gateway chart. The output contains no RBAC,
ServiceAccount, Secret or CRD; those prerequisites require separate approval.

Prepare a **nonsecret** values file with authentication configuration, an explicit
existing `observabilityGateway.serviceAccountName`, and existing Secret
references in `observabilityGateway.extraEnv`. Never export live secret values
or a whole release's potentially sensitive Helm values into this workflow.
The source gateway's normal authentication prerequisites still apply.

```sh
bash hack/render-observability-addon.sh \
  --namespace paprika-system \
  --release paprika-observe \
  --context "$VERIFIED_GKE_CONTEXT" \
  --image "ghcr.io/paprikacd/paprika@sha256:$VERIFIED_IMAGE_DIGEST" \
  --values /path/to/nonsecret-observe-values.yaml \
  --output-dir /path/to/new-observe-render
```

Repeat `--values` for additional nonsecret overlays, in precedence order. The
helper requires a new output directory so earlier evidence is preserved. It
forces unique add-on resource names/selectors, a ClusterIP service, a
NetworkPolicy, and disabled service autodiscovery. It allows only the fixed
gateway listener, connection limits and loopback profiling arguments. It rejects
mutable image references, inline authentication credentials and extra containers.

Public routing is absent even when a supplied values file enables ingress.
Only `--include-route` adds an HTTPRoute, using the source chart's normal Gateway
reference and hostname values. Public routing requires approval of the exact
paths and target; selecting the rendering flag does not grant that approval.

Review `manifests.yaml`, `provenance.json` and `chart/Chart.yaml` before installing.
Provenance records the Git commit, whether the source worktree was dirty, hashes
of source templates, input values and the frozen manifests, and the exact image
digest. A dirty render is explicitly identified; the helper does not attest
that an image was built from that commit. Verify the image's build identity
against the tested source commit during deployment preparation.

The helper prints a concrete `helm install` command with `--kube-context`,
`--atomic`, `--wait` and a bounded timeout, but never executes it. At actual
deployment time, run `kubectl config current-context` and compare the result to
the approved context. Keep the explicit `--kube-context` on Helm and `--context`
on every Kubernetes write. Confirm the existing namespace, approved identity,
provider-read permissions and image digest immediately before installation.

The generated chart refuses another release name or namespace. For subsequent
updates, render a new artifact and use the same add-on release with
`helm upgrade --atomic --wait`, retaining both artifacts and its previous Helm
revision. Verify the deployed image digest and rollout readiness. Use
`helm rollback ADDON_RELEASE PREVIOUS_REVISION --kube-context VERIFIED_CONTEXT
--namespace NAMESPACE --wait --timeout 5m` for an upgrade rollback; for a first
installation, `--atomic` removes an unsuccessful add-on installation. These
operations apply only to the separate add-on release.

Offline boundary tests use synthetic values and allow only `helm template`:

```sh
bash hack/test-observability-addon-rendering.sh
```
