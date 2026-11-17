import { interpolateQueryLiterals } from "./drilldown";
import { seriesName, type Point, type Series } from "./chart-data";
import { validTimestamp } from "./widget-context";
import {
  savedQuerySchema,
  savedQueryReferenceSchema,
  type Dashboard,
  type DataKind,
  type SavedQuery,
  type SavedQueryEntry,
  type SavedQueryParameter,
  type SavedQueryReference,
} from "./schema";

/** A library revision is transport metadata, not part of the strict persisted document. */
function queryDocument(query: SavedQuery): SavedQuery {
  const document = { ...query } as SavedQueryEntry;
  delete document.etag;
  return savedQuerySchema.parse(document);
}

/** Dashboard variables are text; numeric parameters accept only complete finite numeric literals. */
export function savedQueryParameterValue(
  parameter: SavedQueryParameter,
  value: string | number,
): string | number {
  if (parameter.type === "string") {
    if (typeof value !== "string" || value.length > 1024)
      throw new Error(
        `Parameter “${parameter.name}” needs text of at most 1,024 characters.`,
      );
    return value;
  }
  if (typeof value !== "string" && typeof value !== "number")
    throw new Error(`Parameter “${parameter.name}” needs a finite number.`);
  if (
    typeof value === "string" &&
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)
  )
    throw new Error(`Parameter “${parameter.name}” needs a finite number.`);
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number))
    throw new Error(`Parameter “${parameter.name}” needs a finite number.`);
  return number;
}

export function validateSavedQueryTemplate(query: SavedQuery): void {
  const checked = queryDocument(query);
  interpolateQueryLiterals(
    checked.query,
    Object.fromEntries(
      (checked.parameters ?? []).map((parameter) => [
        parameter.name,
        parameter.type === "number" ? 1 : "",
      ]),
    ),
  );
}

/** Resolve typed parameters in one pass; substituted {{text}} remains literal data. */
export function resolveSavedQueryTemplate(
  query: SavedQuery,
  supplied: Record<string, string | number>,
): string {
  const checked = queryDocument(query);
  const parameters = checked.parameters ?? [];
  for (const key of Object.keys(supplied))
    if (!parameters.some((parameter) => parameter.name === key))
      throw new Error(
        `Saved query “${checked.name}” has no parameter “${key}”.`,
      );
  const values: Record<string, string | number> = Object.create(null);
  for (const parameter of parameters) {
    const value = Object.hasOwn(supplied, parameter.name)
      ? supplied[parameter.name]
      : parameter.defaultValue;
    if (value === undefined)
      throw new Error(
        `Set a value for saved query parameter “${parameter.name}”.`,
      );
    values[parameter.name] = savedQueryParameterValue(parameter, value);
  }
  return interpolateQueryLiterals(checked.query, values);
}

export interface SavedQueryObservation {
  series: Series;
  point?: Point;
  seriesIndex?: number;
}
export function resolveSavedQueryReference(
  reference: SavedQueryReference,
  queries: readonly SavedQuery[],
  variableValues: Record<string, string>,
  expectedKind: DataKind,
  observation?: SavedQueryObservation,
): { providerId: string; query: string; kind: DataKind } {
  const ref = savedQueryReferenceSchema.parse(reference);
  const saved = queries.find((query) => query.id === ref.id);
  if (!saved)
    throw new Error(
      `Saved query “${ref.id}” is unavailable. Choose a saved query or switch to a custom query.`,
    );
  if (saved.kind !== expectedKind)
    throw new Error(
      `Saved query “${saved.name}” does not provide ${expectedKind}. Choose a compatible query.`,
    );
  const values: Record<string, string | number> = Object.create(null);
  for (const binding of ref.bindings ?? []) {
    if (binding.source === "constant")
      values[binding.parameter] = binding.value;
    else if (binding.source === "variable") {
      if (!Object.hasOwn(variableValues, binding.variable))
        throw new Error(
          `Set dashboard variable “${binding.variable}” for parameter “${binding.parameter}”.`,
        );
      values[binding.parameter] = variableValues[binding.variable];
    } else if (binding.source === "label") {
      if (
        !observation ||
        !Object.hasOwn(observation.series.labels, binding.label)
      )
        throw new Error(
          `This observation has no label “${binding.label}” for parameter “${binding.parameter}”.`,
        );
      values[binding.parameter] = observation.series.labels[binding.label];
    } else {
      if (!observation)
        throw new Error(
          `Parameter “${binding.parameter}” requires a hovered observation.`,
        );
      if (binding.field === "series")
        values[binding.parameter] = seriesName(
          observation.series,
          observation.seriesIndex ?? 0,
        );
      else if (binding.field === "value") {
        const value = observation.point?.value;
        if (typeof value !== "number" || !Number.isFinite(value))
          throw new Error(
            `This observation has no finite value for parameter “${binding.parameter}”.`,
          );
        values[binding.parameter] = value;
      } else {
        if (!observation.point || !validTimestamp(observation.point.timestamp))
          throw new Error(
            `This observation has no valid timestamp for parameter “${binding.parameter}”.`,
          );
        values[binding.parameter] = observation.point.timestamp / 1000;
      }
    }
  }
  return {
    providerId: saved.providerId,
    kind: saved.kind,
    query: resolveSavedQueryTemplate(saved, values),
  };
}

export function dashboardUsesSavedQuery(
  dashboard: Dashboard,
  id: string,
): boolean {
  return dashboard.widgets.some(
    (widget) =>
      widget.queryRef?.id === id ||
      widget.annotationSource?.queryRef.id === id ||
      (widget.options?.tooltipView?.source?.type === "saved" &&
        widget.options.tooltipView.source.ref.id === id),
  );
}
