# Shorted application provider

The `shorted` provider reads public market and industry data through a fixed set of Shorted Connect RPCs. It supplies typed scalar `records`, or `metrics` through an explicit numeric projection. It does not expose arbitrary HTTP paths, RPC names, headers, administrative actions or writes.

## Configuration and access

Configure `endpoint` as the Shorted API **origin**, for example `https://shorted-api.example.com`. Configure `marketDataEndpoint` separately for market quotes, history and correlations. Origins must have no credentials, query, fragment or path except `/`. The optional market service never falls back to the main API.

When the deployment requires authentication, reference a Kubernetes Secret labelled `observability.paprika.io/credentials=true`. Its JSON document may contain `apiToken`, `marketDataToken` and `adminToken`. Each bearer is sent only to the corresponding configured origin. Credentials are not accepted in provider config or query text. Token-bearing requests require verified HTTPS; numeric loopback HTTP is supported for local testing. Redirects are refused, including redirects within the same origin. Tokens must be rotated by the operator; this adapter does not refresh them.

The source Shorted middleware permits anonymous reads for these public RPCs. An accepted bearer can provide authenticated rate limits, but a successful public read does not prove token identity: the source can treat an invalid public-read token as anonymous. Use the source deployment's documented API identity when its anonymous allowance is insufficient. No internal service key or administrator credential is needed for the public operations. Administrative reads require a separately supplied `adminToken`; a public API token is never used as its fallback. A missing market endpoint reports `not_configured`; a backend 401/403 reports `forbidden` without the response body.

The empty-query health probe requests one summary-only top-short record. It checks the primary endpoint only. Validate a market operation separately before relying on the optional market service.

## Query contract

A records query contains a case-sensitive operation and optional typed arguments:

```json
{"operation":"top_shorts","args":{"period":"3M","limit":10,"summary_only":true}}
```

A metrics query must include a projection. This example returns the source short-position history for a selected stock:

```json
{
  "operation":"stock_history",
  "args":{"product_code":"CBA","period":"3M","max_points":500},
  "projection":{"value":"short_position","time":"timestamp","labels":["product_code"]}
}
```

Records queries must omit `projection`. Its `value` must name a numeric column, `time` must name a timestamp column, and `labels` must name scalar columns. Unknown fields, duplicate JSON keys, invalid types, null arguments and unsupported choices are rejected before contacting the source. Stock codes are normalized to uppercase; lists reject duplicates. The API's native period/date arguments select historical data. Dashboard time ranges and `step` do not silently override those arguments or resample the data. A projection without `time` represents a current observation at the requested range end, not a fabricated history.

