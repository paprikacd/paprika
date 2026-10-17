# Synthetic console walkthrough

The landing page links to `landing/tour.html`, a five-stage captured-console
walkthrough. It is a guided image viewer, not an unauthenticated production
console. Only the surrounding step controls, highlighted targets, enlargement
dialog and evidence disclosure are interactive. The page makes that boundary
visible before every capture.

## One coherent example

The example is `team-00/checkout-service`, in the payments project and production
stage. It is **Healthy and Synced now**. Its health history and finite synthetic
log replay include an earlier dependency failure followed by recovery.

The resource chain is:

```text
Deployment / checkout-service
└─ ReplicaSet / checkout-service-6d8b9f7c4
   ├─ Pod / checkout-service-6d8b9f7c4-b7q2m
   ├─ Pod / checkout-service-6d8b9f7c4-k4n8r
   └─ Pod / checkout-service-6d8b9f7c4-v9x3p
```

The container is `checkout`. Manifests, events, health history and log timestamps
come from the same test fixture. Resource and log reads retain Application
existence, resource membership and read-authorization checks. No production API
implementation or write operation is changed.

The Overview **Health posture** heatmap represents targets. It is distinct from
the Applications **Treemap** mode. Tour labels and capture hotspots must preserve
that distinction.

## Capture source

The UI was compiled from the repository's real console, using the locked
dependencies and normal static export. The resource-graph count label was corrected
from “managed” to “resources” because generated children are included.
`test/fleetconsole` serves it with a fake Kubernetes client and synthetic fleet
records. It has no live cluster connection.

Build and run the fixture from the repository root:

```sh
cd ui
npm ci
npm run build
cd ..
go build -o bin/fleet-console-fixture ./test/fleetconsole
bin/fleet-console-fixture --listen 127.0.0.1:3112 \
  --assets ui/out --applications 24 --data-sources realistic
```

Use `realistic` data sources so the demo does not imply an installed cost or
observability provider. Start a fresh fixture before capturing so its existing
time-sensitive health history is recent.

Capture the real browser at **1440 × 900**, with reduced motion:

| Asset under `landing/tour/` | View and highlighted action |
| --- | --- |
| `applications.webp` | Applications table; Overview navigation opens target health |
| `heatmap.webp` | Overview Health posture heatmap; checkout target opens Application |
| `application.webp` | `checkout-service` detail; Resources tab |
| `resources.webp` | Resource hierarchy and selected workload inspector; Logs tab |
| `logs.webp` | Resource Logs inspector; prior failure and recovery sequence |

For the heatmap, set **Group by → All** and collapse the optional Application
lifecycle board so the target tiles stay visible. The selected resource is
Pod `checkout-service-6d8b9f7c4-b7q2m`; capture its Live tab before Logs.

Images are compressed WebP captures, with labels kept in the actual UI rather
than painted over afterward. Keep originals outside the public `landing/`
directory. After a refresh, update each percentage-positioned hotspot from the
corresponding real control's browser bounds. Do not align a hotspot with a
different console action merely to fill a convenient area.

## Review

- Run fixture read/stream tests and the repository's required Go checks.
- Run `bash hack/test-landing-install.sh` and `node --check landing/tour.js`.
- Follow all five stages with pointer and keyboard; inspect the selected step,
  hash, focus destination, Previous, Next and Replay.
- Open and close the enlarged capture with Escape; verify focus returns.
- Review desktop and 390px layouts, no page overflow, reduced motion and all five
  readable stages with JavaScript disabled.
- Keep the synthetic label, current healthy state and captured-controls notice
  visible. Historical log errors must not be described as a current incident.

The guide's steel selection rails, short directional transitions and focus
accents extend the existing Gamma-adapted landing components. No new third-party
component runtime or external community integration is added.

## Verification evidence

Local review passed the required Go build, focused engine and pipeline tests,
internal/cmd vet, fixture tests and fixture vet. The actual console static export
built successfully; its focused Application page suite passed all 16 tests.
Repository `make lint` also passed with the installed v2.12.2 custom linter
and a matching Go 1.27.0 toolchain. Landing contracts, tour JavaScript syntax
and whitespace checks passed.

Browser review covered 1440px desktop, 900px landing navigation and 390px mobile:
all five steps, aligned hotspots, hash/current-step updates, Previous, Replay,
Left/Right/Home/End, dialog Escape and focus restoration, readable recovery
evidence, reduced motion and five visible stages with JavaScript disabled.
No horizontal page overflow or console warnings/errors were observed.

- [Desktop tour](synthetic-tour-desktop.png)
- [Target heatmap](synthetic-tour-heatmap.png)
- [Resource inspector](synthetic-tour-resources.png)
- [Logs and text evidence](synthetic-tour-logs.png)
- [Mobile tour](synthetic-tour-mobile.png)

These captures are review evidence for this branch. They do not claim deployment
of the tour to the public site.
