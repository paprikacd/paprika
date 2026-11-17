# Chart families, anatomy and capability coverage

## Contents

- Establish actual support
- Map the visual families
- Define family-specific behavior
- Build a working coverage surface
- Promote gaps through existing owners

## Establish actual support

Inventory the visuals needed by the question and references before choosing libraries or laying out panels. Treat a chart capability as data transformation, configuration, rendering, interaction and verification together.

Record each selected family's support honestly:

| Support | Evidence required |
| --- | --- |
| Registered renderer | Imported on a clean application entry, resolved by the current trusted registry, accepts the current normalized input and validates configuration |
| Reusable primitive | Data-driven component with explicit props and behavior, independently demonstrated; not necessarily authorable through dashboard documents |
| Scene fixture | Hardcoded records, geometry or state for a reference study; useful as a visual acceptance target |
| Source available | Owner/schema exists in an inspected checkout, but runtime integration has not been demonstrated |
| Proposed | Identified need without a verified implementation |

Add separate evidence columns for static inspection, numerical/config tests, browser behavior and production integration. A family can be registered while its touch interaction or high-cardinality performance remains unverified. Do not collapse these into a single “supported” badge.

Use [Paprika integration](paprika-integration.md) to refresh the runtime. The starting owners below were inspected at upstream `bb52aed8ded8beb08534f6b190a3e7f37c1b19d8`; the widget lab may vendor and extend them. These paths and IDs are navigation aids, not a claim about a newer deployed build.

## Map the visual families

Paths are relative to `ui/src/features/insights/` in Paprika, or its documented vendor root in the lab.

| Visual / question | Starting owner and ID | Required anatomy | Contract that must be explicit |
| --- | --- | --- | --- |
| Summary + history: what is the current condition? | Built-in `stat`, `chart-renderers.tsx`, `stat-sparkline.tsx` | Label, value/unit, comparison, subordinate trace and freshness | Reducer, scope and comparison window; current missing tail versus historical finite value |
| Continuous history: when did it change? | Built-in `timeseries`, `chart-renderers.tsx` | Actual time scale, calibrated axes, line, optional contained fill, legend and observation state | Timezone, sample timestamps, gaps, interpolation, units, domain and exact-value source |
| Mirrored traffic: what enters and leaves? | `plugins/rich-metrics.tsx`, `directional-traffic` | Positive/negative halves, distinct zero, stable cyan/violet identity and named direction | Raw outbound magnitudes stay positive; sign inversion belongs only to the declared display |
| Outcome composition: what makes up the total? | `plugins/rich-metrics.tsx`, `stacked-timeseries` | Aligned time buckets, stable stack order, zero baseline, legend and component values | Exclusive additive categories, bucket boundaries, missing contributors, count/rate semantics |
| Distribution: where does the population lie? | `plugins/rich-metrics.tsx`, `distribution-heatmap` | Meaningful bucket edges, labelled ordered color scale, time alignment and exact bin inspection | Cumulative versus disjoint buckets, count/rate/density meaning, overflow, missing versus zero |
| Ranked quantitative records: which entities contribute? | `plugins/records.tsx`, `record-table` | Identifier, aligned exact value, common-scale bar, share and row operation | Numeric domain, denominator, sorting/ties, cap/partial state and original row identity |
| Target/capacity: how much margin remains? | `plugins/threshold-gauge.tsx`, `threshold-gauge` | Actual value, target/limit, continuous/segmented/radial mark and explicit accounting | Bounds and units, numerator/denominator, consumed versus remaining, overflow/exhaustion |
| State history: when was each entity in a state? | `plugins/metric-distributions.tsx`, `status-history` | Entity rows, declared sample bins or true intervals, stable state key and unknown treatment | Sample history is not automatically elapsed duration; cadence, aggregation and state persistence |
| Calendar evidence: which dates have events? | `plugins/operational-records.tsx`, `incident-calendar` | Correct month/day structure, count/severity cue, coverage and selected date | UTC event dates versus local episode overlap, timezone, no event versus no coverage |
| Geographic evidence: where is activity located? | `plugins/operational-records.tsx`, `connection-map` | Basemap, projected data, explicit color/size key, selection, camera controls and exact-data alternative | Supplied location precision, valid coordinates, aggregation, camera independence and unlocated counts |
| Exact event/request evidence: which records explain this? | `plugins/records.tsx`, `record-table` | Time, identity, severity/status, bounded text and detail actions | `QueryResult.records` / `RecordFrame`, cap disclosure, exact fields and valid drilldown context |
| Compound comparison rows: how do entities differ across signals? | Existing `record-table` cell owner plus typed extensions when absent | Identifier, exact value, miniature history, score/range and status in aligned columns | Per-column scale/meaning, stable row identity, declared score policy and supported cell types |
| Context and selected observation | Existing scales, cursor, tooltip and context owners | Threshold/event layer, guide, selected rings, inspector and named actions | Policy versus event versus observation, result identity, sample time, focus and invalidation |

Select other families—range marks, histograms, scatterplots, trace waterfalls, topology or treemaps—only when the analytical task warrants them and a verified contract exists. A broad family inventory does not mean every dashboard should contain every family.

## Define family-specific behavior

### Histories, directional plots and stacks

Keep an actual x-domain independent from the observed sample extent. Align related panels by timestamp. Preserve null segments and extrema before downsampling. Use common scales for genuinely comparable series and explicit separate tracks for incompatible units.

