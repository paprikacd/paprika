"use client";

// Adapted from Gamma src/components/ActionMenu.tsx. See README.md.
import {
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, MoreHorizontal } from "lucide-react";
import { GammaButton } from "./button";
import { useFloatingPanel } from "./use-floating-panel";
import { nativeControlDisabled } from "./native-control-disabled";
import styles from "./controls.module.css";
import theme from "./gamma-theme.module.css";

export interface GammaActionMenuItem {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  danger?: boolean;
  selected?: boolean;
  icon?: ReactNode;
  onSelect: () => void;
}

export function GammaActionMenu({
  label = "Actions",
  trigger,
  items,
  className,
  disabled = false,
}: {
  label?: string;
  trigger?: ReactNode;
  items: readonly GammaActionMenuItem[];
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  const [isOpen, setOpen] = useState(false);
  const open = isOpen && !disabled;
  if (disabled && isOpen) setOpen(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const lastOnOpen = useRef(false);
  const typed = useRef({ value: "", at: 0 });
  const dismiss = useCallback(() => setOpen(false), []);
  const portalContainer = useFloatingPanel({
    open,
    anchorRef: triggerRef,
    panelRef,
    onDismiss: dismiss,
    minWidth: 240,
  });
  useLayoutEffect(() => {
    if (!open) return;
    const buttons = panelRef.current?.querySelectorAll<HTMLButtonElement>(
      "button:not([aria-disabled=true])",
    );
    const target = lastOnOpen.current
      ? buttons?.[buttons.length - 1]
      : buttons?.[0];
    target?.focus({ preventScroll: true });
  }, [open, portalContainer]);
  function close(restore = true) {
    setOpen(false);
    if (restore) triggerRef.current?.focus({ preventScroll: true });
  }
  function show(last = false) {
    lastOnOpen.current = last;
    typed.current = { value: "", at: 0 };
    setOpen(true);
  }
  return (
    <>
      <GammaButton
        ref={triggerRef}
        variant="ghost"
        size="sm"
        iconOnly
        className={className}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.key === "ArrowUp");
          }
        }}
      >
        {trigger ?? <MoreHorizontal size={16} aria-hidden="true" />}
      </GammaButton>
      {open &&
        portalContainer &&
        createPortal(
          <div
            ref={panelRef}
            id={id}
            className={`${theme.scope} ${styles.panel} ${styles.menu}`}
            role="menu"
            aria-label={label}
            data-gamma-portal="menu"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                close();
                return;
              }
              if (event.key === "Tab") {
                triggerRef.current?.focus({ preventScroll: true });
                close(false);
                return;
              }
              const buttons = [
                ...(panelRef.current?.querySelectorAll<HTMLButtonElement>(
                  "button:not([aria-disabled=true])",
                ) ?? []),
              ];
              if (!buttons.length) return;
              const current = buttons.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : event.key === "ArrowDown"
                      ? (current + 1) % buttons.length
                      : event.key === "ArrowUp"
                        ? (current - 1 + buttons.length) % buttons.length
                        : -1;
              if (next >= 0) {
                event.preventDefault();
                buttons[next].focus();
                return;
              }
              if (
                event.key.length === 1 &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey &&
                event.key !== " "
              ) {
                const now = event.timeStamp;
                const prefix =
                  (now - typed.current.at < 700 ? typed.current.value : "") +
                  event.key.toLocaleLowerCase();
                typed.current = { value: prefix, at: now };
                const matches = [...prefix].every(
                  (character) => character === prefix[0],
                )
                  ? prefix[0]
                  : prefix;
                const ordered = [
                  ...buttons.slice(current + 1),
                  ...buttons.slice(0, current + 1),
                ];
                ordered
                  .find((button) =>
                    button.dataset.label
                      ?.toLocaleLowerCase()
                      .startsWith(matches),
                  )
                  ?.focus();
                event.preventDefault();
              }
            }}
          >
            {items.map((item) => (
              <button
                type="button"
                key={item.id}
                tabIndex={-1}
                role={
                  item.selected === undefined ? "menuitem" : "menuitemradio"
                }
                aria-checked={item.selected}
                aria-disabled={item.disabled || undefined}
                data-label={item.label}
                data-danger={item.danger || undefined}
                className={`${styles.option} ${styles.menuItem}`}
                onClick={() => {
                  if (!item.disabled) {
                    if (nativeControlDisabled(triggerRef.current)) {
                      close(false);
                      return;
                    }
                    close();
                    item.onSelect();
                  }
                }}
              >
                {item.icon && <span aria-hidden="true">{item.icon}</span>}
                <span className={styles.menuCopy}>
                  <span>{item.label}</span>
                  {item.description && <small>{item.description}</small>}
                </span>
                {item.selected && <Check size={14} aria-hidden="true" />}
              </button>
            ))}
            {!items.length && (
              <div className={styles.empty}>No actions available.</div>
            )}
          </div>,
          portalContainer,
        )}
    </>
  );
}
