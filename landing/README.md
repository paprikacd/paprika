# Paprika public website

The landing page, console tour, documentation and engineering blog are static
HTML. The chart gallery is built from `labs/widget-lab` and published alongside
them at <https://paprikacd.github.io/paprika/>.

## Build and check

From the repository root, with Node.js 22:

```sh
npm ci --prefix landing --no-audit --no-fund
npm ci --prefix labs/widget-lab --no-audit --no-fund
npm test --prefix landing
bash hack/test-landing-install.sh
bash hack/build-landing-with-charts.sh output/public-site
python3 -m http.server 4173 --directory output/public-site
```

To run the same desktop/mobile interaction check as CI, install Chromium with
`npx --prefix landing playwright install chromium`, then run:

```sh
node landing/verify-browser.mjs output/public-site output/public-site-browser
```

The check serves its own local preview and tests search, copying, mobile
navigation, no-JavaScript reading and layout overflow. CI retains its screenshots
as the `paprika-public-site-browser` artifact.

The assembly command verifies content metadata, links and the generated chart
assets before publishing. Build dependencies, Markdown sources and configuration
are excluded from the published directory. The Pages workflow runs on website
changes and changes to the Markdown sources used by the docs. Pull requests
build and validate; merged changes on `master` publish to `gh-pages`.

## Publish a guide

Add an entry to `content/site.json` with a stable slug, descriptive title,
summary, section and repository-relative `source` path. Prefer a maintained
document over a second copy written for the website. The four starting sections
are Start, Deliver, Observe and Integrate. Keep internal implementation plans and
deployment-specific runbooks out of this list unless deliberately reviewed.

The builder remaps links to published guides and leaves source references on
GitHub when they have no public route. Heading fragments follow GitHub's slug
rules. Check links and examples whenever the source API or CLI changes.

## Publish an article

Write a Markdown article in `content/blog/` and add its title, description,
category, publication date, slug and source path to the `posts` manifest. Use
one H1 matching the title, descriptive H2 sections and complete examples. The
blog index, homepage article list, RSS feed and sitemap use that manifest.

Answer a specific engineering question, show the relevant behavior and its
limits, and cite the maintained guide or implementation. Label synthetic
examples. Do not invent adoption statistics, benchmark results, supported
capabilities, people or customer stories. Check the actual implementation
before presenting a configuration field as working behavior.

## SEO and measurement

The sitemap uses canonical URLs under the project path, and content pages ship
readable HTML without requiring JavaScript. Structured data describes the
visible article or guide. Publication dates come from content metadata; build
times are not used as modification dates.

After production publishing, submit
`https://paprikacd.github.io/paprika/sitemap.xml` in the verified Search Console
property and monitor indexing, query impressions and clicks. There is no
Search Console or analytics access implied by this repository. A robots policy
would need to be hosted at `https://paprikacd.github.io/robots.txt`, not inside
this project path.

The next editorial topics should follow real questions and source evidence:
canary analysis that fails closed, connecting existing telemetry backends, and
Kubernetes drift normalization. Validate those topics against search data once
it is available; the initial articles are not based on keyword-volume estimates.

## Flaggr browser analytics

The adapter in `analytics.js` loads Flaggr's pinned browser collector only when
`content/analytics.json` contains a real public `site_…` identifier. A null ID
keeps collection disabled. It must remain null until the site has been created
or located through an authenticated Flaggr connection; do not insert an example
ID, a project ID, an API token, or an MCP credential.

Connect the hosted MCP endpoint at <https://flaggr.dev/mcp> with native OAuth,
following <https://flaggr.dev/connect>. Read the connection, projects, services
and sites before creating anything. Reuse the Paprika site if it exists, or
create a dedicated **Paprika public website** site for
`https://paprikacd.github.io/paprika/` in the appropriate project and service,
with environment `production`. Save its returned `siteId`, `projectId` and
`serviceId` in the configuration. Only the public site ID is emitted in HTML.

The adapter runs only on the exact production origin under `/paprika/`, in a
top-level window. Local previews, other hosts, embedded chart demos and Do Not
Track requests do not load the collector. The pinned collector uses Subresource
Integrity, loads asynchronously and cannot hold up navigation. A failed load
drops its bounded pending event queue after ten seconds.

