"use client";

// Several-value adaptation of GammaSelect. The panel, trigger and list use the same classes. Values are committed
// once when the panel closes, so a dashboard re-queries once per choice rather than once per checkbox.
import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Search, Square, SquareCheck } from "lucide-react";
import styles from "./controls.module.css";
import theme from "./gamma-theme.module.css";
import { useFloatingPanel } from "./use-floating-panel";
import { nativeControlDisabled } from "./native-control-disabled";
import type { GammaSelectOption } from "./select";
import { formatVariableValue, sameVariableValue } from "../variable-values";

/** The row that stands for All: no value is picked, so every value is included. */
const ALL_ROW = "\u0000all";

export interface GammaMultiSelectProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "onChange" | "children" | "size"
> {
  /** The committed values, in option order. An empty list is All when allowAll is on. */
  values: readonly string[];
  options: readonly GammaSelectOption[];
  /** Adds an All row. Unchecking the last value then gives All; without it the last value stays checked. */
  allowAll?: boolean;
  onValuesChange: (values: string[]) => void;
  /** Called when the panel opens, for a sourced variable that loads its values on demand. */
  onOpen?: () => void;
  size?: "sm" | "md";
  placeholder?: string;
  searchable?: boolean;
}

function orderedValues(rows: readonly string[], picked: readonly string[]): string[] {
  return rows.filter((row) => picked.includes(row));
}

