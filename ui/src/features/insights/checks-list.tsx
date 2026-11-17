import type { Ref } from "react";
import { OctagonAlert, Info, TriangleAlert } from "lucide-react";
import type { CheckFinding, CheckReport } from "@/gen/paprika/insights/v1/checks_pb";
import { Severity } from "@/gen/paprika/insights/v1/checks_pb";
import type { Dashboard } from "./schema";
import { GammaButton } from "./gamma/button";
import styles from "./checks-list.module.css";

export interface ChecksListProps {
  report: CheckReport;
  /** Widget titles are read from this document. Without it, a finding names its widget by id. */
  dashboard?: Pick<Dashboard, "widgets">;
  /** When provided, findings that name a widget get a button that focuses or scrolls to it. */
  onFocusWidget?: (widgetId: string) => void;
  /** The accessible name of the list region. */
  label: string;
  /** Level of the counts heading. The severity groups sit one level below it. Default 3, under a page's h2. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /** Receives the counts heading, which is focusable so a caller can move focus to the findings. */
  headingRef?: Ref<HTMLHeadingElement>;
}

type Group = "error" | "warning" | "info";

const GROUPS: { group: Group; heading: string; word: string }[] = [
  { group: "error", heading: "Errors", word: "Error" },
  { group: "warning", heading: "Warnings", word: "Warning" },
  { group: "info", heading: "Notes", word: "Info" },
];

function groupOf(finding: CheckFinding): Group {
  if (finding.severity === Severity.ERROR) return "error";
  if (finding.severity === Severity.WARNING) return "warning";
  return "info";
}

function Glyph({ group }: { group: Group }) {
  const size = 13;
  if (group === "error") return <OctagonAlert size={size} aria-hidden="true" focusable="false" />;
  if (group === "warning") return <TriangleAlert size={size} aria-hidden="true" focusable="false" />;
  return <Info size={size} aria-hidden="true" focusable="false" />;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The counts header, such as "2 errors, 3 warnings". Counts cover every finding, not only the listed ones. */
export function checkCountsText(report: CheckReport): string {
  const parts = [
    report.errorCount > 0 ? plural(report.errorCount, "error") : "",
    report.warningCount > 0 ? plural(report.warningCount, "warning") : "",
    report.infoCount > 0 ? `${report.infoCount} info` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "No findings";
}

/** The error count alone, such as "2 errors", for copy about refusing a save. */
export function errorCountText(report: CheckReport): string {
  const errors = report.errorCount || report.issues.filter((finding) => finding.severity === Severity.ERROR).length;
  return plural(errors, "error");
}

export function ChecksList({ report, dashboard, onFocusWidget, label, headingLevel = 3, headingRef }: ChecksListProps) {
  const shown = report.issues.length;
  const groups = GROUPS.map((entry) => ({
    ...entry,
    findings: report.issues.filter((finding) => groupOf(finding) === entry.group),
  })).filter((entry) => entry.findings.length > 0);
  const title = (widgetId: string) => dashboard?.widgets.find((widget) => widget.id === widgetId)?.title;
  const CountsHeading = `h${headingLevel}` as "h2";
  const GroupHeading = `h${Math.min(headingLevel + 1, 6)}` as "h3";

  return (
    <section className={styles.checks} aria-label={label}>
      <CountsHeading ref={headingRef} tabIndex={-1} className={styles.counts}>
        {checkCountsText(report)}
      </CountsHeading>
      {report.truncated && (
        <p className={styles.notice}>
          Showing {shown} of {report.total} findings. Fix these and check again to see the rest.
        </p>
      )}
      {groups.map((entry) => (
        <div className={styles.group} key={entry.group}>
          <GroupHeading className={styles.groupHeading}>
            {entry.heading} <span className={styles.groupCount}>({entry.findings.length})</span>
          </GroupHeading>
          <ol className={styles.list}>
            {entry.findings.map((finding, index) => {
              const name = title(finding.widgetId);
              const focusable = !!onFocusWidget && !!finding.widgetId && (!dashboard || name !== undefined);
              return (
                <li className={styles.item} data-severity={entry.group} key={`${entry.group}-${finding.ruleId}-${finding.pointer}-${index}`}>
                  <div className={styles.row}>
                    <span className={styles.severity}>
                      <Glyph group={entry.group} />
                      {entry.word}
                    </span>
                    <code className={styles.rule}>{finding.ruleId}</code>
                    <span className={styles.target}>
                      {!finding.widgetId ? "Whole dashboard" : name ?? finding.widgetId}
                      {finding.pointer && <code className={styles.pointer}>{finding.pointer}</code>}
                    </span>
                  </div>
                  <p className={styles.message}>{finding.message}</p>
                  {finding.fix && (
                    <p className={styles.fix}>
                      <span className={styles.fixLabel}>Fix:</span> {finding.fix}
                    </p>
                  )}
                  {focusable && (
                    <GammaButton
                      size="sm"
                      variant="quiet"
                      className={styles.action}
                      aria-label={`Show widget ${name ?? finding.widgetId}`}
                      onClick={() => onFocusWidget!(finding.widgetId)}
                    >
                      Show widget
                    </GammaButton>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </section>
  );
}

/** Checks a document as a save would send it. The client's validate call has this shape. */
export type DocumentValidator = (document: Dashboard, signal?: AbortSignal) => Promise<CheckReport>;

/** Whether a save would be rejected: any error finding, whichever count carried it. */
export function hasErrors(report: CheckReport): boolean {
  return report.errorCount > 0 || report.issues.some((finding) => finding.severity === Severity.ERROR);
}
