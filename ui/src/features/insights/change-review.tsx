import type { FieldChange, JSONValue, DocumentChanges, WidgetChange } from "./dashboard-patch";
import { GammaButton } from "./gamma/button";
import { GammaDisclosure } from "./gamma/disclosure";

/** Longest value printed for one field, so a large series list cannot flood the panel. */
const MAX_VALUE_CHARACTERS = 2000;

const KIND_LABEL: Record<WidgetChange["kind"], string> = {
  added: "added",
  removed: "removed",
  changed: "changed",
  moved: "moved",
};

function valueText(value: JSONValue | undefined): string {
  if (value === undefined) return "none";
  const text = JSON.stringify(value, null, 2) ?? "null";
  return text.length > MAX_VALUE_CHARACTERS ? `${text.slice(0, MAX_VALUE_CHARACTERS)}…` : text;
}

function FieldList({ changes }: { changes: FieldChange[] }) {
  return (
    <ol className="m-0 grid list-none gap-2 p-0">
      {changes.map((change, index) => (
        <li key={`${change.path}-${index}`} className="grid gap-1 text-xs" data-change-kind={change.kind}>
          <div className="flex flex-wrap items-baseline gap-2">
            <code className="font-mono text-[11px] text-[color:var(--gamma-ink)] [overflow-wrap:anywhere]">{change.path}</code>
            <span className="text-[11px] text-[color:var(--gamma-muted)]">{change.kind}</span>
          </div>
          {change.kind !== "add" && (
            <pre className="m-0 whitespace-pre-wrap rounded-[4px] bg-[color:var(--gamma-surface)] p-2 font-mono text-[11px] text-[color:var(--gamma-muted)] [overflow-wrap:anywhere]">
              <span className="sr-only">Before: </span>
              {valueText(change.before)}
            </pre>
          )}
          {change.kind !== "remove" && (
            <pre className="m-0 whitespace-pre-wrap rounded-[4px] bg-[color:var(--gamma-surface)] p-2 font-mono text-[11px] text-[color:var(--gamma-ink)] [overflow-wrap:anywhere]">
              <span className="sr-only">After: </span>
              {valueText(change.after)}
            </pre>
          )}
        </li>
      ))}
    </ol>
  );
}

function fieldCountText(count: number, truncated: boolean): string {
  const base = `${count} field${count === 1 ? "" : "s"}`;
  return truncated ? `${base} or more` : base;
}

/**
 * Field-level review of what replacing the draft would change, one disclosure per widget. The
 * widget-level counts stay in the editor's summary line; this shows the fields behind them.
 */
export function ChangeReview({
  changes,
  onFocusWidget,
}: {
  changes: DocumentChanges;
  onFocusWidget?: (widgetId: string) => void;
}) {
  if (!changes.widgets.length && !changes.dashboard.totalChanges) return null;
  return (
    <section aria-label="Field changes" className="mt-3 grid gap-2">
      {changes.dashboard.totalChanges > 0 && (
        <GammaDisclosure
          title="Dashboard settings"
          meta={fieldCountText(changes.dashboard.totalChanges, changes.dashboard.truncated)}
        >
          <div className="grid gap-2 p-2">
            <FieldList changes={changes.dashboard.changes} />
          </div>
        </GammaDisclosure>
      )}
      {changes.widgets.map((widget) => (
        <GammaDisclosure
          key={`${widget.kind}-${widget.id}`}
          title={`${widget.title || widget.id} · ${KIND_LABEL[widget.kind]}`}
          meta={fieldCountText(widget.diff.totalChanges, widget.diff.truncated)}
        >
          <div className="grid gap-2 p-2">
            <FieldList changes={widget.diff.changes} />
            {onFocusWidget && widget.kind !== "removed" && (
              <div>
                <GammaButton
                  size="sm"
                  variant="quiet"
                  aria-label={`Show widget ${widget.title || widget.id}`}
                  onClick={() => onFocusWidget(widget.id)}
                >
                  Show widget
                </GammaButton>
              </div>
            )}
          </div>
        </GammaDisclosure>
      ))}
    </section>
  );
}
