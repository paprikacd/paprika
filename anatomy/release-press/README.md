# Paprika release proof indexer

This is a bespoke Anatomy 3D figure for the Paprika landing page. `index.html` is a generated, self-contained preview. Its buttons, draggable die, and manual-hold checkbox change only this illustration; they never call Paprika or a cluster.

## The object and the product truth

The three fixed cassettes represent **three separate Applications**: development, staging, and production. Each Application has its own Stage, deployment target, and Release. A carriage travels on machined ways to one cassette; its revision die turns so the selected shoe faces that cassette. The die stands for the exact Git SHA carried by a qualifying upstream Release. It is a **selector/read head**, not an Application moving between environments or a live deployment button.

- Development can select a source revision through GitOps.
- Staging can use `spec.trigger.from` to select a completed development Release's exact SHA when fresh upstream Healthy/Synced evidence and configured verification qualify it.
- Production can similarly reference a completed staging Release. A configured `syncPolicy: Manual` may hold that selected candidate for approval.
- A downstream Application's health is observed after its own Release deploys; it can then qualify the next link. The figure does not display actual health status or live SHA values.

The semantics follow [`docs/guides/environment-promotion.md`](../../../docs/guides/environment-promotion.md). The model intentionally shows an illustrative three-Application setup, not a claim about every Paprika installation.

## What is original

`build.mjs` defines all world coordinates, geometry, and the coupling between carriage travel and die angle. It builds a rounded cast base on feet, dual ways, a rear measuring ruler with ticks and detents, a follower rail, a travelling carriage and bearing, a three-shoe non-axisymmetric revision die, and three distinct fixed Application cassettes with guide rails, lips, screens, health/sync probe bodies, marker grooves, and fasteners. The moving head has 21 live 3D parts. The static bed has 114 authored items. This is not a relabel, recolor, or modified mesh from the Anatomy turning-dial example.

The live movement is purposeful: at bay `n` the carriage travels `68 × n` world units and the die turns to `90° − 120° × n`, so shoe `n` points at its cassette. Anatomy `TURN.mount` re-projects and re-shades those convex parts and resolves their painter order while they move. `live.js` owns accessible stage selection, drag and arrow-key control, a still initial state, offscreen frame pause, and reduced-motion snapping. The drag calculation follows the sliding carriage's projected pivot. `style.css` applies Paprika paper, navy, and steel while leaving the SVG stage transparent.

## Build and preview

From the repository root:

```sh
node landing/anatomy/release-press/build.mjs
```

Open `landing/anatomy/release-press/index.html`, or serve `landing/` and open `/anatomy/release-press/index.html`. The file includes the drawing, styles, live data, and runtime; it needs no CDN or build server on GitHub Pages. Source edits require a rebuild and a commit of the generated file.

The standalone preview declares `noindex, follow`; the landing page is the canonical public entry point for this illustration.

For geometry inspection, `node landing/anatomy/release-press/build.mjs --verify` writes `index-verify.html`. The optional `--audit` path runs the Anatomy orbit checker and is CPU intensive; coordinate it with other local builds.

## Anatomy provenance and limits

`kit/` copies the MIT-licensed Anatomy `iso-kit.mjs`, `turn.mjs`, `turn-build.mjs`, `turn-audit.mjs`, `audit.mjs`, `lathe.mjs`, and `tube.mjs` modules from the locally installed `wheresryan22/anatomy` skill. Its license is in [`ANATOMY-LICENSE`](ANATOMY-LICENSE). Paprika's model geometry, layout, copy, and interaction code are in this directory. The figure is a conceptual machine: stage gates and health checks are represented in copy and cassette details, not as synthetic telemetry or a literal controller trace.
