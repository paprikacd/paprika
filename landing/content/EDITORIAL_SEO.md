# Paprika public editorial and search architecture

This is an internal publication checklist, not a public article. The public
manifest is `content/site.json`; it is the source of truth for article counts,
publication timestamps, canonical URLs, sitemap entries and RSS items.

## Intent-led dashboarding topic cluster

| Search / reader intent | Primary article | Supporting content and next action |
| --- | --- | --- |
| Kubernetes deployment dashboard / release health | `kubernetes-release-dashboard` | Metrics guide, canary guide, promotion guide, dashboards examples |
| Prometheus dashboard PromQL rates, gauges and histogram p95 | `prometheus-dashboard-query-patterns` | Metrics guide, Observe provider discovery, query_dashboard |
| Observability dashboard layout, KPI cards and tooltips | `observability-dashboard-layout` | Public chart showcase, example library, renderer guide |
| Dashboard screenshot testing / responsive chart validation | `visual-testing-observability-dashboards` | Observe renderer guide, MCP authoring, dashboard query contract |
| AI/MCP dashboard creation workflow | `building-dashboards-with-mcp` | Observe plugin, saved queries, ETag-based authoring |

All of the above are *educational intents*, not claims about search volume,
ranking position or customers. No keyword research or Search Console access is
implied. Do not produce near-duplicate variants of the same query; expand
existing pages when a question belongs in the existing topic.

## Publication contract

1. Verify implementation details against maintained repository files; include
   meaningful links to those sources. Do not invent a provider, flag, metric,
   support matrix, benchmark, case study or customer quote.
2. Use an exact-match H1 for the user problem and a 120–160-character
   description where useful. Prefer the natural wording of the question to
   stuffing terms into every heading.
3. Include what the technique cannot establish, especially for Kubernetes
   readiness, drift, provider reachability, empty data and synthetic examples.
4. Reuse the existing technical PNG figures when they explain a contract.
   Create a distinct original SVG `cover` in the navy/steel visual system.
   Every cover must be a safe, self-contained 1200×675 SVG with meaningful
   article-level alt and caption text. Editorial covers are not screenshots
   of the actual product or live telemetry.
5. Link to relevant docs and adjacent blog articles in ordinary prose;
   avoid generic "click here" anchors. A new dashboard guide should link
   to `/paprika/#charts` without implying the public gallery is using
   production data.
6. Declare each article once in `site.json`. The content builder derives
   `BlogPosting`, article-specific Open Graph PNG, canonical path, RSS and
   sitemap; do not duplicate route lists by hand. New blog publishing
   dates are editorial metadata; do not claim a deployment time that has
   not happened.
7. Prefer a change to an existing article over a redundant keyword page.

## On-page discovery

The homepage charts chapter displays three recent dashboarding articles,
using the same manifest as the /blog/ topic hub. The engineering notes section
features the latest three articles across categories. /blog/ lists every
published article once and adds a dashboarding reading route before the
archive. This keeps discovery current without hand-editing hard-coded
slugs in the homepage HTML.

## Measurement and review

Use Flaggr pageview and conversion data cautiously: sessions are anonymous
browser sessions, not distinct people or search impressions. Measure whether
users follow `blog_open` and `docs_open` paths, and whether the articles
receive actual visits. Do not equate synthetic test visits with organic demand.

For search performance, use a verified Search Console property before making
claims about indexing, queries, impressions and click-through rates. Add the
sitemap once it has been published and verify actual canonical URLs. No
automatic submission or verification is performed by this repository.

Review `npm test --prefix landing`, the assembled-site verifier and the
responsive Playwright suite, including no-JavaScript reading, desktop/mobile
cover decoding, structure and internal links. Search is a distribution channel;
technical correctness, readability and accessible navigation come first.

## Next editorial candidates (research before adding)

- How to build an error-budget view that distinguishes signal health from
  provider outage, with a source-backed SLO example.
- Heatmaps versus time-series for Kubernetes pod cardinality, including scale,
  empty bins and high-cardinality limits.
- Practical dashboard query variable design across multiple providers.
- Trace investigation in a service dashboard, using real supported fields.
- Lessons from a real visual regression only after a reproducible fixture and
  before/after evidence exist.
