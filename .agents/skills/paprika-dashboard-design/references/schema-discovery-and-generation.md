# Schema discovery and dashboard generation

## Contents

- Separate source, visual and document contracts
- Discover source meaning with evidence
- Make renderer requirements discoverable
- Bind fields before promoting a preview
- Generate through the canonical document
- Preserve interaction and edit ownership
- Evaluate adversarial inputs

## Separate source, visual and document contracts

Use three maintained owners, joined by validation:

| Contract | Authority | Question answered |
| --- | --- | --- |
| Available data and queries | Existing Observe/provider/query layer and bounded results | What exists in the authorized scope, and what does it mean? |
| Installed visuals | Trusted widget registry, configuration schema and semantic adapter | What can this renderer interpret, display and emit in this host? |
| Saved dashboard | Existing versioned Dashboard/Widget schema and persistence owner | What can be saved, reopened, migrated and reproduced? |

Keep intermediate plans and discovery snapshots separate from the saved document. Do not create a parallel persisted dashboard format or serialize React/parser functions. Export a whitelisted machine-readable projection where useful; retain authoritative runtime validators. Treat capability-manifest and compatibility-hook names below as responsibilities, not verified current APIs.

Distinguish source availability, registered renderer, authorable widget, portable composition and live provider integration. A hand-composed React lens can demonstrate strong interaction while its full workflow remains unavailable to saved documents. Record that boundary.

## Discover source meaning with evidence

Use the current Observe workflow for live discovery. Resolve the intended provider, authenticated scope and time range; reuse maintained discovery/query scheduling. Read provider capabilities before selecting a transport or query language. A provider name or fixture is not evidence that a metric exists.

Discover progressively: inventory → selected dataset/metric metadata → bounded labels/fields → representative result → semantic binding. Avoid fetching every label value or a large raw dataset to populate a picker. Preserve pagination, truncation, cost limits, cancellation and source revision. Cache by authenticated scope, provider identity and applicable schema revision.

Record known meaning and its provenance:

| Descriptor | Required context |
| --- | --- |
| Fields | Stable key/path, label, scalar type, nullability and representative values |
| Meaning | Metric kind/dataset family, base unit, valid conversion, population/denominator |
| Grain | One row per sample, cohort × age, entity × time, interval, hierarchy frame or event |
| Identity | Stable entity/composite key, uniqueness and parent relationships |
| Time | Epoch unit, elapsed time or cost offset; timezone, cadence, extent and aggregation |
| Coverage | Freshness, missing/stale values, partial/truncated output and effective limits |
| Provenance | Provider declaration, saved-query contract, user assertion or bounded sample inference |

Label inferred candidates as inferred. A name or finite sample cannot prove unique identity, exhaustive cardinality, denominator meaning or complete coverage. Metadata/label discovery can outlive observations in a selected window; confirm actual sample availability before claiming a working panel.

A numeric `start` can mean flamegraph cost position, elapsed milliseconds or epoch time. A numeric `value` can mean a counter, cumulative bucket, ratio, money or raw observation. Primitive type alone does not establish semantic compatibility.

## Make renderer requirements discoverable

Inspect current owners before extending them. Preserve installed plugins through additive, versioned changes where possible. Derive configuration structure from the maintained validator; add semantic/UI annotations for facts structural schemas cannot express. Avoid an unrelated schema with different bounds/defaults.

Expose from the registry owner:

- Stable renderer ID/version, description and input kind/family.
- Strict serializable config schema and field grouping/help.
- Required/optional roles, scalar types, units, grain and identity.
- Named semantic invariants and a trusted pure compatibility/adapter function.
- Implemented style controls, states and fixture/example references.
- Layout mode, useful dimensions, plot/legend/inspector slots and overflow policy.
- Interaction inputs/outputs and required host capabilities, including readonly/embedded behavior.
- Effective transport, normalized-frame, semantic-model and rendered-mark budgets.

Derive chart choices, mapping controls, catalogue descriptions, sizing and generator tools from these definitions where feasible. Reference fixture modules by stable example IDs. Keep executable code trusted; export descriptions and schemas only. Validate that every advertised example resolves to an installed owner.

JSON Schema validates structure. Execute trusted semantic code for cost conservation, DAG validity, interval overlap, units and weighted populations. Advertising a named check is not equivalent to executing it.

