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

- **Pipeline:** a wide, branching routing table. The fork represents declared step dependencies and possible parallel work. A drawer represents a declared output reference. It is one possible configuration, not a live execution trace.
- **Promotion:** an upright stage lift. Its release cassette carries one upstream Git revision to a separate downstream Application. Verification and optional approval are controls on the stage, not buttons that approve a real release from this page.
- **Resource evidence:** a comparator with desired and live specimens. The accompanying metric labels describe documented current resource counts, not a score or a telemetry reading from the illustration.

The transparent files `art-pipeline-routing.webp`, `art-promotion-lift.webp`, and `art-resource-comparator.webp` belong to those three subjects. Preserve their alpha channels when replacing them and check each on both paper and navy. Keep `alt` text and captions explicit about illustration versus product capture. Use the console screenshots only with their synthetic-data labels.

The interactive figures live in [`anatomy/`](anatomy/README.md). Edit `anatomy/build.mjs`, run `node landing/anatomy/build.mjs` from the repository root, and commit the generated `pipeline.html` and `gates.html` with the source. Their controls explain mechanisms; they never call Paprika or change cluster state.

## Content and review

Check claims against the current [feature list](../docs/features.md), [getting-started guide](../docs/getting-started.md), [Pipeline guide](../docs/guides/pipelines.md), and [promotion guide](../docs/guides/environment-promotion.md). A Pipeline is optional for a Release. Staged promotion is a configured link between separate Applications.

Run `bash hack/test-landing-install.sh` from the repository root after editing install copy or markup. Review desktop and 390px layouts, keyboard navigation, horizontal console capture scrolling, reduced motion, and the two interactive figures before publishing. The static page is deployed from `landing/` by `.github/workflows/gh-pages.yml` after a merge to `master`.
