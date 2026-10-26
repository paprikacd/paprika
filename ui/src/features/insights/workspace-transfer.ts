import { parseDocument, stringify } from "yaml";
import {
  dashboardSchema,
  MAX_DOCUMENT_BYTES,
  widgetKind,
  savedQuerySchema,
  type Dashboard,
  type DocumentFormat,
  type Provider,
  type SavedQuery,
  type SavedQueryReference,
  type DataKind,
} from "./schema";

import {
  savedQueryParameterValue,
  validateSavedQueryTemplate,
} from "./saved-queries";

export const MAX_LIBRARY_BYTES = 4 * 1024 * 1024;

export interface DashboardBundle {
  dashboards: Dashboard[];
  /** Omission means legacy references resolved by the destination library. */
  savedQueries?: SavedQuery[];
}
export type SavedQueryConflictAction = "reuse" | "copy";
export type SavedQueryImportStatus = "new" | "identical" | "conflict";
const MAX_SAVED_QUERY_BYTES = 32 * 1024;

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
function canonicalQuery(input: SavedQuery, stripEtag = false): SavedQuery {
  const document = { ...input } as SavedQuery & { etag?: unknown };
  if (stripEtag) delete document.etag;
  if (byteLength(document) > MAX_SAVED_QUERY_BYTES)
    throw new Error("Each saved query must be smaller than 32 KiB.");
  const query = savedQuerySchema.parse(document);
  validateSavedQueryTemplate(query);
  return query;
}
function references(dashboards: readonly Dashboard[]) {
  const result: {
    dashboard: Dashboard;
    reference: SavedQueryReference;
    kind: DataKind;
  }[] = [];
  for (const dashboard of dashboards)
    for (const widget of dashboard.widgets) {
      if (widget.queryRef)
        result.push({
          dashboard,
          reference: widget.queryRef,
          kind: widgetKind(widget),
        });
      const view = widget.options?.tooltipView;
      if (view?.source?.type === "saved")
        result.push({
          dashboard,
          reference: view.source.ref,
          kind: widgetKind(view),
        });
    }
  return result;
}
function validateClosure(bundle: DashboardBundle): void {
  if (!bundle.savedQueries) return;
  const definitions = new Map(
    bundle.savedQueries.map((query) => [query.id, query]),
  );
  const used = new Set<string>();
  for (const { dashboard, reference, kind } of references(bundle.dashboards)) {
    const query = definitions.get(reference.id);
    if (!query)
      throw new Error(
        `Dashboard “${dashboard.title}” references saved query “${reference.id}”, which is missing from the bundle.`,
      );
    if (query.kind !== kind)
      throw new Error(
        `Saved query “${query.name}” does not provide ${kind} for dashboard “${dashboard.title}”.`,
      );
    used.add(query.id);
    for (const binding of reference.bindings ?? []) {
      const parameter = query.parameters?.find(
        (item) => item.name === binding.parameter,
      );
      if (!parameter)
        throw new Error(
          `Saved query “${query.name}” has no parameter “${binding.parameter}”. Update the dashboard binding before exporting or importing.`,
        );
      if (
        binding.source === "variable" &&
        !dashboard.variables?.some(
          (variable) => variable.name === binding.variable,
        )
      )
        throw new Error(
          `Dashboard “${dashboard.title}” does not declare variable “${binding.variable}” required by saved query “${query.name}”.`,
        );
      if (binding.source === "constant")
        savedQueryParameterValue(parameter, binding.value);
      if (
        binding.source === "field" &&
        (binding.field === "series"
          ? parameter.type !== "string"
          : parameter.type !== "number")
      )
        throw new Error(
          `Observation ${binding.field} is incompatible with parameter “${parameter.name}” in saved query “${query.name}”.`,
        );
    }
    for (const parameter of query.parameters ?? []) {
      if (
        parameter.defaultValue === undefined &&
        !reference.bindings?.some(
          (binding) => binding.parameter === parameter.name,
        )
      )
        throw new Error(
          `Bind required parameter “${parameter.name}” for saved query “${query.name}” in dashboard “${dashboard.title}”.`,
        );
    }
  }
  for (const query of bundle.savedQueries)
    if (!used.has(query.id))
      throw new Error(
        `Saved query “${query.id}” is not referenced by a dashboard in this bundle.`,
      );
}
function checkedBundle(input: DashboardBundle): DashboardBundle {
  if (
    !Array.isArray(input.dashboards) ||
    input.dashboards.length < 1 ||
    input.dashboards.length > 100
  )
    throw new Error("Import between 1 and 100 dashboards at a time.");
  const ids = new Set<string>();
  const dashboards = input.dashboards.map((document) => {
    if (byteLength(document) > MAX_DOCUMENT_BYTES)
      throw new Error("Each dashboard must be smaller than 256 KiB.");
    const parsed = dashboardSchema.parse(document);
    if (ids.has(parsed.id))
      throw new Error(`Duplicate dashboard ID: ${parsed.id}`);
    ids.add(parsed.id);
    return parsed;
  });
  const result: DashboardBundle = { dashboards };
  if (input.savedQueries !== undefined) {
    if (!Array.isArray(input.savedQueries) || input.savedQueries.length > 256)
      throw new Error("A dashboard bundle supports at most 256 saved queries.");
    const queryIds = new Set<string>();
    result.savedQueries = input.savedQueries.map((input) => {
      const query = canonicalQuery(input);
      if (queryIds.has(query.id))
        throw new Error(`Duplicate saved query ID: ${query.id}`);
      queryIds.add(query.id);
      return query;
    });
  }
  validateClosure(result);
  if (
    byteLength({
      kind: "PaprikaDashboardLibrary",
      schemaVersion: 1,
      ...result,
    }) > MAX_LIBRARY_BYTES
  )
    throw new Error("Libraries must be smaller than 4 MiB.");
  return result;
}

