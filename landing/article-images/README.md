# Public article illustrations

These are conceptual diagrams of documented Paprika behavior. They are not
screenshots, live status reports, measured traffic or customer deployments.
The article manifest chooses a relevant figure, alt text and caption for every
guide and blog post. Related articles can share a figure when it illustrates
the same mechanism.

`hack/render-article-images.mjs` contains the eight new editable diagram
definitions and exports their SVGs and PNGs. It also exports PNG versions of
the existing deployment, pipeline, promotion and resource-evidence SVGs from
`landing/diagrams/`. Each has a separately composed mobile image. PNGs are
committed so publishing needs no image service or additional renderer step.

To regenerate after editing a figure, install the landing dependencies and
Chromium, then run from the repository root:

```sh
node hack/render-article-images.mjs
```

The renderer verifies that text stays within the image. Page-level browser
tests decode every selected image and check visible captions, dimensions,
responsive source selection, schema and social previews.

The four reused delivery illustrations use Anatomy isometric primitives,
Copyright (c) 2026 Ryan, MIT. The notice is included in `LICENSE.anatomy`;
editable sources and product semantics are documented in
[`../diagrams/README.md`](../diagrams/README.md). The new diagrams are native
SVG generated from Paprika's maintained documentation; no image-generation
service or external stock imagery is used.

## Content references

| Figure | Maintained product reference |
| --- | --- |
| API access | `docs/cli.md`, `docs/api.md` |
| Canary steps | `docs/guides/canary.md` |
| Cluster targets | `docs/guides/multi-cluster.md` |
| Observe gateway | `docs/guides/observability-gateway.md` |
| Dashboard authoring | `plugins/paprika-observe/README.md`, `landing/content/blog/building-dashboards-with-mcp.md` |
| Metrics | `docs/guides/metrics.md` |
| Browser renderer | `docs/guides/observe-browser-renderer.md` |
| MCP access | `docs/guides/mcp-client-setup.md`, `docs/guides/mcp-plugin.md` |
