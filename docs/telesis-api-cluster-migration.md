# Telesis API Cluster Migration

This runbook moves the Telesis API origin into a Paprika-managed Kubernetes cluster without dragging runner sandboxing or queue ownership into the same release unit.

## Architecture Boundary

The first movable unit is only the public API origin:

- `charts/telesis-api` deploys `ghcr.io/skunkworq/uptime/api`.
- It owns a Deployment, Service, optional HTTPRoute or Ingress, optional HPA, optional PDB, and optional ServiceMonitor.
- It reads non-secret runtime config from a ConfigMap.
- It reads sensitive config from an existing Secret named by `secretEnv.existingSecret`.
- It mounts Firebase admin credentials from a separate existing Secret named by `firebaseAdmin.existingSecret`.
- It does not deploy Pub/Sub emulator, scheduler, runner, resultprocessor, rollup, or a Docker socket mount.

That separation is deliberate. The API can move independently while the browser runner and queue topology stay on the current droplet, a Sydney runner plane, or a future Paprika agent-managed cluster.

## Target Files

- `charts/telesis-api/`: portable Helm chart for the API origin.
- `deploy/telesis-api-values.example.yaml`: production-shaped values for direct Helm validation.
- `deploy/telesis-api-application.yaml`: Paprika Application that sources the chart from this repo and rolls it out through canary steps.

## Required Secrets

Create these in the Application namespace before applying `deploy/telesis-api-application.yaml`.

Firebase credentials are split by runtime boundary:

- `telesis-firebase-admin`: mounted service-account JSON for API workloads that use `GOOGLE_APPLICATION_CREDENTIALS`.
- `telesis-api-env`: minimal API env keys. For Firebase, keep this to `FIREBASE_PROJECT_ID` unless the API starts reading more Firebase env directly.
- `telesis-firebase-admin-env`: env-style admin keys for future server components that cannot use a mounted JSON file.
- `telesis-firebase-public-env`: public Firebase web config for future frontend components.

Do not inject `telesis-firebase-admin-env` or `telesis-firebase-public-env` into the API chart by default. The API already has the mounted admin JSON and should not receive frontend config or duplicate private-key env vars.

```bash
kubectl -n paprika-e2e create secret generic telesis-api-env \
  --from-literal=DATABASE_URL='...' \
  --from-literal=FIREBASE_PROJECT_ID='...' \
  --from-literal=RESEND_API_KEY='...' \
  --from-literal=RESEND_FROM_EMAIL='...' \
  --from-literal=STRIPE_SECRET_KEY='...' \
  --from-literal=STRIPE_WEBHOOK_SECRET='...' \
  --dry-run=client -o yaml

kubectl -n paprika-e2e create secret generic telesis-firebase-admin \
  --from-file=firebase-admin-key.json=/path/to/firebase-admin-key.json \
  --dry-run=client -o yaml
```

Optional keys can be omitted when the feature is intentionally disabled. `DATABASE_URL` and `FIREBASE_PROJECT_ID` are required for a production-like API health result.

## Validation Before Cutover

Render and validate locally:

```bash
helm lint charts/telesis-api
helm template telesis-api charts/telesis-api --values deploy/telesis-api-values.example.yaml
kubectl apply --dry-run=server -f deploy/telesis-api-application.yaml
```

After the Application is applied, Paprika should roll `telesis-api-release` through `10`, `50`, then `100` percent canary weights. The health checks validate:

- `/health/ready` on the in-cluster service.
- `/health` on the in-cluster service.
- `POST /v1/quick-check` on the in-cluster service, asking the API to check `https://telesis.dev`.

## DNS Cutover

Do not point production traffic at the new origin until the Paprika Application is Healthy and the quick-check gate passes consistently.

1. Create or verify the Gateway route for `origin-vke.telesis.dev`.
2. Smoke test `https://origin-vke.telesis.dev/health/ready`.
3. Smoke test `https://origin-vke.telesis.dev/v1/quick-check`.
4. Update the Cloudflare Worker origin from `origin.telesis.dev` to `origin-vke.telesis.dev`.
5. Keep the droplet origin available until rollback has been tested.

## Runner And Queue Follow-Up

Keep the runner plane independent from the API release. The runner needs either:

- a dedicated Sydney host managed by a Paprika agent, or
- a dedicated cluster/node pool with explicit sandbox isolation and no broad API-origin permissions.

Do not move the current Docker socket runner into the API chart. If a temporary Kubernetes runner is needed, package it as a separate chart/Application with isolated scheduling, a separate service account, explicit resource ceilings, and queue health gates.
