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
