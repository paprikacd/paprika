# Paprika landing diagrams

The Pipeline and promotion figures are built with the [Anatomy](https://github.com/wheresryan22/anatomy) isometric SVG kit (`iso-kit.mjs`, MIT; see `LICENSE`). The generated `pipeline.html` and `gates.html` are standalone so the GitHub Pages landing page needs no JavaScript framework or third-party runtime.

Regenerate after editing the models:

```sh
node landing/anatomy/build.mjs
```

The figures use different mechanisms because they explain different resources:

- `pipeline.html` is a branching routing table. Its Git source, dependent container-step bays, and declared output are one illustrative `Pipeline` configuration. The movable front index selects an assembly; it does not show a running job.
- `gates.html` is a vertical stage lift. It illustrates a handoff between separate `Application` resources linked by `spec.trigger.from`, using the same pinned Git revision. The side modules represent configured verification and optional approval; the preview control cannot approve or deploy a release.

Both figures use the Paprika console's light, navy, and steel-blue palette, have native buttons and keyboard controls, and stop motion under `prefers-reduced-motion`. Keep their captions aligned with `docs/guides/pipelines.md`, `docs/guides/environment-promotion.md`, and `docs/guides/gates.md` when behavior changes. The vendored kit has SVG primitives only, so no Anatomy geometry audit is claimed.

## Custom release proof press

[`release-press/index.html`](release-press/index.html) is a separate, custom 3D Anatomy model embedded near the top of the landing page. Its turning revision die and separate Application bays make the promotion handoff tangible. The bays include health and sync probes; nearby page notes explain fresh desired/live observation and configured verification. A preview control illustrates an optional approval hold. A downstream Release deploys the pinned Git revision under its own Application and is then observed in its target environment.

Edit [`release-press/build.mjs`](release-press/build.mjs), [`release-press/live.js`](release-press/live.js), and [`release-press/style.css`](release-press/style.css) for this model, then regenerate its standalone `index.html` from the build script.

This model illustrates one configured promotion path. Its controls only preview that path; they do not approve, deploy, or read a live cluster. The drawing and its frame are transparent over a Paprika paper canvas, which also keeps the standalone preview readable. Preserve its keyboard controls, reduced-motion behavior, and readable 390px layout when editing it. Keep the explanation aligned with [`docs/guides/environment-promotion.md`](../../docs/guides/environment-promotion.md), especially the exact upstream revision and separate downstream deployment settings.
