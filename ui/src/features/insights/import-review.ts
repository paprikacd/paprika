import { documentFingerprint } from "./fingerprint";
import { diffJSON, type FieldChange, type JSONDiff, type JSONValue } from "./dashboard-diff";
import {
  MAX_DOCUMENT_BYTES,
  widgetKind,
  type Dashboard,
  type DataKind,
  type Provider,
  type SavedQuery,
  type SavedQueryReference,
} from "./schema";
import { dashboardAsSent } from "./layout-compaction";
import { savedQueryParameterValue } from "./saved-queries";
import {
  buildDashboardBundle,
  remapDashboardProviders,
  requiredProviders,
  savedQueryFingerprint,
  type DashboardBundle,
  type ProviderRequirement,
} from "./workspace-transfer";

export type ImportAction = "keep" | "replace" | "copy";
export interface ImportBaseline {
  fingerprint: string;
  etag?: string;
}
export interface ImportSnapshot<T> {
  document: T;
  etag?: string;
}
export type ImportJSONValue = JSONValue;
export type ImportFieldChange = FieldChange;
export type ImportDiff = JSONDiff;
export interface ImportReview {
  status: "new" | "identical" | "conflict";
  baseline?: ImportBaseline;
  diff: ImportDiff;
  canReplace: boolean;
  replaceBlockedReason?: string;
}
export { diffJSON as diffImportDocuments, MAX_DIFF_CHANGES as MAX_IMPORT_DIFF_CHANGES } from "./dashboard-diff";

function canonicalDashboard(input: Dashboard): Dashboard {
  // A save writes the layout as the canvas draws it, so a stored dashboard holds those positions. Canonicalize
  // incoming documents the same way, or a gapped bundle that is drawn identically would compare as a conflict.
  // JSON removes optional undefined fields but never normalizes actual values.
  const document = dashboardAsSent(input);
  const source = documentFingerprint(document);
  if (new TextEncoder().encode(source).byteLength > MAX_DOCUMENT_BYTES)
    throw new Error("Each dashboard must be smaller than 256 KiB.");
  return JSON.parse(source) as Dashboard;
}
function canonicalQuery(input: SavedQuery): SavedQuery {
  return JSON.parse(savedQueryFingerprint(input)) as SavedQuery;
}
function review(
  incoming: Dashboard | SavedQuery,
  existing?: ImportSnapshot<Dashboard | SavedQuery>,
  blockedReason?: string,
): ImportReview {
  if (existing && incoming.id !== existing.document.id)
    throw new Error(
      "Compare documents with the same ID before choosing an import action.",
    );
  const fingerprint = documentFingerprint(incoming as Dashboard);
  const baseline = existing
    ? {
        fingerprint: documentFingerprint(existing.document as Dashboard),
        ...(existing.etag ? { etag: existing.etag } : {}),
      }
    : undefined;
  const replaceBlockedReason = !existing
    ? "This document is new. Import it or create a copy."
    : (blockedReason ??
      (!existing.etag
        ? "Reload this document to obtain its revision before replacing it."
        : undefined));
  return {
    status: !baseline
      ? "new"
      : baseline.fingerprint === fingerprint
        ? "identical"
        : "conflict",
    ...(baseline ? { baseline } : {}),
    diff: diffJSON(
      (existing?.document ?? {}) as ImportJSONValue,
      incoming as ImportJSONValue,
    ),
    canReplace: !replaceBlockedReason,
    ...(replaceBlockedReason ? { replaceBlockedReason } : {}),
  };
}

/** Call with the provider-mapped incoming document and the authoritative review snapshot. */
export function reviewDashboard(
  incoming: Dashboard,
  existing?: ImportSnapshot<Dashboard>,
): ImportReview {
  return review(
    canonicalDashboard(incoming),
    existing
      ? { ...existing, document: canonicalDashboard(existing.document) }
      : undefined,
  );
}
export function reviewSavedQuery(
  incoming: SavedQuery,
  existing?: ImportSnapshot<SavedQuery>,
): ImportReview {
  const next = canonicalQuery(incoming);
  const previous = existing
    ? { ...existing, document: canonicalQuery(existing.document) }
    : undefined;
  const reason =
    previous &&
    (previous.document.providerId !== next.providerId ||
      previous.document.kind !== next.kind)
      ? "A saved query’s data source and kind cannot be replaced. Keep the existing query or create a copy."
      : undefined;
  return review(next, previous, reason);
}

