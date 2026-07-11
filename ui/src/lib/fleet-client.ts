"use client"

import { createPromiseClient, type PromiseClient } from "@connectrpc/connect"

import { PaprikaService } from "@/gen/paprika/v1/api_connect"
import {
  ApplicationSummary as ApplicationSummaryMessage,
  FleetCapability as FleetCapabilityProto,
  FleetConnectionState as FleetConnectionStateProto,
  FleetFacetBucket as FleetFacetBucketMessage,
  FleetFacetDimension as FleetFacetDimensionProto,
  FleetFilter as FleetFilterMessage,
  FleetGroupDimension as FleetGroupDimensionProto,
  FleetHealth as FleetHealthProto,
  FleetHealthBucket as FleetHealthBucketMessage,
  FleetMapNode as FleetMapNodeMessage,
  FleetMapNodeKind as FleetMapNodeKindProto,
  FleetMatrixCell as FleetMatrixCellMessage,
  FleetMatrixHeader as FleetMatrixHeaderMessage,
  FleetObjectKey as FleetObjectKeyMessage,
  FleetReleaseState as FleetReleaseStateProto,
  FleetRolloutState as FleetRolloutStateProto,
  FleetSizeMetric as FleetSizeMetricProto,
  FleetSortDirection as FleetSortDirectionProto,
  FleetSortField as FleetSortFieldProto,
  FleetSourceType as FleetSourceTypeProto,
  FleetSyncState as FleetSyncStateProto,
  QueryApplicationsRequest,
  type QueryApplicationsResponse,
  QueryFleetMapRequest,
  type QueryFleetMapResponse,
  QueryFleetMatrixRequest,
  type QueryFleetMatrixResponse,
  type StageTargetSummary as StageTargetSummaryMessage,
} from "@/gen/paprika/v1/api_pb"
import type {
  FleetGroup,
  FleetHealth,
  FleetQueryState,
  FleetRelease,
  FleetRollout,
  FleetSource,
  FleetSync,
  NamespacedKey,
} from "@/lib/fleet-query"
import { createTransport } from "@/lib/transport"

export type FleetHealthStatus = FleetHealth | "unspecified"
export type FleetSyncStatus = FleetSync | "unspecified"
export type FleetReleaseStatus = FleetRelease | "unspecified"
export type FleetRolloutStatus = FleetRollout | "unspecified"
export type FleetSourceStatus = FleetSource | "unspecified"
export type FleetConnectionStatus =
  | "healthy"
  | "unhealthy"
  | "disabled"
  | "not_configured"
  | "unspecified"
export type FleetCapability =
  | "application_sync"
  | "release_rollback"
  | "gate_approve"
  | "pipeline_retry"
  | "unspecified"
export type FleetFacetDimension =
  | "project"
  | "namespace"
  | "cluster"
  | "stage"
  | "health"
  | "sync"
  | "release"
  | "rollout"
  | "source_type"
  | "unspecified"

export interface FleetStageTarget {
  stableId: string
  stage: string
  ring: number
  cluster?: NamespacedKey
  clusterLabel: string
  health: FleetHealthStatus
  clusterConnection: FleetConnectionStatus
  unmanagedInlineCluster: boolean
}

export interface FleetApplicationSummary {
  identity?: NamespacedKey
  project?: NamespacedKey
  targets: FleetStageTarget[]
  currentStage: string
  currentCluster?: NamespacedKey
  currentClusterLabel: string
  sourceType: FleetSourceStatus
  sourceRevision: string
  health: FleetHealthStatus
  sync: FleetSyncStatus
  driftCount: number
  missingResourceCount: number
  releaseState: FleetReleaseStatus
  rolloutState: FleetRolloutStatus
  resourceCount: number
  repository?: NamespacedKey
  repositoryConnection: FleetConnectionStatus
  effectiveObservabilitySource?: NamespacedKey
  observabilityConnection: FleetConnectionStatus
  blockedGateCount: number
  lastTransitionUnixMs: bigint
  capabilities: FleetCapability[]
}

