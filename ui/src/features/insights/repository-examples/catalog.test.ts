import { describe, expect, it } from "vitest"
import { createExampleCatalogQuery } from "../example-catalog-query"
import { parseDashboardBundle, serializeDashboardBundle, requiredBundleProviders, remapBundleProviders } from "../workspace-transfer"
import { resolveSavedQueryReference } from "../saved-queries"
import { widgetKind } from "../schema"
import { repositoryExamples, repositoryExampleFixtures, repositoryExampleProviders } from "."
import source from "../../../../../docs/design/insights/repository-examples/shorted-sources.json"

const engine = createExampleCatalogQuery(repositoryExampleFixtures)
const range = { start: 1_792_500_000, end: 1_792_503_600, step: 30 }

describe("source-derived repository example library", () => {
  it("keeps all fourteen canonical dashboards and two explicit supplemental collections", () => {
    expect(repositoryExamples).toHaveLength(16)
    expect(new Set(repositoryExamples.map(entry => entry.id)).size).toBe(16)
    expect(repositoryExamples.filter(entry => entry.project === "shorted")).toHaveLength(12)
    expect(repositoryExamples.filter(entry => entry.project === "uptime")).toHaveLength(3)
    expect(repositoryExamples.filter(entry => entry.project === "paprika")).toHaveLength(1)
  })

  it("requires independent mappings for Shorted production telemetry and each local analysis workload", () => {
    const entries = repositoryExamples.slice(0, 5)
    const bundle = {
      dashboards: entries.flatMap(entry => entry.live!.dashboards),
      savedQueries: entries.flatMap(entry => entry.live!.savedQueries!),
    }
    const production = entries[0].providers[0]
    const installed = { ...production, id: "cuttlefish", name: "Cuttlefish Prometheus" }

    // One working Prometheus must not silently satisfy every source repository's telemetry.
    expect(() => remapBundleProviders(bundle, { [production.id]: installed.id }, [installed])).toThrow(/Choose a compatible data source/)
    expect([...requiredBundleProviders(bundle).keys()]).toEqual([
      "source-shorted-grafana-cloud-prometheus",
      "source-shorted-analysis-grafana",
      "source-shorted-analysis-postgres",
      "source-shorted-analysis-prometheus",
    ])
    expect(entries[1].providers[0].id).toBe(production.id)
    expect(entries.flatMap(entry => entry.providers).every(provider => provider.name !== "Shorted source Prometheus")).toBe(true)
  })

  it("accounts for all source Grafana targets, including the synthetic target and row-only panels", () => {
    const examples = repositoryExamples.slice(0, 7)
    const targets = examples.flatMap(entry => entry.coverage.filter(item => item.language))
    expect(targets).toHaveLength(96)
    expect(targets.filter(target => target.sourceQuery)).toHaveLength(95)
    for (const sourceEntry of source.examples.slice(0, 7)) {
      const entry = examples.find(entry => entry.id === sourceEntry.id)!
      for (const panel of sourceEntry.panels) {
        if ("targets" in panel && panel.targets) {
          for (const target of panel.targets) {
            const covered = entry.coverage.find(item => item.sourcePointer === target.sourcePointer)
            expect(covered, `${entry.id}: ${target.sourcePointer}`).toBeDefined()
            expect(covered!.sourceQuery).toEqual(("expression" in target ? target.expression : undefined))
            expect(covered!.sampleWidgetIds.length).toBeGreaterThan(0)
          }
        }
      }
    }
    expect(examples.flatMap(entry => entry.coverage.filter(item => item.sourceType === "row"))).toHaveLength(7)
  })

  it.each(repositoryExamples.map(entry => [entry.id, entry] as const))("validates %s portable query closure and safely resolves its live templates", (_id, entry) => {
    for (const mode of ["sample", "live"] as const) {
      const bundle = entry[mode]
      if (!bundle) continue
      const parsed = parseDashboardBundle(serializeDashboardBundle(bundle, "json"), "json")
      expect(parsed).toEqual(bundle)
      const providers = mode === "sample" ? repositoryExampleProviders : entry.providers
      for (const id of requiredBundleProviders(bundle).keys()) expect(providers.some(provider => provider.id === id)).toBe(true)
      for (const dashboard of bundle.dashboards) {
        const vars = Object.fromEntries((dashboard.variables ?? []).map(v => [v.name, v.defaultValue ?? ""]))
        for (const widget of dashboard.widgets) {
          expect(widget.queryRef, widget.id).toBeDefined()
          const query = resolveSavedQueryReference(widget.queryRef!, bundle.savedQueries!, vars, widgetKind(widget))
          expect(query.query).not.toContain("{{")
          if (mode === "live") {
            expect(query.providerId).not.toMatch(/^example-/)
            expect(query.query).not.toContain("paprika_example_")
            if (query.query.startsWith("{")) expect(() => JSON.parse(query.query)).not.toThrow()
            expect(query.query).not.toMatch(/\$__(?:rate_)?interval|\$(?:stocks|top10shorts|service|instance|db)\b/)
          }
        }
      }
    }
  })

  it.each(repositoryExamples.map(entry => [entry.id, entry] as const))("executes every %s sample saved query without contacting live providers", async (_id, entry) => {
    for (const dashboard of entry.sample.dashboards) {
      const vars = Object.fromEntries((dashboard.variables ?? []).map(v => [v.name, v.defaultValue ?? ""]))
      for (const widget of dashboard.widgets) {
        const resolved = resolveSavedQueryReference(widget.queryRef!, entry.sample.savedQueries!, vars, widgetKind(widget))
        const result = await engine.query({ ...resolved, ...range }, new AbortController().signal)
        expect(result.series ?? result.records?.rows ?? result.traces, `${entry.id}/${widget.id}`).toBeDefined()
        expect((result.series ?? result.records?.rows ?? result.traces)!.length, `${entry.id}/${widget.id}`).toBeGreaterThan(0)
      }
    }
  })

  it("retains exact authored housing points, gaps and source elasticity instead of shifting dates", async () => {
    const entry = repositoryExamples.find(entry => entry.id === "shorted-housing-feature")!
    expect(entry.live).toBeUndefined()
    const widget = entry.sample.dashboards[0].widgets.find(w => w.id === "policy-price")!
    const result = await engine.query({ ...resolveSavedQueryReference(widget.queryRef!, entry.sample.savedQueries!, {}, "records"), ...range }, new AbortController().signal)
    expect(result.records!.rows[0]).toEqual([1980, 39.04, null, null])
    expect(result.records!.rows.find(row => row[0] === 2010)?.[1]).toBe(100)
    const scenario = entry.sample.dashboards[0].widgets.find(w => w.id === "borrowing-power")!
    const scenarios = await engine.query({ ...resolveSavedQueryReference(scenario.queryRef!, entry.sample.savedQueries!, {}, "records"), ...range }, new AbortController().signal)
    expect(scenarios.records!.rows.find(row => row[0] === 6)).toEqual([6, 100, 100, 0, 0])
    expect(scenarios.records!.rows.find(row => row[0] === 5)).toEqual([5, 128, 117, 28, 17])
  })

  it("selects recent bounded SQL history before chronological presentation and preserves source filters", () => {
    const histories: string[] = []
    for (const entry of repositoryExamples) {
      const bundle = entry.live
      if (!bundle) continue
      for (const saved of bundle.savedQueries ?? []) {
        if (saved.providerId !== "source-shorted-postgresql") continue
        const original = entry.coverage.find(item => item.sourceId === saved.metadata?.sourcePanel)!
        expect(original.sourceQuery).toBeDefined()
        const widget = bundle.dashboards[0].widgets.find(item => item.queryRef?.id === saved.id)!
        const variables = Object.fromEntries(bundle.dashboards[0].variables!.map(variable => [variable.name, variable.defaultValue ?? ""]))
        const initial = JSON.parse(resolveSavedQueryReference(widget.queryRef!, bundle.savedQueries!, variables, "metrics").query)
        const sourceSQL = original.sourceQuery!.trim().replace(/;$/, "").replace(/\$(?:stocks|top10shorts)\b/g, "$1")
        if (!initial.projection.time) {
          expect(initial.sql).toBe(sourceSQL)
          expect(initial.sql).not.toContain("recent_history")
          continue
        }
        histories.push(saved.id)
        const sourceBlock = initial.sql.slice(initial.sql.indexOf("SELECT * FROM (\n", 1) + "SELECT * FROM (\n".length, initial.sql.indexOf("\n  ) AS source_history"))
        expect(sourceBlock).toBe(sourceSQL)
        expect(initial.sql).toMatch(/\) AS source_history\s+ORDER BY "time" DESC NULLS LAST\s+LIMIT 100\s+\) AS recent_history\s+ORDER BY "time" ASC NULLS LAST$/)
        expect(original.notes.some(note => note.includes("latest 100 source observations") && note.includes("filters remain intact"))).toBe(true)
        expect(entry.limitations.some(note => note.includes("full history and dashboard-range filtering are not implied"))).toBe(true)
        expect(saved.description).toContain("Latest 100 source observations")
        expect(bundle.dashboards[0].description).toContain("latest 100 source observations")
        expect(bundle.dashboards[0].description).toContain("dashboard time range does not rewrite this SQL")
        const selected = saved.parameters![0].name
        for (const stock of ["BHP", "BHP' OR TRUE --"]) {
          const changed = JSON.parse(resolveSavedQueryReference(widget.queryRef!, bundle.savedQueries!, { ...variables, [selected]: stock }, "metrics").query)
          expect(changed.sql).toBe(initial.sql)
          expect(changed.parameters).toEqual([stock])
        }
      }
    }
    expect(histories).toEqual(["src-shorted-per-stock-p2-t0", "src-shorted-per-stock-p3-t0", "src-shorted-shorts-overview-p1-t0"])
  })

  it("binds the remaining application operations to real read adapters with explicit admin scope", () => {
    const admin = repositoryExamples.find(entry => entry.id === "shorted-admin-dashboard")!
    expect(admin.liveStatus).toBe("ready")
    expect(admin.live!.savedQueries!.map(query => JSON.parse(query.query.replace("{{environment}}", '"production"')).operation)).toEqual(["admin_fleet", "admin_issues", "admin_jobs", "admin_sync"])
    const collection = repositoryExamples.find(entry => entry.id === "shorted-widget-catalog")!
    expect(collection.coverage.filter(item => item.status === "unsupported-live")).toEqual([])
    expect(collection.live!.savedQueries!.some(query => query.query.includes("portfolio_positions"))).toBe(true)
    expect(collection.live!.savedQueries!.some(query => query.query.includes("screener"))).toBe(true)
    expect(collection.live!.savedQueries!.some(query => query.query.includes("sector_performance"))).toBe(true)
  })

  it("updates sample portfolio values from explicit quantity variables", async () => {
    const entry = repositoryExamples.find(entry => entry.id === "shorted-widget-catalog")!
    const dashboard = entry.sample.dashboards[0]
    const widget = dashboard.widgets.find(widget => widget.id === "portfolio-summary")!
    const variables = Object.fromEntries(dashboard.variables!.map(variable => [variable.name, variable.defaultValue ?? ""]))
    variables.cba_shares = "2"
    const resolved = resolveSavedQueryReference(widget.queryRef!, entry.sample.savedQueries!, variables, "records")
    const result = await engine.query({ ...resolved, ...range }, new AbortController().signal)
    const columns = result.records!.columns
    const cba = result.records!.rows.find(row => row[columns.findIndex(column => column.key === "stock_code")] === "CBA")!
    expect(cba[columns.findIndex(column => column.key === "quantity")]).toBe(2)
    expect(cba[columns.findIndex(column => column.key === "market_value")]).toBe(270.4)
  })

  it("keeps snapshot counts compact and layouts free of overlaps", () => {
    const overview = repositoryExamples.find(entry => entry.id === "uptime-overview")!.sample.dashboards[0]
    expect(overview.widgets.slice(0, 4).map(widget => widget.layout)).toEqual([0, 3, 6, 9].map(x => ({ x, y: 0, w: 3, h: 3 })))
    for (const widget of overview.widgets.slice(0, 4)) expect(widget.options).toMatchObject({ decimals: 0, showSparkline: false })
    for (const entry of repositoryExamples) for (const bundle of [entry.sample, entry.live]) {
      if (!bundle) continue
      for (const dashboard of bundle.dashboards) for (let i = 0; i < dashboard.widgets.length; i++) {
        const a = dashboard.widgets[i].layout
        for (const other of dashboard.widgets.slice(i + 1)) {
          const b = other.layout
          expect(a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y, `${dashboard.id}: overlapping widgets`).toBe(false)
        }
      }
    }
  })

  it("binds sample trace service and admin all-environment filters", async () => {
    const interaction = repositoryExamples.find(entry => entry.id === "paprika-signal-features")!
    const traces = interaction.sample.dashboards[0].widgets.find(widget => widget.id === "traces")!
    const traceQuery = resolveSavedQueryReference(traces.queryRef!, interaction.sample.savedQueries!, { service: "worker" }, "traces")
    expect((await engine.query({ ...traceQuery, ...range }, new AbortController().signal)).traces!.map(trace => trace.service)).toEqual(["worker"])
    const admin = repositoryExamples.find(entry => entry.id === "shorted-admin-dashboard")!
    const sync = admin.sample.dashboards[0].widgets.find(widget => widget.id === "market-data-sync")!
    const all = resolveSavedQueryReference(sync.queryRef!, admin.sample.savedQueries!, { environment: "" }, "records")
    const production = resolveSavedQueryReference(sync.queryRef!, admin.sample.savedQueries!, { environment: "production" }, "records")
    expect((await engine.query({ ...all, ...range }, new AbortController().signal)).records!.rows).toHaveLength(2)
    expect((await engine.query({ ...production, ...range }, new AbortController().signal)).records!.rows).toHaveLength(1)
  })

})
