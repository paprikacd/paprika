"use client";

import { useLayoutEffect, useState, type RefObject } from "react";
import { inheritGammaTheme } from "./inherit-theme";

/** Keep overlays inside a native modal's top layer; body siblings are inert. */
export function floatingPanelContainer(anchor: HTMLElement | null) {
  return anchor?.closest<HTMLDialogElement>("dialog[open]") ?? document.body;
}

/** Gamma positioning, extended to a modal-aware portal and visual viewport. */
export function useFloatingPanel({
  open,
  anchorRef,
  panelRef,
  onDismiss,
  revision,
  minWidth = 180,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  onDismiss: () => void;
  revision?: unknown;
  minWidth?: number;
}) {
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null,
  );
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!open || !anchor) return;
    const container = floatingPanelContainer(anchor);
    if (container !== portalContainer) setPortalContainer(container);
    if (!panel || container !== portalContainer) return;
    const stopTheme = inheritGammaTheme(anchor, panel);
    function position() {
      if (!panel || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const width =
        viewport?.width ??
        (document.documentElement.clientWidth || window.innerWidth);
      const margin = 8,
        gap = 6;
      const panelWidth = Math.min(
        Math.max(rect.width, minWidth),
        Math.max(0, width - margin * 2),
      );
      panel.style.width = `${panelWidth}px`;
      const below = top + height - rect.bottom - gap - margin;
      const above = rect.top - top - gap - margin;
      const wanted = Math.min(panel.scrollHeight || 320, 320);
      const flipped = below < wanted && above > below;
      const available = Math.max(0, flipped ? above : below);
      const panelHeight = Math.min(wanted, available);
      panel.style.maxHeight = `${Math.min(320, available)}px`;
      panel.style.left = `${Math.max(left + margin, Math.min(rect.left, left + width - panelWidth - margin))}px`;
      panel.style.top = `${Math.max(top + margin, Math.min(flipped ? rect.top - gap - panelHeight : rect.bottom + gap, top + height - panelHeight - margin))}px`;
      panel.dataset.side = flipped ? "above" : "below";
    }
    function outside(event: Event) {
      if (
        event.target instanceof Node &&
        !anchor?.contains(event.target) &&
        !panel?.contains(event.target)
      )
        onDismiss();
    }
    position();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(position)
        : null;
    observer?.observe(anchor);
    observer?.observe(panel);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside);
    return () => {
      stopTheme();
      observer?.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside);
    };
  }, [
    open,
    anchorRef,
    panelRef,
    onDismiss,
    revision,
    minWidth,
    portalContainer,
  ]);
  return portalContainer;
}