/** Portable exports carry only the exact referenced definitions, without revision metadata. */
export function buildDashboardBundle(
  dashboards: Dashboard[],
  library: readonly SavedQuery[] = [],
): DashboardBundle {
  const documents = checkedBundle({ dashboards }).dashboards;
  const ids = new Set(references(documents).map((item) => item.reference.id));
  const savedQueries: SavedQuery[] = [];
  for (const id of ids) {
    const matches = library.filter((query) => query.id === id);
    if (!matches.length)
      throw new Error(
        `Saved query “${id}” is unavailable. Restore its definition or switch the dashboard to a custom query before exporting.`,
      );
    if (matches.length > 1)
      throw new Error(`Duplicate saved query ID in the workspace: ${id}`);
    savedQueries.push(canonicalQuery(matches[0], true));
  }
  return checkedBundle({ dashboards: documents, savedQueries });
}

/** Absent definitions retain the old destination-library reference behavior. */
export function parseDashboardBundle(
  source: string,
  format: DocumentFormat,
): DashboardBundle {
  if (new TextEncoder().encode(source).byteLength > MAX_LIBRARY_BYTES)
    throw new Error("Libraries must be smaller than 4 MiB.");
  let value: unknown;
  if (format === "json") value = JSON.parse(source);
  else {
    const document = parseDocument(source, { uniqueKeys: true, merge: false });
    if (document.errors.length) throw new Error(document.errors[0].message);
    value = document.toJS({ maxAliasCount: 0 });
  }
  if (
    value &&
    typeof value === "object" &&
    "kind" in value &&
    value.kind === "PaprikaDashboardLibrary"
  ) {
    const record = value as Record<string, unknown>;
    if (
      record.schemaVersion !== 1 ||
      Object.keys(record).some(
        (key) =>
          !["kind", "schemaVersion", "dashboards", "savedQueries"].includes(
            key,
          ),
      ) ||
      !Array.isArray(record.dashboards)
    )
      throw new Error("Invalid dashboard library document.");
    return checkedBundle({
      dashboards: record.dashboards as Dashboard[],
      ...(Object.hasOwn(record, "savedQueries")
        ? { savedQueries: record.savedQueries as SavedQuery[] }
        : {}),
    });
  }
  return checkedBundle({ dashboards: [value as Dashboard] });
}
export function parseDashboardLibrary(
  source: string,
  format: DocumentFormat,
): Dashboard[] {
  return parseDashboardBundle(source, format).dashboards;
}
export function serializeDashboardBundle(
  bundle: DashboardBundle,
  format: DocumentFormat,
): string {
  const value = {
    kind: "PaprikaDashboardLibrary",
    schemaVersion: 1,
    ...checkedBundle(bundle),
  };
  const source =
    format === "json"
      ? JSON.stringify(value, null, 2)
      : stringify(value, { lineWidth: 0 });
  if (new TextEncoder().encode(source).byteLength > MAX_LIBRARY_BYTES)
    throw new Error("Libraries must be smaller than 4 MiB.");
  return source;
}
export function serializeDashboardLibrary(
  dashboards: Dashboard[],
  format: DocumentFormat,
  library: readonly SavedQuery[] = [],
): string {
  return serializeDashboardBundle(
    buildDashboardBundle(dashboards, library),
    format,
  );
}