export interface FleetFacetBucket {
  dimension: FleetFacetDimension
  object?: NamespacedKey
  value?: string
  label: string
  count: bigint
}

export interface FleetApplicationsPage {
  applications: FleetApplicationSummary[]
  total: bigint
  nextCursor: string
  indexGeneration: bigint
  facets: FleetFacetBucket[]
}

export interface FleetHealthBucket {
  health: FleetHealthStatus
  count: bigint
}

export interface FleetMapNode {
  stableId: string
  kind: "group" | "application" | "unspecified"
  label: string
  application?: NamespacedKey
  groupObject?: NamespacedKey
  groupValue?: string
  applicationCount: bigint
  targetCount: bigint
  health: FleetHealthBucket[]
  resourceWeight: bigint
  requestRateWeight: number
  effectiveWeight: number
  usedResourceFallback: boolean
  children: FleetMapNode[]
}

export interface FleetMapResult {
  roots: FleetMapNode[]
  total: bigint
  indexGeneration: bigint
  facets: FleetFacetBucket[]
}

export interface FleetMatrixHeader {
  stableId: string
  label: string
  object?: NamespacedKey
  value?: string
}

export interface FleetMatrixCell {
  rowId: string
  columnId: string
  applicationCount: bigint
  targetCount: bigint
  health: FleetHealthBucket[]
  resourceWeight: bigint
  requestRateWeight: number
  usedResourceFallback: boolean
}

export interface FleetMatrixResult {
  rows: FleetMatrixHeader[]
  columns: FleetMatrixHeader[]
  cells: FleetMatrixCell[]
  total: bigint
  indexGeneration: bigint
  facets: FleetFacetBucket[]
}

export interface QueryApplicationsOptions {
  cursor?: string
  pageSize?: number
  signal?: AbortSignal
}

export interface FleetRequestOptions {
  signal?: AbortSignal
}

let browserFleetClient: PromiseClient<typeof PaprikaService> | undefined

export function getFleetClient(): PromiseClient<typeof PaprikaService> {
  browserFleetClient ??= createPromiseClient(PaprikaService, createTransport())
  return browserFleetClient
}

export function toQueryApplicationsRequest(
  state: FleetQueryState,
  options: Pick<QueryApplicationsOptions, "cursor" | "pageSize"> = {},
): QueryApplicationsRequest {
  return new QueryApplicationsRequest({
    filter: toFleetFilter(state),
    search: state.q,
    sort: toSortField(state.sort),
    direction: toSortDirection(state.direction),
    pageSize: options.pageSize ?? 100,
    cursor: options.cursor ?? "",
  })
}

export function toQueryFleetMapRequest(state: FleetQueryState): QueryFleetMapRequest {
  return new QueryFleetMapRequest({
    filter: toFleetFilter(state),
    search: state.q,
    group: toGroupDimension(state.group),
    sizeMetric: toSizeMetric(state.size),
  })
}

export function toQueryFleetMatrixRequest(state: FleetQueryState): QueryFleetMatrixRequest {
  return new QueryFleetMatrixRequest({
    filter: toFleetFilter(state),
    search: state.q,
    rowGroup: toGroupDimension(state.rows),
    columnGroup: toGroupDimension(state.columns),
    sizeMetric: toSizeMetric(state.size),
  })
}

export async function queryApplications(
  state: FleetQueryState,
  options: QueryApplicationsOptions = {},
): Promise<FleetApplicationsPage> {
  const response = await getFleetClient().queryApplications(
    toQueryApplicationsRequest(state, options),
    { signal: options.signal },
  )
  return fromQueryApplicationsResponse(response)
}

export async function queryFleetMap(
  state: FleetQueryState,
  options: FleetRequestOptions = {},
): Promise<FleetMapResult> {
  const response = await getFleetClient().queryFleetMap(toQueryFleetMapRequest(state), {
    signal: options.signal,
  })
  return fromQueryFleetMapResponse(response)
}

