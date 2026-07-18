# Fleet admin dashboard validation and rollout

The fleet admin dashboard is a loopback-only, Kubernetes-reviewed operational
path. It does not weaken the normal public or pod-forwarded Paprika
authentication path. Use it only from a trusted workstation and only against a
namespace whose pod-creation boundary is restricted to trusted platform
operators.

> **Security warning:** `pods/portforward` permission to an eligible
> admin-enabled Paprika pod grants unrestricted Paprika administration for the
> reviewed session. The CLI prints this exact warning:
>
> `Warning: exact pod port-forward permission grants unrestricted Paprika administration. This workflow trusts the namespace pod-creation boundary; use it only where pod creation is restricted to trusted platform operators.`

## Local mocked validation

The local gate compiles the real UI and Go fixture server, serves deterministic
mocked Kubernetes fleet objects, and runs the desktop/mobile fleet and admin
acceptance specs:

```bash
rtk bash hack/test-fleet-console.sh
rtk bash hack/test-admin-dashboard-helm.sh
```

This path does not require a cluster. It verifies fleet scope, every application
presentation, delivery views, admin-session UI state, runtime request auditing,
and the chart's port-3001 isolation.

## Open a reviewed dashboard

Build the CLI, confirm the exact permission, and start a random-port,
non-opening JSON session:

```bash
rtk make build-cli
REVIEWED_CONTEXT="$(
  rtk kubectl --kubeconfig=terraform/omega-oidc.kubeconfig config current-context
)"
rtk kubectl --kubeconfig=terraform/omega-oidc.kubeconfig \
  --context="$REVIEWED_CONTEXT" auth can-i create pods/portforward -n paprika-e2e
rtk proxy ./bin/paprika --output=json admin dashboard \
  --kubeconfig terraform/omega-oidc.kubeconfig \
  --context "$REVIEWED_CONTEXT" \
  --namespace paprika-e2e \
  --release paprika-e2e \
  --port 0 \
  --no-open \
  --timeout 60s
```

Keep stdout and stderr separate in automation. Stdout emits exactly one JSON
object when the proxy is ready:

```json
{
  "context": "<reviewed-context>",
  "namespace": "paprika-e2e",
  "pod": "paprika-e2e-api-server-...",
  "url": "http://127.0.0.1:49152/dashboard/",
  "subject": "reviewed-kubernetes-subject",
  "sessionExpiry": "2026-07-19T12:00:00Z",
  "accessMode": "kubernetes-port-forward-admin"
}
```

The object has exactly `context`, `namespace`, `pod`, `url`, `subject`,
`sessionExpiry`, and `accessMode`. The URL must use `127.0.0.1`, and the
subject/access mode describe the reviewed session. It never includes the
Kubernetes credential, Authorization header, or opaque admin-session header.
Do not print process environments or kubeconfig contents while automating it.

Use `--port 0` for a fresh browser origin. If a fixed `--port` is necessary,
clear trusted-origin storage and service-worker state before reusing that
origin for another cluster.

Stop the foreground CLI with `Ctrl-C` or `SIGTERM`. Shutdown revokes the
session, closes the hidden Kubernetes forward, and stops the loopback proxy.
Closing only the browser does not stop or revoke the session. If shutdown
reports a revoke failure, do not reuse the origin; remove the process, verify
the forward is gone, and investigate the selected pod before trying again.

## Live release gate

The real harness owns an isolated run namespace and requires all inputs
explicitly:

```bash
REVIEWED_CONTEXT="$(
  rtk kubectl --kubeconfig=terraform/omega-oidc.kubeconfig config current-context
)"
rtk proxy env \
  FLEET_ADMIN_KUBECONFIG=terraform/omega-oidc.kubeconfig \
  FLEET_ADMIN_CONTEXT="$REVIEWED_CONTEXT" \
  FLEET_ADMIN_TARGET_NAMESPACE=paprika-e2e \
  FLEET_ADMIN_TARGET_RELEASE=paprika-e2e \
  FLEET_ADMIN_PUBLIC_URL=https://paprika.benebsworth.com \
  FLEET_ADMIN_ARTIFACT_ROOT=artifacts/fleet-admin-live \
  PAPRIKA_E2E_TRACE=on \
  bash hack/test-fleet-admin-dashboard.sh
```

The harness proves that the public endpoint and an ordinary port-forward remain
HTTP 401/Connect `unauthenticated`, while the reviewed admin proxy returns HTTP
200. It exercises every fleet view on desktop and mobile, then revokes the CLI
session and deletes only its UID-recorded run namespace.

Each invocation writes sanitized evidence under
`artifacts/fleet-admin-live/<run-id>/`, including readiness JSON, CLI/process
results, request status/headers/bodies, rendered fixtures, exact indexed
snapshots, screenshots, traces, reports, current/previous API and manager logs,
events, and cleanup results. Never add kubeconfigs, tokens, cookies,
Authorization values, or admin-session values to this directory.

## Immutable deployment and rollback

`.github/workflows/deploy-vke.yml` deploys only
`ghcr.io/paprikacd/paprika@sha256:<digest>`. A successful `Build & Push`
workflow supplies the exact four-key `image-metadata-<head-sha>` artifact. A
manual run requires a full 40-character commit SHA, a `sha256:` digest, and the
positive build run ID of the successful `Build & Push` run that produced that
artifact. Both paths fetch full trusted history, require the commit to be on
`origin/master`, query the Actions API to bind the repository, workflow, push
event, master branch, successful conclusion, run ID, and commit, then download
the exact artifact from that run. The artifact repository/SHA/digest/platform
must match the requested values before the workflow re-inspects the OCI object
as `linux/amd64` and validates the selected child-manifest digest used in pod
`imageID` values. A commit and digest without the matching build run ID are
rejected.

Before mutation the workflow records a real deployed Helm revision and
sanitized Helm, workload, pod, readiness, image, and event evidence. It applies
one digest reference to manager, API server, repo server, and webhook receiver
with `helm upgrade --install --atomic --wait`. The release is accepted only
after readiness, `/readyz`, amd64, image/imageID, admin-listener isolation, and
the real live browser harness all pass.

Workflow evidence is uploaded even on failure as
`fleet-admin-vke-<run-id>-<run-attempt>`. Raw Helm values/manifests and
Kubernetes output stay in runner temporary storage; only redacted evidence is
uploaded.

If Helm fails, `--atomic` restores the prior release and the workflow verifies
that restoration. If a post-upgrade security/browser gate fails, the workflow
rolls back to the recorded positive revision:

```bash
rtk helm rollback paprika-e2e "$PREVIOUS_REVISION" \
  --namespace paprika-e2e --wait --timeout 5m
```

It then verifies workload readiness and both ordinary/public unauthenticated
behavior. If no release existed before the run, only the newly created release
is uninstalled. The failing post-upgrade evidence and recovery result remain in
the uploaded artifact. Cancellation after the workflow crosses the recorded
mutation boundary follows the same recovery path; cancellation or failure
before that boundary never selects rollback or uninstall.

## Rollout record

After a successful omega rollout, record the run ID, source commit, immutable
image digest, Helm revision, reviewed context and subject (never credentials),
test summary, evidence path, and namespace/session cleanup result here.