export interface ImportCompatibilityIssue {
  dashboardId: string;
  dashboardTitle: string;
  widgetId: string;
  location: "widget" | "tooltip" | "annotations";
  reason: string;
}
export interface ImportCompatibility {
  compatible: boolean;
  reason?: string;
  issues: ImportCompatibilityIssue[];
  affectedDashboardIds: string[];
}
interface ReferenceUse {
  dashboard: Dashboard;
  widgetId: string;
  location: "widget" | "tooltip" | "annotations";
  reference: SavedQueryReference;
  kind: DataKind;
}
function queryUses(
  dashboards: readonly Dashboard[],
  id: string,
): ReferenceUse[] {
  const uses: ReferenceUse[] = [];
  // Persisted documents are validated when loaded; a host may also include an
  // unsaved draft. Unrelated draft fields must not block a safe query edit.
  for (const dashboard of dashboards) {
    for (const widget of dashboard.widgets) {
      if (widget.queryRef?.id === id)
        uses.push({
          dashboard,
          widgetId: widget.id,
          location: "widget",
          reference: widget.queryRef,
          kind: widgetKind(widget),
        });
      if (widget.annotationSource?.queryRef.id === id)
        uses.push({ dashboard, widgetId: widget.id, location: "annotations", reference: widget.annotationSource.queryRef, kind: "records" });
      const view = widget.options?.tooltipView;
      if (view?.source?.type === "saved" && view.source.ref.id === id)
        uses.push({
          dashboard,
          widgetId: widget.id,
          location: "tooltip",
          reference: view.source.ref,
          kind: widgetKind(view),
        });
    }
  }
  return uses;
}
function referenceIssues(
  query: SavedQuery,
  use: ReferenceUse,
): Map<string, string> {
  const issues = new Map<string, string>();
  if (query.kind !== use.kind)
    issues.set("kind", `The saved query does not provide ${use.kind}.`);
  for (const binding of use.reference.bindings ?? []) {
    const parameter = query.parameters?.find(
      (item) => item.name === binding.parameter,
    );
    if (!parameter) {
      issues.set(
        `missing:${binding.parameter}`,
        `Parameter “${binding.parameter}” is not declared by this query.`,
      );
      continue;
    }
    if (
      binding.source === "variable" &&
      !use.dashboard.variables?.some(
        (variable) => variable.name === binding.variable,
      )
    )
      issues.set(
        `variable:${binding.parameter}`,
        `Dashboard variable “${binding.variable}” is not declared.`,
      );
    if (binding.source === "constant") {
      try {
        savedQueryParameterValue(parameter, binding.value);
      } catch (error) {
        issues.set(
          `constant:${binding.parameter}`,
          error instanceof Error
            ? error.message
            : `Parameter “${binding.parameter}” has an incompatible constant.`,
        );
      }
    }
    if (
      binding.source === "field" &&
      (binding.field === "series"
        ? parameter.type !== "string"
        : parameter.type !== "number")
    )
      issues.set(
        `field:${binding.parameter}`,
        `Observation ${binding.field} is incompatible with ${parameter.type} parameter “${binding.parameter}”.`,
      );
  }
  for (const parameter of query.parameters ?? [])
    if (
      parameter.defaultValue === undefined &&
      !use.reference.bindings?.some(
        (binding) => binding.parameter === parameter.name,
      )
    )
      issues.set(
        `required:${parameter.name}`,
        `Required parameter “${parameter.name}” has no binding or default.`,
      );
  return issues;
}