export async function queryFleetMatrix(
  state: FleetQueryState,
  options: FleetRequestOptions = {},
): Promise<FleetMatrixResult> {
  const response = await getFleetClient().queryFleetMatrix(toQueryFleetMatrixRequest(state), {
    signal: options.signal,
  })
  return fromQueryFleetMatrixResponse(response)
}

export function fromQueryApplicationsResponse(
  response: QueryApplicationsResponse,
): FleetApplicationsPage {
  return {
    applications: response.applications.map(fromApplicationSummary),
    total: response.total,
    nextCursor: response.nextCursor,
    indexGeneration: response.indexGeneration,
    facets: response.facets.map(fromFacetBucket),
  }
}

export function fromQueryFleetMapResponse(response: QueryFleetMapResponse): FleetMapResult {
  return {
    roots: response.roots.map(fromMapNode),
    total: response.total,
    indexGeneration: response.indexGeneration,
    facets: response.facets.map(fromFacetBucket),
  }
}

export function fromQueryFleetMatrixResponse(response: QueryFleetMatrixResponse): FleetMatrixResult {
  return {
    rows: response.rows.map(fromMatrixHeader),
    columns: response.columns.map(fromMatrixHeader),
    cells: response.cells.map(fromMatrixCell),
    total: response.total,
    indexGeneration: response.indexGeneration,
    facets: response.facets.map(fromFacetBucket),
  }
}

function toFleetFilter(state: FleetQueryState): FleetFilterMessage {
  return new FleetFilterMessage({
    projects: state.projects.map(toObjectKey),
    namespaces: [...state.namespaces],
    clusters: state.clusters.map(toObjectKey),
    stages: [...state.stages],
    health: state.health.map(toHealth),
    sync: state.sync.map(toSync),
    releaseStates: state.release.map(toRelease),
    rolloutStates: state.rollout.map(toRollout),
    sourceTypes: state.sources.map(toSource),
  })
}

function toObjectKey(key: NamespacedKey): FleetObjectKeyMessage {
  return new FleetObjectKeyMessage({ namespace: key.namespace, name: key.name })
}

function fromObjectKey(key?: FleetObjectKeyMessage): NamespacedKey | undefined {
  return key ? { namespace: key.namespace, name: key.name } : undefined
}

function toHealth(value: FleetHealth): FleetHealthProto {
  switch (value) {
    case "healthy":
      return FleetHealthProto.HEALTHY
    case "progressing":
      return FleetHealthProto.PROGRESSING
    case "degraded":
      return FleetHealthProto.DEGRADED
    case "failed":
      return FleetHealthProto.FAILED
    case "unknown":
      return FleetHealthProto.UNKNOWN
    case "missing":
      return FleetHealthProto.MISSING
  }
}

function toSync(value: FleetSync): FleetSyncStateProto {
  switch (value) {
    case "synced":
      return FleetSyncStateProto.SYNCED
    case "out_of_sync":
      return FleetSyncStateProto.OUT_OF_SYNC
    case "unknown":
      return FleetSyncStateProto.UNKNOWN
  }
}

function toSource(value: FleetSource): FleetSourceTypeProto {
  switch (value) {
    case "git":
      return FleetSourceTypeProto.GIT
    case "helm":
      return FleetSourceTypeProto.HELM
    case "kustomize":
      return FleetSourceTypeProto.KUSTOMIZE
    case "s3":
      return FleetSourceTypeProto.S3
    case "oci":
      return FleetSourceTypeProto.OCI
    case "inline":
      return FleetSourceTypeProto.INLINE
  }
}

