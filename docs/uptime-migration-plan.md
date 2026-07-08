# Telesis Uptime Migration Plan

This note captures the current shape of `/Users/benebsworth/projects/uptime` and the safest path to bring it under Paprika control.

## Current Topology

| Layer | Current target | Notes |
| --- | --- | --- |
| Frontend | Vercel project `uptime-frontend`, alias `https://telesis.dev` | Prebuilt Vercel deploy from `frontend/`. |
| API edge | Cloudflare Worker `uptime-edge-cache` at `https://api.telesis.dev` | Proxies to `origin.telesis.dev`; Worker deploy uses Wrangler. |
| API origin | DigitalOcean droplet `170.64.247.130` | Caddy routes `api.telesis.dev` and `origin.telesis.dev` to localhost `9500`. |
| Backend services | Docker Compose in `/opt/telesis` | `api`, `scheduler`, `runner`, `resultprocessor`, `rollup`, `pubsub`. |
| Images | API mirrored to `australia-southeast1-docker.pkg.dev/uptime-485903/uptime-prod-docker/api:ab2d5b3`; legacy services still reference `ghcr.io/skunkworq/uptime/{scheduler,runner,resultprocessor,rollup}:latest` | Build script targets `linux/amd64`. |
| Database | Supabase Postgres | Existing compose notes IPv6 for direct DB connectivity. |
| Auth | Firebase Authentication | API uses Firebase project and admin credentials. |
| Queue | Pub/Sub emulator container | Existing services use pull mode through `PUBSUB_EMULATOR_HOST=pubsub:8085`. |
| Checks | Runner region `syd1` | Runner also needs Docker socket for Playwright sandbox checks. |

## Recommended Path

Use a two-phase migration so Paprika can own rollout and health without moving every dependency at once.

| Phase | Target | Work |
| --- | --- | --- |
| 1 | Paprika-managed Telesis backend on VKE | Deploy the backend services as Applications with health checks on `/health`, `/health/live`, and `/health/ready`; keep Supabase, Firebase, Cloudflare, and Vercel external. |
| 2 | Dedicated Sydney runner plane | Run runner and sandbox capacity in Sydney, either as a separate Paprika-managed cluster/agent or as a constrained node pool. Keep the control plane scheduling through queue topics. |

This avoids coupling the UI/API move to the hardest operational part: regional browser check execution with Docker sandboxing.

The first phase now has concrete artifacts:

| File | Purpose |
| --- | --- |
| `charts/telesis-api/` | Portable Helm chart for the Telesis API origin only. |
| `deploy/telesis-api-values.example.yaml` | Production-shaped values for local Helm validation. |
| `deploy/telesis-api-application.yaml` | Paprika Application with canary rollout and health gates. |
| `docs/telesis-api-cluster-migration.md` | Runbook for secrets, validation, and DNS cutover. |

## VKE Application Cut Plan

| Service | Kubernetes shape | Health |
| --- | --- | --- |
| `api` | Deployment + Service + Gateway route for `origin.telesis.dev` | `/health/ready` readiness, `/health/live` liveness, `/health` detailed health check in Paprika. |
| `scheduler` | Deployment with 1 replica | `/health`; needs topic/bootstrap validation. |
| `runner` | Deployment on dedicated runner nodes | `/health`; requires sandbox runtime decision before production traffic. |
| `resultprocessor` | Deployment with 1 replica | `/health`; consumes result subscription. |
| `rollup` | Deployment with 1 replica or Cron-style controller split later | `/health`; rollup intervals from env. |
| `pubsub` | Prefer managed queue or NATS before long-term production | Current emulator is acceptable only for a controlled migration dry run. |

## Required Paprika Work Before Cutting Traffic

1. Add a Telesis ApplicationSet or multiple Applications with per-service health checks and environment Secret references.
2. Use canary rollout for `api` first, with Cloudflare still pointing at the droplet origin until the VKE origin passes health and quick-check smoke.
3. Use the Paprika health checks in `deploy/telesis-api-application.yaml` as the promotion gate, with `POST /v1/quick-check` kept as a manual or low-frequency synthetic smoke test.
4. Decide runner isolation:
   - Preferred short term: keep runner on the existing droplet or a Sydney worker host, but manage it through Paprika once agent scheduling is ready.
   - Preferred long term: dedicated VKE node pool or separate Sydney cluster with restricted runner permissions.
5. Migrate DNS last:
   - `origin.telesis.dev` to VKE Gateway.
   - Keep `api.telesis.dev` Cloudflare Worker in front unless cache/auth behavior is intentionally replaced.

## Demo Coverage

The demo app now exercises canary rollout and an HTTP health gate. Telesis uses the same shape through `deploy/telesis-api-application.yaml`, with the API image pulled from Google Artifact Registry through the `telesis-gar` secret:

```yaml
healthChecks:
  - name: api-ready
    httpProbe:
      url: http://telesis-api-release.<namespace>.svc.cluster.local:9500/health
    expression: http.statusCode == 200
  - name: api-detailed-health
    httpProbe:
      url: http://telesis-api-release.<namespace>.svc.cluster.local:9500/health
    expression: http.statusCode == 200
```
