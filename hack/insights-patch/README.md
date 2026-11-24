# Insights patch applier

Reviewed repairs for live dashboards and saved queries. Every dashboard change is
merged with the same code the UI uses (`ui/src/features/insights/dashboard-patch.ts`),
checked against the Go port by `docs/design/insights/conformance/dashboard-patch.json`.

## Usage

```sh
export PAPRIKA_OBSERVE_URL=https://<observe host>/observe/mcp
export PAPRIKA_OBSERVE_TOKEN=<write-capable Observe token>

node hack/insights-patch/cli.mjs set.json                       # plan only, writes nothing
node hack/insights-patch/cli.mjs set.json --apply --receipt r.json
```

The plan reads every target first. It stops before any write when a target is
missing, an `expect` value differs, an edit cannot be applied, or the merged
dashboard has a lint error. Apply writes in set order, reads each result back and
compares it with the plan. The first failure stops the run. Nothing is retried, so a
conflict means: read the document again and review the new state.

The receipt records each item's state (`planned`, `unchanged`, `updated`, `failed`),
the before and expected documents, the ETags, the widget changes and the placements.
It never contains the token.

## Patch set

```json
{
  "version": 1,
  "description": "What this set repairs and why",
  "dashboards": [
    {
      "id": "service-overview",
      "message": "Commit message shown in the audit trail",
      "expect": { "title": "Service overview" },
      "widget_edits": [{ "op": "update", "id": "rate", "patch": { "unit": "req/s" } }]
    }
  ],
  "savedQueries": [{ "id": "request-rate", "patch": { "description": null } }]
}
```

- A dashboard takes `patch` (dashboard fields only), `widget_edits`, or both.
  `widget_edits` use the same operations as `patch_dashboard`: `update`, `add`, `remove`.
- `expect` maps top-level fields to the values the reviewer saw. A mismatch blocks the plan.
- A saved query takes a `patch` as a JSON Merge Patch. `null` deletes a key.
- `null` in a patch removes a key; arrays are replaced whole.

## Reverting

Each receipt item holds `before` and `beforeEtag`. To revert, build a set whose
`widget_edits` (or `patch`) restores those values, then run it with the ETag the
document has now. A fresh read is required, so a concurrent edit is not overwritten.