| Operation | Native read RPC | Arguments and limits | Selected result columns |
| --- | --- | --- | --- |
| `top_shorts` | `MarketService/GetTopShorts` | `period` (default `3M`), `limit` 1–100 (30), `offset` 0–10000, `summary_only` (true), `product_codes` 1–50 | `product_code`, `name`, `industry`, `timestamp`, `short_position`, `reported_short_positions`, `total_product_in_issue`, `available_from` |
| `industry_treemap` | `MarketService/GetIndustryTreeMap` | `period` (`3M`), `limit` 1–100 (10), `view_mode` `CURRENT_CHANGE` or `PERCENTAGE_CHANGE` | `industry`, `product_code`, `short_position` |
| `stock_history` | `StockService/GetStockData` | Required `product_code`; `period` (`3M`), `from`, `to`, `as_of`, `full_resolution`, `max_points` 1–1000 (1000) | Same columns as `top_shorts`; source timestamps and availability dates |
| `stock_prices` | `StockService/GetStockPrices` | Required `product_code`; `period` (`3M`), `from`, `to`, `max_points` 1–1000 (1000) | `stock_code`, `timestamp`, `open`, `high`, `low`, `close`, `adjusted_close`, `volume`, `change`, `change_percent` |
| `stock_details` | `StockService/GetStockDetails` | Required `product_code` | `product_code`, `company_name`, `industry`, `summary`, `website`, `logo_gcs_url`, `logo_icon_gcs_url` |
| `market_quotes` | `MarketDataService/GetMultipleStockPrices` | Required `stock_codes` 1–50 | Same price columns; one current quote per returned stock |
| `market_history` | `MarketDataService/GetHistoricalPrices` | Required `stock_code`; `period` `1d`, `1w`, `1m`, `3m`, `6m`, `1y`, `2y` (`3m`); `interval` only `1d` | Same price columns |
| `market_correlations` | `MarketDataService/GetStockCorrelations` | Required `stock_codes` 1–10; `period` `1m`, `3m`, `6m`, `1y` (`3m`) | `stock_code`, `other_stock_code`, `correlation` |
| `market_news` | `NewsService/GetMarketNews` | `limit` 1–100 (20), `source`, `price_sensitive_only` | `id`, `stock_code`, `source`, `headline`, `url`, `published_at`, `sentiment`, `relevance_score`, `is_price_sensitive`, `summary`, `image_url`, `syndication_count` |
| `industry_records` | `IndustryIntelligenceService/GetIndustryIntelligence` | `industry`, `record_limit` 1–200 (50), `stock_code` | Source identity, signal/metric identity, industry/stock/entity, `has_metric_value`, `metric_value`, `unit`, period/availability dates, title/summary/source URL/confidence |
| `industry_time_buckets` | Same industry RPC | Same industry arguments | Signal/source/metric identity, `metric_label`, `unit`, `bucket_label`, `bucket_start`, `total_value`, `record_count`, `entity_count`, `zero_value_count` |
| `industry_entity_totals` | Same industry RPC | Same industry arguments | Signal/source/metric identity, `stock_code`, `entity_label`, `unit`, `total_value`, `record_count`, `latest_as_of` |
| `industry_sources` | Same industry RPC | Same industry arguments | `source_key`, `display_name`, `signal_kind`, `publisher`, `source_url`, `licence`, `cadence` |

The first API's periods are `1D`, `1W`, `1M`, `3M`, `6M`, `1Y`, `2Y`, `5Y`, `10Y`, `MAX`. Dates are `YYYY-MM-DD`; `to` requires `from` and must not precede it. When `top_shorts.summary_only` is false, the adapter clamps the result limit to 20, accepts at most 20 product codes and limits the period to two years. Source responses can be downsampled. `full_resolution` requests native observations while retaining the explicit `max_points` cap used by the source RPC/store.

## Fidelity and limits

Each query has a 10-second aggregate deadline including bounded transient HTTP retries, a 16 KiB query limit, a 2 MiB backend response limit, and at most 1000 returned rows (or a lower caller limit). Oversized responses fail explicitly. Row/cell clipping and source `downsampled` flags set `truncated`; strings are clipped on UTF-8 boundaries at 16 KiB. The adapter makes one logical RPC per query and does not paginate automatically. Selecting several industry sections performs separate reads of the same source RPC.

Frames contain scalar strings, finite numbers, booleans, timestamps and nulls. Date-only values become midnight UTC. Missing numeric values remain null rather than invented zeroes. For industry records, the source's `hasMetricValue` flag preserves the distinction between a real zero and unavailable data. Some other proto3 scalar fields omit zero on the wire; absent values remain unknown because the adapter cannot infer presence. Metric nulls become explicit missing samples. Unsupported nested source fields are not serialized into labels. Price fields that a particular operation does not return remain null.

These operations support Shorted stock histories, quotes, top-shorts, industry views, news and correlation widgets. Portfolio holdings and weights remain explicit dashboard inputs; the adapter does not read a user's private portfolio. Housing scenarios use attributed authored static datasets and retain their historical dates; the optional HousingService live tail is not part of this adapter. Protected administrative reads use their own credential as described below. Cache and job-execution mutations remain unavailable.

