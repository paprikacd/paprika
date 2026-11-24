"use client";

import { useEffect, useMemo, useState } from "react";
import type { InsightsClient } from "./client";
import { DashboardCanvas } from "./canvas";
import { interpolateQuery, resolveDashboardVariables, type VariableValues } from "./drilldown";
import { assertProviderQueryTemplate } from "./provider-query-template";
import { SavedQueryLibraryProvider } from "./saved-query-context";
import { resolveSavedQueryReference } from "./saved-queries";
import type { Dashboard, Provider, QueryRequest, SavedQueryEntry } from "./schema";
import { createQueryScheduler, createResolvedQueryFetcher } from "./query";
import { useInsightsTheme } from "./insights-theme";
import gammaTheme from "./gamma/gamma-theme.module.css";
import styles from "./insights.module.css";

export interface EmbeddedWidgetProps {
  client: InsightsClient;
  dashboardId: string;
  widgetId: string;
  /** Variable values from the link. Names the dashboard does not declare are ignored. */
  variables: VariableValues;
  /** The Insights link to the whole dashboard. */
  href: string;
}

type Loaded = {
  dashboard: Dashboard;
  providers: Provider[];
  queries: SavedQueryEntry[];
};

/**
 * One read-only widget from a saved dashboard, for the console. It takes no drilldowns, selections or edits, so the
 * tile is a reading. Its CSS and charts load only where this module is imported.
 */
export default function EmbeddedWidget({ client, dashboardId, widgetId, variables, href }: EmbeddedWidgetProps) {
  const key = `${dashboardId}\u0000${widgetId}`;
  const [result, setResult] = useState<{ key: string; loaded?: Loaded; error?: string }>();
  // A result for another link is ignored, so a changed link never shows the previous dashboard.
  const current = result?.key === key ? result : undefined;
  const loaded = current?.loaded;
  const error = current?.error;
  const [end] = useState(() => Math.floor(Date.now() / 1000));
  const { resolvedTheme } = useInsightsTheme();
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const { dashboard } = await client.get(dashboardId, controller.signal);
        const widget = dashboard.widgets.find((item) => item.id === widgetId);
        const providers = await client.providers(controller.signal);
        const queries = widget?.queryRef ? await client.listSavedQueries(controller.signal) : [];
        if (!controller.signal.aborted) setResult({ key, loaded: { dashboard, providers, queries } });
      } catch (failure) {
        if (!controller.signal.aborted)
          setResult({ key, error: failure instanceof Error ? failure.message : "Could not load this widget." });
      }
    })();
    return () => controller.abort();
  }, [client, dashboardId, widgetId, key]);

  const values = useMemo<VariableValues | undefined>(() => {
    if (!loaded) return undefined;
    const declared = new Set((loaded.dashboard.variables ?? []).map((variable) => variable.name));
    const overrides = Object.fromEntries(Object.entries(variables).filter(([name]) => declared.has(name)));
    try {
      return resolveDashboardVariables(loaded.dashboard, overrides);
    } catch {
      return resolveDashboardVariables(loaded.dashboard);
    }
  }, [loaded, variables]);

  const fetcher = useMemo(() => {
    if (!loaded || !values) return undefined;
    const scheduler = createQueryScheduler((request: QueryRequest, signal: AbortSignal) =>
      client.query(request, signal, { replayCapacity: false }),
    );
    return createResolvedQueryFetcher(scheduler, (request: QueryRequest) => {
      const { queryRef, ...resolved } = request;
      if (queryRef) {
        const authored = loaded.queries.find((query) => query.id === queryRef.id);
        if (authored) assertProviderQueryTemplate(loaded.providers.find((provider) => provider.id === authored.providerId)?.type, authored.query);
        return { ...resolved, ...resolveSavedQueryReference(queryRef, loaded.queries, values, request.kind) };
      }
      assertProviderQueryTemplate(loaded.providers.find((provider) => provider.id === request.providerId)?.type, request.query);
      return { ...resolved, query: interpolateQuery(request.query, values) };
    });
  }, [client, loaded, values]);

  if (error) return <p role="alert" className="text-note text-muted-foreground">{error}</p>;
  if (!loaded || !values || !fetcher) return <p className="text-note text-muted-foreground">Loading metrics…</p>;
  const widget = loaded.dashboard.widgets.find((item) => item.id === widgetId);
  if (!widget)
    return (
      <p className="text-note text-muted-foreground">
        This widget is no longer on the dashboard. <a href={href} className="underline">Open dashboard</a>
      </p>
    );
  const tile: Dashboard = {
    ...loaded.dashboard,
    widgets: [{
      ...widget,
      drilldowns: undefined,
      selectionBindings: undefined,
      layout: { x: 0, y: 0, w: 12, h: widget.layout.h },
    }],
  };
  return (
    <SavedQueryLibraryProvider queries={loaded.queries} variables={loaded.dashboard.variables ?? []} values={values}>
      <div className={`${styles.root} ${gammaTheme.scope}`} data-insights-theme={resolvedTheme}>
        <DashboardCanvas
          dashboard={tile}
          providers={loaded.providers}
          fetcher={fetcher}
          end={end}
          editing={false}
          onSelect={() => {}}
          onLayout={() => {}}
        />
      </div>
      <a href={href} className="text-note underline">Open dashboard</a>
    </SavedQueryLibraryProvider>
  );
}
