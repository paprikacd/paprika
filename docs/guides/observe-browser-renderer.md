# Optional Paprika Observe browser renderer

The `render_dashboard` MCP tool can return a **real Chromium/Playwright PNG**
with `image/png` content when an isolated render worker is configured.
It is not a simulation of chart appearance. The operator must deploy the
worker as a **loopback-only sidecar of the observability gateway Pod**.

Build the opt-in image with:

```sh
docker build -f ui/Dockerfile.render-worker -t ghcr.io/paprikacd/paprika-render-worker:<revision> .
node --test ui/render-worker.test.mjs
```

Gateway config:

- `PAPRIKA_OBSERVE_RENDER_URL=http://127.0.0.1:9081/render`
- `PAPRIKA_OBSERVE_RENDER_SECRET` from a Kubernetes secret (32+ bytes)

Renderer config:

- `PAPRIKA_RENDER_SECRET`: same secret (never log or store in Git)
- `PAPRIKA_RENDER_UI_ORIGIN`: the trusted internal Paprika UI origin,
  e.g. `http://paprika-e2e-api-server:3000`

No external Service or Ingress should expose port 9081. The MCP gateway
validates the dashboard through the human-authorized Insights API first,
then mints a short-lived delegated token. The worker accepts only a fixed
dashboard ID and viewport, blocks arbitrary browser destinations, denies
mutating API requests and wipes its ephemeral browser context after capture.
Browser screenshots are capped at 4 MiB, 20 seconds and two simultaneous jobs.

**This implementation is opt-in.** It is not included in the current Helm
release. Before enabling it in production, validate screenshots against the
actual UI on desktop (1512), tablet (768) and mobile (390), both themes,
and test slow/error responses, cancellation, cross-origin blocking and
an authorized viewer's RBAC. The tool is registered only when the sidecar
configuration is present. An image is visual evidence; use `query_dashboard`
to verify exact values, missing telemetry and freshness separately.

## Helm activation (after real-browser verification)

An optional chart field `observabilityGateway.renderWorker` renders the
loopback Chromium sidecar, enables the Go MCP tool and injects a pre-existing
Kubernetes Secret into both containers. It stays **disabled by default**.
Enable only with a tested, immutable GHCR image digest, a private Secret and
the internal UI origin. The gateway Pod's network policy must permit egress
to the selected Paprika API-server UI Service on TCP 3000. Run
`helm template` and inspect the Pod SecurityContext/egress rules before
deployment; never disable network policy or reuse OAuth signing secrets
as the renderer shared secret.

```yaml
observabilityGateway:
  renderWorker:
    enabled: true
    image: ghcr.io/paprikacd/paprika-render-worker@sha256:<verified-image-digest>
    uiOrigin: http://paprika-e2e-api-server:3000
    secretName: paprika-dashboard-renderer
    secretKey: secret
```

No worker image or Secret is created by these Helm changes; publishing,
secret provisioning and a real authenticated screenshot test are required
before enabling. Existing deployments are unchanged.
