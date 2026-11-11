# Operational dashboard presentation

`patches.json` contains reviewed widget edits for three existing dashboards.
It is input for Paprika Observe's `patch_dashboard`, not a seed document or an
automatic startup migration. The [presentation browser suite](../../ui/e2e/insights-presentation.e2e.mjs)
exercises these same settings with explicitly synthetic observations.

The on-call reading task is to compare CPU and memory over the same time range,
then distinguish request volume, response classes and latency percentiles.
Equal-width, six-row resource panels reserve useful plot height above their
statistics tables. Latency and response series take the semantic series roles
(p50, p95, p99, client-error, server-error), which are palette slots rather than
status meanings, and the stat and trend colours fall back to the palette. Exact
label rules keep identities stable when the backend reorders series. Queries, units, thresholds, variables,
refresh cadence and missing-data policies are unchanged.

The three Service overview trends share a latest-value legend row. Two redundant
series descriptions are removed so their plotting edges align.

Apply only after the matching UI release is deployed:

1. Discover providers and the canonical dashboard/widget schemas. Read each
   current dashboard, inspect its layout and query bindings, and capture its
   existing rendering. Review these edits against any intervening changes.
2. Call `patch_dashboard` with that document's exact current `etag` and the
   corresponding edits as `widget_edits` (each edit uses `op: "update"`). Never
   retry a conflict without rereading and reviewing the new document.
3. Read back and compare the entire document to the expected targeted merge.
   Query each dashboard sequentially with bounded results, then inspect actual
   renders at 1512, 768 and 390px in both themes, including a pinned inspector.
   Record freshness and partial results separately from visual quality.

The resource panels gain one grid row; subsequent rows move down by one to avoid
overlap. No other layout or presentation field is replaced. If reverting, use
the recorded before values and a fresh ETag, preserving concurrent edits.
