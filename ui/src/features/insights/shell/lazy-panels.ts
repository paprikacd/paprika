import { lazy } from "react"
import type * as RepositoryWorkspaceModule from "../repository-workspace"

export type RepositoryWorkspace = typeof RepositoryWorkspaceModule

export const DashboardHistory = lazy(() => import("../dashboard-history").then(module => ({ default: module.DashboardHistory })))

export const Explorer = lazy(() => import("../explorer").then(module => ({ default: module.Explorer })))

// The shortcut list opens only on request, so it loads then rather than with the first view.
export const ShortcutList = lazy(() => import("../shortcut-list").then(module => ({ default: module.ShortcutList })))

// The inspector is opened on demand, so its code stays out of the first view.
export const QueryInspector = lazy(() => import("../query-inspector").then(module => ({ default: module.QueryInspector })))

// Builder panels and save checks open on request, so their code and styles load then rather than with the first view.
export const DocumentEditor = lazy(() => import("../document-editor").then(module => ({ default: module.DocumentEditor })))

export const ProviderManager = lazy(() => import("../provider-manager").then(module => ({ default: module.ProviderManager })))

export const DashboardManager = lazy(() => import("../dashboard-manager").then(module => ({ default: module.DashboardManager })))

export const ChecksList = lazy(() => import("../checks-list").then(module => ({ default: module.ChecksList })))

export const AIBuilder = lazy(() =>
  import("../ai").then((module) => ({ default: module.AIBuilder })),
)

// The same loaders serve React.lazy and the hover/focus preloads. A failed chunk is reported by its panel's boundary.
export const loadWidgetEditor = () => import("../widget-editor")

export const WidgetEditor = lazy(() => loadWidgetEditor().then((module) => ({ default: module.WidgetEditor })))

export const loadRepositoryGallery = () => import("../repository-gallery")

export const RepositoryGallery = lazy(() => loadRepositoryGallery().then((module) => ({ default: module.RepositoryGallery })))

// The template picker loads only when it is opened, so the empty canvas stays light.
export const loadStarterPicker = () => import("../starter-picker")

export const StarterPicker = lazy(() => loadStarterPicker().then((module) => ({ default: module.StarterPicker })))

// The example catalog (about 1 MB of JSON) and its query engine load only for example mode or the Examples panel.
export const loadRepositoryWorkspace = (): Promise<RepositoryWorkspace> => import("../repository-workspace")

export function preloadWidgetEditor() {
  loadWidgetEditor().catch(() => undefined)
}

export function preloadExamples() {
  loadRepositoryGallery().catch(() => undefined)
  loadRepositoryWorkspace().catch(() => undefined)
}
