# query_dashboard acceptance receipts, October 2026

Dated evidence split out of [dashboard-query.md](../dashboard-query.md), which holds the current contract.
These records describe what was deployed and checked on those days; never cite them as current behaviour.

## Omega acceptance — 26 October 2026

Deployed and verified at 22:40 Melbourne time (11:40 UTC):

- Source: `d4b6f354f2126cc0bfa46400bad7e92907e1a9b2`.
- [Linux amd64 build](https://github.com/paprikacd/paprika/actions/runs/40314288403)
  succeeded; immutable image
  `ghcr.io/paprikacd/paprika@sha256:ecf761f8411d36346887d273951a28c7043bacbe1540412cd4772fb7a6034f88`.
- Helm revision 50 is deployed. Helm 3.21.2 lint, render and server-side dry run
  passed. All 65 managed objects and six hooks were reviewed; only API, Insights
  and Observe deployment images changed. Controller placement, both MCP client
  registries and the original Bound Insights PVC were preserved.
- All six running components are ready with zero restarts. System-health warnings
  are unchanged from the pre-deployment baseline: one degraded application and
  three applications with exhausted retries. Reconcile generations are current.

The real [Service overview](https://paprika.benebsworth.com/dashboard/insights/?dashboard=service-overview)
returned eight widgets from seven unique provider executions, avoiding the
duplicate stat/chart query. Four live machine checks and seven live browser
checks passed, including light/dark layouts at 1512px and 390px, rapid service
switching, sparklines, exact observations and persisted-document integrity.
The machine comparison used `2026-10-26T10:36:00Z`–`11:36:00Z`, step 12 seconds.

| Service | Raw normalized provider results | Complete MCP result | Reduction |
|---|---:|---:|---:|
| `uptime-api` | 150,006 bytes | 6,393 bytes | 96% |
| `brandbrain-api` | 16,842 bytes | 3,364 bytes | 80% |

These are measured JSON byte counts, not tokenizer estimates. The compact size
includes both structured content and the text synopsis. Uptime's metric readings,
timestamps, extrema and sample counts match the provider responses exactly.
Brandbrain's six metric signals correctly remain empty. Both services return a
100-trace provider sample with three compact examples, explicit truncation and
100 unknown statuses; none is interpreted as healthy. A one-widget drilldown
returned 12 history points. All eight dashboard/saved-query documents retained
their exact content and ETags. The browser recorded no page errors or document
writes.

Local validation also passed required Go build/vet and engine/pipeline tests,
full Insights/gateway/API/MCP/cmd tests, race/admission tests, pre-commit lint,
seven machine-query browser scenarios, and 15 existing authoring scenarios.
The reusable live validator additionally runs against populated and empty local
provider fixtures to cover omitted empty result arrays.

Receipts and screenshots are in the git-ignored
`artifacts/insights/dashboard-query-live-20261026/`; local fixture evidence is in
`artifacts/insights/dashboard-query/`. Temporary read-only validation tokens were
removed after acceptance. The test used scoped machine credentials, not an
interactive OAuth sign-in test.

## Rollout recheck — 27 October 2026

On 27 October Melbourne time, the API, Insights and Observe gateway were still ready
on the deployed `d4b6f354` image above. No replacement rollout was needed.
The public Observe endpoint advertised `query_dashboard` and passed all four
live machine checks again. The Service overview still resolves eight widgets
into seven unique queries, with all eight saved documents unchanged.

For `uptime-api`, the complete MCP response measured 6,335 bytes against 149,673
bytes of full normalized provider results (96% smaller). For `brandbrain-api`,
it measured 3,363 against 16,825 bytes (80% smaller), correctly preserving empty
HTTP metric signals and a bounded trace sample. All seven real-provider browser
checks also passed, including light/dark desktop/mobile rendering, service
switching and sparklines. Existing unrelated fleet-health warnings are unchanged.

The Observe README and both bundled skills now direct clients to
`list_dashboards` → `query_dashboard` for an existing dashboard instead of
fetching and executing each saved query separately. Package contract tests pass.
Fresh results and a readable bundle presentation are available under
`artifacts/insights/dashboard-bundle-rollout-20261027/` (git-ignored). Temporary
read-only validation tokens were removed after this recheck.
