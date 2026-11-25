import { EMPTY_INCOMPLETE, EMPTY_RANGE } from "../benign-states";
import { useTooltipWidgetData } from "../tooltip-widget-data";
import styles from "../charts.module.css";

export function EmptyState({ partial = false }: { partial?: boolean }) {
  const source = useTooltipWidgetData();
  const contextualPartial = !!(source?.result.truncated || source?.result.records?.truncated);
  const incomplete = partial || contextualPartial;
  return (
    <div className={styles.state} data-widget-state="empty">
      <strong>{incomplete ? EMPTY_INCOMPLETE.title : EMPTY_RANGE.title}</strong>
      <p>{partial ? EMPTY_INCOMPLETE.partialHint : contextualPartial ? EMPTY_INCOMPLETE.contextualHint : EMPTY_RANGE.hint}</p>
    </div>
  );
}
