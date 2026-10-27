"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { assertProviderQueryTemplate } from "./provider-query-template";
import { resolveTooltipQuery } from "./tooltip-context";
import {
  tooltipViewSchema,
  type DataKind,
  type Provider,
  type QueryRequest,
  type QueryResult,
  type TooltipView,
} from "./schema";
import type { Point, Series } from "./chart-data";
import type { QueryFetcher } from "./query";
import {
  useSavedQueryLibrary,
  type SavedQueryLibrary,
} from "./saved-query-context";
import { resolveSavedQueryReference } from "./saved-queries";

export type TooltipQuerySource = Extract<
  NonNullable<TooltipView["source"]>,
  { type: "query" }
>;
export interface TooltipQueryEnvironment {
  fetcher: QueryFetcher;
  providers: Provider[];
  start: number;
  end: number;
  step: number;
}
const Environment = createContext<TooltipQueryEnvironment | null>(null);

/** The host supplies its existing session scheduler; renderers never create a client. */
export function TooltipQueryProvider({
  children,
  fetcher,
  providers,
  start,
  end,
  step,
}: TooltipQueryEnvironment & { children: ReactNode }) {
  const value = useMemo(
    () => ({ fetcher, providers, start, end, step }),
    [fetcher, providers, start, end, step],
  );
  return <Environment.Provider value={value}>{children}</Environment.Provider>;
}

export function buildTooltipRequest(
  source:
    | TooltipQuerySource
    | Extract<NonNullable<TooltipView["source"]>, { type: "saved" }>,
  series: Series,
  kind: DataKind,
  environment: Omit<TooltipQueryEnvironment, "fetcher">,
  point?: Point,
  library?: Pick<SavedQueryLibrary, "queries" | "values">,
): QueryRequest {
  const checked = tooltipViewSchema.parse({
    type: kind === "traces" ? "traces" : "timeseries",
    source,
  }).source as typeof source;
  const template = checked.type === "saved" ? library?.queries.find(query => query.id === checked.ref.id) : checked;
  if (template) assertProviderQueryTemplate(environment.providers.find(provider => provider.id === template.providerId)?.type, template.query);
  const resolved =
    checked.type === "saved"
      ? resolveSavedQueryReference(
          checked.ref,
          library?.queries ?? [],
          library?.values ?? {},
          kind,
          { series, point },
        )
      : {
          providerId: checked.providerId,
          query: resolveTooltipQuery(checked, series, point),
          kind,
        };
  const provider = environment.providers.find(
    (entry) => entry.id === resolved.providerId,
  );
  if (!provider)
    throw new Error(
      `Tooltip provider “${resolved.providerId}” is not configured. Choose a data source in the widget editor.`,
    );
  if (!provider.capabilities.includes(kind))
    throw new Error(
      `The tooltip data source does not support ${kind}. Choose a compatible data source in the widget editor.`,
    );
  if (
    ![environment.start, environment.end, environment.step].every(
      Number.isFinite,
    ) ||
    environment.end <= environment.start ||
    environment.end - environment.start > 31 * 86400 ||
    environment.step <= 0
  )
    throw new Error(
      "The dashboard time range is unavailable for this tooltip query.",
    );
  return {
    providerId: resolved.providerId,
    query: resolved.query,
    kind,
    start: environment.start,
    end: environment.end,
    step: environment.step,
  };
}

interface QueryState {
  key: string;
  fetcher: QueryFetcher;
  data?: QueryResult;
  error: string | null;
  loading: boolean;
}

/** Mounted only inside an open tooltip. Old query data is masked during render. */
export function useTooltipQuery(
  source: TooltipView["source"],
  series: Series,
  kind: DataKind,
  enabled = true,
  point?: Point,
) {
  const environment = useContext(Environment);
  const library = useSavedQueryLibrary();
  const prepared = useMemo(() => {
    if (
      !enabled ||
      !source ||
      source.type === "series" ||
      source.type === "widget"
    )
      return { key: "", error: null };
    if (source.type === "saved" && library.loading)
      return { key: "", error: null };
    if (source.type === "saved" && library.error)
      return { key: "", error: library.error };
    if (!environment)
      return {
        key: "",
        error:
          "Tooltip querying is unavailable in this view. Open the dashboard to run this query.",
      };
    try {
      return {
        key: JSON.stringify(
          buildTooltipRequest(
            source,
            series,
            kind,
            environment,
            point,
            library,
          ),
        ),
        error: null,
      };
    } catch (error) {
      return {
        key: "",
        error:
          error instanceof Error
            ? error.message
            : "The tooltip query configuration is invalid.",
      };
    }
  }, [source, series, kind, environment, enabled, point, library]);
  const request = useMemo(
    () =>
      prepared.key ? (JSON.parse(prepared.key) as QueryRequest) : undefined,
    [prepared.key],
  );
  const fetcher = environment?.fetcher;
  const [state, setState] = useState<QueryState>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!request || !fetcher || !enabled) return;
    const controller = new AbortController();
    let disposed = false;
    const key = JSON.stringify(request);
    queueMicrotask(() => {
      if (disposed) return;
      setState({ key, fetcher, loading: true, error: null });
      void Promise.resolve()
        .then(() => {
          if (disposed || controller.signal.aborted)
            throw new DOMException("Aborted", "AbortError");
          return fetcher(request, controller.signal);
        })
        .then(
          (data) => {
            if (!disposed && !controller.signal.aborted)
              setState({ key, fetcher, data, loading: false, error: null });
          },
          (error) => {
            if (!disposed && !controller.signal.aborted)
              setState({
                key,
                fetcher,
                loading: false,
                error:
                  error instanceof Error
                    ? error.message
                    : "The tooltip query could not be completed.",
              });
          },
        );
    });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [request, fetcher, enabled, attempt]);
  const refresh = useCallback(() => setAttempt((value) => value + 1), []);
  const current =
    request && state?.key === prepared.key && state.fetcher === fetcher
      ? state
      : undefined;
  return {
    data: prepared.error ? undefined : current?.data,
    loading:
      (enabled && source?.type === "saved" && !!library.loading) ||
      (!prepared.error && !!request && (current?.loading ?? true)),
    error: prepared.error ?? current?.error ?? null,
    refresh,
    canRetry: !prepared.error && !!request && !!current?.error,
  };
}
