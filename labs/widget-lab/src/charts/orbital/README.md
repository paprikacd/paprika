# Orbital contact charts

These registered widgets render explicitly synthetic ground tracks and predicted contacts. The fixture does not propagate ephemerides, contain measured station telemetry or perform scheduling writes.

## Contact qualification profile

`orbital-pass-profile` complements the station skyplot and fleet contact timeline with three aligned signal tracks for one contact. Elevation, relative link margin and throughput use separate degree/dB/Mbps axes and exactly the same UTC bounds and plot gutters. The composed lens shares contact and observation selection with the map and skyplot. The timeline remains a fleet overview; its signal overlay can still be enabled in the editor.

Eight explicit column bindings cover observation ID, contact ID, satellite, station, epoch-millisecond timestamp, elevation, margin and throughput. Binding metadata declares exact types and units. The adapter validates loaded columns, nonempty identities, duplicate IDs, unique timestamps per contact, consistent satellite/station identity, elevation in 0–90°, and nonnegative nullable rates. It is independent of fixture names and row/column order.

### Planning calculation

The default criteria are elevation at least 10° and link margin at least 3 dB. They are configurable planning thresholds, not a claim of an operational station policy. The default maximum interval between adjacent samples is 60 seconds.

Within an accepted adjacent sample interval, both thresholds are evaluated by linear interpolation. Their eligible fractional intervals are intersected. Transfer volume then integrates the linearly interpolated Mbps over that clipped elapsed time and divides megabits by eight, giving decimal MB. Adjacent qualifying intervals merge without changing the original integral.

Missing margin leaves eligibility unknown. Missing rate leaves transfer unknown while retaining otherwise known qualification duration. An interval known to be below the elevation threshold contributes zero even if its transfer evidence is missing. An interval beyond the configured gap limit is never bridged. Summaries retain known contributions alongside unknown complete totals; no missing value becomes zero. Signal coverage names the duration supported by all required signal values, which can differ from the narrower question of qualification eligibility.

The profile does not assume the timestamps of ground-track and skyplot samples match. The lens emits the selected source observation timestamp; siblings use their actual nearest observation and show that timestamp.

### Configuration and interaction

The editor exposes elevation/margin thresholds, maximum gap, qualifying shading, threshold rules, sample marks, standalone picker and all field bindings. Appearance controls preserve source values and totals. Arrow keys inspect exact samples, Enter/click pins, Escape dismisses, and native previous/next buttons and the observation slider provide pointer alternatives. Embedded previews stay static.

### Verification in this iteration

- `npm test -- tests/orbital-contact.test.ts tests/orbital-pass-profile.test.ts`: **26 tests passed**, including threshold crossings within intervals, rate integration, gap handling, zero capacity, mapping repair, unit/type rejection, independent input and canonical embedded rendering.
- `npm run typecheck`: passed after integration.
- Browser interactions and responsive review are recorded by the owning iteration report; these test results alone do not establish those checks.
