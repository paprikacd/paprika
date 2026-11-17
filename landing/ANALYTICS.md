# Optional public landing analytics

GA status: **disabled**, with no measurement ID or production origin configured.
The existing upstream Flaggr adapter is separate and already configured by the
site builder. This GA draft neither disables nor changes that tracking.

This draft does not create a Google Analytics property, connect OpenSEO, deploy a
script, or enable tracking. It adds no telemetry to the Paprika console/operator,
cluster, workloads, CLI, demo tour, or other GitHub Pages projects.

## Activation gates

1. Verify `https://paprikacd.github.io/paprika/` is the actual production landing
   deployment and that this project owns it. Do not broaden this to the entire
   GitHub Pages host or copy another product's ID.
2. Reuse or provision a dedicated GA4 web stream through an authorized account
   workflow. Record its public `G-...` measurement ID and connect the correct
   property to OpenSEO separately. Do not put service-account credentials here.
3. In GA4 Admin verify Enhanced Measurement, Google Signals, user-provided data,
   advertising links and cross-domain measurement are all disabled. Only manual
   public page views are intended; do not auto-collect form/search/download data.
4. Review the site's privacy disclosure and retention settings. The consent UI
   identifies Google, cookies and browser/network information. Google still
   processes network information (including IP) when a visitor opts in.
5. Set `origin`, `gaMeasurementId`, `gaPrivacyReviewed: true` and `enabled: true`
   in `analytics-config.js` only after these checks and release review. These are
   public configuration, not secrets. No fictional IDs are included.
6. Verify in a real browser/GA DebugView that only the intended landing page view
   arrives, denial emits no Google requests, and withdrawal/reload stops Google requests.
   Unit tests use a simulated vendor queue and do not validate Google's behavior.

## Privacy boundary

The loader is restricted to `/paprika/` and `/paprika/index.html`, exact configured
HTTPS origin, no query/hash at initialization, no DNT/GPC signal, and explicit
per-tab opt-in stored in sessionStorage. There is no pre-consent Google script or
request, nor a cookieless consent-mode ping. Storage failures fail closed.
Manual page location/title are fixed; referrer is blank. Cookies use a Paprika
prefix and `/paprika/` path, host-only, to avoid cross-project cookie identity.

Withdrawal sets Google's documented disable flag and drops the pending queue
before reloading into denied state. It cannot recall already-sent requests or
erase server-side records. If browser storage fails during withdrawal, it blocks
future transmission on the page without reloading a stale grant and asks the
visitor to close the tab. Existing browser cookies may remain until expiry or
browser deletion; the UI does not promise deletion.

This is for static pages, **not an SPA adapter**. Do not reuse in a private app
runtime, infer sensitive routes, send command text, cluster names, deployment
IDs, query strings, form contents, user IDs or user-provided event properties.

## Flaggr lifecycle gate

This draft adds no new Flaggr loader, and preserves the already configured
upstream Flaggr integration unchanged (see reconciliation below). Before any
combined consent/activation claim, review the deployed version's lifecycle and
privacy behavior, including the stop work in `skunkworq/flaggr#200`. A transmission
stop is not full observer teardown. Do not load an unverified `latest` script.

## Checks

```
node --test hack/test-landing-analytics.cjs
bash hack/test-landing-install.sh
# After installing the existing UI dev dependencies and Playwright browser:
node hack/test-landing-analytics-browser.cjs
```

## Upstream reconciliation

Current master already includes `analytics.js`, a separate Flaggr adapter, and
`content/analytics.json` with a real public site ID. Both are preserved unchanged.
Our adapter is now `google-analytics.js`. The source-only browser harness tests
GA consent, not the fully built site's existing Flaggr behavior. The existing
Flaggr adapter collects URLs including documentation search queries and is NOT
controlled by this GA consent panel. Thus the site's overall analytics are not
claimed to be off. Before GA activation, align the policy and consent/lifecycle
behavior across both vendors; do not imply the Google-only switch stops Flaggr.
Merging landing changes into master automatically publishes GitHub Pages.
