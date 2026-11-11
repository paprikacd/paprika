# Omega Observe Control Room: 6 November 2026 receipt

This is a dated record of one MCP-authored dashboard, kept out of the Observe
skill and AGENTS.md. It is evidence of what happened on that day, not a
statement about the dashboard's current data or health. The procedure it
illustrates is in `plugins/paprika-observe/skills/paprika-observe/SKILL.md`.

## What was built

The saved dashboard `omega-observe-operations-control-room` reused existing
saved queries from `omega-k8s-cluster-overview`, `telesis-metrics-gateway` and
`service-overview`. Its service variable was bound explicitly to `uptime-api`
or `brandbrain-api`, and the Kubernetes selectors were explicit constant
bindings rather than unbound variables. Reusing verified saved queries avoided
mismatched provider IDs and invented PromQL.

Dashboard URL at the time: `https://paprika.benebsworth.com/dashboard/insights/?dashboard=omega-observe-operations-control-room`

Save sequence used: `list_insights_providers`, then `get_insights_schema`
(`kind: "dashboard"`), then `get_dashboard` for the source query references,
then `create_dashboard`, then `query_dashboard`.

## Regression

The first MCP visual styling pass bulk-added `showStatBar: true` with
`min: 0` and `max: 100` to percentage stat cards. Those cards already had
sparklines and only two grid rows of height, and some carried long source
descriptions. The fixed-height cards scrolled internally, the repeated
descriptions pushed the primary readings down, and unnecessary axis captions
reduced chart readability. The telemetry stayed healthy the whole time, so
the data checks passed while the layout got worse.

The corrective patch removed the five percentage bars, the empty or bulky
source descriptions, the redundant axis captions and the forced 100% scales.

## Readback

After the correction, `query_dashboard` returned 14 widgets, 13 distinct
queries executed, 1 deduplicated query, zero signal errors and fresh stat
observations.

This proves the saved document and its data readback. It does not prove the
corrected layout: no screenshot was verified at that point. Visual QA is a
separate check, and it was not claimed here.

## Lesson

Five percentage stat bars with bounds on short KPI cards, next to sparklines
and long descriptions, made the dashboard worse while every data check stayed
green. Removing the redundant elements restored the simpler presentation. The
composition rules served with `get_insights_schema` now state these limits.
