# BrandBrain API Cluster Migration

BrandBrain remains a Vercel frontend with an external Postgres database and GCS buckets. The API origin is moved from the shared DigitalOcean host to the omega VKE cluster as one Paprika-managed application.

## Runtime Shape

- Chart source: `https://github.com/paprikacd/brandbrain-api-chart.git`
- Image: `us-central1-docker.pkg.dev/brandbrain-486909/brandbrain/api:f6ec73d55c91-vke-20260709034617`
- Kubernetes namespace: `paprika-e2e`
- Canary hostname: `origin-vke.brandbrain.dev`
- Public hostname: `api.brandbrain.dev`
- Current chart revision: `7311e771ca2d577aaa7209dc350b1b3e3966f6e7`

## Secrets

The cluster uses three manually seeded secrets:

- `brandbrain-gar`: Artifact Registry pull secret for `us-central1-docker.pkg.dev`.
- `brandbrain-api-env`: runtime env secret from GCP Secret Manager plus provider keys from local env.
- `brandbrain-gcp-service-account`: `brandbrain-backend` JSON credentials mounted as `GOOGLE_APPLICATION_CREDENTIALS`.

The Kubernetes API process intentionally does not use the old `BRANDBRAIN_DEPLOY_SECRET` upload endpoint. Rollouts are controlled by Paprika from the chart repo and image tag.

## Validation

Paprika health checks cover:

- `GET /health`
- `GET /version` with Postgres and GCS dependency checks
- `POST /brandbrain.v1.BrandService/SearchBrands`

Manual canary smoke:

```sh
curl -fsS https://origin-vke.brandbrain.dev/health
curl -fsS https://origin-vke.brandbrain.dev/version
curl -fsS -H 'Content-Type: application/json' \
  -d '{"query":"test","limit":1,"offset":0}' \
  https://origin-vke.brandbrain.dev/brandbrain.v1.BrandService/SearchBrands
```

## Live Validation

Validated on 2026-07-09 after `api.brandbrain.dev` cut-over:

- `GET https://api.brandbrain.dev/health` returns healthy.
- `GET https://api.brandbrain.dev/version` reports healthy Postgres and GCS checks.
- Tracked crawl started through `POST /api/v1/discover/start` with `dispatch_mode=server`, `browser_mode=disabled`, and a two-page crawl budget.
- Crawl job `disc-1783574318148044753` completed with domain `brandbrain.dev`, 9 logos, and 6 colors.
- After the API pod restarted during the chart rollout, `GET /api/v1/discover/status` and `GET /api/v1/discover/result` still returned the completed job from persisted storage.
- Auto-ingest created searchable brand `brandbrain-vke-smoke-20260709051837` with tags `vke-smoke` and `migration-validation`.
- Paprika release `brandbrain-api-release-f1cfe65268` completed at 100% canary weight from chart revision `7311e771ca2d577aaa7209dc350b1b3e3966f6e7`.

## Chart Hardening

The chart intentionally keeps dependency checks out of kubelet readiness:

- Deployment readiness, liveness, and startup probes use `/health`.
- Paprika `Application` health checks own `/version` dependency checks and search smoke validation.
- Rolling updates use `maxUnavailable: 0` so the single API replica is replaced without intentionally dropping capacity.
- `DISCOVERY_TRACE_CAPTURE=on_failure` and GCS trace storage are configured for failed crawl debugging.
- `image.digest` is available for immutable image pinning.
- `serviceMonitor.enabled=true` can render a Prometheus Operator `ServiceMonitor` for `/metrics`.

## DigitalOcean Residuals

DigitalOcean API inventory on 2026-07-09:

- One active droplet remains: `cuttlefish-controlplane`, id `558547040`, region `syd1`, size `s-2vcpu-4gb`, public SSH IP `170.64.130.76`, reserved IP `170.64.247.130`.
- The reserved IP remains attached to the same droplet.
- Firewall `cuttlefish-controlplane` still allows inbound `22`, `80`, `443`, and `4444` from `0.0.0.0/0` and `::/0`.
- Public health checks: `api.telesis.dev/health`, `origin.telesis.dev/health`, and `api.brandbrain.dev/health` return `200`; `api.flaggr.dev/health` returns `404`; `api.cuttlefish.sh/healthz` returned `502` during this validation pass.
- SSH from this environment failed with `Permission denied (publickey)`, so process-level inventory is based on the canonical `~/projects/cuttlefish/DROPLET.md` runbook and public/DO API checks.

Remaining migration candidates from the shared droplet:

- `cuttlefish` control plane on `api.cuttlefish.sh` / port `4444`.
- Old `telesis` Docker Compose stack (`api`, `scheduler`, `runner`, `resultprocessor`, local Pub/Sub emulator) if it is still running on the host after the VKE cut-over.
- `brandbrain-api` systemd deployment can be drained after rollback expectations are agreed; DNS now points at VKE.
- `flaggr` is documented as a dead stub on the droplet and should be removed from shared-host routing rather than migrated as-is.
