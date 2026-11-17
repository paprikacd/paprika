# Synthetic telemetry contract

This evaluation uses deterministic synthetic data for a fictional checkout API. It does not query Paprika providers or report a live service. The fixture is designed to expose chart and interaction defects, including missing intervals and quiet-service behavior.

## Population and time

- Three regions: `ap-southeast-2`, `us-west-2`, `eu-west-1`.
- Sixty one-minute intervals ending `2026-10-30T05:00:00Z` in revision zero. Runtime timestamps are epoch **milliseconds**. Each sample represents `(timestamp − 60 seconds, timestamp]`.
- A new revision advances the window by one minute; retained observed values remain deterministic for their absolute interval.
- The synthetic deployment occurs at `04:28Z`. The regression fixture changes the Sydney distribution beginning in the interval ending `04:31Z`. This is supplied scenario context, not evidence of real-world causality.
- Range and region filtering occurs before semantic summaries. Presentation width is not an input to these summaries.

## Distributions, rates and ratios

Histogram counts are **disjoint**, with millisecond upper bounds `50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2500, 5000`. Synthetic observations are bounded at 5,000 ms; there is no dropped overflow population. Every observed histogram sums exactly to its interval's integer request count. Quantiles pool compatible counts first and use linear interpolation inside the selected bucket. They are histogram estimates, not exact raw request quantiles. No per-region percentile averaging is used.

Request rate is the collected interval request count divided by 60 seconds. Error ratio is the sum of failed requests divided by the sum of eligible requests. Its data representation is a fraction; a percentage-valued chart adapter must multiply by 100. Zero requests produce an undefined error ratio and undefined latency quantiles, with a known request rate of zero.

## Missingness and coverage

The gaps scenario has five missing middle intervals and three missing final intervals across all regions at revision zero. Missing observations use `null` for counts, buckets and derived values. An aggregate fleet interval is unavailable if any selected region is unavailable. It does not silently sum a subset into a full fleet total.

Window totals and pooled quantiles describe the **observed population**; summary coverage states the observed/expected region-interval ratio. A partial total must be labelled as observed. Mean fleet request rate uses only fully observed intervals. A completely absent population yields null totals, not zero. `latest` names the final requested interval, while `latestObserved` names the last fully observed historical interval. Their timestamps may differ. Stale-tail fixtures deliberately exercise that difference.

The quiet scenario contains collected zero counts in most intervals and occasional one-to-four request observations. Latency has gaps during zero-traffic intervals because no distribution exists there; traffic itself remains measured zero.

## Comparison windows

Comparisons use adjacent, equal-duration windows of whole one-minute intervals ending at the selected end time. For a 60-minute range these are 30 and 30 minutes; for 30 minutes, 15 and 15. For a 15-minute range these are 7 and 7 minutes, excluding the leading minute from the comparison only. The returned comparison metadata declares that exclusion. Both sides retain independent coverage. A relative change from zero or unavailable data is undefined; an error ratio difference is explicitly in percentage points.

## Test scope

The numerical tests validate fixture generation, pooling, ratio weighting, null/zero separation, coverage, filtering, units, equal comparison windows and malformed-input rejection. Browser checks must separately establish KPI invariance under resize and ensure the production renderer preserves missingness, isolated observations, identity, and exact-value access. Unit fixtures do not establish runtime or accessibility conformance.
