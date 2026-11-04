# Widget Lab iteration 14: fail-safe visualization switching

## Incident
The Kubernetes "Workload placement & pressure" panel had a wide record source (hundreds of rows and many columns). The editor offered a generic "Records table" conversion because schema validation confirmed compatible records, without accounting for the limited chart-preview viewport. The preview also passed naturalHeight to every renderer, allowing a record-table to expand beyond its preview and overlap the Data workspace.

## Behaviour
- Registry/schema validation remains necessary. An additional UI safety gate rejects automatic generic-table conversion from a specialist record visualisation when the loaded frame has more than 12 columns, or combines more than 200 rows with more than 10 columns. The read-only Data tab still exposes the complete source with its own bounded scrolling.
- The current renderer is always retained as an available choice, including pre-existing wide record tables. Small records may still convert to a generic table without altering query or field identity.
- Conversion is preflighted again when selected: the selected renderer must remain in the compatible list, pass the result contract, and parse the fully constructed candidate. Failed preflight keeps the original chart and displays a reason, without adding an Undo step or enabling Apply.
- The preview has finite height for fill-based visualisations. naturalHeight is reserved for explicitly intrinsic renderer families and statistic cards. Horizontal/vertical overflow stays inside the chart; the neighboring Data workspace never overlaps it.
- A last-resort preview error boundary displays a recoverable failure instead of tearing down the editor. Apply is disabled for a configuration whose preview has thrown. Editing valid config or switching to another supported renderer recovers the preview.
- No production renderer, source query, provider, or persisted schema changes.

## Verification
- Validate the 924-row Kubernetes placement case: generic Records table must not appear in the type options.
- Validate small result conversion, source identity, current wide-table editing and bounded table viewport.
- Validate a deliberately throwing preview renderer: the editor continues to display the fallback and does not apply the failed candidate.
- Run Widget Lab typecheck, unit suite, production Vite build, and diff whitespace checks. Browser-level geometry testing is still recommended before release, because happy-dom cannot measure rendered overflow.