/** Definitions compare canonically; changing a parameter/default/provider is a conflict. */
export function savedQueryFingerprint(query: SavedQuery): string {
  return JSON.stringify(canonicalQuery(query, true), (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return value;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, value[key]]),
    );
  });
}
export function queryImportStatus(
  query: SavedQuery,
  destination: readonly SavedQuery[],
): SavedQueryImportStatus {
  const matches = destination.filter((item) => item.id === query.id);
  if (matches.length > 1)
    throw new Error(`Duplicate saved query ID in the destination: ${query.id}`);
  if (!matches.length) {
    savedQueryFingerprint(query);
    return "new";
  }
  return savedQueryFingerprint(query) === savedQueryFingerprint(matches[0])
    ? "identical"
    : "conflict";
}
export function remapBundleQueryReferences(
  bundle: DashboardBundle,
  idMap: Record<string, string>,
): DashboardBundle {
  const source = checkedBundle(bundle);
  const mappedId = (id: string) => (Object.hasOwn(idMap, id) ? idMap[id] : id);
  return checkedBundle({
    dashboards: source.dashboards.map((document) => ({
      ...document,
      widgets: document.widgets.map((widget) => {
        const view = widget.options?.tooltipView;
        return {
          ...widget,
          ...(widget.queryRef
            ? {
                queryRef: {
                  ...widget.queryRef,
                  id: mappedId(widget.queryRef.id),
                },
              }
            : {}),
          ...(view?.source?.type === "saved"
            ? {
                options: {
                  ...widget.options,
                  tooltipView: {
                    ...view,
                    source: {
                      ...view.source,
                      ref: {
                        ...view.source.ref,
                        id: mappedId(view.source.ref.id),
                      },
                    },
                  },
                },
              }
            : {}),
        };
      }),
    })),
    ...(source.savedQueries
      ? {
          savedQueries: source.savedQueries.map((query) => ({
            ...query,
            id: mappedId(query.id),
          })),
        }
      : {}),
  });
}
export function selectBundleDashboards(
  bundle: DashboardBundle,
  ids: readonly string[],
): DashboardBundle {
  const source = checkedBundle(bundle);
  const selected = new Set(ids);
  if (ids.length !== selected.size)
    throw new Error("Choose each dashboard once.");
  for (const id of selected)
    if (!source.dashboards.some((document) => document.id === id))
      throw new Error(`Dashboard “${id}” is not in this bundle.`);
  const dashboards = source.dashboards.filter((document) =>
    selected.has(document.id),
  );
  const queries = new Set(
    references(dashboards).map((item) => item.reference.id),
  );
  return checkedBundle({
    dashboards,
    ...(source.savedQueries
      ? {
          savedQueries: source.savedQueries.filter((query) =>
            queries.has(query.id),
          ),
        }
      : {}),
  });
}
export function requiredBundleProviders(
  bundle: DashboardBundle,
): Map<string, Set<DataKind>> {
  const source = checkedBundle(bundle);
  const result = requiredProviders(source.dashboards);
  for (const query of source.savedQueries ?? []) {
    if (!result.has(query.providerId)) result.set(query.providerId, new Set());
    result.get(query.providerId)!.add(query.kind);
  }
  return result;
}
export function remapBundleProviders(
  bundle: DashboardBundle,
  mapping: Record<string, string>,
  providers: Provider[],
): DashboardBundle {
  const source = checkedBundle(bundle);
  return checkedBundle({
    dashboards: remapDashboardProviders(source.dashboards, mapping, providers),
    ...(source.savedQueries
      ? {
          savedQueries: source.savedQueries.map((query) => {
            const providerId = Object.hasOwn(mapping, query.providerId)
              ? mapping[query.providerId]
              : query.providerId;
            if (
              !providers
                .find((provider) => provider.id === providerId)
                ?.capabilities.includes(query.kind)
            )
              throw new Error(
                `Choose a compatible data source for saved query “${query.name}” (${query.providerId}).`,
              );
            return { ...query, providerId };
          }),
        }
      : {}),
  });
}

