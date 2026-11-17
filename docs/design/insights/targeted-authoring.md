# Schema discovery and targeted MCP authoring

Paprika Observe can build and edit the same persisted documents used by Insights.
It does not maintain a second dashboard model. Read the deployed contract with
`get_insights_schema({"kind":"dashboard"})`, `widget`, or `saved_query`.
The result includes the full JSON Schema, canonical examples and notes on
validation that JSON Schema cannot express. Replace example provider IDs with
IDs returned by `list_insights_providers`.

Schema discovery requires `paprika:observe` and Insights read permission.
Every write also requires explicit `paprika:insights:write` consent and Insights
write permission. These tools grant no provider configuration or fleet writes.

## Edit only selected fields

Read the document and ETag first. Then send only the intended changes:

```json
{
  "name": "patch_saved_query",
  "arguments": {
    "id": "service-request-rate",
    "etag": "\"<exact ETag from get_saved_query>\"",
    "patch": {
      "description": "Requests per second for the selected service",
      "tags": ["service", "traffic"],
      "metadata": {"owner": "platform"}
    }
  }
}
```

Patches follow object merge semantics: omitted fields remain intact, nested
objects merge, `null` removes a field, and arrays replace as a whole. Use `null`
only when removal is valid; required fields cannot be removed. Query expressions,
parameters, descriptions, tags and metadata use the saved-query schema.
Document `id` and `schemaVersion` are immutable. Saved-query `providerId` and
`kind` are also immutable through patches; create a new query when changing
its identity. Existing full-document updates retain their compatibility checks.

## Edit dashboard widgets by ID

```json
{
  "name": "patch_dashboard",
  "arguments": {
    "id": "service-overview",
    "etag": "\"<exact ETag from get_dashboard>\"",
    "patch": {"description": "Core service signals", "folder": "Services"},
    "widget_edits": [
      {
        "op": "update",
        "id": "request-rate",
        "patch": {
          "title": "Request rate",
          "options": {"decimals": 2, "showSparkline": true}
        }
      }
    ]
  }
}
```

The dashboard `patch` cannot replace `widgets`. Use `widget_edits` instead:

- `update` takes an existing `id` and object `patch`; the widget ID is immutable.
- `add` takes a complete canonical `widget` with a new ID and appends it.
- `remove` takes an existing widget `id`.

A batch permits at most 48 operations, with one operation per widget ID.
Untouched widgets and their order remain intact. Layout, options, tooltips,
links, saved-query references and explicit bindings use the canonical widget
schema. Dashboard variables use the canonical dashboard schema; their array
replaces in full, so retain other variables when editing it.

## Concurrency, validation and UI synchronization

The gateway reads the current document through the authenticated UI proxy,
compares its exact strong ETag with the supplied ETag, applies the edits in
memory, then conditionally saves once using that same caller ETag. A change
between read and save still conflicts. There is no automatic retry, wildcard
overwrite or partial batch save. Reread and review both changes after a
conflict, then submit the revised intent with the new ETag.

The final document goes through the existing Insights validation and store.
Saved-query provider authorization and reference compatibility remain enforced.
Dashboard imports may retain unresolved references for portability; saving a
dashboard is not proof of provider access or available data. Execute
`query_dashboard` to validate its signals.

Patches are bounded to 32 levels of nesting. Final dashboard and saved-query
documents retain their 256 KiB and 32 KiB limits. Unknown fields, invalid
layouts/options, missing widget targets and incompatible parameters reject the
entire change. Successful edits return the document, its new ETag and UI URL.
Empty patches and edits that leave the document unchanged are rejected without
creating a new document version.
Clean open views refresh through existing synchronization. Unsaved local drafts
remain local, and a stale draft save receives a conflict.

Whole-document deletion and provider configuration are not exposed here.

## Verification

`ui/e2e/insights-observe-authoring.e2e.mjs` exercises the authenticated MCP →
Insights → browser flow with deterministic telemetry, including concurrent
edit conflicts, atomic batches, saved-query re-execution and dirty drafts.
It runs in the normal CI browser gate.

For an authorized production acceptance run, provide a private
`INSIGHTS_SERVICE_OVERVIEW_CONFIG` file with `baseURL`, `mcpURL`, `tokenFile`
(console API token), `mcpTokenFile` (Observe and Insights write scopes),
`dashboardId`, `outputDir`, and `allowTemporaryWrites: true`, then run
`node ui/e2e/insights-targeted-authoring-live.e2e.mjs`. The source dashboard
must have the Service overview request-rate and service-traces saved-query
widgets and the uptime-api/brandbrain-api shared service variable. The test
creates unique temporary documents, validates real provider results and UI
refresh in both themes, and conditionally deletes only its own test documents.
Original documents remain unchanged; concurrent edits block cleanup.
Credentials are never included in reports or screenshots.