Implementation provenance: Shorted revision `af0e5d03ab5ebb9a0bcd12ac2a95af19206f8d0b`, its `proto/shortedapi/shorts/v1alpha1/` and `proto/marketdata/v1/marketdata.proto` contracts, and public-read authorization in `services/shorts/internal/services/shorts/middleware_connect.go`. The durable source inventory is in [shorted-source-notes.md](../design/insights/repository-examples/shorted-source-notes.md).

## Additional application reads

These operations complete the source widget and administrative read collections without adding arbitrary RPC selection:

| Operation | Source and inputs | Result semantics |
| --- | --- | --- |
| `screener` | Native `ScreenerService/ScreenStocks`; `limit` 1–100 (10), `offset` 0–10000, `product_codes` up to50, `sort_field` and `sort_direction` native enum names | Stock/company/industry, current short percentage, four-week change, price/fundamental scalars. Source `totalCount` beyond returned rows marks truncation; no top-shorts substitution. |
| `portfolio_positions` | One `GetMultipleStockPrices` for explicit `positions`: 1–50 unique `{stock_code,quantity,cost?}` entries. Quantity and per-share cost must be finite, nonnegative and at most1,000,000. | Per-position quantity, close, market value, daily amount/percentage change, optional cost basis/gain and completeness. Quantities are inputs, never private account holdings. |
| `portfolio_summary` | Same explicit holdings and one quote read | Aggregate market value, day change, position counts and completeness. A missing quote keeps the aggregate null instead of reporting a misleading partial total. |
| `sector_performance` | One quote read for the exact six representative baskets in source `stock-data-service.ts`; no arguments | Current percentage-change averages, volume, observed/expected constituents, completeness and two gainers/losers. This is a representative basket, not a full sector index or historical-period return. Unlike the source's missing-as-zero divisor, a missing constituent keeps an aggregate unknown. |
| `admin_jobs` | `GET /api/admin/jobs`, no arguments | Read-only job names, statuses, schedule labels, timestamps, numeric counts, retired and stale flags. Freeform backend messages, execution identities, log URLs and hosts are omitted. |
| `admin_issues` | Same job read | Active critical, overdue or warning jobs; intentionally retired jobs are excluded. |
| `admin_fleet` | Same job read | Active/retired/critical/overdue/warning counts and health. Critical/overdue jobs yield critical; warnings or stale data yield degraded. Retired jobs never degrade fleet status. |
| `admin_sync` | `GET /api/admin/sync-status`; `limit` 1–100 (20), `environment` production/development/empty, `exclude_local` boolean (true) | Safe run ID, timestamps, status, environment, duration and processing/checkpoint counts. Hostnames and error text are omitted. |

Administrative operations require `adminToken` in the Secret, sent as `Authorization: Bearer` only to these two fixed GET paths on `endpoint`. No admin secret means `not_configured` without an HTTP call. The source backend accepts its configured internal service identity; supply that identity only when explicitly authorizing these privileged read panels. No fallback secret value is supplied. Public and market reads never receive the admin credential. The connector does not expose `/api/admin/jobs/.../execute`, subscription management or cache flushes.

Industry operations additionally accept optional `signal_kind` and `metric_key` exact filters. These are validated scalar identifiers, applied locally to the corresponding response fields **before** the returned-row limit. They are not forwarded as unsupported RPC fields. They allow each channel's saved query to select its own metric while sharing the dashboard's `industry` parameter.

```json
{
  "operation":"portfolio_positions",
  "args":{"positions":[{"stock_code":"CBA","quantity":100},{"stock_code":"BHP","quantity":50,"cost":40}]}
}
```

The repository example collection binds explicit share quantities as numeric saved-query parameters. Its synthetic quote fixture recomputes sample portfolio values when those quantities change; live imports perform the same multiplication using current source quotes.
