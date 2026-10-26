import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp, RefreshCw } from "lucide-react";
import type { Dashboard, DocumentFormat, Provider, SavedQuery } from "./schema";
import type {
  BundleImportRequest,
  BundleImportResult,
  BundleImportReview,
} from "./bundle-import";
import {
  MAX_LIBRARY_BYTES,
  parseDashboardBundle,
  remapDashboardProviders,
  requiredBundleProviders,
  selectBundleDashboards,
  type DashboardBundle,
} from "./workspace-transfer";
import {
  canKeepSavedQuery,
  remapImportBundle,
  requiredImportProviders,
  reviewDashboard,
  reviewSavedQuery,
  savedQueryCompatibility,
  type ImportAction,
  type ImportDiff,
  type ImportJSONValue,
} from "./import-review";
import { useSavedQueryLibrary } from "./saved-query-context";
import { GammaButton } from "./gamma/button";
import { GammaDisclosure } from "./gamma/disclosure";
import { GammaInput, GammaTextarea } from "./gamma/input";
import { GammaSelect } from "./gamma/select";
import { ProviderIcon } from "./source-identity";
import styles from "./portable-import-panel.module.css";

export interface PortableImportProps {
  providers: Provider[];
  onImportBundle?: (
    request: BundleImportRequest,
  ) => Promise<BundleImportResult>;
  onReviewBundle?: (bundle: DashboardBundle) => Promise<BundleImportReview>;
  onRefreshQueries?: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  initialDocument?: { source: string; format: DocumentFormat };
}
function initialMapping(bundle: DashboardBundle, providers: Provider[]) {
  const mapping: Record<string, string> = Object.create(null);
  for (const [id, kinds] of requiredBundleProviders(bundle))
    if (
      providers.some(
        (provider) =>
          provider.id === id &&
          [...kinds].every((kind) => provider.capabilities.includes(kind)),
      )
    )
      mapping[id] = id;
  return mapping;
}
function DiffValue({
  value,
  label,
}: {
  value: ImportJSONValue | undefined;
  label: string;
}) {
  const type =
    value === undefined
      ? "not present"
      : value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value;
  return (
    <div className={styles.diffValue}>
      <span>
        {label} <small>{type}</small>
      </span>
      <pre tabIndex={0} aria-label={`${label} value`}>
        {value === undefined ? "Not present" : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
function Comparison({ name, diff }: { name: string; diff: ImportDiff }) {
  return (
    <GammaDisclosure
      title={`Compare changes for ${name}`}
      meta={`${diff.totalChanges} change${diff.totalChanges === 1 ? "" : "s"}`}
    >
      {!diff.totalChanges ? (
        <p>The saved and incoming definitions are identical.</p>
      ) : (
        <ol className={styles.diff}>
          {diff.changes.map((change, index) => (
            <li key={`${change.path}-${index}`}>
              <strong>{change.path}</strong>
              <span className={styles.changeKind}>{change.kind}</span>
              <div className={styles.diffPair}>
                <DiffValue label="Current" value={change.before} />
                <DiffValue label="Incoming" value={change.after} />
              </div>
            </li>
          ))}
        </ol>
      )}
      {diff.truncated && (
        <p>
          Showing the first {diff.changes.length} of {diff.totalChanges}{" "}
          changes. Review the complete source document before replacing.
        </p>
      )}
    </GammaDisclosure>
  );
}
function prepare(source: string, format: DocumentFormat) {
  return {
    bundle: parseDashboardBundle(source, format),
    sessionId: crypto.randomUUID(),
  };
}
const copyLabel = "Create a copy";
function selectedAction(choices: Record<string, ImportAction>, id: string) {
  return Object.hasOwn(choices, id) ? choices[id] : undefined;
}
export function PortableImportPanel({
  providers,
  onImportBundle,
  onReviewBundle,
  onRefreshQueries,
  onBusyChange,
  initialDocument,
}: PortableImportProps) {
  const library = useSavedQueryLibrary();
  const [initial] = useState(() => {
    if (!initialDocument) return {};
    try {
      return {
        review: prepare(initialDocument.source, initialDocument.format),
      };
    } catch (error) {
      return {
        error:
          error instanceof Error ? error.message : "Invalid dashboard bundle.",
      };
    }
  });
  const [source, setSource] = useState(initialDocument?.source ?? "");
  const [format, setFormat] = useState<DocumentFormat>(
    initialDocument?.format ?? "yaml",
  );
  const [review, setReview] = useState(initial.review);
  const [mapping, setMapping] = useState<Record<string, string>>(() =>
    initial.review
      ? initialMapping(initial.review.bundle, providers)
      : Object.create(null),
  );
  const [queryChoices, setQueryChoices] = useState<
    Record<string, ImportAction>
  >({});
  const [dashboardChoices, setDashboardChoices] = useState<
    Record<string, ImportAction>
  >({});
  const [lockedActions, setLockedActions] = useState<
    Record<string, ImportAction>
  >({});
  const [snapshot, setSnapshot] = useState<{
    sessionId: string;
    value?: BundleImportReview;
    error?: string;
  }>();
  const [error, setError] = useState(initial.error ?? "");
  const [message, setMessage] = useState("");
  const [importing, setImporting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [remaining, setRemaining] = useState<string[]>();
  const file = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const reviewLoader = useRef(onReviewBundle);
  useEffect(() => {
    reviewLoader.current = onReviewBundle;
  }, [onReviewBundle]);
  useEffect(() => {
    if (!review || !reviewLoader.current) return;
    let active = true;
    reviewLoader.current(review.bundle).then(
      (value) => {
        if (active) setSnapshot({ sessionId: review.sessionId, value });
      },
      (error) => {
        if (active)
          setSnapshot({
            sessionId: review.sessionId,
            error:
              error instanceof Error
                ? error.message
                : "Could not load saved documents for comparison.",
          });
      },
    );
    return () => {
      active = false;
    };
  }, [review]);
  const loading =
    !!review && !!onReviewBundle && snapshot?.sessionId !== review.sessionId;
  const snapshotError =
    snapshot?.sessionId === review?.sessionId ? snapshot?.error : undefined;
  const current = useMemo<BundleImportReview>(
    () =>
      onReviewBundle
        ? ((snapshot?.sessionId === review?.sessionId
            ? snapshot?.value
            : undefined) ?? { dashboards: [], queries: [] })
        : {
            dashboards: [],
            queries: library.queries.map(({ etag, ...document }) => ({
              document,
              etag,
            })),
          },
    [onReviewBundle, snapshot, review, library.queries],
  );
  const pending = useMemo(
    () =>
      review?.bundle.dashboards.filter(
        (document) => !remaining || remaining.includes(document.id),
      ) ?? [],
    [review, remaining],
  );
  const activeBundle = useMemo(() => {
    const ids = pending
      .filter(
        (document) => selectedAction(dashboardChoices, document.id) !== "keep",
      )
      .map((document) => document.id);
    return review && ids.length
      ? selectBundleDashboards(review.bundle, ids)
      : undefined;
  }, [review, pending, dashboardChoices]);
  const queries = useMemo(
    () =>
      (activeBundle?.savedQueries ?? []).map((original) => {
        // Compare the incoming definition, even when Keep substitutes a different saved query.
        const incoming = {
          ...original,
          providerId: Object.hasOwn(mapping, original.providerId)
            ? mapping[original.providerId]
            : original.providerId,
        };
        const existing = current.queries.find(
          (item) => item.document.id === original.id,
        );
        const comparison = reviewSavedQuery(incoming, existing);
        const action =
          selectedAction(queryChoices, original.id) ??
          (comparison.status === "new"
            ? undefined
            : comparison.status === "identical"
              ? "keep"
              : "copy");
        const keep =
          existing && activeBundle
            ? canKeepSavedQuery(activeBundle, original.id, existing.document)
            : undefined;
        const replacement = existing
          ? savedQueryCompatibility(
              incoming,
              current.dashboards.map((item) => item.document),
              existing.document,
            )
          : undefined;
        const replaceReason = !onReviewBundle
          ? "Load an authoritative saved comparison to replace this query."
          : (comparison.replaceBlockedReason ??
            (replacement?.compatible ? undefined : replacement?.reason));
        const issue =
          action === "keep"
            ? !existing
              ? "This query is no longer available to keep. Refresh the comparison."
              : !keep?.compatible
                ? keep?.reason
                : undefined
            : action === "replace"
              ? replaceReason
              : undefined;
        return {
          original,
          incoming,
          existing,
          comparison,
          action,
          keep,
          replacement,
          replaceReason,
          issue,
        };
      }),
    [activeBundle, mapping, current, queryChoices, onReviewBundle],
  );
  const keptQueries = useMemo(
    () =>
      new Map<string, SavedQuery>(
        queries
          .filter((item) => item.action === "keep" && item.existing)
          .map((item) => [item.original.id, item.existing!.document]),
      ),
    [queries],
  );
  const requirements = useMemo(
    () =>
      activeBundle
        ? requiredImportProviders(activeBundle, new Set(keptQueries.keys()))
        : new Map<string, Set<"metrics" | "traces">>(),
    [activeBundle, keptQueries],
  );
  const mapped = useMemo(() => {
    if (!activeBundle) return { ready: true };
    try {
      return {
        ready: true,
        bundle: remapImportBundle(
          activeBundle,
          mapping,
          providers,
          keptQueries,
        ),
      };
    } catch (error) {
      return {
        ready: false,
        error:
          error instanceof Error
            ? error.message
            : "Choose compatible data sources.",
      };
    }
  }, [activeBundle, mapping, providers, keptQueries]);
  const dashboards = useMemo(
    () =>
      (review?.bundle.dashboards ?? []).map((original) => {
        let incoming: Dashboard = original;
        try {
          incoming = remapDashboardProviders([original], mapping, providers)[0];
        } catch {
          /* Sources can be selected after choosing Keep. */
        }
        const existing = current.dashboards.find(
          (item) => item.document.id === original.id,
        );
        const comparison = reviewDashboard(incoming, existing);
        const action = selectedAction(dashboardChoices, original.id) ?? "copy";
        const complete = !!remaining && !remaining.includes(original.id);
        const issue =
          !complete && action === "keep" && !existing
            ? "This dashboard is no longer available to keep. Refresh the comparison."
            : !complete && action === "replace" && !comparison.canReplace
              ? comparison.replaceBlockedReason
              : undefined;
        return { original, existing, comparison, action, complete, issue };
      }),
    [review, mapping, providers, current, dashboardChoices, remaining],
  );
  const usesLibrary = !!activeBundle?.dashboards.some((document) =>
    document.widgets.some(
      (widget) =>
        widget.queryRef ||
        widget.options?.tooltipView?.source?.type === "saved",
    ),
  );
  const libraryUnavailable =
    !onReviewBundle && usesLibrary && (library.loading || !!library.error);
  const issues = [
    ...dashboards.map((item) => item.issue),
    ...queries.map((item) => item.issue),
  ].filter(Boolean);
  const blocked =
    !review ||
    !onImportBundle ||
    !mapped.ready ||
    !!libraryUnavailable ||
    loading ||
    !!snapshotError ||
    importing ||
    refreshing ||
    issues.length > 0;
  const allCopies = pending.every(
    (document) =>
      (selectedAction(dashboardChoices, document.id) ?? "copy") === "copy",
  );

  function clearReview() {
    generation.current++;
    setReview(undefined);
    setRemaining(undefined);
    setAttempted(false);
    setQueryChoices({});
    setDashboardChoices({});
    setLockedActions({});
    setError("");
    setMessage("");
  }
  function preview(text = source, kind = format) {
    try {
      const next = prepare(text, kind);
      clearReview();
      setMapping(initialMapping(next.bundle, providers));
      setReview(next);
    } catch (error) {
      clearReview();
      setError(
        error instanceof Error ? error.message : "Invalid dashboard bundle.",
      );
    }
  }
  function clearReplacementChoices() {
    setQueryChoices((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([, action]) => action !== "replace"),
      ),
    );
    setDashboardChoices((previous) =>
      Object.fromEntries(
        Object.entries(previous).map(([id, action]) => [
          id,
          action === "replace" ? "keep" : action,
        ]),
      ),
    );
  }
  async function refreshReview() {
    if (!review) return;
    const sessionId = review.sessionId;
    setRefreshing(true);
    setError("");
    try {
      if (onReviewBundle) {
        const value = await onReviewBundle(review.bundle);
        setSnapshot({ sessionId, value });
      } else await onRefreshQueries?.();
      clearReplacementChoices();
      setMessage(
        "Comparison refreshed. Choose Replace again if needed. Completed decisions and the retry session are kept.",
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not refresh the comparison.",
      );
    } finally {
      setRefreshing(false);
    }
  }
  async function importBundle() {
    if (!review || !onImportBundle || blocked) return;
    const request: BundleImportRequest = {
      sessionId: review.sessionId,
      bundle: review.bundle,
      providerMapping: mapping,
      queryChoices: Object.fromEntries(
        queries
          .filter((item) => item.action)
          .map((item) => [item.original.id, item.action!]),
      ),
      dashboardChoices: Object.fromEntries(
        dashboards.map((item) => [item.original.id, item.action]),
      ),
      dashboardBaselines: Object.fromEntries(
        dashboards
          .filter((item) => item.comparison.baseline)
          .map((item) => [item.original.id, item.comparison.baseline!]),
      ),
      queryBaselines: Object.fromEntries(
        queries
          .filter((item) => item.comparison.baseline)
          .map((item) => [item.original.id, item.comparison.baseline!]),
      ),
    };
    setAttempted(true);
    setImporting(true);
    onBusyChange?.(true);
    setError("");
    try {
      const result = await onImportBundle(request);
      setMessage(
        `${result.totalAdded} dashboard decision${result.totalAdded === 1 ? "" : "s"} completed. This attempt: ${result.added} created, ${result.dashboardsKept} kept, ${result.dashboardsReplaced} replaced. Saved queries: ${result.queriesAdded} created, ${result.queriesReused} kept, ${result.queriesReplaced} replaced.`,
      );
      setRemaining(result.failed.map((document) => document.id));
      if (result.dashboardTargetsLocked)
        setLockedActions(request.dashboardChoices ?? {});
      if (result.errors.length) setError(result.errors.join("\n"));
      if (result.complete) {
        setReview(undefined);
        setSource("");
        setAttempted(false);
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Import failed. Your review is preserved; retry when the problem is resolved.",
      );
    } finally {
      setImporting(false);
      onBusyChange?.(false);
    }
  }
  return (
    <section className={styles.panel} aria-label="Portable dashboard import">
      <h3>Import dashboards</h3>
      <p>
        Review saved and incoming definitions. Keep what is here, replace a
        saved version, or create a copy with new links.
      </p>
      <fieldset disabled={importing || refreshing || loading}>
        <div className={styles.actions}>
          <GammaSelect
            aria-label="Library import format"
            disabled={importing || refreshing || loading || attempted}
            value={format}
            onValueChange={(value) => {
              clearReview();
              setFormat(value as DocumentFormat);
            }}
            options={[
              { value: "yaml", label: "YAML" },
              { value: "json", label: "JSON" },
            ]}
          />
          <GammaButton
            size="sm"
            variant="secondary"
            disabled={attempted}
            onClick={() => file.current?.click()}
          >
            <FileUp size={14} /> Choose file
          </GammaButton>
        </div>
        <GammaInput
          ref={file}
          type="file"
          hidden
          accept=".json,.yaml,.yml"
          aria-label="Choose dashboard bundle"
          onChange={async (event) => {
            const input = event.target,
              selected = input.files?.[0];
            input.value = "";
            if (!selected) return;
            clearReview();
            const token = ++generation.current;
            if (selected.size > MAX_LIBRARY_BYTES) {
              setError("Libraries must be smaller than 4 MiB.");
              return;
            }
            try {
              const text = await selected.text();
              if (token !== generation.current) return;
              const kind = selected.name.endsWith(".json") ? "json" : "yaml";
              setSource(text);
              setFormat(kind);
              preview(text, kind);
            } catch {
              if (token === generation.current)
                setError("Could not read the file. Choose it again.");
            }
          }}
        />
        <label>
          Dashboard or library document
          <GammaTextarea
            aria-label="Library import source"
            spellCheck={false}
            value={source}
            disabled={attempted}
            onChange={(event) => {
              clearReview();
              setSource(event.target.value);
            }}
            placeholder="Paste JSON or YAML…"
          />
        </label>
        <GammaButton
          size="sm"
          variant="secondary"
          disabled={!source.trim() || attempted}
          onClick={() => preview()}
        >
          Review import
        </GammaButton>
        {review && (
          <div className={styles.review} aria-label="Import review">
            <h4>
              {review.bundle.dashboards.length} dashboard
              {review.bundle.dashboards.length === 1 ? "" : "s"}
              {review.bundle.savedQueries &&
                ` · ${review.bundle.savedQueries.length} saved quer${review.bundle.savedQueries.length === 1 ? "y" : "ies"}`}
            </h4>
            {loading && (
              <p role="status">Loading saved versions for comparison…</p>
            )}
            <div aria-label="Dashboard review">
              {dashboards.map((item) => (
                <div className={styles.query} key={item.original.id}>
                  <strong>{item.original.title}</strong>
                  <code>{item.original.id}</code>
                  <p>
                    {item.original.folder || "Workspace root"} ·{" "}
                    {item.original.widgets.length} widget
                    {item.original.widgets.length === 1 ? "" : "s"}
                    {item.complete
                      ? " · Completed"
                      : item.comparison.status === "new"
                        ? " · New dashboard"
                        : item.comparison.status === "identical"
                          ? " · Identical saved version"
                          : " · Different saved version"}
                  </p>
                  <label>
                    Dashboard action
                    <GammaSelect
                      aria-label={`Import dashboard ${item.original.title}`}
                      value={item.action}
                      disabled={
                        item.complete || importing || refreshing || loading
                      }
                      onValueChange={(value) =>
                        setDashboardChoices((previous) => ({
                          ...previous,
                          [item.original.id]: value as ImportAction,
                        }))
                      }
                      options={[
                        {
                          value: "keep",
                          label: "Keep existing",
                          disabled:
                            !item.existing ||
                            selectedAction(lockedActions, item.original.id) ===
                              "copy",
                          description:
                            "Keep the saved dashboard and skip its incoming query dependencies.",
                        },
                        {
                          value: "replace",
                          label: "Replace existing",
                          disabled:
                            !item.comparison.canReplace ||
                            !onReviewBundle ||
                            selectedAction(lockedActions, item.original.id) ===
                              "copy",
                          description:
                            "Update the saved dashboard at its existing ID.",
                        },
                        {
                          value: "copy",
                          label: copyLabel,
                          disabled:
                            !!selectedAction(lockedActions, item.original.id) &&
                            selectedAction(lockedActions, item.original.id) !==
                              "copy",
                          description: "Create a dashboard with a new ID.",
                        },
                      ]}
                    />
                  </label>
                  {item.action === "replace" && (
                    <p className={styles.warning}>
                      Replaces this saved dashboard. Links to its ID will open
                      the incoming version.
                    </p>
                  )}
                  {item.issue && (
                    <p role="alert" className={styles.error}>
                      {item.issue}
                    </p>
                  )}
                  {item.existing && !item.complete && (
                    <Comparison
                      name={item.original.title}
                      diff={item.comparison.diff}
                    />
                  )}
                </div>
              ))}
            </div>
            {[...requirements].map(([id, kinds]) => (
              <label key={id}>
                Connect {id}
                <GammaSelect
                  aria-label={`Connect ${id}`}
                  disabled={importing || refreshing || loading}
                  value={mapping[id] ?? ""}
                  onValueChange={(value) => {
                    setMapping((previous) =>
                      Object.assign(Object.create(null), previous, {
                        [id]: value,
                      }),
                    );
                  }}
                  placeholder="Choose a data source"
                  searchable
                  options={providers
                    .filter((provider) =>
                      [...kinds].every((kind) =>
                        provider.capabilities.includes(kind),
                      ),
                    )
                    .map((provider) => ({
                      value: provider.id,
                      label: provider.name,
                      icon: <ProviderIcon type={provider.type} />,
                    }))}
                />
              </label>
            ))}
            {!!queries.length && (
              <div className={styles.queries} aria-label="Saved query review">
                <h4>
                  {remaining
                    ? "Saved queries for remaining dashboards"
                    : "Saved queries"}
                </h4>
                {queries.map((item) => (
                  <div className={styles.query} key={item.original.id}>
                    <strong>{item.original.name}</strong>
                    <code>{item.original.id}</code>
                    <p>
                      {item.comparison.status === "new"
                        ? "New query. Its ID will be preserved unless you choose a copy."
                        : item.comparison.status === "identical"
                          ? "An identical query already exists in this workspace."
                          : "This ID belongs to a different query. Compare the definitions before choosing."}
                    </p>
                    <label>
                      Query action
                      <GammaSelect
                        aria-label={`Import query ${item.original.name}`}
                        disabled={importing || refreshing || loading}
                        value={item.action ?? "create"}
                        onValueChange={(value) =>
                          setQueryChoices((previous) => {
                            const next = { ...previous };
                            if (value === "create")
                              delete next[item.original.id];
                            else next[item.original.id] = value as ImportAction;
                            return next;
                          })
                        }
                        options={[
                          ...(item.comparison.status === "new"
                            ? [
                                {
                                  value: "create",
                                  label: "Create query",
                                  description:
                                    "Preserve the original query ID.",
                                },
                              ]
                            : []),
                          {
                            value: "keep",
                            label: "Keep existing",
                            disabled: !item.existing || !item.keep?.compatible,
                            description:
                              "Use the saved query without changing its definition.",
                          },
                          {
                            value: "replace",
                            label: "Replace existing",
                            disabled: !!item.replaceReason,
                            description:
                              "Update the query for every dashboard that uses it.",
                          },
                          {
                            value: "copy",
                            label: copyLabel,
                            description:
                              "Create a new ID; imported main-widget and tooltip links will point to that copy.",
                          },
                        ]}
                      />
                    </label>
                    {item.existing && !item.keep?.compatible && (
                      <p>Keep unavailable: {item.keep?.reason}</p>
                    )}
                    {item.existing && item.replaceReason && (
                      <p>Replace unavailable: {item.replaceReason}</p>
                    )}
                    {item.action === "replace" && (
                      <div
                        className={styles.warning}
                        role="note"
                        aria-label={`Replacement impact for ${item.original.name}`}
                      >
                        <strong>
                          Changes every dashboard using this query
                        </strong>
                        <p>
                          The existing query ID stays the same. This includes
                          dashboards outside this import.
                        </p>
                        {item.replacement?.affectedDashboardIds.length ? (
                          <ul>
                            {current.dashboards
                              .filter((saved) =>
                                item.replacement!.affectedDashboardIds.includes(
                                  saved.document.id,
                                ),
                              )
                              .map((saved) => (
                                <li key={saved.document.id}>
                                  {saved.document.title}
                                </li>
                              ))}
                          </ul>
                        ) : (
                          <p>No saved dashboards currently use this query.</p>
                        )}
                      </div>
                    )}
                    {item.issue && (
                      <p role="alert" className={styles.error}>
                        {item.issue}
                      </p>
                    )}
                    {item.existing && (
                      <Comparison
                        name={item.original.name}
                        diff={item.comparison.diff}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
            {activeBundle?.savedQueries === undefined && usesLibrary && (
              <p>
                Legacy document: saved query definitions are not included. Its
                links must resolve in this workspace.
              </p>
            )}
            {libraryUnavailable && (
              <p role="alert">
                {library.loading
                  ? "Loading the saved query library before import…"
                  : `Saved query library unavailable: ${library.error}`}
              </p>
            )}
            {snapshotError && (
              <p role="alert" className={styles.error}>
                {snapshotError}
              </p>
            )}
            {!mapped.ready && <p>{mapped.error}</p>}
            {attempted && (
              <p>
                Retry skips completed dashboards. Changes apply to remaining
                dashboards; completed decisions are kept. {pending.length}{" "}
                dashboard{pending.length === 1 ? "" : "s"} remaining.
                {Object.keys(lockedActions).length > 0 &&
                  " Dashboard copy destinations are fixed to preserve saved links. You can still change Keep to Replace, query choices, and data sources."}
              </p>
            )}
            <GammaButton
              size="sm"
              variant="primary"
              disabled={blocked}
              onClick={importBundle}
            >
              {importing
                ? "Importing…"
                : allCopies
                  ? `Import ${pending.length} as new`
                  : "Apply import choices"}
            </GammaButton>
            {(onReviewBundle || onRefreshQueries) && (
              <GammaButton
                size="sm"
                variant="secondary"
                disabled={importing || refreshing || loading}
                onClick={refreshReview}
              >
                <RefreshCw size={14} />
                {onReviewBundle
                  ? "Refresh comparison"
                  : "Refresh query library"}
              </GammaButton>
            )}
          </div>
        )}
        {attempted && (
          <GammaButton
            size="sm"
            variant="quiet"
            onClick={() => {
              clearReview();
              setSource("");
            }}
          >
            Review a different document
          </GammaButton>
        )}
      </fieldset>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  );
}
