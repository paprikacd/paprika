import { useEffect, useRef, useState } from "react";
import { Check, Download, FileUp, Braces, X } from "lucide-react";
import {
  parseDashboard,
  serializeDashboard,
  type Dashboard,
  type DocumentFormat,
  type Provider,
} from "./schema";
import {
  buildDashboardBundle,
  downloadDocument,
  MAX_LIBRARY_BYTES,
  parseDashboardBundle,
  serializeDashboardBundle,
} from "./workspace-transfer";
import {
  PortableImportPanel,
  type PortableImportProps,
} from "./portable-import-panel";
import { useSavedQueryLibrary } from "./saved-query-context";
import {
  ChecksList,
  checkCountsText,
  errorCountText,
  hasErrors,
  type DocumentValidator,
} from "./checks-list";
import type { CheckReport } from "@/gen/paprika/insights/v1/checks_pb";
import styles from "./insights.module.css";
import { GammaButton } from "./gamma/button";
import { GammaInput, GammaTextarea } from "./gamma/input";

type CheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; report: CheckReport; document: Dashboard }
  | { status: "failed"; message: string };
type CheckOutcome =
  | { report: CheckReport; document: Dashboard }
  | { failure: string }
  | "cancelled";

/** A check that has not answered within this long is a failed check: Apply stays available. */
const CHECK_TIMEOUT_MS = 10_000;

class CheckTimeout extends Error {}

