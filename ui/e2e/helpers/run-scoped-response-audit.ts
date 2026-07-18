type UnknownRecord = Record<string, unknown>

export interface RunScopedResponseAudit {
  scoped: boolean
  violations: string[]
}

const queryProcedures = new Set([
  "/paprika.v1.PaprikaService/QueryApplications",
  "/paprika.v1.PaprikaService/QueryFleetMap",
  "/paprika.v1.PaprikaService/QueryFleetMatrix",
  "/paprika.v1.PaprikaService/QueryReleases",
])

const directNamespaceProcedures = new Set([
  "/paprika.v1.PaprikaService/GetApplication",
  "/paprika.v1.PaprikaService/ListPipelines",
  "/paprika.v1.PaprikaService/ListReleases",
  "/paprika.v1.PaprikaService/ListRollouts",
])

export function auditRunScopedResponse(
  path: string,
  request: UnknownRecord,
  response: UnknownRecord,
  expectedNamespace: string,
): RunScopedResponseAudit {
  const requestAudit = auditRequestScope(path, request, expectedNamespace)
  if (!requestAudit.scoped || requestAudit.violations.length > 0) return requestAudit

  const violations: string[] = []
  if (path.endsWith("/QueryApplications")) {
    forEachCollection(response.applications, (application, index) => {
      auditObjectKey(
        record(application)?.identity,
        `applications[${index}].identity`,
        expectedNamespace,
        violations,
        true,
      )
      for (const field of [
        "project",
        "currentCluster",
        "repository",
        "effectiveObservabilitySource",
      ]) {
        auditObjectKey(
          record(application)?.[field],
          `applications[${index}].${field}`,
          expectedNamespace,
          violations,
          false,
        )
      }
      forEachCollection(record(application)?.targets, (target, targetIndex) => {
        auditObjectKey(
          record(target)?.cluster,
          `applications[${index}].targets[${targetIndex}].cluster`,
          expectedNamespace,
          violations,
          false,
        )
      })
    })
    auditFacets(response.facets, expectedNamespace, violations)
  } else if (path.endsWith("/QueryFleetMap")) {
    forEachCollection(response.roots, (root, index) => {
      auditFleetMapNode(root, `roots[${index}]`, expectedNamespace, violations)
    })
    auditFacets(response.facets, expectedNamespace, violations)
  } else if (path.endsWith("/QueryFleetMatrix")) {
    auditMatrixHeaders(response.rows, "rows", expectedNamespace, violations)
    auditMatrixHeaders(response.columns, "columns", expectedNamespace, violations)
    auditFacets(response.facets, expectedNamespace, violations)
  } else if (path.endsWith("/GetApplication")) {
    auditObjectKey(
      response.application,
      "application",
      expectedNamespace,
      violations,
      true,
      typeof request.name === "string" ? request.name : undefined,
    )
  } else if (path.endsWith("/QueryReleases") || path.endsWith("/ListReleases")) {
    auditDirectCollection(response.releases, "releases", expectedNamespace, violations)
  } else if (path.endsWith("/ListRollouts")) {
    auditDirectCollection(response.rollouts, "rollouts", expectedNamespace, violations)
  } else if (path.endsWith("/ListPipelines")) {
    auditDirectCollection(response.pipelines, "pipelines", expectedNamespace, violations)
  }
  return { scoped: true, violations }
}

function auditRequestScope(
  path: string,
  request: UnknownRecord,
  expectedNamespace: string,
): RunScopedResponseAudit {
  if (queryProcedures.has(path)) {
    const filter = record(request.filter)
    const namespaces = filter?.namespaces
    if (
      !Array.isArray(namespaces) ||
      namespaces.length !== 1 ||
      namespaces[0] !== expectedNamespace
    ) {
      return {
        scoped: false,
        violations: [
          `request.filter.namespaces=${JSON.stringify(namespaces)}, ` +
            `expected exactly ${JSON.stringify([expectedNamespace])}`,
        ],
      }
    }

    const violations: string[] = []
    auditFilterObjectKeys(
      filter?.projects,
      "request.filter.projects",
      expectedNamespace,
      violations,
    )
    auditFilterObjectKeys(
      filter?.clusters,
      "request.filter.clusters",
      expectedNamespace,
      violations,
    )
    auditFilterStages(filter?.stages, violations)
    return {
      scoped: true,
      violations,
    }
  }
  if (!directNamespaceProcedures.has(path)) return { scoped: false, violations: [] }
  if (request.namespace !== expectedNamespace) {
    return {
      scoped: false,
      violations: [
        `request.namespace=${String(request.namespace)}, expected ${expectedNamespace}`,
      ],
    }
  }
  if (
    path.endsWith("/GetApplication") &&
    (typeof request.name !== "string" || request.name.length === 0)
  ) {
    return { scoped: false, violations: ["request.name is required"] }
  }
  return { scoped: true, violations: [] }
}

