# Financial lenses and allocation charts

## Contents

- Define the accounting population
- Reconcile value, change and return
- Make treemap encodings explicit
- Compose the investigation
- Validate transfer and interaction

## Define the accounting population

Start with the financial question: current allocation, contribution to a change, performance over time, liquidity, cost or revenue. Choose families from [chart coverage](chart-families.md) and verify their actual registry/configuration support before promising them. A time-series renderer, categorical treemap and table do not automatically provide a financial lens's accounting or drilldown behavior.

Declare the reporting currency, valuation timestamp/timezone, price source, quote freshness, position quantities and population. Label authored prices and histories as synthetic. A synthetic closing snapshot must not appear as a live market feed; familiar ticker names do not change its provenance.

Keep price, position value, cost basis, cash, profit/loss and percentage return distinct. For multiple currencies, use explicit exchange rates and their timestamps before aggregation. A unit label alone does not convert money. State whether the selected time window changes the historical performance, the valuation snapshot, or both.

Decide which positions enter every denominator: all assets including cash, equities only, one sector, gross exposure, or another named population. Preserve liabilities and short positions in accounting. Do not hide them merely because an area chart cannot encode negative magnitude.

## Reconcile value, change and return

For a simple unchanged-position closing fixture in one currency, use these relationships before formatting or visual reduction:

| Quantity | Relationship | Required qualification |
| --- | --- | --- |
| Position value | `Vᵢ = quantityᵢ × priceᵢ` | Prices and quantities refer to the same valuation basis. |
| Previous value from known percentage change | `Vᵢ,previous = Vᵢ / (1 + rᵢ / 100)` | Quantities are unchanged; `rᵢ > −100%`; change excludes unmatched flows/corporate actions. |
| Portfolio value | `V = Σ Vᵢ` | Sum one reporting currency and one declared population. |
| Position weight | `wᵢ = 100 × Vᵢ / V` | State the denominator; an empty/zero denominator is unavailable, not 0% allocation. |
| Daily contribution | `ΔVᵢ = Vᵢ − Vᵢ,previous` | This simple difference assumes no unmatched deposits, withdrawals, trades or distributions. |
| Pooled return | `r = 100 × (Σ Vᵢ / Σ Vᵢ,previous − 1)` | Pool previous and current values; do not average individual percentage changes. |

Apply the same pooling at sector and portfolio levels. Reconcile sector values, weights and contributions to the headline. Check raw weights against 100%; permit honest display-rounding differences rather than changing source weights to force rounded labels to sum.

When quantities, external flows, fees, dividends or corporate actions change, choose and name the applicable return method before implementing calculations. Distinguish price return from total return, realized from unrealized change, and time-weighted from money-weighted performance. Do not extend the simple unchanged-position formulas beyond their assumptions.

Rebase comparison histories to the same start instant and basis, for example `100 × (value(t) / value(start) − 1)` for percentage change. Use compatible valuation calendars and explicit gap handling. A portfolio's period KPI must equal its plotted endpoint on that basis. If daily contribution and history describe the same closing population, reconcile the last plotted day to the contribution total as well.

Do not fabricate an allocation or cash history from an unrelated performance curve. Show a snapshot meter when only the current allocation/balance is available. Generate deterministic synthetic data from one model when historical and snapshot evidence need to reconcile.

## Make treemap encodings explicit

Use **nonnegative magnitude** for area, such as market value, revenue or explicitly labelled gross exposure. Keep signed daily change or contribution separate from the area field. A declining holding can have a positive market value and therefore a valid positive area. Never size rectangles directly from signed return.

If short positions require magnitude area, choose an explicit gross-exposure representation, show sign separately and retain net totals elsewhere. Do not silently apply absolute value and keep the label “net asset value.” Zero values have no area; retain them in equivalent records and disclose their omission from the plotted area. Invalid or missing values are not zeros.

Use a stable diverging color scale centred on **zero change**. Declare its units and endpoints. Preserve the same scale through filtering, drilldown, reordering and resizing; otherwise a weak move can acquire the same color as a strong move after filtering. Clamp only the color interpolation at the declared limits and keep the actual value in inspection. Use a distinct unknown treatment; neutral zero change is known data. Separate selection/focus from change color.

Fit the hierarchy to the measured container. Budget sector headings, rectangle gaps and minimum readable labels; reduce labels before shrinking every glyph. Use clipping to contain text, but preserve full names and exact values through inspection or a companion table. Keep stable entity/group keys rather than assigning color, history or selection by row index.

Provide a complete group investigation:

- Show hierarchy and scope through sector headers or an equivalent group control, breadcrumbs and Reset.
- Let a holding expose exact value/unit, signed change, group and weight with its denominator named.
- Distinguish transient inspection from a pin; provide keyboard/touch access and reachable dismissal.
- Declare whether group drilldown filters only the treemap, a linked ledger, or the shared query. Keep unrelated portfolio KPIs unchanged for local drilldown.
- Retain selected identity through camera/layout changes; invalidate stale inspection when source values or data mappings are replaced.
- Keep embedded variants static, without nested inspectors or drilldown controls.

Use the existing typed records host and trusted plugin registry. Extend the canonical owner where feasible. If a separate allocation renderer is needed because categorical fills or fixed geometry cannot express the contract, isolate its adapter, strict config and interaction owner, and record it as a local extension. Do not add an unrelated chart stack.

## Compose the investigation

Give each panel a different evidential role. A useful allocation lens can pair a dominant treemap with sector weights, then performance against a comparable reference and an exact holdings ledger. Signed contribution bars answer which groups caused the net change; exposure bars answer how much capital each group represents. Label those different quantities and use common scales within each comparison.

Keep compact value/unit/comparison hierarchy and the existing Paprika surface grammar. Treat green/red or cyan/rose as declared gain/loss encoding, not health severity. Align numeric columns and zero baselines. Preserve readable legends and exact records at narrow widths. Do not reproduce a finance aesthetic by adding arbitrary mini-traces, tickers or animated prices unsupported by the input.

## Validate transfer and interaction

Use focused fixtures for unequal position sizes and mixed positive/negative returns; they expose accidental arithmetic averaging. Include zero cash, missing change, zero/negative area inputs, duplicated identifiers, reordered rows and an empty population. Test currency and price-unit conversion where implemented.

Verify conservation from holdings to sectors to portfolio, return/endpoint agreement, and source invariance through filtering, resizing and color-limit changes. Check that a missing change remains unknown while its valid market value can still occupy area.

Exercise sector drilldown/reset, exact selection, keyboard operation, source replacement and two independent instances in the browser. Inspect labels and detail placement at actual narrow widths. Confirm the available editor types/configurations are valid for the result's fields, not merely its `records` data kind. Record financial calculations, visual readability, interaction, performance and upstream integration as separate evidence.
