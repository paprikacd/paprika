import { dashboardSchema, type Dashboard } from "./schema"
import { exampleDashboard } from "./example"
import { documentFingerprint } from "./fingerprint"
import type { InsightsClient } from "./client"

export const EXAMPLE_STORAGE_KEY = "paprika-insights-example-v1"
export interface ExampleWorkspace {
  dashboards: Dashboard[]
  activeId: string
}

export function readExampleWorkspace(storage: Pick<Storage, "getItem">): ExampleWorkspace {
  try {
    const source = storage.getItem(EXAMPLE_STORAGE_KEY)
    if (source) {
      const parsed = JSON.parse(source)
      // Accept the single-document format written by the first preview.
      if (parsed.schemaVersion === 1) {
        const dashboard = dashboardSchema.parse(parsed)
        return { dashboards: [dashboard], activeId: dashboard.id }
      }
      const dashboards = dashboardSchema.array().max(100).parse(parsed.dashboards)
      if (!dashboards.length && parsed.activeId === "") return { dashboards, activeId: "" }
      if (dashboards.length && dashboards.some((item) => item.id === parsed.activeId))
        return { dashboards, activeId: parsed.activeId }
    }
  } catch {
    /* Invalid local examples never prevent opening the workspace. */
  }
  return { dashboards: [exampleDashboard], activeId: exampleDashboard.id }
}

export function saveExampleWorkspace(
  storage: Pick<Storage, "setItem">,
  dashboards: Dashboard[],
  active: Dashboard,
) {
  const documents = [
    ...dashboards.filter((item) => item.id !== active.id),
    dashboardSchema.parse(active),
  ]
  if (documents.length > 100)
    throw new Error("The example workspace supports up to 100 dashboards.")
  storage.setItem(
    EXAMPLE_STORAGE_KEY,
    JSON.stringify({ dashboards: documents, activeId: active.id }),
  )
  return documents
}

export function writeExampleWorkspace(
  storage: Pick<Storage, "setItem">,
  dashboards: Dashboard[],
  activeId: string,
) {
  const documents = dashboardSchema.array().max(100).parse(dashboards)
  const selected = documents.some((item) => item.id === activeId)
    ? activeId
    : (documents[0]?.id ?? "")
  storage.setItem(
    EXAMPLE_STORAGE_KEY,
    JSON.stringify({ dashboards: documents, activeId: selected }),
  )
}

/** Import reads and conditional writes always use the persisted browser workspace. */
export function createExampleDashboardImportClient(
  storage: Pick<Storage, "getItem" | "setItem">,
): Pick<InsightsClient, "list" | "get" | "save"> {
  return {
    list: async () => readExampleWorkspace(storage).dashboards,
    get: async id => {
      const dashboard = readExampleWorkspace(storage).dashboards.find(item => item.id === id)
      if (!dashboard) throw new Error("Dashboard not found. Refresh the comparison.")
      return { dashboard, etag: documentFingerprint(dashboard) }
    },
    save: async (input, etag) => {
      const document = dashboardSchema.parse(input)
      const workspace = readExampleWorkspace(storage)
      const old = workspace.dashboards.find(item => item.id === document.id)
      if ((old && documentFingerprint(old) !== etag) || (!old && etag))
        throw new Error("This dashboard changed. Refresh the comparison before importing.")
      writeExampleWorkspace(storage, [...workspace.dashboards.filter(item => item.id !== document.id), document], workspace.activeId)
      return documentFingerprint(document)
    },
  }
}
