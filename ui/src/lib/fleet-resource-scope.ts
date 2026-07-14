import {
  FleetMapNodeKind,
  ListPipelinesRequest,
  type FleetMapNode,
  type Pipeline,
  type Release,
  type Rollout,
} from "@/gen/paprika/v1/api_pb"
import type { FleetScope } from "@/lib/fleet-scope-context"
import type { NamespacedKey } from "@/lib/fleet-query"

export interface FleetMapApplicationAssociation {
  identity: NamespacedKey
  project?: NamespacedKey
  currentCluster?: NamespacedKey
  currentStage: string
}

export function planPipelineScopeRequests(
  scope: FleetScope,
): readonly ListPipelinesRequest[] {
  const namespaces = uniqueSortedStrings(scope.namespaces)
  const namespaceSet = new Set(namespaces)
  const projects = uniqueSortedKeys(scope.projects)

  if (projects.length > 0) {
    return projects
      .filter((project) => namespaces.length === 0 || namespaceSet.has(project.namespace))
      .map(
        (project) =>
          new ListPipelinesRequest({
            namespace: project.namespace,
            project: project.name,
          }),
      )
  }

  if (namespaces.length > 0) {
    return namespaces.map((namespace) => new ListPipelinesRequest({ namespace }))
  }

  return [new ListPipelinesRequest()]
}

export function mergeScopedPipelines(
  responses: readonly (readonly Pipeline[])[],
): readonly Pipeline[] {
  const seen = new Set<string>()
  const pipelines: Pipeline[] = []
  for (const response of responses) {
    for (const pipeline of response) {
      const key = resourceKey(pipeline.namespace, pipeline.name)
      if (seen.has(key)) continue
      seen.add(key)
      pipelines.push(pipeline)
    }
  }
  return pipelines
}

export function flattenMapApplicationAssociations(
  roots: readonly FleetMapNode[],
): readonly FleetMapApplicationAssociation[] {
  const applications: FleetMapApplicationAssociation[] = []

  const visit = (node: FleetMapNode) => {
    const identity = node.application
    if (
      node.kind === FleetMapNodeKind.APPLICATION &&
      identity?.namespace &&
      identity.name
    ) {
      const metadata = node.applicationMetadata
      applications.push({
        identity: { namespace: identity.namespace, name: identity.name },
        project: namespacedKey(metadata?.project),
        currentCluster: namespacedKey(metadata?.currentCluster),
        currentStage: metadata?.currentStage ?? "",
      })
    }
    for (const child of node.children) visit(child)
  }

  for (const root of roots) visit(root)
  return applications
}

export function buildRolloutApplicationAssociations(
  rollouts: readonly Rollout[],
  releases: readonly Release[],
  applications: readonly FleetMapApplicationAssociation[],
): ReadonlyMap<string, FleetMapApplicationAssociation> {
  const releasesByRollout = new Map<string, Release[]>()
  for (const release of releases) {
    if (!release.namespace || !release.rolloutRef) continue
    appendBucket(releasesByRollout, resourceKey(release.namespace, release.rolloutRef), release)
  }

  const applicationsByIdentity = new Map<string, FleetMapApplicationAssociation[]>()
  for (const application of applications) {
    if (!application.identity.namespace || !application.identity.name) continue
    appendBucket(
      applicationsByIdentity,
      resourceKey(application.identity.namespace, application.identity.name),
      application,
    )
  }

  const associations = new Map<string, FleetMapApplicationAssociation>()
  for (const rollout of rollouts) {
    if (!rollout.namespace || !rollout.name) continue
    const rolloutKey = resourceKey(rollout.namespace, rollout.name)
    const releaseMatches = releasesByRollout.get(rolloutKey)
    if (releaseMatches?.length !== 1) continue

    const applicationName = releaseMatches[0].application
    if (!applicationName) continue
    const applicationMatches = applicationsByIdentity.get(
      resourceKey(rollout.namespace, applicationName),
    )
    if (applicationMatches?.length !== 1) continue
    associations.set(rolloutKey, applicationMatches[0])
  }
  return associations
}

export function rolloutMatchesFleetScope(
  rollout: Rollout,
  associatedApplication: FleetMapApplicationAssociation | undefined,
  scope: FleetScope,
): boolean {
  if (
    scope.namespaces.length > 0 &&
    !scope.namespaces.includes(rollout.namespace)
  ) {
    return false
  }

  const needsAssociation =
    scope.projects.length > 0 || scope.clusters.length > 0 || scope.stages.length > 0
  if (needsAssociation && !associatedApplication) return false
  if (!associatedApplication) return true

  if (
    scope.projects.length > 0 &&
    (!associatedApplication.project ||
      !scope.projects.some((project) => sameKey(project, associatedApplication.project!)))
  ) {
    return false
  }
  if (
    scope.clusters.length > 0 &&
    (!associatedApplication.currentCluster ||
      !scope.clusters.some((cluster) =>
        sameKey(cluster, associatedApplication.currentCluster!),
      ))
  ) {
    return false
  }
  if (
    scope.stages.length > 0 &&
    !scope.stages.includes(associatedApplication.currentStage)
  ) {
    return false
  }
  return true
}

function uniqueSortedStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right))
}

function uniqueSortedKeys(values: readonly NamespacedKey[]): NamespacedKey[] {
  const keys = new Map<string, NamespacedKey>()
  for (const value of values) {
    if (!value.namespace || !value.name) continue
    keys.set(resourceKey(value.namespace, value.name), value)
  }
  return [...keys.values()].sort((left, right) =>
    resourceKey(left.namespace, left.name).localeCompare(resourceKey(right.namespace, right.name)),
  )
}

function namespacedKey(
  value: { namespace: string; name: string } | undefined,
): NamespacedKey | undefined {
  if (!value?.namespace || !value.name) return undefined
  return { namespace: value.namespace, name: value.name }
}

function sameKey(left: NamespacedKey, right: NamespacedKey): boolean {
  return left.namespace === right.namespace && left.name === right.name
}

function resourceKey(namespace: string, name: string): string {
  return `${namespace}/${name}`
}

function appendBucket<T>(buckets: Map<string, T[]>, key: string, value: T) {
  const bucket = buckets.get(key)
  if (bucket) bucket.push(value)
  else buckets.set(key, [value])
}
