# Portable dashboard bundles

Dashboard exports can include the saved-query definitions used by widgets and tooltip widgets. The destination reviews those definitions and provider mappings before creating dashboard copies. Connection URLs, authentication material, provider configuration, revision ETags and executable plugin code are never part of the bundle.

## Export and editing

- **Code → Export** validates the current source draft. A dashboard with saved-query links exports a bundle containing that edited dashboard and its exact query dependencies. A dashboard without saved-query links keeps the ordinary single-dashboard JSON/YAML export.
- **Manage → Export your library → YAML/JSON** exports the saved dashboard library and the exact union of its referenced saved queries. Unsaved canvas/source changes are exported through Code or saved first.
- Missing query definitions, incompatible kinds and invalid required parameter mappings block export with a concrete error. A partially portable file is not silently downloaded.
- The Code textarea remains a single-dashboard editor. Ordinary dashboard files load into its draft. Bundle files, legacy library files and pasted library documents open the same import review as Manage. **Back to source** restores the preserved editor draft; import choices are explicit. Replacing the clean active dashboard updates the canvas; an unsaved active draft must be saved or discarded before its saved dashboard can be replaced.

## Document contract

The existing library envelope is extended, preserving its kind and version:

```yaml
kind: PaprikaDashboardLibrary
schemaVersion: 1
dashboards:
  # One or more strict Dashboard documents
savedQueries:
  # The strict SavedQuery documents referenced above
```

`savedQueries` present means the bundle must contain every referenced definition, including tooltip saved-query references. Duplicate IDs, missing definitions, unrelated extra definitions, incompatible kinds, undeclared dashboard-variable bindings and missing required parameters are rejected. Each definition is included once even when multiple dashboards use it. String/number parameter types, defaults and all reference bindings survive JSON/YAML serialization.

An absent `savedQueries` field identifies the legacy contract: linked queries must already exist in the destination. Single dashboard documents remain accepted. YAML aliases, duplicate keys and merge syntax are rejected. Limits are 4 MiB per import/export file, 1–100 dashboards, 256 KiB per dashboard, at most 256 saved queries, and 32 KiB per saved query. The canonical implementation is `workspace-transfer.ts`; strict persisted document shapes remain in `schema.ts` and the Go service.

## Import review

1. Parse the JSON/YAML file and load authoritative saved dashboards and queries with their revisions. The comparison never uses an unsaved canvas as its baseline.
2. Choose a dashboard action. **Create a copy** is the default; **Keep existing** skips its incoming document and dependencies; **Replace existing** updates the same ID after deliberate selection. Replace requires a reviewed saved revision.
3. Map providers needed by active incoming documents. Queries kept from the destination retain their existing provider, so an unavailable incoming provider does not prevent Keep.
4. Review each active saved query. New queries default to **Create query**, preserving the ID, with **Create a copy** available. Identical existing queries default to Keep; differing definitions default to Copy. A different definition can be kept when all incoming references are compatible. Replace requires the same provider and kind, compatibility with every persisted destination reference, and explicit selection. The warning lists affected saved dashboards, including those outside the import.
5. Expand **Compare changes** to inspect typed Current/Incoming fields. Widget IDs, parameters and binding identities keep the comparison meaningful across reordering. Zero, false, null and absence remain distinct; full query strings are available in scrollable text. Display is capped at 200 changes with a visible total. Kept query substitution does not erase the incoming definition from its diff.
6. Apply the reviewed choices. Query copies receive new IDs and both imported main-widget and tooltip references point to those copies. Dashboard copies receive new IDs; imported drilldown targets follow each dashboard's selected copy or existing destination. External targets retain their IDs.

Creates use conditional writes; replacements use the reviewed fingerprint and ETag. Changes after review cause a conflict, not an overwrite. If a response is lost after a successful write, the importer reads that exact target ID and confirms its fingerprint before counting it as successful. It never treats an unrelated existing document as its own receipt.

## Partial results and refresh

The original bundle, review session and allocated copy destinations survive retry. Completed dashboard decisions are skipped. Provider/query repairs affect remaining dashboards only. Once a dashboard write was attempted, transitions between a new copy ID and the existing ID are locked to preserve saved drilldown links; Keep and Replace can still switch within the existing ID. A failed preflight alone does not lock destinations.

**Refresh comparison** reloads authoritative saved documents and revisions. It clears explicit Replace selections for deliberate reselection while preserving the source, session and completed receipts. Dashboard Replace resets to Keep; query Replace resets to its safe default. Merely changing a provider preserves explicit actions, updates the diff and displays any new incompatibility. Starting a different document creates a new session. Closing/back actions and starting another review are disabled while an import write is pending.

Import is dependency-ordered, not an atomic multi-document transaction: a failed dashboard can leave a successfully created or replaced query available. Results report created, kept and replaced resources plus per-item errors. Successful work is preserved; rollback does not delete resources that could now be referenced elsewhere. Retry identity survives within the review session, not a browser reload.

## UI and implementation

`PortableImportPanel` is shared by `DashboardManager` and `DocumentEditor`. It uses Gamma buttons, inputs and selects plus a small adapter of the maintained Gamma `DisclosureStack` for comparisons. Source/CSS provenance is recorded in `gamma/README.md` and `artifacts/insights/import-review/gamma-discovery.json`. Comparison bodies mount only when opened, and stack Current/Incoming values in the narrow inspector. Phone controls retain 44px targets and scoped Insights tokens.

Pure bundle validation/remapping lives in `workspace-transfer.ts`; typed diffs and compatibility in `import-review.ts`; conditional writes and retry receipts in `bundle-import.ts`. The host supplies persistence and authoritative review snapshots. Focused UI tests cover draft/file races, dependency closure, choices and baselines, explicit replacement consent, incompatibility, pending-write navigation and partial retry. The original portability evidence remains in [portable-bundles-review.md](portable-bundles-review.md); the expanded Keep/Replace/Copy review is tracked in [import-review.md](import-review.md).
