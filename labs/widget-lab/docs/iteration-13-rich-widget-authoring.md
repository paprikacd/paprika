# Widget Lab iteration 13: rich widget and tooltip configuration

## Scope

Extend the isolated Widget Lab's existing Paprika editor using only capabilities supported by registered renderers and the canonical schema. The lab retains synthetic fixtures: no provider query runs, production dashboard persistence, or production chart code changes.

## Editor experience

The panel action menu now includes Appearance and presets and Configure tooltips, which target the existing editor. The property rail offers:

- Presentation presets: Focus, Investigate, and Briefing. Presets preserve the original query, queryRef, provider, mapping, layout, and any authored tooltip source.
- Panel appearance: Gamma theme-relative defaults with optional background and text overrides. Apply updates the actual panel host, not only the editor preview.
- Visualization: supported renderer choices, value formatting, time-series draw/curve/width/fill, axes, grid, timezone-aware calendar scale, numeric insets and reference lines.
- Statistic: sparkline and placement, icon, bounded progress bar with required min/max, freshness, and ordered threshold rules.
- Series: exact label/value colour matching on timeseries where the production renderer consumes rules.
- Data labels: category and numeric label visibility for supported builtin bar and heatmap widgets.
- Tooltip: common placement, gap and size, source-aware metric title/value caption/precision/unit, and an optional bounded series-backed mini visualization with type, title, height, grid, axes and legend. Record and trace families retain their renderer-owned content.
- Full configuration: existing validated JSON editor for nested plugin configuration, data bindings, declarative saved or query-backed tooltip sources and settings not represented by the guided controls.

The live preview uses the current validated draft, and the tooltip content sample uses the normalized loaded fixture. For actual pointer placement, keyboard focus, explicit pinning and the embedded chart, interact with the chart itself. The sample is not a replacement for the floating tooltip owner.

## Contracts

All guided edits pass canonical widget/schema validation. Invalid drafts keep the last valid visualization and block Apply. Renderers advertise their own supported controls; the editor does not expose unimplemented behaviour. Source definitions, unit semantics, ID and query context remain unchanged when applying presentation presets. Session edits reset when leaving the dashboard route.

Existing Gamma primitives, semantic tokens, modal focus handling, Undo/Redo, Apply/Discard, tooltip portal/theme inheritance and responsive behaviour remain the owners.

## Verification

Run npm run typecheck, npm test -- --maxWorkers=2, npm run build and git diff --check in labs/widget-lab. Regression coverage includes preset schema compatibility, tooltip sources, live preview content, bounded rules, editor deep links and actual panel colour application. Automated rendering and happy-dom tests do not substitute for a desktop/mobile pointer and keyboard browser review.

