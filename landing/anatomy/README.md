# Paprika landing diagrams

The Pipeline and promotion figures are built with the [Anatomy](https://github.com/wheresryan22/anatomy) isometric SVG kit (`iso-kit.mjs`, MIT; see `LICENSE`). The generated `pipeline.html` and `gates.html` are standalone so the GitHub Pages landing page needs no JavaScript framework or third-party runtime.

Regenerate after editing the models:

```sh
node landing/anatomy/build.mjs
```

Each bench is an explanatory model. The selected carriage is controlled by the visitor and does not show a real pipeline or promotion state. Keep the captions aligned with `docs/guides/pipelines.md` and `docs/guides/gates.md` if the product behavior changes.
