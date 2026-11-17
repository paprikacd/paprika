import type { Provider } from "../schema"
import type { DashboardBundle } from "../workspace-transfer"
import type { FixtureDefinition } from "../example-catalog-query"
import catalog from "./catalog.json"
import fixtures from "./fixtures.json"

export type DashboardLibraryBundle = DashboardBundle
export interface SourceCoverage {
  sourceId: string
  sourceTitle: string
  sourceType: string
  sourcePointer?: string
  sourceQuery?: string
  language?: string
  sampleWidgetIds: string[]
  liveWidgetIds: string[]
  status: "mapped" | "adapted" | "source-only" | "unsupported-live"
  notes: string[]
}
export interface RepositoryExample {
  id: string
  title: string
  project: "shorted" | "uptime" | "paprika"
  description: string
  source: { revision: string; paths: string[] }
  sample: DashboardLibraryBundle
  live?: DashboardLibraryBundle
  liveStatus: "ready" | "partial" | "unavailable"
  /** Placeholder source providers; import review remaps these to installed providers. */
  providers: (Provider & { description?: string })[]
  coverage: SourceCoverage[]
  limitations: string[]
}

/** Explicit local sample sources. These never contact a configured live provider. */
export const repositoryExampleProviders: Provider[] = [
  { id: "example-prometheus", name: "Sample metrics", type: "prometheus", capabilities: ["metrics"] },
  { id: "example-tempo", name: "Sample traces", type: "tempo", capabilities: ["traces"] },
  { id: "example-records", name: "Sample application records", type: "shorted", capabilities: ["records"] },
]
export const repositoryExamples: RepositoryExample[] = catalog as unknown as RepositoryExample[]
export const repositoryExampleFixtures: FixtureDefinition[] = fixtures as unknown as FixtureDefinition[]
