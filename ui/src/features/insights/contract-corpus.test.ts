// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { galleryDocuments } from "../../../../demo/insights-gallery/dashboards.mjs"
import { referenceDashboardBundles } from "../../../e2e/fixtures/reference-dashboard-data"
import { registerDefaultWidgetPlugins } from "./plugins/threshold-gauge"
import { dashboardSchema } from "./schema"
import { getWidgetDefinition } from "./widget-registry"

// Every document the product ships as an example must pass the canonical dashboard schema, and every plugin widget in
// them must pass its own plugin's configuration schema. A new example that breaks either fails here, not in a demo.
const repository = new URL("../../../../", import.meta.url)

interface WidgetLike {
  id?: string
  type: string
  pluginId?: string
  config?: unknown
}
interface DocumentLike {
  id?: string
  widgets?: WidgetLike[]
}

function starters(): DocumentLike[] {
  const folder = new URL("internal/insights/starters/", repository)
  return readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(new URL(name, folder), "utf8")) as DocumentLike)
}

function catalogDocuments(): DocumentLike[] {
  const catalog = JSON.parse(
    readFileSync(new URL("ui/src/features/insights/repository-examples/catalog.json", repository), "utf8"),
  ) as Array<{ sample: { dashboards: DocumentLike[] } }>
  return catalog.flatMap((entry) => entry.sample.dashboards)
}

function galleryDocumentsForTest(): DocumentLike[] {
  return galleryDocuments({ metrics: "metrics", traces: "traces", records: "records" }).dashboards as DocumentLike[]
}

function referenceDocuments(): DocumentLike[] {
  return referenceDashboardBundles.flatMap((bundle) => bundle.dashboards as DocumentLike[])
}

const corpora: Array<[string, () => DocumentLike[]]> = [
  ["starters", starters],
  ["repository examples", catalogDocuments],
  ["gallery", galleryDocumentsForTest],
  ["reference dashboards", referenceDocuments],
]

registerDefaultWidgetPlugins()

describe("example corpus passes the contract", () => {
  for (const [name, load] of corpora) {
    it(`every ${name} document passes the dashboard schema`, () => {
      const documents = load()
      expect(documents.length).toBeGreaterThan(0)
      const failures = documents.flatMap((document) => {
        const result = dashboardSchema.safeParse(document)
        return result.success ? [] : [`${document.id ?? "(no id)"}: ${result.error.issues[0]?.message ?? "invalid"}`]
      })
      expect(failures).toEqual([])
    })
  }

  it("every plugin widget in the corpus passes its plugin's configuration schema", () => {
    const failures = corpora.flatMap(([, load]) =>
      load().flatMap((document) =>
        (document.widgets ?? []).flatMap((widget) => {
          if (widget.type !== "plugin" || widget.pluginId === undefined) return []
          const schema = getWidgetDefinition("plugin", widget.pluginId)?.configSchema
          if (!schema) return []
          const result = schema.safeParse(widget.config ?? {})
          return result.success ? [] : [`${document.id}/${widget.id}: ${widget.pluginId} ${result.error.issues[0]?.message ?? "invalid"}`]
        }),
      ),
    )
    expect(failures).toEqual([])
  })
})