/** With previous, reject only newly introduced broken references, plus changed text-binding types. */
export function savedQueryCompatibility(
  query: SavedQuery,
  dashboards: readonly Dashboard[],
  previous?: SavedQuery,
): ImportCompatibility {
  const next = canonicalQuery(query),
    old = previous ? canonicalQuery(previous) : undefined;
  if (old && old.id !== next.id)
    throw new Error("Compare saved queries with the same ID.");
  const uses = queryUses(dashboards, next.id);
  const issues: ImportCompatibilityIssue[] = [];
  for (const use of uses) {
    const currentIssues = referenceIssues(next, use);
    const oldIssues = old
      ? referenceIssues(old, use)
      : new Map<string, string>();
    if (old)
      for (const binding of use.reference.bindings ?? []) {
        if (binding.source !== "variable" && binding.source !== "label")
          continue;
        const before = old.parameters?.find(
          (item) => item.name === binding.parameter,
        );
        const after = next.parameters?.find(
          (item) => item.name === binding.parameter,
        );
        if (before && after && before.type !== after.type)
          currentIssues.set(
            `binding-type:${binding.parameter}`,
            `Parameter “${binding.parameter}” changes from ${before.type} to ${after.type}, which changes its ${binding.source === "label" ? "observation-label" : "dashboard-variable"} binding contract.`,
          );
      }
    for (const [code, reason] of currentIssues)
      if (!oldIssues.has(code))
        issues.push({
          dashboardId: use.dashboard.id,
          dashboardTitle: use.dashboard.title,
          widgetId: use.widgetId,
          location: use.location,
          reason,
        });
  }
  return {
    compatible: !issues.length,
    ...(issues.length
      ? {
          reason: `${issues[0].dashboardTitle} / ${issues[0].widgetId} (${issues[0].location}): ${issues[0].reason}`,
        }
      : {}),
    issues,
    affectedDashboardIds: [...new Set(uses.map((use) => use.dashboard.id))],
  };
}
export function canKeepSavedQuery(
  bundle: DashboardBundle,
  id: string,
  existing: SavedQuery,
): ImportCompatibility {
  if (existing.id !== id)
    throw new Error("Choose the existing saved query with the same ID.");
  return savedQueryCompatibility(existing, bundle.dashboards);
}

/** Call after removing dashboards whose action is Keep. Kept query sources are not remapped. */
export function requiredImportProviders(
  bundle: DashboardBundle,
  keptIds: ReadonlySet<string>,
): Map<string, Set<ProviderRequirement>> {
  const requirements = requiredProviders(bundle.dashboards);
  for (const query of bundle.savedQueries ?? []) {
    if (keptIds.has(query.id)) continue;
    if (!requirements.has(query.providerId))
      requirements.set(query.providerId, new Set());
    requirements.get(query.providerId)!.add(query.kind);
  }
  return requirements;
}
export function remapImportBundle(
  bundle: DashboardBundle,
  mapping: Record<string, string>,
  providers: Provider[],
  keptQueries: ReadonlyMap<string, SavedQuery>,
): DashboardBundle {
  const dashboards = remapDashboardProviders(
    bundle.dashboards,
    mapping,
    providers,
  );
  if (!bundle.savedQueries) return { dashboards };
  const definitions = bundle.savedQueries.map((incoming) => {
    const kept = keptQueries.get(incoming.id);
    if (kept && kept.id !== incoming.id)
      throw new Error("Choose the existing saved query with the same ID.");
    const document = canonicalQuery(
      kept ?? {
        ...incoming,
        providerId: Object.hasOwn(mapping, incoming.providerId)
          ? mapping[incoming.providerId]
          : incoming.providerId,
      },
    );
    if (
      !providers.some(
        (provider) =>
          provider.id === document.providerId &&
          provider.capabilities.includes(document.kind),
      )
    )
      throw new Error(
        `Choose a compatible data source for saved query “${document.name}” (${document.providerId}).`,
      );
    return document;
  });
  return buildDashboardBundle(dashboards, definitions);
}
