import styles from "./tooltip-instructions.module.css";

/** Match the primary input device without hiding keyboard help on desktops. */
export function TooltipInstructions() {
  return <span data-tooltip-instructions>
    <span className={styles.keyboard}>Page Up/Down to scroll · Esc to close</span>
    <span className={styles.touch}>Swipe to scroll · tap outside to close</span>
  </span>;
}
