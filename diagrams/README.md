# Paprika delivery diagrams

These editable SVGs explain four different product behaviors. They are synthetic
examples, not screenshots, current fleet status, or deployment controls. Each SVG
has an accessible title and description and contains native text; it needs no
JavaScript, network requests, fonts, or raster assets to render.

| Story | Desktop | Mobile | Meaning |
| --- | --- | --- | --- |
| Deployment lifecycle | `deployment.svg` | `deployment-mobile.svg` | Application source → optional Pipeline → rendered manifests for a Release → Kubernetes resources; health and desired/live synchronization return as observations. `Stage.cluster` selects the target. |
| Pipeline execution | `pipeline-running.svg`, `pipeline-blocked.svg` | Matching `-mobile.svg` files | Build → parallel unit-test and policy-test → package, with `maxParallel: 2`. Package waits for both prerequisites; the failure illustration blocks its start. Outputs are declared references. |
| Environment promotion | `promotion.svg` | `promotion-mobile.svg` | Separate DEV, STG and PROD Application records live on the management cluster. Each targets a distinct environment. Verification Jobs execute on the management cluster and probe the upstream environment. PROD retains its accepted release during an approval hold. |
| Resource evidence | `evidence.svg` | `evidence-mobile.svg` | Desired `spec.replicas: 3` differs from live `spec.replicas: 2`. Two ready live replicas can be healthy while synchronization still reports a difference. |

The short revisions `9f3a2c1` and `7d41f02` and all workload names are illustrative.
The first is the completed DEV/STG revision and PROD candidate; the second is
PROD's currently accepted revision. Real promotion identity and approval also
bind to the exact upstream Release UID and current target settings. Selecting a
Git revision does not copy an image, artifact, environment configuration,
credentials, database, or Kubernetes object from one cluster to another.

## Edit and rebuild

Edit `build.mjs`, then run from the repository root:

```sh
node landing/diagrams/build.mjs
node --check landing/diagrams/build.mjs
```

The generator writes all eighteen SVGs deterministically. The deployment
overview also has `deployment-source.svg`, `deployment-build.svg`,
`deployment-apply.svg` and `deployment-observe.svg` variants with matching
`-mobile.svg` files. They preserve the full diagram and all readable labels;
a steel outline identifies the group selected in the page's lifecycle tabs.
The observe variant also emphasizes the evidence return path. Desktop viewBoxes are
1200 × 620, except the more detailed promotion diagram at 1200 × 720. Mobile
compositions are 600 pixels wide and use a vertical layout. Use them with
`<picture>` and a `(max-width: 600px)` source rather than shrinking the desktop
graph onto a phone. Keep adjacent text and captions available; status uses words
and symbols as well as color.

## Product references

- [`docs/guides/pipelines.md`](../../docs/guides/pipelines.md): dependencies,
  parallelism, steps, declared artifact references, and optional release work.
- [`docs/guides/environment-promotion.md`](../../docs/guides/environment-promotion.md):
  separate Applications, execution placement, upstream verification, candidate
  identity, target-specific configuration, and exact candidate approval.
- [`AGENTS.md`](../../AGENTS.md), architecture invariants: source pinning,
  Application/Release responsibilities, Stage routing, and resource observations.
- [`internal/health/`](../../internal/health/): resource health assessment.

## Visual direction and provenance

The native vector direction follows the ImageGen concept board produced for this
landing iteration: upright manifest/resource cards, container and Pod solids,
distinct Kubernetes target islands, crisp paper/navy/steel surfaces. Every native
label and connection was written from the product references rather than copied
from generated image text. Amber marks a manual hold; red marks failure or a
configuration difference; green and a checkmark indicate success. No general
purpose mechanical press, lift, clamp, or artifact conveyor is used.

Isometric platform and Pod geometry uses the repository's existing
[`landing/anatomy/iso-kit.mjs`](../anatomy/iso-kit.mjs). Anatomy is Copyright
(c) 2026 Ryan, under the [MIT license](../anatomy/LICENSE); that existing notice
remains intact and each generated SVG contains attribution. No third party code
is vendored in this directory. These figures use static 2.5D geometry, so they
make no claim of a moving-solid orbit or collision audit.

All eighteen outputs were rendered in headless Chrome and reviewed at their native
sizes for text clipping, overlaps, status legibility and arrow placement. Local
`qa-*.png` captures are ignored; page-level desktop and 390px captures belong in
the landing review evidence.