function toRelease(value: FleetRelease): FleetReleaseStateProto {
  switch (value) {
    case "pending":
      return FleetReleaseStateProto.PENDING
    case "promoting":
      return FleetReleaseStateProto.PROMOTING
    case "canarying":
      return FleetReleaseStateProto.CANARYING
    case "verifying":
      return FleetReleaseStateProto.VERIFYING
    case "complete":
      return FleetReleaseStateProto.COMPLETE
    case "failed":
      return FleetReleaseStateProto.FAILED
    case "rolled_back":
      return FleetReleaseStateProto.ROLLED_BACK
    case "superseded":
      return FleetReleaseStateProto.SUPERSEDED
    case "awaiting_approval":
      return FleetReleaseStateProto.AWAITING_APPROVAL
  }
}

function toRollout(value: FleetRollout): FleetRolloutStateProto {
  switch (value) {
    case "pending":
      return FleetRolloutStateProto.PENDING
    case "progressing":
      return FleetRolloutStateProto.PROGRESSING
    case "paused":
      return FleetRolloutStateProto.PAUSED
    case "healthy":
      return FleetRolloutStateProto.HEALTHY
    case "degraded":
      return FleetRolloutStateProto.DEGRADED
    case "failed":
      return FleetRolloutStateProto.FAILED
    case "rolled_back":
      return FleetRolloutStateProto.ROLLED_BACK
    case "aborted":
      return FleetRolloutStateProto.ABORTED
  }
}

function toSortField(value: FleetQueryState["sort"]): FleetSortFieldProto {
  switch (value) {
    case "name":
      return FleetSortFieldProto.NAME
    case "project":
      return FleetSortFieldProto.PROJECT
    case "cluster":
      return FleetSortFieldProto.CLUSTER
    case "stage":
      return FleetSortFieldProto.STAGE
    case "health":
      return FleetSortFieldProto.HEALTH
    case "sync":
      return FleetSortFieldProto.SYNC
    case "release":
      return FleetSortFieldProto.RELEASE
    case "rollout":
      return FleetSortFieldProto.ROLLOUT
    case "resource_count":
      return FleetSortFieldProto.RESOURCE_COUNT
    case "last_transition":
      return FleetSortFieldProto.LAST_TRANSITION
    case "impact":
      return FleetSortFieldProto.IMPACT
    case "relevance":
      return FleetSortFieldProto.RELEVANCE
  }
}

function toSortDirection(value: FleetQueryState["direction"]): FleetSortDirectionProto {
  return value === "desc" ? FleetSortDirectionProto.DESC : FleetSortDirectionProto.ASC
}

function toGroupDimension(value: FleetGroup): FleetGroupDimensionProto {
  switch (value) {
    case "project":
      return FleetGroupDimensionProto.PROJECT
    case "cluster":
      return FleetGroupDimensionProto.CLUSTER
    case "stage":
      return FleetGroupDimensionProto.STAGE
    case "health":
      return FleetGroupDimensionProto.HEALTH
  }
}

function toSizeMetric(value: FleetQueryState["size"]): FleetSizeMetricProto {
  return value === "request_rate"
    ? FleetSizeMetricProto.REQUEST_RATE
    : FleetSizeMetricProto.RESOURCE_COUNT
}

function fromApplicationSummary(message: ApplicationSummaryMessage): FleetApplicationSummary {
  return {
    identity: fromObjectKey(message.identity),
    project: fromObjectKey(message.project),
    targets: message.targets.map(fromStageTarget),
    currentStage: message.currentStage,
    currentCluster: fromObjectKey(message.currentCluster),
    currentClusterLabel: message.currentClusterLabel,
    sourceType: fromSource(message.sourceType),
    sourceRevision: message.sourceRevision,
    health: fromHealth(message.health),
    sync: fromSync(message.sync),
    driftCount: message.driftCount,
    missingResourceCount: message.missingResourceCount,
    releaseState: fromRelease(message.releaseState),
    rolloutState: fromRollout(message.rolloutState),
    resourceCount: message.resourceCount,
    repository: fromObjectKey(message.repository),
    repositoryConnection: fromConnection(message.repositoryConnection),
    effectiveObservabilitySource: fromObjectKey(message.effectiveObservabilitySource),
    observabilityConnection: fromConnection(message.observabilityConnection),
    blockedGateCount: message.blockedGateCount,
    lastTransitionUnixMs: message.lastTransitionUnixMs,
    capabilities: message.capabilities.map(fromCapability),
  }
}