Flaggr owns automatic pageviews, Web Vitals, browser error and scroll reporting.
Its current collector records page URLs and referrers, including ordinary query
parameters such as documentation `?q=` searches. The conversion adapter passes
only fixed event names, but that does **not** make the collector path-only.
Automatic DOM click collection is disabled. No user identity or account token
is supplied by this integration.

| Event | Meaning |
| --- | --- |
| `get_started` | Follow an installation entry point |
| `cli_download` | Click a CLI archive download; checksum links do not count |
| `docs_open` | Follow a documentation link |
| `demo_open` | Open the console tour |
| `blog_open` | Follow an engineering blog link |
| `docs_search` | Submit a nonempty documentation search |
| `code_copy` | Successfully copy a guide example or CLI installation command |
| `mcp_copy` | Successfully copy an MCP/Observe setup command |

These events measure website interactions. A download click or copied command
does not prove that someone installed Paprika.

After enabling the configuration, run the normal build and checks, then verify
the deployed collector loads with its expected integrity and a real browser
request to `https://ingest.flaggr.dev/e` reports accepted events. Confirm them
with `list_recent_browser_events` using the observed site/project IDs. HTTP 202
alone is not sufficient: rejected or filtered batches can accept zero events.
Do not send fabricated visits from a command-line HTTP client.

### Structured data

`structured-data.mjs` renders one JSON-LD graph per page at build time. The
homepage, documentation and blog share stable identities for the Paprika
website, maintainers and Apache-licensed source project. Each canonical page
has its own `WebPage` identity; guides use `TechArticle`, posts use
`BlogPosting`, and directory pages use `CollectionPage` with an `ItemList`
matching their visible links. The blog also has a shared `Blog` identity.

Visible breadcrumbs and `BreadcrumbList` use the same entries, including the
current article title. Every article displays its linked maintainer byline.
Publication timestamps come only from the blog manifest (`YYYY-MM-DDTHH:mm:ssZ`).
The initial three posts use `2026-11-07T06:57:52Z`, the completion of the first
successful [Pages deployment containing the blog](https://github.com/paprikacd/paprika/actions/runs/42349213527).
Undated guides remain
undated, and builds never create `dateModified` values. The generic console
social preview is not asserted to be an article-specific image. Add an article
image only alongside a relevant, visible illustration and validation for it.

`npm test --prefix landing` covers safe JSON-LD embedding and repeat builds.
The assembled-site verifier checks graph identities and references, absolute
URLs and assets, canonical metadata, visible breadcrumbs, bylines, dates and
directory entries. Browser checks cover all 22 landing/docs/blog pages with
JavaScript disabled at 390px, plus desktop/mobile reading and navigation.
Both checks run before the publishing step in the website workflow.

For schema changes, also test representative generated pages in the
[Schema.org validator](https://validator.schema.org/) and
[Google Rich Results Test](https://search.google.com/test/rich-results).
Schema.org validity and Google rich-result eligibility are different checks;
`SoftwareSourceCode` and `TechArticle` describe the content without inventing
offers or ratings. Follow the current
[Google article guidance](https://developers.google.com/search/docs/appearance/structured-data/article)
when adding editorial metadata. Successful validation does not guarantee a
particular search appearance.

### Monitoring through MCP

Use passive reads: `get_browser_analytics_overview`, `get_web_vitals`,
`list_browser_issues`, `query_browser_segments`, `list_recent_browser_events`
and `get_site_health`. Monitor the dedicated site in production, retaining the
time range and sample counts. Compare page traffic and conversions across
equivalent periods. Flaggr's visitor count represents anonymous tab sessions,
not distinct people; missing or delayed data is not a healthy zero.

Initial checks should cover ingestion freshness, browser error changes, p75
Web Vitals with sufficient samples, and installation/download/documentation
interactions. An empty new site needs a baseline before traffic-drop alerts
are meaningful. Do not use `check_site_guardrails` for passive monitoring: that
tool can execute mitigation. Configure any automatic rollout or mitigation
separately from analytics monitoring.