function auditFilterObjectKeys(
  value: unknown,
  field: string,
  expectedNamespace: string,
  violations: string[],
) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    violations.push(`${field}: expected array`)
    return
  }
  value.forEach((entry, index) => {
    auditObjectKey(
      entry,
      `${field}[${index}]`,
      expectedNamespace,
      violations,
      true,
    )
  })
}

function auditFilterStages(value: unknown, violations: string[]) {
  if (value === undefined) return
  if (!Array.isArray(value)) {
    violations.push("request.filter.stages: expected array")
    return
  }
  value.forEach((stage, index) => {
    if (typeof stage !== "string" || stage.length === 0) {
      violations.push(
        `request.filter.stages[${index}]: expected non-empty string`,
      )
    }
  })
}

function auditFleetMapNode(
  value: unknown,
  path: string,
  expectedNamespace: string,
  violations: string[],
) {
  const node = record(value)
  const applicationNode =
    node?.kind === "FLEET_MAP_NODE_KIND_APPLICATION" ||
    (typeof node?.stableId === "string" && node.stableId.startsWith("a:"))
  auditObjectKey(
    node?.application,
    `${path}.application`,
    expectedNamespace,
    violations,
    applicationNode,
  )
  auditObjectKey(
    node?.groupObject,
    `${path}.groupObject`,
    expectedNamespace,
    violations,
    false,
  )
  const metadata = record(node?.applicationMetadata)
  auditObjectKey(
    metadata?.project,
    `${path}.applicationMetadata.project`,
    expectedNamespace,
    violations,
    false,
  )
  auditObjectKey(
    metadata?.currentCluster,
    `${path}.applicationMetadata.currentCluster`,
    expectedNamespace,
    violations,
    false,
  )
  forEachCollection(node?.children, (child, index) => {
    auditFleetMapNode(
      child,
      `${path}.children[${index}]`,
      expectedNamespace,
      violations,
    )
  })
}

function auditMatrixHeaders(
  value: unknown,
  field: string,
  expectedNamespace: string,
  violations: string[],
) {
  forEachCollection(value, (header, index) => {
    auditObjectKey(
      record(header)?.object,
      `${field}[${index}].object`,
      expectedNamespace,
      violations,
      false,
    )
  })
}

function auditFacets(
  value: unknown,
  expectedNamespace: string,
  violations: string[],
) {
  forEachCollection(value, (facet, index) => {
    auditObjectKey(
      record(facet)?.object,
      `facets[${index}].object`,
      expectedNamespace,
      violations,
      false,
    )
  })
}

function auditDirectCollection(
  value: unknown,
  field: string,
  expectedNamespace: string,
  violations: string[],
) {
  forEachCollection(value, (entry, index) => {
    auditObjectKey(
      entry,
      `${field}[${index}]`,
      expectedNamespace,
      violations,
      true,
    )
  })
}

function auditObjectKey(
  value: unknown,
  path: string,
  expectedNamespace: string,
  violations: string[],
  required: boolean,
  expectedName?: string,
) {
  if (value === undefined && !required) return
  const object = record(value)
  if (typeof object?.namespace !== "string" || object.namespace.length === 0) {
    violations.push(`${path}: missing namespace`)
  } else if (object.namespace !== expectedNamespace) {
    violations.push(`${path}: namespace=${object.namespace}`)
  }
  if (typeof object?.name !== "string" || object.name.length === 0) {
    violations.push(`${path}: missing name`)
  } else if (expectedName !== undefined && object.name !== expectedName) {
    violations.push(`${path}: name=${object.name}, expected ${expectedName}`)
  }
}

function forEachCollection(
  value: unknown,
  callback: (entry: unknown, index: number) => void,
) {
  if (!Array.isArray(value)) return
  value.forEach(callback)
}

function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}
