# Telesis API Cluster Migration

This runbook moves the Telesis API origin into a Paprika-managed Kubernetes cluster without dragging runner sandboxing or queue ownership into the same release unit.

## Architecture Boundary

The first movable unit is only the public API origin:

- `https://github.com/paprikacd/telesis-api-chart` deploys `australia-southeast1-docker.pkg.dev/uptime-485903/uptime-prod-docker/api`.
- It owns a Deployment, Service, optional HTTPRoute or Ingress, optional HPA, optional PDB, and optional ServiceMonitor.
- It reads non-secret runtime config from a ConfigMap.
- It reads sensitive config from an existing Secret named by `secretEnv.existingSecret`.
- It mounts Firebase admin credentials from a separate existing Secret named by `firebaseAdmin.existingSecret`.
- It does not deploy Pub/Sub emulator, scheduler, runner, resultprocessor, rollup, or a Docker socket mount.

That separation is deliberate. The API can move independently while the browser runner and queue topology stay on the current droplet, a Sydney runner plane, or a future Paprika agent-managed cluster.

## Target Files

- `https://github.com/paprikacd/telesis-api-chart`: portable Helm chart for the API origin.
- `deploy/telesis-api-values.example.yaml`: production-shaped values for direct Helm validation against the chart repo.
- `deploy/telesis-api-application.yaml`: Paprika Application that sources the external chart repo and rolls it out through canary steps.

## Required Secrets

Create these in the Application namespace before applying `deploy/telesis-api-application.yaml`.

The API image is mirrored into Google Artifact Registry at `australia-southeast1-docker.pkg.dev/uptime-485903/uptime-prod-docker/api`. Create `telesis-gar` as a namespace-scoped `kubernetes.io/dockerconfigjson` image pull secret before rollout, and keep `imagePullSecrets[0].name: telesis-gar` in the Application parameters.

```bash
gcloud config set account ben.ebsworth@gmail.com
gcloud config set project uptime-485903
KUBECONFIG_PATH=terraform/omega-oidc.kubeconfig \
  NAMESPACE=paprika-e2e \
  ./deploy/seed-gar-pull-secret.sh
```

The helper creates or reuses `vultr-telesis-pull@uptime-485903.iam.gserviceaccount.com`, grants `roles/artifactregistry.reader` on the `uptime-prod-docker` repository, creates a service-account key for the Docker config, replaces the Kubernetes pull secret, and validates the pull with a temporary pod.

GHCR remains usable as a fallback source if that package is made readable by a token with `read:packages` and package access:

```bash
export GHCR_USERNAME='<github-user-or-bot>'
export GHCR_TOKEN='<github-token-with-read-packages>'
KUBECONFIG_PATH=terraform/omega-oidc.kubeconfig \
  NAMESPACE=paprika-e2e \
  ./deploy/seed-ghcr-pull-secret.sh
```

Firebase credentials are split by runtime boundary:

- `telesis-firebase-admin`: mounted service-account JSON for API workloads that use `GOOGLE_APPLICATION_CREDENTIALS`.
- `telesis-api-env`: API runtime keys from the current droplet env file, including `DATABASE_URL`, `FIREBASE_PROJECT_ID`, `FRONTEND_BASE_URL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, and `RESEND_FROM_NAME`.
- `telesis-firebase-admin-env`: env-style admin keys for future server components that cannot use a mounted JSON file.
- `telesis-firebase-public-env`: public Firebase web config for future frontend components.
- `telesis-web-env`: frontend auth/runtime keys from the current production frontend env file, including NextAuth, Google OAuth, and API URL values.
- `telesis-provider-env`: provider and infra credentials from the repository root env file, including Cloudflare, Telstra, and Terraform-compatible Cloudflare aliases.

Do not inject `telesis-firebase-admin-env`, `telesis-firebase-public-env`, `telesis-web-env`, or `telesis-provider-env` into the API chart by default. The API already has the mounted admin JSON and only needs `telesis-api-env`; frontend config, provider credentials, and duplicate private-key env vars should stay out of the API pod.

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
helm lint ../telesis-api-chart
helm template telesis-api ../telesis-api-chart --values deploy/telesis-api-values.example.yaml
kubectl apply --dry-run=server -f deploy/telesis-api-application.yaml
```

The Application tracks `https://github.com/paprikacd/telesis-api-chart.git` on `main` with `pollInterval: 60s`. The `paprika.benebsworth.com/webhook` route can also receive GitHub push events for the chart repo and trigger immediate syncs.

After the Application is applied, Paprika should roll `telesis-api-release` through `10`, `50`, then `100` percent canary weights. The health checks validate `/health` on the in-cluster service. The stricter `/health/ready` endpoint can return `503` for degraded dependency latency even while the API is serving traffic.

Keep `POST /v1/quick-check` as a manual smoke test or a separate synthetic monitor with an explicit rate-limit budget. Do not use it as a high-frequency Paprika health gate because the public endpoint is intentionally rate limited.

## DNS Cutover

Do not point production traffic at the new origin until the Paprika Application is Healthy and a manual quick-check smoke test passes.

1. Create or verify the Gateway route for `origin-vke.telesis.dev`.
2. Smoke test `https://origin-vke.telesis.dev/health`.
3. Smoke test `https://origin-vke.telesis.dev/v1/quick-check`.
4. Update the Cloudflare Worker origin from `origin.telesis.dev` to `origin-vke.telesis.dev`.
5. Keep the droplet origin available until rollback has been tested.

## Runner And Queue Follow-Up

Keep the runner plane independent from the API release. The runner needs either:

- a dedicated Sydney host managed by a Paprika agent, or
- a dedicated cluster/node pool with explicit sandbox isolation and no broad API-origin permissions.

Do not move the current Docker socket runner into the API chart. If a temporary Kubernetes runner is needed, package it as a separate chart/Application with isolated scheduling, a separate service account, explicit resource ceilings, and queue health gates.