| Family | Required meaning | Reject or request repair |
| --- | --- | --- |
| Distribution | Group plus raw observations; one row per sample | Means/quantiles treated as raw samples; absent mapped column |
| Cohort matrix | Cohort, age, original size, retained count, observed state | Changing denominator; retained > population; future treated as zero |
| Aggregate flamegraph | Ancestry, inclusive/self cost, cost offsets and unit | Broken cost accounting/containment; time inferred from cost offsets |
| Sampled flamechart | Actual start/end, thread and stack ancestry in time units | Aggregate-only input; within-thread overlaps; invented gap filling |
| Allocation treemap | Stable entity, nonnegative area measure, hierarchy, valuation/currency | Signed return as area; incompatible currencies; wrong share population |
| Geographic map | Coordinate roles/projection, entity identity, declared value meaning | Arbitrary numbers treated as coordinates; ambiguous duplicate IDs |
| Resource Gantt | Tasks/resources, intervals, dependencies and constraints | Cycles/precedence conflicts; editing without a proposal host |

For profiles, retain format-specific meaning. Aggregate Flamebearer/folded input supplies no elapsed chronology. Speedscope sampled intervals require reconciled time weights; byte allocations remain bytes. Declare accepted subsets and effective UI bounds; a private parser limit does not enlarge the normalized host budget.

## Bind fields before promoting a preview

Assess proposed config against the descriptor and actual bounded result. Return compatible, needs mapping, or incompatible with structured diagnostics: role, configured field, observed type/unit, required meaning, candidate repairs. Never silently substitute a default mapping.

Provide role → field controls filtered by actual scalar type, with unit and sample context. Ask the user to resolve material ambiguity when evidence is insufficient. Expose an explicit supported transform if needed; a display suffix does not perform a conversion.

Keep three statuses distinct: configuration parses; binding interprets this result correctly; intended source/query executed successfully. Promote last-valid preview only after applicable config and compatibility checks. Revalidate when config, renderer, mapping or source revision changes; bound/memoize expensive model work. Mark pending-data compatibility unverified. Preserve draft and prior valid preview on failure and mappings when switching to a table and back.

A faithful record table can remain a fallback, but do not silently replace the requested chart and call the task complete. Explain the missing mapping or capability.

## Generate through the canonical document

1. Establish audience, operational question, population/time and decision.
2. Capture relevant source discovery and installed visual capabilities with revisions.
3. Bind real source meaning to chart roles; resolve transforms/queries through current owners.
4. Plan evidence roles and a suitable composition. Avoid a universal four-KPI/equal-card layout.
5. Allocate readable plot area and responsive priorities from family requirements. Declare selected/degraded states and interaction scope.
6. Compile existing Dashboard/Widget values, query references/bindings, variables, placement and supported interactions.
7. Validate structure, semantic binding, numerical invariants and effective resource budgets.
8. Render the actual registered owners used by the product/editor at representative sizes and states.
9. Repair through scoped document patches, preserving stable IDs, queries, mappings and unrelated user edits.
10. Apply/save through the authorized draft/persistence owner and verify reload when durable saving is in scope.

Treat typed recipes as compiler inputs, not a competing saved format. Prove export/reopen with contrasting compositions before claiming general generation. If the canonical document cannot express linked state, either extend its maintained owner with tests or identify that behavior as scene-only. Do not present custom React workflow generation as a portable JSON capability.

Continue through routine compatible cases automatically. Ask only about unresolved meaning that materially changes the result and cannot be established from authorized sources. Keep rationale and diagnostics accessible without a mandatory approval ritual.

## Preserve interaction and edit ownership

Distinguish inspect, highlight, local filter, shared query scope, navigation and proposed data change. Declare the identity/set, source/target panels, affected population, clear/reset and result-replacement behavior. Hover or camera movement must not become a query or document edit.

Keep scheduling/design changes host-owned: baseline → proposed diff → validation → Apply/Discard → bounded Undo. Standalone or embedded charts remain readonly without the required host. A generic context callback does not establish arbitrary editing support.

For regeneration, compute a scoped patch against a known document revision. Preserve invalid unsaved drafts and detect conflicts rather than overwriting work with defaults. Keep query execution and durable-save status explicit.

## Evaluate adversarial inputs

- **Latency and availability:** cumulative seconds buckets, per-instance millisecond quantiles, mismatched labels/populations and missing tails. Require proper distribution pooling, actual conversion and coverage.
- **Profile chronology:** aggregate byte costs and an independent sampled-time profile. Preserve aggregate meaning and real time gaps/threads; do not invent chronology or unsupported exports.
- **Schema change during editing:** renamed fields, missing value column, duplicate IDs, invalid draft and a newer saved revision. Require repairable diagnostics, scoped patches and draft/conflict recovery.

Use raw artifacts for independent generation tests. Record discovery grounding, canonical validity, analytical truth, visual readability, actual interaction, export/reopen and resource use separately. A screenshot does not establish source provenance or document portability.
