import { type Dashboard } from "../schema"
import { type RejectedLinkPart } from "../drilldown"
import { type DuplicatePlacement } from "../layout-edit"
import { readDashboardLink } from "../dashboard-view"

/** The notice phrase for where a copy settled. A copy the compactor lifted out of its row says nothing about its neighbour. */
export function placementPhrase(placement: DuplicatePlacement): string {
  return placement === "beside" ? " beside it" : placement === "below" ? " below it" : ""
}

export function initialNavigation(documents: Dashboard[], fallback: Dashboard) {
  try {
    const link = readDashboardLink()
    if (!link.navigation) return { document: fallback, link: { dashboardId: fallback.id }, rejected: [] as RejectedLinkPart[], error: "" }
    const document = documents.find(item => item.id === link.navigation!.dashboardId)
    if (!document) throw new Error("The linked dashboard is unavailable. Choose a dashboard from the library.")
    return { document, link: link.navigation, rejected: link.rejected, error: "" }
  } catch (error) {
    return { document: fallback, link: { dashboardId: fallback.id }, rejected: [] as RejectedLinkPart[], error: error instanceof Error ? error.message : "Invalid dashboard link" }
  }
}

/** The first visible control that opens the builder panel with this name, if one is on screen. */
export function panelOpenerElement(name: string): HTMLElement | null {
  for (const element of document.querySelectorAll<HTMLElement>(`[data-panel-opener="${CSS.escape(name)}"]`)) {
    if (element.isConnected && !element.closest("[inert], [hidden]") && !element.matches(":disabled")) return element
  }
  return null
}
