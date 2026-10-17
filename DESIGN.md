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
- **Environment chain artwork:** three distinct DEV, STG, and PROD platforms, with a testing chamber between each pair. The pictured token is a metaphor for selecting a pinned Git commit, not an image or artifact moving between clusters. The wide and mobile images were generated with the image generation skill for this page; their captions keep the product meaning explicit.
- **Release proof press:** a custom turning instrument for the promotion decision. Its revision die, health/sync probes, and separate Application bays make candidate selection and target deployment distinct. Nearby notes explain fresh observation and configured verification; the preview control illustrates an optional approval hold. It is an illustrative model, not a live fleet trace or a deployment control. Keep this figure separate from the narrower Pipeline and stage-lift examples.
- **Resource evidence:** a comparator with desired and live specimens. The accompanying metric labels describe documented current resource counts, not a score or a telemetry reading from the illustration.

The landing uses transparent `art-pipeline-routing.webp`, `art-environment-test-chain.webp`, `art-environment-test-chain-mobile.webp`, and `art-resource-comparator.webp`. Preserve their alpha channels when replacing them and inspect each on its page background. `art-promotion-lift.webp` remains in the repository as the earlier visual concept. Keep `alt` text and captions explicit about illustration versus product capture. Use the console screenshots only with their synthetic-data labels.

The environment pair was generated from one art brief in wide and portrait compositions: an isometric industrial instrument, three separate Application platforms labeled DEV, STG, and PROD, a compact TEST chamber between each pair, a small blue revision token, navy and steel enamel with restrained brass details, and a transparent background. Render the labels as part of the machines and keep the scene readable at 390px. The token is a visual reference to one Git revision, so every reuse needs adjacent text explaining that no image or artifact is transferred between environments.

The interactive figures live in [`anatomy/`](anatomy/README.md). Edit `anatomy/build.mjs`, run `node landing/anatomy/build.mjs` from the repository root, and commit the generated `pipeline.html` and `gates.html` with the source. The custom release proof press has its own source and standalone page in [`anatomy/release-press/`](anatomy/release-press/). Its transparent stage should compose cleanly on paper, and its controls must remain previews that never call Paprika or change cluster state.

## Content and review

Check claims against the current [feature list](../docs/features.md), [getting-started guide](../docs/getting-started.md), [Pipeline guide](../docs/guides/pipelines.md), and [promotion guide](../docs/guides/environment-promotion.md). A Pipeline is optional for a Release. Staged promotion is a configured link between separate Applications.

Run `bash hack/test-landing-install.sh` from the repository root after editing install copy or markup. Review desktop and 390px layouts, keyboard navigation, horizontal console capture scrolling, reduced motion, and all three interactive figures before publishing. The static page is deployed from `landing/` by `.github/workflows/gh-pages.yml` after a merge to `master`.
