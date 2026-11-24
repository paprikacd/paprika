"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { InsightsClient } from "./client";
import { DashboardCanvas } from "./canvas";
import { readDashboardLink, serialiseDashboardView, viewedDashboard } from "./dashboard-view";
import { interpolateQuery, resolveDashboardVariables, resolveLinkView, type DashboardNavigation, type VariableValues } from "./drilldown";
import type { EmbedRequest } from "./embed-request";
import { useInsightsTheme } from "./insights-theme";
import { assertProviderQueryTemplate } from "./provider-query-template";
import { createQueryScheduler, createResolvedQueryFetcher } from "./query";
import { SavedQueryLibraryProvider } from "./saved-query-context";
import { resolveSavedQueryReference } from "./saved-queries";
import type { Dashboard, Provider, QueryRequest, SavedQueryEntry } from "./schema";
import { alignedDashboardEnd } from "./time-range";
import gammaTheme from "./gamma/gamma-theme.module.css";
import styles from "./insights.module.css";

type Loaded = { dashboard: Dashboard; providers: Provider[]; queries: SavedQueryEntry[] };

const NO_OP = () => {};
const keepPreview = (preview: ReactNode) => preview;

/** The link's view, or why the link cannot show a widget. Reads the address once, when the frame opens. */
function readView(): { view: DashboardNavigation; rejected: ReturnType<typeof readDashboardLink>["rejected"] } | { error: string } {
  try {
    const link = readDashboardLink();
    return link.navigation ? { view: link.navigation, rejected: link.rejected } : { error: "This widget link names no dashboard." };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "This widget link is not valid." };
  }
}

/**
 * The Insights page in embed mode: one widget of a saved dashboard, read-only, filling the frame. It takes the link's
 * dashboard, variables, time range and refresh, keeps auto refresh, and offers no editing, drilldowns or selections.
 * Its one link opens the whole dashboard in the top window.
 */
export function EmbedView({ client, embed }: { client: InsightsClient; embed: EmbedRequest }) {
  const [link] = useState(readView);
  const view = "view" in link ? link.view : undefined;
  const [result, setResult] = useState<{ loaded?: Loaded; error?: string }>({});
  const { resolvedTheme } = useInsightsTheme();
  const [end, setEnd] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!view || !embed.widgetId) return;
    const controller = new AbortController();
    (async () => {
      try {
        const { dashboard } = await client.get(view.dashboardId, controller.signal);
        const widget = dashboard.widgets.find((item) => item.id === embed.widgetId);
        const providers = await client.providers(controller.signal);
        const queries = widget?.queryRef ? await client.listSavedQueries(controller.signal) : [];
        if (!controller.signal.aborted) setResult({ loaded: { dashboard, providers, queries } });
      } catch (failure) {
        if (!controller.signal.aborted)
          setResult({ error: failure instanceof Error ? failure.message : "Could not load this widget." });
      }
    })();
    return () => controller.abort();
  }, [client, view, embed.widgetId]);

  const loaded = result.loaded;
  // The view as the dashboard can use it: undeclared or malformed link values are dropped, as on the full page.
  const shown = useMemo(() => {
    if (!loaded || !view) return undefined;
    const { state } = resolveLinkView(loaded.dashboard, view, "rejected" in link ? link.rejected : []);
    const dashboard = viewedDashboard(loaded.dashboard, state);
    let values: VariableValues;
    try {
      values = resolveDashboardVariables(dashboard, state.variables);
    } catch {
      values = resolveDashboardVariables(dashboard);
    }
    return { dashboard, state, values };
  }, [loaded, view, link]);

  const fetcher = useMemo(() => {
    if (!loaded || !shown) return undefined;
    const scheduler = createQueryScheduler((request: QueryRequest, signal: AbortSignal) =>
      client.query(request, signal, { replayCapacity: false }),
    );
    return createResolvedQueryFetcher(scheduler, (request: QueryRequest) => {
      const { queryRef, ...resolved } = request;
      if (queryRef) {
        const authored = loaded.queries.find((query) => query.id === queryRef.id);
        if (authored) assertProviderQueryTemplate(loaded.providers.find((provider) => provider.id === authored.providerId)?.type, authored.query);
        return { ...resolved, ...resolveSavedQueryReference(queryRef, loaded.queries, shown.values, request.kind) };
      }
      assertProviderQueryTemplate(loaded.providers.find((provider) => provider.id === request.providerId)?.type, request.query);
      return { ...resolved, query: interpolateQuery(request.query, shown.values) };
    });
  }, [client, loaded, shown]);

  // Auto refresh as on the full page: a fixed window does not move, and a hidden frame waits until it is shown.
  const refresh = shown?.dashboard.customTimeRange ? 0 : shown?.dashboard.refreshInterval ?? 0;
  useEffect(() => {
    if (!refresh) return;
    const advance = () => { if (!document.hidden) setEnd(Math.floor(Date.now() / 1000)); };
    const timer = setInterval(advance, refresh * 1000);
    document.addEventListener("visibilitychange", advance);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", advance);
    };
  }, [refresh]);

  const fullHref = useMemo(() => {
    if (!view) return undefined;
    try {
      return serialiseDashboardView(shown?.state ?? view);
    } catch {
      return undefined;
    }
  }, [view, shown]);
  const widget = loaded?.dashboard.widgets.find((item) => item.id === embed.widgetId);
  const tile = useMemo(() => widget && { ...widget, drilldowns: undefined, selectionBindings: undefined }, [widget]);
  const board = useMemo<Dashboard | undefined>(() => shown && tile && { ...shown.dashboard, widgets: [tile] }, [shown, tile]);

  let notice = "";
  if ("error" in link) notice = link.error;
  else if (!embed.widgetId) notice = "This widget link is not valid.";
  else if (result.error) notice = result.error;
  else if (loaded && !widget) notice = "This widget is no longer on the dashboard.";

  return (
    <div
      className={`${styles.root} ${gammaTheme.scope} flex-col overflow-hidden`}
      data-insights-theme={embed.theme ?? resolvedTheme}
      data-insights-embed=""
      style={{ height: "100dvh", minHeight: 0 }}
    >
      <main className="flex min-h-0 flex-1 flex-col [&_[data-testid=dashboard-canvas]]:h-full">
        {notice ? (
          <p role="alert" className="m-auto max-w-[40ch] px-4 text-center text-note" style={{ color: "var(--gamma-muted)" }}>{notice}</p>
        ) : !board || !tile || !fetcher || !loaded || !shown ? (
          <p role="status" className="m-auto text-note" style={{ color: "var(--gamma-muted)" }}>Loading widget…</p>
        ) : (
          <SavedQueryLibraryProvider queries={loaded.queries} variables={shown.dashboard.variables ?? []} values={shown.values}>
            <DashboardCanvas
              dashboard={board}
              providers={loaded.providers}
              fetcher={fetcher}
              end={alignedDashboardEnd(shown.dashboard, end)}
              editing={false}
              onSelect={NO_OP}
              onLayout={NO_OP}
              variables={shown.values}
              focus={{ widget: tile, render: keepPreview }}
            />
          </SavedQueryLibraryProvider>
        )}
      </main>
      {fullHref ? (
        <footer className="flex shrink-0 justify-end px-1 pt-1">
          <a href={fullHref} target="_top" className="text-note underline underline-offset-2" style={{ color: "var(--gamma-muted)" }}>
            Open dashboard
          </a>
        </footer>
      ) : null}
    </div>
  );
}
