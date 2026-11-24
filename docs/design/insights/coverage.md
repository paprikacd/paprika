# Dashboard coverage and embed mode

A dashboard can say which applications it is for. Application pages then list the matching dashboards and
show the first one's summary widget in embed mode.

## The `covers` member

`covers` is optional: `{applications, variables?, summaryWidget?}`.

- `applications`: 1 to 16 entries. Each has an optional lowercase `namespace` and an optional `name`. An
  omitted member matches any value, so `{}` matches every application.
- `variables`: maps a declared dashboard variable to `namespace` or `name`. The application page opens the
  dashboard with that variable set to the application's namespace or name.
- `summaryWidget`: the ID of a widget in the dashboard, shown on the application page.

Label and project matching are not part of `covers`. Go (`internal/insights/coverage.go`) and Zod (`schema.ts`)
reach the same verdict on every case in [conformance/coverage.json](conformance/coverage.json). The JSON Schema
agrees except where a case names a `jsonSchemaGap`: it cannot check that a variable or widget reference exists.

## Lookup

`GET /api/application-dashboards?namespace=&name=` (see the [service contract](../../../internal/insights/README.md))
returns the dashboards whose `covers` match, most specific first, at most 8, with `truncated`. Each matching
entry scores 3 for a namespace and name, 2 for a name, 1 for a namespace and 0 for `{}`; a dashboard takes its
best score. A mapped variable whose value is not in its declared options is left out.

First-party starters declare `covers` only where it holds for every application. `namespace-capacity` covers
`{}` through its namespace variable. `service-overview` and `slo-burn-rate` declare none, because they assume
the application name is a `service` label.

## Embed mode

The application page shows the summary widget in a same-origin frame of the Insights page:

```text
/dashboard/insights/?dashboard=<id>&embed=<widgetId>&theme=light
```

`theme` is `light` or `dark`. The usual `vars`, `range` and `refresh` parameters apply. Embed mode renders that
one widget read-only, filling the frame, with an Open dashboard link that targets the top window. Only the
Insights page may be framed, and only by the same origin.

## Application links

A widget can also link to an application page. That link is a drilldown entry: see
[drilldowns](drilldowns.md) for its shape and bindings.