export function GammaMultiSelect({
  values,
  options,
  allowAll = false,
  onValuesChange,
  onOpen,
  size = "md",
  placeholder = "Choose values",
  searchable = false,
  disabled,
  className = "",
  onKeyDown,
  onClick,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: GammaMultiSelectProps) {
  const id = useId(),
    listId = `${id}-list`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [isOpen, setOpen] = useState(false);
  // The picks while the panel is open. They reach the caller once, on close.
  const [draft, setDraft] = useState<string[]>([]);
  // Values the list does not declare are kept as rows, so a value a source no longer returns can still be cleared.
  const [extras, setExtras] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [activeRow, setActiveRow] = useState<string | null>(null);
  const open = isOpen && !disabled;
  if (disabled && isOpen) setOpen(false);

  const normalized = query.trim().toLocaleLowerCase();
  const declared = options.map((option) => option.value);
  // A sourced list can finish loading while the panel is open, so an extra may since have become a declared row.
  const rows = [...declared, ...extras.filter((value) => !declared.includes(value))];
  const matchesQuery = (value: string) => {
    if (!normalized) return true;
    const option = options.find((item) => item.value === value);
    return [option?.label ?? value, option?.description ?? "", ...(option?.keywords ?? [])].some((text) =>
      text.toLocaleLowerCase().includes(normalized),
    );
  };
  const visible = (searchable ? rows.filter(matchesQuery).slice(0, 100) : rows);
  const available = [...(allowAll && !normalized ? [ALL_ROW] : []), ...visible];
  const active = available.find((row) => row === activeRow) ?? available[0];
  const rowId = (row: string) => `${id}-option-${encodeURIComponent(row)}`;
  const isChecked = (row: string) => (row === ALL_ROW ? draft.length === 0 : draft.includes(row));

  // Closing commits the picks once, in row order, and only when they differ from the committed values.
  const finish = useCallback(() => {
    setOpen(false);
    const listed = options.map((option) => option.value);
    const next = orderedValues([...listed, ...extras.filter((value) => !listed.includes(value))], draft);
    if (!sameVariableValue(next, [...values])) onValuesChange(next);
  }, [draft, extras, options, values, onValuesChange]);

  const portalContainer = useFloatingPanel({
    open,
    anchorRef: triggerRef,
    panelRef,
    onDismiss: finish,
    revision: query,
    // Wider than a narrow trigger, so typical values fit on their one row.
    minWidth: 240,
  });
  useLayoutEffect(() => {
    if (open && searchable) searchRef.current?.focus({ preventScroll: true });
  }, [open, searchable, portalContainer]);

  function show() {
    if (disabled || nativeControlDisabled(triggerRef.current)) return;
    setQuery("");
    setDraft([...values]);
    setExtras(values.filter((value) => !declared.includes(value)));
    setActiveRow(allowAll && values.length === 0 ? ALL_ROW : (declared[0] ?? null));
    setOpen(true);
    onOpen?.();
  }
  function close(returnFocus = false) {
    finish();
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }
  function toggle(row: string) {
    if (row === ALL_ROW) {
      setDraft([]);
      return;
    }
    setDraft((current) => {
      if (current.includes(row)) {
        const next = current.filter((value) => value !== row);
        // Without All, the last value stays checked: an empty list would be All, which needs Include All.
        return next.length === 0 && !allowAll ? current : next;
      }
      return [...current, row];
    });
  }

  function handleKey(event: KeyboardEvent<HTMLElement>, fromSearch = false) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || disabled) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      if (fromSearch) triggerRef.current?.focus({ preventScroll: true });
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) show();
      else if (available.length) {
        const index = available.indexOf(active ?? "");
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveRow(available[(index + direction + available.length) % available.length]);
      }
    } else if (event.key === "Enter" || (event.key === " " && !fromSearch)) {
      event.preventDefault();
      if (!open) show();
      else if (active) toggle(active);
    }
  }

  // The trigger names picks by their labels, so an empty-string value reads "Empty value", not a blank.
  const labels = values.map((value) => options.find((option) => option.value === value)?.label ?? (value || "Empty value"));
  const triggerValue = formatVariableValue(labels, "All");
  const fullText = labels.join(", ");
  const label = ariaLabel ?? "Choose values";
  return (
    <>
      <button
        {...props}
        ref={triggerRef}
        type="button"
        role="combobox"
        className={`${styles.select} ${className}`}
        data-gamma-select=""
        data-gamma-multi=""
        data-size={size}
        data-placeholder={values.length === 0 && !allowAll ? true : undefined}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={!searchable && open && active ? rowId(active) : undefined}
        onClick={(event) => {
          onClick?.(event);
          if (!event.defaultPrevented) {
            if (open) close();
            else show();
          }
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          handleKey(event);
        }}
      >
        <span className={styles.selectValue}>
          <span className={styles.selectCopy}>
            {/* A count or a truncated value keeps its full text as a title. */}
            <span className={styles.selectLabel} title={values.length ? fullText : undefined}>
              {values.length || allowAll ? triggerValue : placeholder}
            </span>
          </span>
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {open &&
        portalContainer &&
        createPortal(
          <div ref={panelRef} className={`${theme.scope} ${styles.panel}`} data-gamma-portal="select">
            {searchable && (
              <div className={styles.search}>
                <Search size={15} aria-hidden="true" />
                <input
                  ref={searchRef}
                  role="combobox"
                  type="text"
                  autoComplete="off"
                  placeholder="Search values…"
                  aria-label={`Search ${label.toLocaleLowerCase()}`}
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={active ? rowId(active) : undefined}
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveRow(null);
                  }}
                  onKeyDown={(event) => handleKey(event, true)}
                />
              </div>
            )}
            <ul
              id={listId}
              className={styles.list}
              role="listbox"
              aria-multiselectable="true"
              aria-label={ariaLabel ? `${ariaLabel} options` : undefined}
              aria-labelledby={ariaLabel ? undefined : ariaLabelledBy}
            >
              {available.map((row) => {
                const option = options.find((item) => item.value === row);
                const isAll = row === ALL_ROW;
                const text = isAll ? "All" : (option?.label ?? row);
                return (
                  <li
                    key={row}
                    id={rowId(row)}
                    role="option"
                    aria-selected={isChecked(row)}
                    aria-label={isAll ? undefined : option?.accessibleLabel}
                    className={styles.option}
                    data-active={active === row || undefined}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerMove={() => setActiveRow(row)}
                    onClick={() => toggle(row)}
                  >
                    <span className={styles.optionIdentity}>
                      <span className={styles.optionCopy}>
                        {/* One row per value: a long value ends in an ellipsis and keeps its full text as a title. */}
                        <span className={styles.optionLine} title={text}>{text}</span>
                        {!isAll && option?.description && (
                          <span className={styles.optionDetails}>
                            <small>{option.description}</small>
                          </span>
                        )}
                        {!isAll && !option && <small>Not in the list</small>}
                      </span>
                    </span>
                    <span className={styles.check} aria-hidden="true">
                      {isChecked(row) ? <SquareCheck size={15} /> : <Square size={15} />}
                    </span>
                  </li>
                );
              })}
            </ul>
            {!available.length && (
              <div role="status" className={styles.empty}>
                No matching values.
              </div>
            )}
          </div>,
          portalContainer,
        )}
    </>
  );
}
