// Adapted from Gamma src/components/GammaTabs.tsx; see README.md.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import styles from "./gamma.module.css";

function revealTab(tab: HTMLElement) {
  const list = tab.parentElement;
  if (!list) return;
  const bounds = list.getBoundingClientRect();
  const target = tab.getBoundingClientRect();
  // Keep the focus ring clear of the edge fade, without scrolling the page.
  const inset = 20;
  if (target.left < bounds.left + inset) list.scrollLeft += target.left - bounds.left - inset;
  else if (target.right > bounds.right - inset) list.scrollLeft += target.right - bounds.right + inset;
}

export function GammaTabs({
  label,
  tabs,
  value,
  onChange,
  variant = "segmented",
}: {
  label: string;
  tabs: { id: string; title: string; content: ReactNode }[];
  value: string;
  onChange: (id: string) => void;
  variant?: "segmented" | "underline";
}) {
  const instance = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const bounds = list.getBoundingClientRect();
      const first = list.firstElementChild?.getBoundingClientRect();
      const last = list.lastElementChild?.getBoundingClientRect();
      const next = {
        left: !!first && first.left < bounds.left,
        right: !!last && last.right > bounds.right,
      };
      setOverflow(previous => previous.left === next.left && previous.right === next.right ? previous : next);
    };
    const revealSelected = () => {
      const selected = list.querySelector<HTMLElement>('[aria-selected="true"]');
      if (selected) revealTab(selected);
      measure();
    };
    revealSelected();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(revealSelected);
    observer?.observe(list);
    for (const tab of list.children) observer?.observe(tab);
    list.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer?.disconnect();
      list.removeEventListener("scroll", measure);
    };
  }, [value, tabs.length]);

  return (
    <div className={styles["sample-tabs"]} data-variant={variant}>
      <div className={styles.tabNavigation} data-overflow-left={overflow.left || undefined} data-overflow-right={overflow.right || undefined}>
        <div ref={listRef} id={`${instance}-tabs`} role="tablist" aria-label={label}>
          {tabs.map((tab, index) => (
            <button
              type="button"
              key={tab.id}
              id={`${instance}-tab-${tab.id}`}
              role="tab"
              aria-selected={value === tab.id}
              aria-controls={`${instance}-panel-${tab.id}`}
              tabIndex={value === tab.id ? 0 : -1}
              onFocus={(event) => revealTab(event.currentTarget)}
              onClick={() => onChange(tab.id)}
              onKeyDown={(event) => {
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? tabs.length - 1
                      : event.key === "ArrowRight"
                        ? (index + 1) % tabs.length
                        : event.key === "ArrowLeft"
                          ? (index + tabs.length - 1) % tabs.length
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                onChange(tabs[next].id);
                document
                  .getElementById(`${instance}-tab-${tabs[next].id}`)
                  ?.focus({ preventScroll: true });
              }}
            >
              {tab.title}
            </button>
          ))}
        </div>
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`${instance}-panel-${tab.id}`}
          role="tabpanel"
          aria-labelledby={`${instance}-tab-${tab.id}`}
          hidden={value !== tab.id}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