export function requiredProviders(documents: Dashboard[]) {
  const result = new Map<string, Set<"metrics" | "traces">>();
  for (const document of documents)
    for (const widget of document.widgets) {
      if (!widget.queryRef) {
        if (!result.has(widget.providerId))
          result.set(widget.providerId, new Set());
        result.get(widget.providerId)!.add(widgetKind(widget));
      }
      const view = widget.options?.tooltipView;
      if (view?.source?.type === "query") {
        if (!result.has(view.source.providerId))
          result.set(view.source.providerId, new Set());
        result.get(view.source.providerId)!.add(widgetKind(view));
      }
    }
  return result;
}

export function remapDashboardProviders(
  documents: Dashboard[],
  mapping: Record<string, string>,
  providers: Provider[],
) {
  return documents.map((document) => ({
    ...document,
    widgets: document.widgets.map((widget) => {
      const providerId =
        !widget.queryRef && Object.hasOwn(mapping, widget.providerId)
          ? mapping[widget.providerId]
          : widget.providerId;
      const provider = providers.find((item) => item.id === providerId);
      if (
        !widget.queryRef &&
        !provider?.capabilities.includes(widgetKind(widget))
      )
        throw new Error(
          `Choose a compatible data source for ${widget.providerId}.`,
        );
      const view = widget.options?.tooltipView;
      if (view?.source?.type !== "query") return { ...widget, providerId };
      const tooltipProviderId = Object.hasOwn(mapping, view.source.providerId)
        ? mapping[view.source.providerId]
        : view.source.providerId;
      if (
        !providers
          .find((item) => item.id === tooltipProviderId)
          ?.capabilities.includes(widgetKind(view))
      )
        throw new Error(
          `Choose a compatible data source for tooltip provider ${view.source.providerId}.`,
        );
      return {
        ...widget,
        providerId,
        options: {
          ...widget.options,
          tooltipView: {
            ...view,
            source: { ...view.source, providerId: tooltipProviderId },
          },
        },
      };
    }),
  }));
}

export function downloadDocument(
  source: string,
  name: string,
  format: DocumentFormat,
) {
  const url = URL.createObjectURL(
    new Blob([source], {
      type: format === "json" ? "application/json" : "application/yaml",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name}.${format}`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