For an area, distinguish absolute magnitude from an interval envelope; do not fill a truncated y-domain in a way that implies magnitude from zero. For mirrored traffic, identify signed display values in the inspector and retain raw magnitudes for accounting and exports. For stacks, align components by actual bucket/time keys and retain missing contributions. Displaying narrower bars must not change source counts.

Give selected state the same semantic richness in the compact variant: exact timestamp or interval, relevant simultaneous values and units, entity scope, meaningful history and a reachable clear/detail action. Embedded histories must remain static and avoid nested inspectors or new queries.

### Quantitative tables and miniature charts

Treat each row as a compact comparison, not arbitrary decoration. Define a column's purpose, source field, formatting, domain, sorting rule and interaction. Preserve the exact number alongside a bar. Use one zero-based domain across comparable magnitude bars, or a declared capacity/percentage domain; a share bar normalized to the largest row does not encode percent of total.

Declare whether miniature histories share x/y domains. Shared-domain trends support magnitude comparison; independent-domain trends support shape comparison and need that limitation visible in inspection. Key trend data and colors by stable entity, never filtered/sorted row position. Avoid using status color to represent an unrelated categorical identity.

For country, trend-array, segmented-score and status cells, inspect the current table schema. The inspected `record-table` supports bar and color styles; those do not establish arbitrary sparkline/flag/segment support. Add bounded typed cell specifications through the same owner when required. Reject executable HTML/JavaScript templates from document data. Include a plain exact representation and keyboard row operation.

### Budget and target marks

Derive visible accounting from one semantic result. If a headline means “remaining” while a fill means “consumed,” label both; consider whether that mismatch adds reading effort. Show overrun and negative remaining values even when the track's painted length is bounded. For segmented marks, document quantization and whether a partial segment is allowed. Do not turn a fraction into an unrelated severity policy.

Keep time-based SLO budgets separate from request-based budgets. A reference fixture's illustrative bar length is confined to literal reproduction. A working capacity/gauge example must calculate the geometry from the declared minimum, maximum and value.

### State histories and context intervals

Decide whether marks represent samples, fixed aggregation bins or start/end intervals. Equal-width samples at irregular times are an observation sequence, not elapsed duration. A state-duration renderer needs ordered, non-overlapping interval bounds and an explicit persistence/unknown rule. Preserve brief failures when aggregating; a maximum-severity bin and duration-weighted availability answer different questions.

Keep the unknown pattern consistent across timeline, main plot and calendar, while explaining whether it means missing observations, incomplete coverage or unavailable classification. Exclude outside-window time visibly rather than calling it healthy.

A horizontal threshold rule does not implement an incident time band. Add typed temporal annotations through the scale owner: start/end, category, label, applicable scope and accessible exact details. Keep annotations clipped and aligned during zoom/resize. Do not imply that a nearby deployment caused an incident.

### Calendar and record linkage

Choose date semantics before aggregation. A UTC event calendar groups records differently from a local calendar of episodes overlapping each day. Handle midnight, daylight-saving changes and clipped query bounds according to the chosen model. Count distinct episodes when that is the question; do not count each hourly incident sample as a separate incident.

Declare the scope of a selected date. A local evidence filter should not silently change availability or the budget denominator. Provide month navigation, clear selection, accessible date names and an equivalent event list. A blank date cannot mean both “no incidents” and “no data” without another cue.

### Geography

Read [geographic charts](geographic-charts.md) for every map implementation or substantial change. Require genuine location data, one projection, bounded camera state, useful inspection, zoom/pan/reset and non-drag alternatives when navigation is in scope. Keep concept speckles and reconstruction geometry out of analytical results.

## Build a working coverage surface

Use a compact evaluation route or existing component workshop when substantial family work needs demonstration. Render the actual registered component through `WidgetVisualization`, using existing `Widget` and `QueryResult` types. Do not create another persisted dashboard schema for the catalogue.

Register dependencies deterministically at the supported entry point. Open the coverage route directly in a fresh session; visiting another route first must not be required to populate the registry. Parse each example through the same configuration owner used by the application. Test an invalid option so silent fallback cannot masquerade as support.

For each family demonstrate ready data, selected state, a relevant gap/unknown case and empty/error handling. Add wide/narrow panel and alternate theme when those variants are supported. Avoid a giant static gallery whose visual marks never receive changing inputs. Make the exact input/config available in evaluation details, outside ordinary dashboard chrome.

Capture emitted selection/context where the renderer supplies it. Verify any required timestamp or entity before using that event for drilldown; a source implementation may emit only a label/value. Distinguish local camera or legend changes from query-backed scope changes. Confirm embedded variants do not retain controls or nested inspection.

Keep a capability ledger with: family, exact owner/ID, support level, data kind, config fields actually exposed, missing behaviors, evidence and revision. Pair it with at least one independent data fixture per promoted family. Update the ledger after implementation; preserve historical audits as history rather than leave current support ambiguous.

## Promote gaps through existing owners

Prioritize missing behavior by the user's requested visuals and investigation path. Reuse the current chart engine and Gamma host. For the reference direction, common genuine gaps are reusable elapsed-time intervals, typed rich table cells, map navigation, and common observation contracts; verify the actual owner before implementing each.

When a lab vendors upstream code, preserve licenses and record the base revision, dependency closure and local diffs. Prove the imported owner compiles and renders with its normalized inputs. A copied map or calendar file is not an integration until its required schema, helpers, styles, registration and behavior work together.

Do not describe lab integration as upstream production delivery. State the remaining transfer explicitly and provide the owner changes/provenance needed to make that transfer concrete.
