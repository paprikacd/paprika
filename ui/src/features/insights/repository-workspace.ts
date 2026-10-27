import {
  exampleDashboard,
  exampleMetadata,
  exampleProviders,
  exampleQuery,
} from "./example"
import { EXAMPLE_STORAGE_KEY, readExampleWorkspace } from "./example-storage"
import { createExampleCatalogQuery } from "./example-catalog-query"
import {
  repositoryExamples,
  repositoryExampleFixtures,
  repositoryExampleProviders,
} from "./repository-examples"
import type { InsightsClient } from "./client"

const catalog = createExampleCatalogQuery(repositoryExampleFixtures)
export const repositoryWorkspaceProviders = [
  ...new Map(
    [...repositoryExampleProviders, ...exampleProviders].map((provider) => [
      provider.id,
      provider,
    ]),
  ).values(),
]
export const repositoryWorkspaceQueries = [
  ...new Map(
    repositoryExamples
      .flatMap((entry) => entry.sample.savedQueries ?? [])
      .map((query) => [query.id, query]),
  ).values(),
]

/** Seed only an untouched browser workspace. Edited or deliberately empty libraries remain intact. */
export function readRepositoryExampleWorkspace(
  storage: Pick<Storage, "getItem">,
) {
  if (storage.getItem(EXAMPLE_STORAGE_KEY) !== null)
    return readExampleWorkspace(storage)
  const dashboards = [
    ...new Map(
      [
        exampleDashboard,
        ...repositoryExamples.flatMap((entry) => entry.sample.dashboards),
      ].map((dashboard) => [dashboard.id, dashboard]),
    ).values(),
  ]
  return { dashboards, activeId: exampleDashboard.id }
}

export const repositoryWorkspaceQuery: InsightsClient["query"] = (
  request,
  signal,
) => {
  if (request.kind === "records" || request.query.includes("paprika_example_"))
    return catalog.query(request, signal)
  return exampleQuery(request, signal)
}
export const repositoryWorkspaceMetadata: InsightsClient["metadata"] = async (
  provider,
  options,
  signal,
) => {
  if (
    options.metric?.startsWith("paprika_example_") ||
    provider === "example-records"
  )
    return catalog.metadata(provider, options, signal)
  const previous = await exampleMetadata(provider, options, signal)
  if (options.kind !== "metrics") return previous
  const added = await catalog.metadata(provider, options, signal)
  return {
    ...previous,
    values: [...new Set([...previous.values, ...added.values])].sort(),
    truncated: previous.truncated || added.truncated,
  }
}
