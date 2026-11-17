# Grid selection ownership

`react-grid-layout+2.3.0.patch` forwards react-draggable's existing
`enableUserSelectHack` option through `dragConfig` and `resizeConfig`. The default
remains unchanged. Both module formats, declaration formats and the GridItem memo
comparison carry the option. The processing callback includes its dependencies.

Paprika disables this workaround because its handles already prevent native text
selection. The workaround otherwise adds/removes a body class and installs
`*::selection { all: inherit }`, recalculating thousands of chart descendants on
press/release. The canvas instead owns one transparent gesture surface; chart
inspection and text selection are restored on drop.

The patch applies with `npm ci`/`npm install` and fails installation on a mismatch.
Keep the grid version pinned. On upgrade, prefer an upstream option if available;
otherwise review and regenerate the patch against the new source. Do not silently
drop it. `insights-edit-performance.e2e.mjs` exercises actual drag and resize
handles, rejects the global selection stylesheet/class, checks no queries are
issued, inspects a chart after release, and saves/reloads the changed layout.

The production fixture contains 12 panels, three 500-record maps/honeycombs,
a record table, and eight time-series panels of 8 × 2,000 raw samples. Run it
without other browser suites or builds in parallel. Timing is diagnostic;
interaction, selection, persistence and reduced-motion assertions gate CI.
