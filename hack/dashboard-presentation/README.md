# Operational dashboard presentation

`patches.json` is a patch set for the [insights-patch applier](../insights-patch/README.md).
It holds reviewed widget edits for three existing dashboards. It is not a seed
document or a startup migration. The [presentation browser suite](../../ui/e2e/insights-presentation.e2e.mjs)
applies the same set to synthetic fixtures through the shared merge, so the
suite and a live apply cannot drift.

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

The memory panels deliberately omit `legendPosition`. The plugin default is
`"bottom"`, so they match the table legend without an explicit value. The CPU
panels set `legendPosition` in their patches.

Apply only after the matching UI release is deployed:

1. Plan. Run the CLI without `--apply`. It reads each dashboard, checks its ETag,
   merges the edits, lints the merged result and prints each widget's changed
   fields. Review these against any intervening changes.

   ```sh
   PAPRIKA_OBSERVE_URL=… PAPRIKA_OBSERVE_TOKEN=… node hack/insights-patch/cli.mjs hack/dashboard-presentation/patches.json
   ```

2. Apply. Add `--apply --receipt <file>`. Each write uses the exact ETag from the
   plan, is read back and compared with the planned document, and stops the run on
   the first conflict. Never retry a conflict without rereading and reviewing the
   new document.
3. Verify. Query each dashboard sequentially with bounded results, then inspect
   actual renders at 1512, 768 and 390px in both themes, including a pinned
   inspector. Record freshness and partial results separately from visual quality.

The resource panels gain one grid row; subsequent rows move down by one to avoid
overlap. No other layout or presentation field is replaced. To revert, use the
receipt's recorded `before` values with a fresh ETag, preserving concurrent edits.
