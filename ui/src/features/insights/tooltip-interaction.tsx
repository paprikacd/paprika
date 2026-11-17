"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * The panel owner of one widget. A pinned owner outranks transient previews
 * in the same scope; pinning another observation replaces it.
 */
export interface TooltipScopeStore {
  /** The token holding the scope's panel, or null. Stable across renders for useSyncExternalStore. */
  getOwner: () => symbol | null;
  subscribe: (listener: () => void) => () => void;
  /**
   * Claims the panel for a token. A transient claim fails while a different
   * pinned owner holds the scope. Any other claim retires the previous owner,
   * which is dismissed as superseded.
   */
  claim: (token: symbol, pinned: boolean, retire: () => void) => boolean;
  /** Frees the panel when its owner unmounts. */
  release: (token: symbol) => void;
}

export function createTooltipScopeStore(): TooltipScopeStore {
  let current: { token: symbol; pinned: boolean; retire: () => void } | null = null;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of listeners) listener(); };
  return {
    getOwner: () => current?.token ?? null,
    subscribe: listener => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    claim: (token, pinned, retire) => {
      if (current?.token === token) {
        current.pinned = pinned;
        current.retire = retire;
        return true;
      }
      if (current?.pinned && !pinned) return false;
      const previous = current;
      current = { token, pinned, retire };
      notify();
      previous?.retire();
      return true;
    },
    release: token => {
      if (current?.token !== token) return;
      current = null;
      notify();
    },
  };
}

const ProvidedScope = createContext<TooltipScopeStore | null>(null);
const dashboardScopes = new WeakMap<Element, TooltipScopeStore>();

/** The scope the nearest WidgetTooltipProvider supplies, or null. */
export const useProvidedTooltipScope = () => useContext(ProvidedScope);

/**
 * The scope an anchor belongs to: the nearest provider, else its dashboard
 * widget (`data-widget-id`), else the anchor alone, which has no rivals.
 */
export function tooltipScopeFor(anchor: Element, provided: TooltipScopeStore | null): TooltipScopeStore {
  if (provided) return provided;
  const host = anchor.closest("[data-widget-id]") ?? anchor;
  const existing = dashboardScopes.get(host);
  if (existing) return existing;
  const created = createTooltipScopeStore();
  dashboardScopes.set(host, created);
  return created;
}

/** Gives every observation tooltip beneath it one shared panel owner. It renders no DOM of its own. */
export function WidgetTooltipProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => createTooltipScopeStore(), []);
  return <ProvidedScope.Provider value={store}>{children}</ProvidedScope.Provider>;
}

/** The token of the observation panel whose content is rendering, so an inspector inside it nests under it. */
export const TooltipOwnerContext = createContext<symbol | null>(null);

// A nested inspector portals to the body, outside its parent's DOM, so the parent records it here.
const nestedPanels = new Map<symbol, { token: symbol; element: Element }[]>();

/** Records a panel rendered inside another owner's content. Returns the function that removes it. */
export function registerNestedPanel(parent: symbol, token: symbol, element: Element): () => void {
  const entry = { token, element };
  nestedPanels.set(parent, [...(nestedPanels.get(parent) ?? []), entry]);
  return () => {
    const remaining = (nestedPanels.get(parent) ?? []).filter(candidate => candidate !== entry);
    if (remaining.length) nestedPanels.set(parent, remaining);
    else nestedPanels.delete(parent);
  };
}

/** True when a node lies in a panel nested under the owner, at any depth. */
export function isInNestedPanel(owner: symbol, node: Node): boolean {
  return (nestedPanels.get(owner) ?? []).some(entry => entry.element.contains(node) || isInNestedPanel(entry.token, node));
}

type EscapeHandler = (event: KeyboardEvent) => void;
const escapeStack: { token: symbol; handle: EscapeHandler }[] = [];
let escapeListening = false;

// Escape acts on the topmost open panel only, so one press closes one panel.
const onEscapeKey = (event: KeyboardEvent) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  escapeStack[escapeStack.length - 1]?.handle(event);
};

/** Adds a panel to the Escape stack. The returned function removes it. */
export function registerTooltipEscape(token: symbol, handle: EscapeHandler): () => void {
  const entry = { token, handle };
  escapeStack.push(entry);
  if (!escapeListening && typeof document !== "undefined") {
    document.addEventListener("keydown", onEscapeKey, true);
    escapeListening = true;
  }
  return () => {
    const index = escapeStack.indexOf(entry);
    if (index >= 0) escapeStack.splice(index, 1);
    if (!escapeStack.length && escapeListening) {
      document.removeEventListener("keydown", onEscapeKey, true);
      escapeListening = false;
    }
  };
}

/** Moves a panel to the top of the stack when the user works in it, so the next Escape closes that panel. */
export function raiseTooltipEscape(token: symbol) {
  const index = escapeStack.findIndex(entry => entry.token === token);
  if (index >= 0 && index < escapeStack.length - 1) escapeStack.push(...escapeStack.splice(index, 1));
}
