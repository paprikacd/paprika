# BrandBrain API Cluster Migration

BrandBrain remains a Vercel frontend with an external Postgres database and GCS buckets. The API origin is moved from the shared DigitalOcean host to the omega VKE cluster as one Paprika-managed application.

## Runtime Shape

- Chart source: `https://github.com/paprikacd/brandbrain-api-chart.git`
- Image: `us-central1-docker.pkg.dev/brandbrain-486909/brandbrain/api:f6ec73d55c91-vke-20260709034617`
- Kubernetes namespace: `paprika-e2e`
- Canary hostname: `origin-vke.brandbrain.dev`
- Public cut-over target: `api.brandbrain.dev` after canary health and frontend smoke pass

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
