# Monitor status and daily observation views

Insights includes three metric widgets for monitor and service status. Select
them in the widget library and connect them to a metrics query or saved query.
For a binary Prometheus `up` metric, the default thresholds show values below
1 as down and values from 1 as up. Change the thresholds in the Style tab if
the source uses different status values.

- **Monitor status grid** shows the latest returned observation for each
  series. A missing or non-finite latest observation is unknown, rather than
  reusing an older value. `maxSeries` limits the visible monitors and the
  widget reports any omitted series.
- **Uptime calendar** groups observations into UTC days and arranges them by
  month. It displays one series by default; `maxSeries` can show more.
- **Uptime timeline** uses the same UTC daily grouping as a strip for each
  series, with eight series by default.

For the calendar and timeline, a day whose finite observations all have the
same threshold state uses that state. Days with different states or a mixture
of finite and missing observations are mixed; days with no finite observation
are unknown. These views summarize **recorded samples**, not continuous
availability. They do not calculate uptime percentages, incident durations or
imply that a state lasted the whole day. Hover or focus a cell to inspect its
date, sample count and latest recorded value. Click or press Enter to pin the
details; Escape dismisses them. Arrow keys move between cells.

The daily widgets accept `maxDays` from 7 to 366 and `maxSeries` from 1 to 24.
The available history remains limited by the query time range: Paprika
currently permits a maximum range of 31 days. Larger settings do not fetch
data outside the selected range. Provider retention and returned samples may
limit the available history further.