function fromStageTarget(message: StageTargetSummaryMessage): FleetStageTarget {
  return {
    stableId: message.stableId,
    stage: message.stage,
    ring: message.ring,
    cluster: fromObjectKey(message.cluster),
    clusterLabel: message.clusterLabel,
    health: fromHealth(message.health),
    clusterConnection: fromConnection(message.clusterConnection),
    unmanagedInlineCluster: message.unmanagedInlineCluster,
  }
}

function fromFacetBucket(message: FleetFacetBucketMessage): FleetFacetBucket {
  return {
    dimension: fromFacetDimension(message.dimension),
    object: message.key.case === "object" ? fromObjectKey(message.key.value) : undefined,
    value: message.key.case === "value" ? message.key.value : undefined,
    label: message.label,
    count: message.count,
  }
}

function fromHealthBucket(message: FleetHealthBucketMessage): FleetHealthBucket {
  return { health: fromHealth(message.health), count: message.count }
}

function fromMapNode(message: FleetMapNodeMessage): FleetMapNode {
  return {
    stableId: message.stableId,
    kind: fromMapNodeKind(message.kind),
    label: message.label,
    application: fromObjectKey(message.application),
    groupObject:
      message.groupKey.case === "groupObject" ? fromObjectKey(message.groupKey.value) : undefined,
    groupValue: message.groupKey.case === "groupValue" ? message.groupKey.value : undefined,
    applicationCount: message.applicationCount,
    targetCount: message.targetCount,
    health: message.health.map(fromHealthBucket),
    resourceWeight: message.resourceWeight,
    requestRateWeight: message.requestRateWeight,
    effectiveWeight: message.effectiveWeight,
    usedResourceFallback: message.usedResourceFallback,
    children: message.children.map(fromMapNode),
  }
}

function fromMatrixHeader(message: FleetMatrixHeaderMessage): FleetMatrixHeader {
  return {
    stableId: message.stableId,
    label: message.label,
    object: message.key.case === "object" ? fromObjectKey(message.key.value) : undefined,
    value: message.key.case === "value" ? message.key.value : undefined,
  }
}

function fromMatrixCell(message: FleetMatrixCellMessage): FleetMatrixCell {
  return {
    rowId: message.rowId,
    columnId: message.columnId,
    applicationCount: message.applicationCount,
    targetCount: message.targetCount,
    health: message.health.map(fromHealthBucket),
    resourceWeight: message.resourceWeight,
    requestRateWeight: message.requestRateWeight,
    usedResourceFallback: message.usedResourceFallback,
  }
}

function fromHealth(value: FleetHealthProto): FleetHealthStatus {
  switch (value) {
    case FleetHealthProto.HEALTHY:
      return "healthy"
    case FleetHealthProto.PROGRESSING:
      return "progressing"
    case FleetHealthProto.DEGRADED:
      return "degraded"
    case FleetHealthProto.FAILED:
      return "failed"
    case FleetHealthProto.UNKNOWN:
      return "unknown"
    case FleetHealthProto.MISSING:
      return "missing"
    default:
      return "unspecified"
  }
}

function fromSync(value: FleetSyncStateProto): FleetSyncStatus {
  switch (value) {
    case FleetSyncStateProto.SYNCED:
      return "synced"
    case FleetSyncStateProto.OUT_OF_SYNC:
      return "out_of_sync"
    case FleetSyncStateProto.UNKNOWN:
      return "unknown"
    default:
      return "unspecified"
  }
}

function fromSource(value: FleetSourceTypeProto): FleetSourceStatus {
  switch (value) {
    case FleetSourceTypeProto.GIT:
      return "git"
    case FleetSourceTypeProto.HELM:
      return "helm"
    case FleetSourceTypeProto.KUSTOMIZE:
      return "kustomize"
    case FleetSourceTypeProto.S3:
      return "s3"
    case FleetSourceTypeProto.OCI:
      return "oci"
    case FleetSourceTypeProto.INLINE:
      return "inline"
    default:
      return "unspecified"
  }
}

