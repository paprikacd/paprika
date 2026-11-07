# Optional Paprika Observe browser renderer

The `render_dashboard` MCP tool can return a **real Chromium/Playwright PNG**
with `image/png` content when an isolated render worker is configured.
It captures the actual Insights UI in a **loopback-only sidecar of the
observability gateway Pod**. Chart installations leave it disabled by default;
the trusted master publication and VKE deployment workflow enables the tested
worker using the exact published image digest.

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
All HTTP redirects are rejected before following them, including redirects
from an otherwise permitted API path. The gateway sends the authorized
dashboard ETag, and the worker checks the revision actually read by the UI
before returning the PNG. A changed or unobserved revision is rejected.
Browser screenshots are capped at 4 MiB, 20 seconds and two simultaneous jobs.
Timeouts and client disconnects release capacity, including requests with a
stalled body or browser startup. Deferred widgets must finish loading before
capture; a loading skeleton is not accepted as a completed screenshot.

The required browser CI job runs `ui/e2e/insights-render-worker.e2e.mjs`
against the authenticated Insights UI with deterministic telemetry. It captures
desktop (1512) and mobile (390) in both themes, focused plot inspection,
redirect isolation, revision conflicts and provider denial, and verifies that
rendering leaves the saved document unchanged. PNGs and revision evidence are
uploaded under `artifacts/insights/render-worker`. Those fixtures verify the
renderer; production appearance still requires a live `render_dashboard` call.
The tool is registered only when the sidecar configuration is present. Use
`query_dashboard` alongside the image to verify values, missing telemetry and
freshness separately.

## Trusted publication and VKE deployment

After the required checks pass on a trusted master push, the existing publish
job builds both the application and `ui/Dockerfile.render-worker`. It passes
each immutable GHCR digest to the VKE reusable workflow. That workflow validates
the renderer reference before privileged operations, then calls
`hack/prepare-dashboard-renderer.sh` in the verified `vke` context.

The helper creates a dedicated random shared Secret only if it is absent,
validates an existing Secret without printing its contents, and writes temporary
Helm values containing only the digest, Secret reference and internal UI origin.
The chart grants the gateway Pod egress to this release's API server on TCP 3000.
After the normal rollout checks, deployment verifies the worker's loopback
health endpoint inside the gateway Pod. Publication and health do not replace
the final authenticated screenshot check.

Manual application deployments may omit `render_worker_image_ref`; the helper
preserves an already deployed immutable worker image. If no worker is deployed,
that manual path leaves it disabled. It never substitutes an unpinned tag.

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

For installations outside the trusted VKE workflow, publish the worker image
and provision the dedicated Secret before enabling these values. The Helm chart
itself does not create the shared Secret. Verify the deployed digest and run an
authenticated screenshot check after rollout.
