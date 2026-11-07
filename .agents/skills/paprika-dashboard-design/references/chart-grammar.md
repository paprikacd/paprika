# Chart grammar and analytical truth

## Contents

- Question-to-encoding map
- Time and metric semantics
- Summaries, units, and comparisons
- Axes, density, and missingness
- Specialized chart contracts

## Question-to-encoding map

Treat this as selection guidance. Check current registry capabilities before proposing a renderer.

| Analytical question | Useful starting point | Required meaning | Common failure |
| --- | --- | --- | --- |
| How did a signal change? | Time-series line | Time x-axis; labelled measure; gap policy | Spline invents extrema; sparse data stretched to whole window |
| What is its current or window value? | Stat with optional sparkline | Reducer, timestamp/window, unit, freshness | Last finite sample presented as current; sparkline changes stat |
| Which entities differ most? | Sorted horizontal bars or dot plot | Comparable unit, population, order | Truncated bar baseline; colors change with rank |
| How much of a known capacity is used? | Linear/segmented or compact radial meter | Numerator, denominator, limit policy | Arbitrary maximum; normalizing overcapacity to 100% |
| How do components contribute over time? | Stacked bars/areas | Additive disjoint components; aligned time | Missing series treated as zero; hidden individual variation |
| How is latency distributed? | Histogram; distribution heatmap over time | Bucket bounds, counts/rates, density/color scale | Treating cumulative buckets as disjoint frequencies |
| When did a state change? | State timeline or state-history matrix | State duration or explicit sampled-state policy | Interpolating categorical states; fabricating continuity |
| Which entities are currently unhealthy? | Status matrix/heatmap | Latest sample per entity; missing state | Mistaking a status heatmap for a time-distribution chart |
| Are two measures associated? | Scatterplot | Same entity/time population; meaningful units | Inferring causality; joining mismatched time samples |
| What exact items or values matter? | Table | Units, sorting, bounded navigation | Decorative chart where exact comparison is the task |
| What contributed to trace duration? | True span waterfall | Start offset, duration, parentage and incomplete spans | Relabelling a list of trace summaries as a waterfall |
| How do components connect? | Directed topology/pipeline diagram | Real nodes/edges, direction, state, drilldown | Invented links; line width implies unmeasured traffic |
| Where is the signal? | Supplied-coordinate map | Valid supplied locations and geographic measure | Invented coordinates or location precision |
| On which days did events occur? | Calendar | Explicit timezone/day boundary and coverage | Empty day shown as healthy despite missing observations |

Use a donut only for a small, genuinely compositional whole where approximate shares are sufficient. Prefer bars for precise comparison. Avoid 3D perspective and decorative area distortion. Do not interpret “advanced” as a requirement for an exotic chart.

## Time and metric semantics

### Declare the kind before formatting

- **Gauge:** an observation at a time; choose last/mean/max according to the decision. A mean of irregular samples is not necessarily a time-weighted mean.
- **Counter:** cumulative state with resets. Display the total only when that is the question. For throughput, compute a rate in the source/query layer.
- **Ratio:** a numerator and denominator over the same population/window. For a fleet error ratio, sum errors and requests then divide; do not average instance percentages.
- **Distribution:** bucketed observations or compatible distributions, not an ordinary list of rates. State bucket/count/rate semantics.
- **Quantile:** an estimated location in a population distribution. Preserve percentile, time window, and aggregation basis. Do not average p95s.
- **State/event:** categorical values and event timestamps. Do not apply continuous interpolation without an explicit domain contract.
- **Trace/record:** a bounded set may be a sample, not a complete population. A row count from a capped response is not a system total.

### Prometheus examples

Discover actual metrics, labels, histogram type, scrape interval, and provider capabilities before using these illustrative expressions. The names below are examples.

```promql
sum by (service) (rate(http_requests_total[5m]))
```

Apply `rate` to each counter before summing so an instance reset remains visible to the rate calculation. Choose the window from the scrape cadence and analytical purpose; do not hard-code five minutes as a universal rule.

For compatible classic histogram buckets:

```promql
histogram_quantile(
  0.95,
  sum by (service, le) (
    rate(http_request_duration_seconds_bucket[5m])
  )
)
```

For compatible native histograms, where the provider supports them:

```promql
histogram_quantile(
  0.95,
  sum by (service) (
    rate(http_request_duration_seconds[5m])
  )
)
```

Do not mix these input models or average precomputed summary quantiles. Convert units after the semantic calculation, including the accompanying thresholds.

### Time contract

Keep these separate: selected range, query evaluation step, scrape/sample cadence, rate window, aggregation bucket, refresh cadence, and displayed timezone. They are not interchangeable.

Use timestamped observations, sorted without mutating source data. Define duplicate timestamp resolution and reject non-finite values. Align by actual timestamp or an explicit shared binning rule; never zip arrays from differently sampled series. A nearest-point tooltip must report the actual observation time and respect a maximum time tolerance. No sufficiently near sample means no sample.

Inspect timestamp units at boundaries: Paprika query requests use Unix seconds, while its chart sample model consumes epoch milliseconds. Convert deliberately in the existing adapter, not by guessing magnitude or changing only labels.

Verify channel types at a chart library's temporal-scale boundary. A calendar-aware scale factory may require `Date` channel values even when normalized timestamps are numeric. Adapt the plotting channel while retaining the exact numeric timestamp on the datum for identity, cursor synchronization, and inspection. Compile a real chart scene and check its time domain, ticks, and selected observation; a successful type check or an isolated scale call does not prove the scene accepts the channel.

