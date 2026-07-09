# Cuttlefish and Flaggr VKE Migration

Date: 2026-07-09

## Cuttlefish

- Paprika application: `cuttlefish-controlplane`
- Chart repo: `https://github.com/paprikacd/cuttlefish-controlplane-chart`
- Image: `us-central1-docker.pkg.dev/cuttlefish-d16cd/cuttlefish/controlplane:d79947400714-vke-20260709055002`
- Kubernetes secrets:
  - `cuttlefish-gar`
  - `cuttlefish-controlplane-gcp-service-account`
  - `cuttlefish-controlplane-env`
- Gateway hostnames:
  - `origin-vke.cuttlefish.sh`
  - `api.cuttlefish.sh`

Validation:

```bash
curl -fsS https://origin-vke.cuttlefish.sh/healthz
curl -fsS https://api.cuttlefish.sh/healthz
kubectl --kubeconfig=terraform/omega.kubeconfig -n paprika-e2e get application cuttlefish-controlplane
```

Notes:

- `api.cuttlefish.sh` DNS was moved from the DigitalOcean reserved IP to the VKE Gateway IP `104.156.233.70`.
- `origin-vke.cuttlefish.sh` was added as a direct VKE canary/origin hostname.
- The previous DigitalOcean tfvars did not contain `SECRET_ENCRYPTION_KEY`; a new strong Kubernetes-only key was generated for the cluster secret. Any workflow secrets encrypted under a different previous runtime key need to be re-seeded or migrated deliberately.

## Flaggr

- Paprika application: `flaggr-api`
- Chart repo: `https://github.com/paprikacd/flaggr-api-chart`
- Image: `australia-southeast1-docker.pkg.dev/flaggr-478302/flaggr/api:954872b1ef6c-vke-20260709055002`
- Kubernetes secrets:
  - `flaggr-gar`
  - `flaggr-api-gcp-service-account`
- Gateway hostnames:
  - `origin-vke.flaggr.dev`
  - `api.flaggr.dev`

Validation:

```bash
curl -fsS https://origin-vke.flaggr.dev/health
curl -fsS https://api.flaggr.dev/health
kubectl --kubeconfig=terraform/omega.kubeconfig -n paprika-e2e get application flaggr-api
```

Notes:

- `origin-vke.flaggr.dev` is a DNS-only Cloudflare A record to the VKE Gateway IP `104.156.233.70`.
- `api.flaggr.dev` remains Cloudflare-proxied and routed through the `flaggr-edge-cache` Worker.
- The Worker binding `API_ORIGIN` now points to `https://origin-vke.flaggr.dev`, preserving edge-cache behavior while using the VKE-backed Go API.
