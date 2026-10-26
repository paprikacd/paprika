// Adapted from Gamma src/components/GammaTabs.tsx; see README.md.
import { useId, type ReactNode } from "react";
import styles from "./gamma.module.css";

export function GammaTabs({
  label,
  tabs,
  value,
  onChange,
}: {
  label: string;
  tabs: { id: string; title: string; content: ReactNode }[];
  value: string;
  onChange: (id: string) => void;
}) {
  const instance = useId();
  return (
    <div className={styles["sample-tabs"]}>
      <div role="tablist" aria-label={label}>
        {tabs.map((tab, index) => (
          <button
            type="button"
            key={tab.id}
            id={`${instance}-tab-${tab.id}`}
            role="tab"
            aria-selected={value === tab.id}
            aria-controls={`${instance}-panel-${tab.id}`}
            tabIndex={value === tab.id ? 0 : -1}
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
                ?.focus();
            }}
          >
            {tab.title}
          </button>
        ))}
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