Expose material panel time overrides. Compare equal-duration windows unless the question intentionally compares calendar periods. Specify whether an overlay aligns by elapsed time, calendar position, or another meaningful axis. Calendar periods and local days may differ in duration across daylight-saving changes; do not silently label a fixed 24 hours as every local day.

## Summaries, units, and comparisons

### Separate meaning from drawing

Use the pipeline: source observations → semantic transformation → canonical result/statistics → display reduction → marks. Tooltips must point to represented observations; exported exact values and semantic summaries must not be recomputed from the display-reduced path.

A renderer may show fewer marks when narrow. Its KPI must remain equal for the same source/window. If the source changes resolution in response to width, obtain summaries using a stable semantic query or a fixed aggregation contract. A fixed point count alone does not prove correct totals or percentiles.

### Conversion and precision

Paprika's current `unit` option is a label suffix. Seconds to milliseconds requires multiplying by 1000 in the query or adapter; it also requires converting domain bounds, thresholds, tooltip values, exports, and reference values consistently. Do not double-convert a query that already returns milliseconds.

Distinguish decimal bytes (kB/MB/GB) from binary bytes (KiB/MiB/GiB), bits from bytes, percentage values (0–100) from fractions (0–1), and counts from rates. Choose a consistent compact formatter per comparable plot, not different magnitude prefixes that obscure direct comparison. Make exact values inspectable.

Round for reading, not computation. Avoid a rounded “0%” that masks a material low error rate; use appropriate precision or a labelled bound such as “<0.01%” when warranted. Avoid invented decimals for estimated quantities. Use a documented signed-zero policy.

Define a delta's comparison, direction and unit. A change from 20% to 25% is +5 percentage points or +25% relative; name the chosen quantity. If the comparison is zero or unavailable, do not emit Infinity, a fabricated 100%, or a healthy badge. Negative is not inherently good; evaluate direction using the actual measure.

### Thresholds and uncertainty

Attach thresholds to a named user policy, limit, SLO, or documented source. Show the relevant window and denominator. Do not invent an 80% critical CPU threshold or a universal latency SLO.

Represent an SLO burn rate relative to the defined budget. Keep alert state, service health, and data availability separate. Treat zero traffic explicitly rather than claiming 0% errors proves good service.

Show prediction/uncertainty bands only when supplied or calculated by an identified method. Label estimates, samples, and partial coverage. An event near a spike supports investigation, not an automatic causal claim.

## Axes, density, and missingness

- Include zero for absolute-length bars and filled magnitude areas. Signed bars include the appropriate positive/negative extent. Range bars representing intervals use their own explicit endpoint semantics.
- A cropped line/scatter domain may reveal useful variation. Label it; compare small multiples on shared domains unless independent domains are explicitly disclosed.
- Use log scales only for a valid positive domain and a multiplicative question. Handle zero/negative values explicitly; never silently drop them. A symlog proposal needs a labelled transform and actual support.
- Use labelled reference lines/bands for meaningful limits. Keep relevant breaches visible even when autoscaling; show clipping if outliers are intentionally excluded.
- Prefer horizontal reference grids; add vertical geometry only when time reading needs it. A grid should not resemble another series.
- Do not connect through missing data by default. A large cadence gap without an explicit null still requires a policy. Do not extend a line to now when the latest observation is old.
- Reduce ticks before label size. Keep endpoint and important threshold meaning. Avoid repeated rotated labels as the default solution.
- For many entities, use meaningful aggregation, search/filter, small multiples, a sorted table, or top-N with explicit selection and omitted remainder. Only sum an “Other” group for an additive measure; never invent “Other p95.”

## Specialized chart contracts

**Stacking:** stack only compatible additive quantities on aligned timestamps. Define treatment of incomplete contributions; never turn absence into zero silently. Use separate positive and negative baselines. Normalized 100% composition must state what denominator is present and whether coverage is complete. Show individual values and totals accurately in inspection.

**Directional traffic:** mirror outbound geometry only with explicit direction labels. A signed display transform may show `-outboundMagnitude` in the plot and inspector when both identify the series as mirrored egress and make the sign convention clear. Retain positive outbound magnitude in fixture/provider rates, accounting, exports, and drilldowns. Treat any signed display `QueryResult` as a presentation view; never reuse it as the raw metric source for totals, ratios, export, or navigation. Name mini-history statistics for the selected mirrored series rather than generic “History.” Signed min/max describe the displayed values; the most negative value represents the largest outbound magnitude.

**Distribution heatmaps:** distinguish cumulative bucket boundaries from disjoint bins; difference cumulative buckets exactly once. Validate monotonic counts, bounds, and compatible schemas. State whether color is count, rate, fraction, or density. If bucket widths vary, do not imply equal-width density without normalization. Keep overflow/+Inf interpretation explicit.

**Gauges:** a bounded capacity has a real denominator and an over-range treatment. Arc/segment geometry must match the measured fraction. Gauge thresholds must express configured limits; a decorative gradient is not a health model.

**State timelines:** choose whether a state persists until the next event, expires after a cadence limit, or is merely sampled. Encode unknown intervals and exact transition times. Do not turn an event list into a continuous uptime record.

**Waterfalls and traces:** align start offsets and durations to a shared time axis. Do not sum overlapping spans into elapsed time or invent missing parent spans. Distinguish sampled traces from aggregate request latency.

**Maps, topology, calendars:** use supplied facts; validate coordinates, identifiers, edge direction, timezone, and coverage. Differentiate absent topology from an empty system and missing days from healthy days.

See [research sources](research-sources.md) for primary rationale. These chart-selection defaults are project guidance, not universal accessibility standards.
