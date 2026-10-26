import { useId, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import styles from "./disclosure.module.css";

/** Adapted from Gamma DisclosureStack; mount large comparison bodies only when open. */
export function GammaDisclosure({
  title,
  children,
  meta,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  meta?: string;
  defaultOpen?: boolean;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(defaultOpen);
  return (
    <div className={styles.item} data-expanded={expanded}>
      <button
        type="button"
        className={styles.trigger}
        id={`${id}-trigger`}
        aria-controls={`${id}-panel`}
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className={styles.title}>{title}</span>
        {meta && <span className={styles.meta}>{meta}</span>}
        <Plus className={styles.plus} size={16} aria-hidden="true" />
      </button>
      <div
        id={`${id}-panel`}
        role="region"
        aria-labelledby={`${id}-trigger`}
        hidden={!expanded}
        className={styles.panel}
      >
        {expanded && children}
      </div>
    </div>
  );
}