function fromRelease(value: FleetReleaseStateProto): FleetReleaseStatus {
  switch (value) {
    case FleetReleaseStateProto.PENDING:
      return "pending"
    case FleetReleaseStateProto.PROMOTING:
      return "promoting"
    case FleetReleaseStateProto.CANARYING:
      return "canarying"
    case FleetReleaseStateProto.VERIFYING:
      return "verifying"
    case FleetReleaseStateProto.COMPLETE:
      return "complete"
    case FleetReleaseStateProto.FAILED:
      return "failed"
    case FleetReleaseStateProto.ROLLED_BACK:
      return "rolled_back"
    case FleetReleaseStateProto.SUPERSEDED:
      return "superseded"
    case FleetReleaseStateProto.AWAITING_APPROVAL:
      return "awaiting_approval"
    default:
      return "unspecified"
  }
}

function fromRollout(value: FleetRolloutStateProto): FleetRolloutStatus {
  switch (value) {
    case FleetRolloutStateProto.PENDING:
      return "pending"
    case FleetRolloutStateProto.PROGRESSING:
      return "progressing"
    case FleetRolloutStateProto.PAUSED:
      return "paused"
    case FleetRolloutStateProto.HEALTHY:
      return "healthy"
    case FleetRolloutStateProto.DEGRADED:
      return "degraded"
    case FleetRolloutStateProto.FAILED:
      return "failed"
    case FleetRolloutStateProto.ROLLED_BACK:
      return "rolled_back"
    case FleetRolloutStateProto.ABORTED:
      return "aborted"
    default:
      return "unspecified"
  }
}

function fromConnection(value: FleetConnectionStateProto): FleetConnectionStatus {
  switch (value) {
    case FleetConnectionStateProto.HEALTHY:
      return "healthy"
    case FleetConnectionStateProto.UNHEALTHY:
      return "unhealthy"
    case FleetConnectionStateProto.DISABLED:
      return "disabled"
    case FleetConnectionStateProto.NOT_CONFIGURED:
      return "not_configured"
    default:
      return "unspecified"
  }
}

function fromCapability(value: FleetCapabilityProto): FleetCapability {
  switch (value) {
    case FleetCapabilityProto.APPLICATION_SYNC:
      return "application_sync"
    case FleetCapabilityProto.RELEASE_ROLLBACK:
      return "release_rollback"
    case FleetCapabilityProto.GATE_APPROVE:
      return "gate_approve"
    case FleetCapabilityProto.PIPELINE_RETRY:
      return "pipeline_retry"
    default:
      return "unspecified"
  }
}

function fromFacetDimension(value: FleetFacetDimensionProto): FleetFacetDimension {
  switch (value) {
    case FleetFacetDimensionProto.PROJECT:
      return "project"
    case FleetFacetDimensionProto.NAMESPACE:
      return "namespace"
    case FleetFacetDimensionProto.CLUSTER:
      return "cluster"
    case FleetFacetDimensionProto.STAGE:
      return "stage"
    case FleetFacetDimensionProto.HEALTH:
      return "health"
    case FleetFacetDimensionProto.SYNC:
      return "sync"
    case FleetFacetDimensionProto.RELEASE:
      return "release"
    case FleetFacetDimensionProto.ROLLOUT:
      return "rollout"
    case FleetFacetDimensionProto.SOURCE_TYPE:
      return "source_type"
    default:
      return "unspecified"
  }
}

function fromMapNodeKind(value: FleetMapNodeKindProto): FleetMapNode["kind"] {
  switch (value) {
    case FleetMapNodeKindProto.GROUP:
      return "group"
    case FleetMapNodeKindProto.APPLICATION:
      return "application"
    default:
      return "unspecified"
  }
}
