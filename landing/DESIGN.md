# Landing design system

The landing page uses the Paprika console's visual language: a technical instrument board for source, release, and cluster evidence. Keep product screenshots and configuration illustrations visibly distinct. Product captures on this page come from the real console connected to a local synthetic fleet; they do not represent customer deployments.

## Foundations

| Role | Value | Use |
| --- | --- | --- |
| Paper | `#f2f2f3` | Main background |
| White | `#ffffff` | Console captures and figure plates |
| Navy | `#1d2d3d` | Navigation, evidence, community, terminal |
| Steel | `#5980a6` | Accent and selected mechanisms |
| Steel dark | `#416180` | Readable actions and links on paper |
| Steel pale | `#e7f0f8` | Promotion chapter |
| Text | `#1d1f20` | Copy on light backgrounds |

The source of truth for tokens, type scales, and breakpoints is [`site.css`](site.css). Use Barlow for reading, Barlow Condensed for display and actions, and the system monospace stack for short technical labels. Keep square corners, restrained rules, and visible keyboard focus. Do not add fabricated status values, adoption metrics, customer logos, or testimonials to fill space.

## Visual grammar

Use recognizable software entities: Git revision cards, Application configuration, container Jobs, rendered manifests, Release records and Kubernetes resource stacks. Depth and light should help separate these entities. A decorative machine must not carry product meaning that is only recoverable from its caption.

The page tells four distinct stories, each with one primary figure:

| Story | Diagram | Meaning |
| --- | --- | --- |
| Deployment | `diagrams/deployment.svg` | Application source resolves a revision; an optional Pipeline executes configured work; a Release renders and applies resources; health and sync observations return from the target. Stage/cluster is target configuration. |
| Pipeline | `diagrams/pipeline-running.svg`, `pipeline-blocked.svg` | Container step dependencies, bounded parallel work, and a failed prerequisite preventing a dependent step from running. Outputs are declared references. |
| Promotion | `diagrams/promotion.svg` | Separate management-cluster Application records select distinct workload targets. Verification Jobs run on the management cluster against the upstream environment. Production can retain its accepted Release while a candidate awaits approval. |
| Resource evidence | `diagrams/evidence.svg` | A synthetic desired manifest and live object differ in a field. Sync comparison and health assessment remain distinct. |

Each figure has a purpose-built mobile composition. Keep labels as native SVG text and supply adjacent HTML explanation and useful alt text. The static diagrams use Anatomy isometric primitives; their generator, license notice and product semantics live in [`diagrams/`](diagrams/README.md). No moving 3D geometry is introduced by these figures.

The earlier routing table, stage lift, environment conveyor, comparator and release press remain in the repository as previous explorations. They are no longer embedded in the landing page. Do not reintroduce multiple promotion metaphors or imply that an image/package travels between environment clusters.

## Gamma components and effects

The maintained Gamma MCP implementations of MorphTabs, SpotlightSurface and ProgressStack inform [`gamma-ui.js`](gamma-ui.js) and [`gamma-ui.css`](gamma-ui.css). These small vanilla adaptations use Paprika's tokens and do not add a React runtime. Preserve the source provenance and contracts in [`docs/design/gamma-provenance.md`](../docs/design/gamma-provenance.md).

- Tabs change readable explanatory panels, with a moving underline and short directional entrance for pointer input. Keyboard selection is immediate and uses Left/Right, Home and End.
- Spotlight surfaces add a local pointer highlight behind meaningful copy and native actions. Keyboard focus gets a centered equivalent; touch keeps normal scrolling.
- Process cards explain clearly labelled illustrative states. They do not simulate live telemetry, percentages or deployment progress.
- Reduced motion removes movement. Content stays readable if JavaScript fails or is disabled. Hover must never reveal the only explanation or action.

The page's versioned local stylesheet URLs prevent a newly published HTML page from using a previous cached layout. Bump the version suffix when changing these layout contracts.

## Imagegen direction

The built-in image generation tool produced [`gamma-delivery-vision.png`](../docs/design/gamma-delivery-vision.png) as an inspiration board. Its upright document cards, target islands, Pod stacks and quiet construction grid informed the native implementation. The generated board is design reference material and is not served as a factual product diagram. The full prompt and tool mode are recorded in [`gamma-imagegen-brief.md`](../docs/design/gamma-imagegen-brief.md).

## Content and review

Check claims against the current [feature list](../docs/features.md), [getting-started guide](../docs/getting-started.md), [Pipeline guide](../docs/guides/pipelines.md), and [promotion guide](../docs/guides/environment-promotion.md). A Pipeline is optional for a Release. Staged promotion is a configured link between separate Applications.

Run `bash hack/test-landing-install.sh` from the repository root after editing install copy or markup. Review desktop and 390px layouts, keyboard navigation, horizontal console capture scrolling, reduced motion, no-JavaScript content, tab interactions, and all four diagram stories before publishing. The static page is deployed from `landing/` by `.github/workflows/gh-pages.yml` after a merge to `master`.