/** Settles with the check, or rejects with CheckTimeout after the limit, whether or not the check honours its signal. */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new CheckTimeout(`The check did not finish within ${ms / 1000} seconds.`));
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function DocumentEditor({
  dashboard,
  onApply,
  onClose,
  providers = [],
  onImportBundle,
  onRefreshQueries,
  onReviewBundle,
  checkDocument,
  onFocusWidget,
}: {
  dashboard: Dashboard;
  onApply: (dashboard: Dashboard) => void;
  onClose: () => void;
  providers?: Provider[];
  onImportBundle?: PortableImportProps["onImportBundle"];
  onRefreshQueries?: PortableImportProps["onRefreshQueries"];
  onReviewBundle?: PortableImportProps["onReviewBundle"];
  /** Dry-run checks for the draft and for imported dashboards. Without it, the Check action is absent and Apply is local. */
  checkDocument?: DocumentValidator;
  /** Focuses or scrolls to a widget on the canvas, for a finding's "Show widget" action. */
  onFocusWidget?: (widgetId: string) => void;
}) {
  const library = useSavedQueryLibrary();
  const [checkState, setCheckState] = useState<CheckState>({ status: "idle" });
  const [applying, setApplying] = useState(false);
  // Counts refused applies, so focus moves to the findings once per refusal.
  const [refusals, setRefusals] = useState(0);
  const checksHeading = useRef<HTMLHeadingElement>(null);
  const checking = useRef<AbortController | null>(null);
  // The check in flight and the last answer, keyed by the document text they checked.
  const inFlight = useRef<{ json: string; promise: Promise<CheckOutcome>; token: object } | null>(null);
  const lastAnswer = useRef<{ json: string; outcome: CheckOutcome } | null>(null);
  useEffect(() => () => checking.current?.abort(), []);
  useEffect(() => {
    if (refusals) checksHeading.current?.focus();
  }, [refusals]);
  const [importing, setImporting] = useState(false);
  const [review, setReview] = useState<{
    source: string;
    format: DocumentFormat;
    key: number;
  }>();
  const fileGeneration = useRef(0);
  const [format, setFormat] = useState<DocumentFormat>("yaml");
  const [source, setSource] = useState(() =>
    serializeDashboard(dashboard, "yaml"),
  );
  const [error, setError] = useState("");
  const [valid, setValid] = useState(false);
  const [base, setBase] = useState(() => JSON.stringify(dashboard));
  const stale = base !== JSON.stringify(dashboard);
  // Read after an await, when the render that started the apply is no longer current.
  const latest = useRef({ dashboard, base });
  useEffect(() => {
    latest.current = { dashboard, base };
  });
  const file = useRef<HTMLInputElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const sourceField = useRef<HTMLTextAreaElement>(null);
  const wasReview = useRef(false);
  const reviewKey = review?.key;
  useEffect(() => {
    const target =
      reviewKey !== undefined
        ? reviewHeading.current
        : wasReview.current
          ? sourceField.current
          : null;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView?.({ block: "nearest" });
    wasReview.current = reviewKey !== undefined;
  }, [reviewKey]);

  function validate() {
    try {
      const parsed = parseDashboard(source, format);
      setError("");
      // A draft the last check refused is not ready to apply, whatever its schema.
      setValid(!(checkState.status === "done" && hasErrors(checkState.report)));
      return parsed;
    } catch {
      try {
        parseDashboardBundle(source, format);
        setReview({ source, format, key: ++fileGeneration.current });
        setError("");
      } catch (bundleError) {
        setError(
          bundleError instanceof Error
            ? bundleError.message
            : "Invalid document",
        );
      }
      setValid(false);
    }
  }
  // Editing never waits for a check. An edit cancels a running one, and its findings are cleared because
  // they describe the text that was replaced.
  function resetChecks() {
    checking.current?.abort();
    checking.current = null;
    inFlight.current = null;
    lastAnswer.current = null;
    setCheckState({ status: "idle" });
  }
  function runCheck(parsed: Dashboard): Promise<CheckOutcome> {
    if (!checkDocument) return Promise.resolve("cancelled");
    const json = JSON.stringify(parsed);
    // A check already running for this exact text is awaited, not restarted.
    if (inFlight.current?.json === json) return inFlight.current.promise;
    checking.current?.abort();
    const controller = new AbortController();
    const token = {};
    checking.current = controller;
    setCheckState({ status: "checking" });
    const promise = (async (): Promise<CheckOutcome> => {
      try {
        const report = await withTimeout(
          checkDocument(parsed, controller.signal),
          CHECK_TIMEOUT_MS,
          () => controller.abort(),
        );
        if (controller.signal.aborted) return "cancelled";
        setValid(!hasErrors(report));
        setCheckState({ status: "done", report, document: parsed });
        const outcome: CheckOutcome = { report, document: parsed };
        lastAnswer.current = { json, outcome };
        return outcome;
      } catch (error) {
        // A timeout aborts the signal too, so it is named before the abort is read as an edit.
        if (controller.signal.aborted && !(error instanceof CheckTimeout)) return "cancelled";
        const failure = error instanceof Error ? error.message : "Could not check this dashboard.";
        setCheckState({ status: "failed", message: failure });
        return { failure };
      } finally {
        if (checking.current === controller) checking.current = null;
        if (inFlight.current?.token === token) inFlight.current = null;
      }
    })();
    inFlight.current = { json, promise, token };
    return promise;
  }
  function check() {
    const parsed = validate();
    if (parsed) void runCheck(parsed);
  }
  async function apply() {
    const parsed = validate();
    if (!parsed || stale) return;
    if (!checkDocument) {
      onApply(parsed);
      return;
    }
    const json = JSON.stringify(parsed);
    setApplying(true);
    // A just-checked identical draft keeps its answer; a running check for it is awaited.
    const answered = lastAnswer.current?.json === json ? lastAnswer.current.outcome : undefined;
    const outcome = answered ?? (await runCheck(parsed));
    setApplying(false);
    // The canvas may have changed while the check ran. An older draft must not overwrite it.
    const now = latest.current;
    if (now.base !== JSON.stringify(now.dashboard)) return;
    if (outcome === "cancelled") return;
    // A save the server would reject stays here with its findings and focus moves to them. An unavailable
    // or timed-out check does not block applying: the canvas is local and the save validates again.
    if ("report" in outcome && hasErrors(outcome.report)) {
      setRefusals((count) => count + 1);
      return;
    }
    onApply(parsed);
  }
  function changeFormat(next: DocumentFormat) {
    if (format === next) return;
    resetChecks();
    fileGeneration.current++;
    const parsed = validate();
    if (parsed) {
      setFormat(next);
      setSource(serializeDashboard(parsed, next));
      setValid(false);
    }
  }
  function download() {
    const parsed = validate();
    if (!parsed) return;
    try {
      const linked = parsed.widgets.some(
        (widget) =>
          widget.queryRef ||
          widget.options?.tooltipView?.source?.type === "saved",
      );
      if (linked && (library.loading || library.error))
        throw new Error(
          library.loading
            ? "Wait for the saved query library to load before exporting linked dashboards."
            : `Saved query library unavailable: ${library.error}`,
        );
      const output = linked
        ? serializeDashboardBundle(
            buildDashboardBundle([parsed], library.queries),
            format,
          )
        : serializeDashboard(parsed, format);
      downloadDocument(output, parsed.id, format);
      setError("");
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not export the dashboard.",
      );
    }
  }
  if (review)
    return (
      <section className={styles.document} aria-label="Dashboard source editor">
        <div className={styles.panelHeading}>
          <h2 ref={reviewHeading} tabIndex={-1}>
            Review dashboard import
          </h2>
          <GammaButton
            iconOnly
            size="sm"
            variant="quiet"
            aria-label="Close source editor"
            disabled={importing}
            onClick={onClose}
          >
            <X size={18} />
          </GammaButton>
        </div>
        <p className={styles.muted}>
          Your source draft is preserved. This import creates dashboard copies
          and brings their saved queries into the workspace.
        </p>
        <GammaButton
          size="sm"
          variant="secondary"
          disabled={importing}
          onClick={() => {
            fileGeneration.current++;
            setReview(undefined);
          }}
        >
          Back to source
        </GammaButton>
        <PortableImportPanel
          key={review.key}
          initialDocument={review}
          providers={providers}
          onImportBundle={onImportBundle}
          onRefreshQueries={onRefreshQueries}
          onReviewBundle={onReviewBundle}
          validateDocument={checkDocument}
          onBusyChange={setImporting}
        />
      </section>
    );

  // One status line stays mounted, so every change to it is announced; the findings list is not a live region.
  const summary: { text: string; tone: "ok" | "error" | "muted" | "" } = !checkDocument
    ? valid
      ? { text: "Valid dashboard · ready to apply", tone: "ok" }
      : { text: "", tone: "" }
    : checkState.status === "checking"
      ? { text: "Checking dashboard…", tone: "muted" }
      : checkState.status === "failed"
        ? {
            text: `Could not check this dashboard: ${checkState.message}. Applying to the canvas does not depend on the check.`,
            tone: "error",
          }
        : checkState.status === "done" && hasErrors(checkState.report)
          ? { text: `${errorCountText(checkState.report)}. Fix them before applying.`, tone: "error" }
          : checkState.status === "done"
            ? { text: `${checkCountsText(checkState.report)}. Ready to apply.`, tone: "ok" }
            : valid
              ? { text: "Valid dashboard · ready to apply", tone: "ok" }
              : { text: "", tone: "" };

  return (
    <section className={styles.document} aria-label="Dashboard source editor">
      <div className={styles.panelHeading}>
        <div>
          <h2>
            <Braces size={18} /> Dashboard source
          </h2>
        </div>
        <GammaButton
          iconOnly
          size="sm"
          variant="quiet"
          className={styles.iconButton}
          aria-label="Close source editor"
          onClick={onClose}
        >
          <X size={18} />
        </GammaButton>
      </div>
      <p className={styles.muted}>
        Edit, version, or generate your dashboard. Changes stay here until you
        apply them to the canvas.
      </p>
      <p className={styles.muted}>
        Export includes any referenced saved queries. A library or bundle import
        opens a shared review before creating copies.
      </p>
      {stale && (
        <div className={styles.validationError} role="alert">
          The canvas changed while this editor was open. Load its latest
          document before applying changes.
          <GammaButton
            size="sm"
            variant="secondary"
            className={styles.secondary}
            onClick={() => {
              resetChecks();
              fileGeneration.current++;
              setSource(serializeDashboard(dashboard, format));
              setBase(JSON.stringify(dashboard));
              setValid(false);
              setError("");
            }}
          >
            Load latest canvas
          </GammaButton>
        </div>
      )}
      <div className={styles.sourceTools}>
        <div className={styles.segmented} aria-label="Document format">
          {(["yaml", "json"] as const).map((value) => (
            <GammaButton
              size="sm"
              variant="quiet"
              key={value}
              aria-pressed={format === value}
              onClick={() => changeFormat(value)}
            >
              {value.toUpperCase()}
            </GammaButton>
          ))}
        </div>
        <div className={styles.actions}>
          <GammaButton
            size="sm"
            variant="quiet"
            onClick={() => file.current?.click()}
          >
            <FileUp size={14} /> Import
          </GammaButton>
          <GammaButton size="sm" variant="quiet" onClick={download}>
            <Download size={14} /> Export
          </GammaButton>
        </div>
      </div>
      <GammaInput
        ref={file}
        type="file"
        accept=".json,.yaml,.yml,application/json,application/yaml"
        hidden
        aria-label="Import dashboard document"
        onChange={async (event) => {
          const input = event.target;
          const selected = input.files?.[0];
          input.value = "";
          if (!selected) return;
          resetChecks();
          const generation = ++fileGeneration.current;
          if (selected.size > MAX_LIBRARY_BYTES) {
            setError("Libraries must be smaller than 4 MiB.");
            return;
          }
          try {
            const text = await selected.text();
            if (generation !== fileGeneration.current) return;
            const kind = selected.name.endsWith(".json") ? "json" : "yaml";
            try {
              parseDashboard(text, kind);
              setFormat(kind);
              setSource(text);
              setValid(false);
              setError("");
            } catch {
              parseDashboardBundle(text, kind);
              setReview({ source: text, format: kind, key: generation });
              setError("");
            }
          } catch (error) {
            if (generation === fileGeneration.current)
              setError(
                error instanceof Error
                  ? error.message
                  : "Could not read this file. Your source draft is preserved.",
              );
          }
        }}
      />
      <GammaTextarea
        ref={sourceField}
        className={styles.codeEditor}
        aria-label="Dashboard source"
        spellCheck={false}
        value={source}
        onChange={(event) => {
          resetChecks();
          fileGeneration.current++;
          setSource(event.target.value);
          setValid(false);
          setError("");
        }}
      />
      {error && (
        <pre role="alert" className={styles.validationError}>
          {error}
        </pre>
      )}
      <p
        role="status"
        aria-live="polite"
        className={
          summary.tone === "ok"
            ? styles.valid
            : summary.tone === "error"
              ? styles.validationError
              : summary.tone === "muted"
                ? styles.muted
                : undefined
        }
      >
        {summary.tone === "ok" && <Check size={14} aria-hidden="true" />}
        {summary.tone === "ok" ? " " : null}
        {summary.text}
      </p>
      {checkDocument && checkState.status === "done" && (
        <ChecksList
          label="Dashboard checks"
          report={checkState.report}
          dashboard={checkState.document}
          onFocusWidget={onFocusWidget}
          headingRef={checksHeading}
        />
      )}
      <div className={styles.panelFooter}>
        <GammaButton
          size="sm"
          variant="secondary"
          className={styles.secondary}
          onClick={validate}
        >
          Validate document
        </GammaButton>
        {checkDocument && (
          <GammaButton
            size="sm"
            variant="secondary"
            className={styles.secondary}
            disabled={checkState.status === "checking"}
            onClick={check}
          >
            Check
          </GammaButton>
        )}
        <GammaButton
          size="sm"
          variant="primary"
          className={styles.primary}
          disabled={stale || applying}
          onClick={() => void apply()}
        >
          Apply to canvas
        </GammaButton>
      </div>
    </section>
  );
}
