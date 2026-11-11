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
import { ChecksList, hasErrors, type DocumentValidator } from "./checks-list";
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

export function DocumentEditor({
  dashboard,
  onApply,
  onClose,
  providers = [],
  onImportBundle,
  onRefreshQueries,
  onReviewBundle,
  checkDocument,
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
}) {
  const library = useSavedQueryLibrary();
  const [checkState, setCheckState] = useState<CheckState>({ status: "idle" });
  const [applying, setApplying] = useState(false);
  const checking = useRef<AbortController | null>(null);
  useEffect(() => () => checking.current?.abort(), []);
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
      setValid(true);
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
    setCheckState({ status: "idle" });
  }
  async function runCheck(parsed: Dashboard): Promise<CheckOutcome> {
    if (!checkDocument) return "cancelled";
    checking.current?.abort();
    const controller = new AbortController();
    checking.current = controller;
    setCheckState({ status: "checking" });
    try {
      const report = await checkDocument(parsed, controller.signal);
      if (controller.signal.aborted) return "cancelled";
      setValid(!hasErrors(report));
      setCheckState({ status: "done", report, document: parsed });
      return { report, document: parsed };
    } catch (error) {
      if (controller.signal.aborted) return "cancelled";
      const failure = error instanceof Error ? error.message : "Could not check this dashboard.";
      setCheckState({ status: "failed", message: failure });
      return { failure };
    } finally {
      if (checking.current === controller) checking.current = null;
    }
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
    setApplying(true);
    const outcome = await runCheck(parsed);
    setApplying(false);
    // A save the server would reject stays here with its findings. An unavailable check does not
    // block applying: the canvas is local and the save validates again.
    if (outcome === "cancelled") return;
    if ("report" in outcome && hasErrors(outcome.report)) return;
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
      {valid && (
        <p className={styles.valid} role="status">
          <Check size={14} /> Valid dashboard · ready to apply
        </p>
      )}
      {checkDocument && checkState.status === "checking" && (
        <p className={styles.muted} role="status">
          Checking dashboard…
        </p>
      )}
      {checkDocument && checkState.status === "failed" && (
        <p role="alert" className={styles.validationError}>
          Could not check this dashboard: {checkState.message}. Applying to the
          canvas does not depend on the check.
        </p>
      )}
      {checkDocument && checkState.status === "done" && (
        <ChecksList
          label="Dashboard checks"
          report={checkState.report}
          dashboard={checkState.document}
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
