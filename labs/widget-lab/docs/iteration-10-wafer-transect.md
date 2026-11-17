# Wafer Intelligence: physical cross-section widget

## Question and ownership

`wafer-transect` asks how observed electrical leakage changes along a physical row or column through a selected die. It supplements the spatial die map: the map identifies a pattern; the section exposes its magnitude and missing observations on an exact physical axis.

The registered owner is `src/charts/wafer/WaferTransect.tsx`, with pure adapters in `model.ts`. It uses the established `Widget` / `QueryResult` host, scoped Gamma tokens, shared plot measurement, inspection lifecycle and domain panel. It appears independently in the chart catalogue and below the lot thumbnails in Wafer Intelligence.

## Semantic and editing contract

- Source fields for horizontal position, vertical position and leakage can be mapped to renamed columns. Their roles require number/mm, number/mm and number/nA respectively. Mapping does not modify the source. The established wafer adapter still checks grid/coordinate agreement, unique physical positions, wafer dimensions, test-state meaning and process ordering.
- Row/column indices are physical identities. They are independent of input ordering and array position. A configured section must have supplied die records. An invalid index blocks the editor preview rather than silently choosing another row.
- Following selection uses the selected die's row or column. With no applicable selection, the configured index is used. Fixed sections keep their scope while another die is selected.
- The spatial axis retains the wafer radius in millimetres. Measured values retain exact supplied leakage. Linear scale includes zero. Log scale rejects a selected section containing measured zero.
- Connections join adjacent grid positions only. Null measurements and absent physical slots break the path. No interpolated measurement or invented missing-row record is created.
- Untested, tested without a leakage measurement and edge-excluded positions remain distinct. All unmeasured positions appear in a labelled lane outside the numeric scale. Median and observed counts exclude nulls; the eligible denominator excludes edge positions.
- The adjustable leakage reference affects presentation only. It never changes supplied final test bins or global wafer yield.

Implemented controls include field mappings, section direction, follow-selection, fixed index, linear/log scale, adjacent connections, grid and reference visibility/value. Only tooltips and legend are advertised as generic style controls.

## Interaction and composition

The chart shares the selected die with the map and process-history panels. Hover/focus gives transient evidence; click or Enter pins it. One roving SVG tab stop supports arrow navigation and Home/End. A labelled die selector and paged exact table provide pointer alternatives. The table shows twelve rows per page inside a bounded scroll region. Embedded rendering remains passive.

The header identifies the actual row/column and its fixed millimetre coordinate. Quantitative leakage uses bin-coloured points, a quiet adjacent-sample trace and a separate amber reference. A concise summary exposes the measured population and the three unavailable/excluded counts. At narrow widths, controls and captions wrap and the exact table owns its horizontal scrolling.

## Executed verification

- All 28 tests in `wafer-model.test.ts`, `wafer-renderers.test.ts` and `wafer-transect.test.ts` passed.
- Whole-project TypeScript validation passed after integration.
- After final presentation/pagination refinements, all 16 tests in `wafer-renderers.test.ts` and `wafer-transect.test.ts` passed again.
- `git diff --check` passed.
- Independent test data uses different wafer/die identities, reversed row order and renamed coordinates/leakage fields. Observations and original source frames are preserved.
- Targeted tests cover physical row/column selection, fixed versus linked scope, missing and absent slot gaps, eligible population accounting, measured zero, invalid indices, invalid/mistyped/wrong-unit bindings, coordinate disagreement and a passive embedded renderer.

Browser interaction and visual evidence are recorded by the integrating task. The checks above do not establish physical touch, assistive-technology, production performance or durable dashboard persistence. The source remains the deterministic synthetic wafer fixture.
