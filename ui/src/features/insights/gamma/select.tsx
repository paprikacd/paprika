"use client";

// Select-only adaptation of Gamma SearchCombobox and ActionMenu. See README.md.
import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "lucide-react";
import styles from "./controls.module.css";
import theme from "./gamma-theme.module.css";
import { useFloatingPanel } from "./use-floating-panel";
import { nativeControlDisabled } from "./native-control-disabled";

export interface GammaSelectOption {
  value: string;
  label: string;
  description?: string;
  accessibleLabel?: string;
  /** Decorative identity; visible in the trigger and option list. */
  icon?: ReactNode;
  /** Non-interactive supporting content, such as tags and metadata. */
  details?: ReactNode;
  /** Compact supporting context retained when this option is selected. */
  selectedDetails?: ReactNode;
  disabled?: boolean;
  keywords?: readonly string[];
}
export interface GammaSelectProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "value" | "onChange" | "children" | "size"
> {
  value: string;
  options: readonly GammaSelectOption[];
  onValueChange: (value: string) => void;
  size?: "sm" | "md";
  placeholder?: string;
  searchable?: boolean;
}

export function GammaSelect({
  value,
  options,
  onValueChange,
  size = "md",
  placeholder = "Choose an option",
  searchable = false,
  disabled,
  name,
  className = "",
  onKeyDown,
  onClick,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...props
}: GammaSelectProps) {
  const id = useId(),
    listId = `${id}-list`;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<string, HTMLLIElement>());
  const typeahead = useRef({ value: "", at: 0 });
  const [isOpen, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeValue, setActiveValue] = useState<string | null>(null);
  const open = isOpen && !disabled;
  if (disabled && isOpen) setOpen(false);
  const selected = options.find((option) => option.value === value);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = options.filter(
    (option) =>
      !normalized ||
      [option.label, option.description ?? "", ...(option.keywords ?? [])].some((text) =>
        text.toLocaleLowerCase().includes(normalized),
      ),
  );
  const visible = searchable ? matches.slice(0, 100) : matches;
  const available = visible.filter((option) => !option.disabled);
  const active =
    available.find((option) => option.value === activeValue) ??
    available.find((option) => option.value === value) ??
    available[0];
  const optionId = (value: string) =>
    `${id}-option-${encodeURIComponent(value)}`;
  const dismiss = useCallback(() => setOpen(false), []);
  const portalContainer = useFloatingPanel({
    open,
    anchorRef: triggerRef,
    panelRef,
    onDismiss: dismiss,
    revision: query,
  });
  useLayoutEffect(() => {
    if (open && searchable) searchRef.current?.focus({ preventScroll: true });
  }, [open, searchable, portalContainer]);
  useLayoutEffect(() => {
    if (open && active)
      optionRefs.current
        .get(active.value)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [open, active, portalContainer]);
  function close(returnFocus = false) {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true });
  }
  function show(last = false) {
    if (disabled || nativeControlDisabled(triggerRef.current)) return;
    setQuery("");
    setActiveValue(
      (selected && !selected.disabled
        ? selected
        : last
          ? options.filter((option) => !option.disabled).at(-1)
          : options.find((option) => !option.disabled)
      )?.value ?? null,
    );
    typeahead.current = { value: "", at: 0 };
    setOpen(true);
  }
  function commit(option: GammaSelectOption) {
    if (option.disabled) return;
    if (disabled || nativeControlDisabled(triggerRef.current)) {
      close();
      return;
    }
    onValueChange(option.value);
    close(true);
  }
  function handleKey(event: KeyboardEvent<HTMLElement>, fromSearch = false) {
    if (event.defaultPrevented || event.nativeEvent.isComposing || disabled)
      return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab") {
      // Restore the trigger before the browser's native Tab movement, so a
      // portaled search field never moves focus to an unrelated page footer.
      if (fromSearch) triggerRef.current?.focus({ preventScroll: true });
      close();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) show(event.key === "ArrowUp");
      else if (available.length) {
        const index = available.findIndex(
          (option) => option.value === active?.value,
        );
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setActiveValue(
          available[(index + direction + available.length) % available.length]
            .value,
        );
      }
    } else if (
      open &&
      (event.key === "Home" || event.key === "End") &&
      (!fromSearch || event.altKey)
    ) {
      event.preventDefault();
      setActiveValue(
        (event.key === "Home" ? available[0] : available.at(-1))?.value ?? null,
      );
    } else if (event.key === "Enter" || (event.key === " " && !fromSearch)) {
      event.preventDefault();
      if (!open) show();
      else if (active) commit(active);
    } else if (
      !fromSearch &&
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      const now = event.timeStamp;
      const typed =
        (now - typeahead.current.at < 700 ? typeahead.current.value : "") +
        event.key.toLocaleLowerCase();
      typeahead.current = { value: typed, at: now };
      const repeating = [...typed].every((character) => character === typed[0]);
      const prefix = repeating ? typed[0] : typed;
      const enabled = options.filter((option) => !option.disabled);
      const start = enabled.findIndex(
        (option) => option.value === (open ? active?.value : value),
      );
      const ordered = repeating
        ? [...enabled.slice(start + 1), ...enabled.slice(0, start + 1)]
        : enabled;
      const match = ordered.find((option) =>
        option.label.toLocaleLowerCase().startsWith(prefix),
      );
      if (match) {
        if (!open) {
          setQuery("");
          setOpen(true);
        }
        setActiveValue(match.value);
      }
    }
  }
  const label = ariaLabel ?? "Choose an option";
  return (
    <>
      <button
        {...props}
        ref={triggerRef}
        type="button"
        role="combobox"
        name={undefined}
        className={`${styles.select} ${className}`}
        data-gamma-select=""
        data-size={size}
        data-placeholder={!selected || undefined}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-expanded={open}
        aria-describedby={[props["aria-describedby"], selected?.selectedDetails ? `${listId}-selected-details` : undefined].filter(Boolean).join(" ") || undefined}
        aria-haspopup="listbox"
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && !searchable && active ? optionId(active.value) : undefined
        }
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
          {selected?.icon && <span className={styles.optionIcon} aria-hidden="true">{selected.icon}</span>}
          <span className={styles.selectCopy}>
            <span className={styles.selectLabel}>{selected?.label ?? (value || placeholder)}</span>
            {selected?.selectedDetails && <span className={styles.selectedDetails} id={`${listId}-selected-details`}>{selected.selectedDetails}</span>}
          </span>
        </span>
        <ChevronDown size={15} aria-hidden="true" />
      </button>
      {name && (
        <input type="hidden" name={name} value={value} disabled={disabled} />
      )}
      {open &&
        portalContainer &&
        createPortal(
          <div
            ref={panelRef}
            className={`${theme.scope} ${styles.panel}`}
            data-gamma-portal="select"
          >
            {searchable && (
              <div className={styles.search}>
                <Search size={15} aria-hidden="true" />
                <input
                  ref={searchRef}
                  role="combobox"
                  type="text"
                  autoComplete="off"
                  placeholder="Search options…"
                  aria-label={`Search ${label.toLocaleLowerCase()}`}
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={
                    active ? optionId(active.value) : undefined
                  }
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveValue(null);
                  }}
                  onKeyDown={(event) => handleKey(event, true)}
                />
              </div>
            )}
            <ul
              id={listId}
              className={styles.list}
              role="listbox"
              aria-label={ariaLabel ? `${ariaLabel} options` : undefined}
              aria-labelledby={ariaLabel ? undefined : ariaLabelledBy}
            >
              {visible.map((option) => (
                <li
                  key={option.value}
                  id={optionId(option.value)}
                  role="option"
                  aria-label={option.accessibleLabel}
                  aria-describedby={option.accessibleLabel && (option.description || option.details) ? `${optionId(option.value)}-details` : undefined}
                  ref={(element) => {
                    if (element) optionRefs.current.set(option.value, element);
                    else optionRefs.current.delete(option.value);
                  }}
                  className={styles.option}
                  aria-selected={option.value === value}
                  aria-disabled={option.disabled || undefined}
                  data-active={active?.value === option.value || undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onPointerMove={() => {
                    if (!option.disabled) setActiveValue(option.value);
                  }}
                  onClick={() => commit(option)}
                >
                  <span className={styles.optionIdentity}>
                    {option.icon && <span className={styles.optionIcon} aria-hidden="true">{option.icon}</span>}
                    <span className={styles.optionCopy}>
                      <span>{option.label}</span>
                      <span className={styles.optionDetails} id={`${optionId(option.value)}-details`}>
                        {option.description && <small>{option.description}</small>}
                        {option.details}
                      </span>
                    </span>
                  </span>
                  <span className={styles.check} aria-hidden="true">
                    {option.value === value && <Check size={15} />}
                  </span>
                </li>
              ))}
            </ul>
            {!visible.length && (
              <div role="status" className={styles.empty}>
                No matching options.
              </div>
            )}
          </div>,
          portalContainer,
        )}
    </>
  );
}
