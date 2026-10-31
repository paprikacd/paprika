import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

/** One inspection lifecycle for compound charts. Selection never mutates source data. */
export function useInspection<T extends { id: string }>(items: T[], revision: unknown, enabled = true, externalSelection?: string, selectionKey: (item: T) => string = item => item.id) {
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | SVGElement | null>(null);
  const returningFocus = useRef(false);
  const previous = useRef({ revision, externalSelection });
  const current = useRef({ items, selectionKey });
  current.current = { items, selectionKey };
  useEffect(() => {
    const selectionChanged = previous.current.externalSelection !== externalSelection;
    const sourceChanged = previous.current.revision !== revision;
    previous.current = { revision, externalSelection };
    if (!selectionChanged && !sourceChanged) return;
    setHover(null);
    // A mark click may be echoed by a linked host. Keep that exact pin; a
    // different external selection or a new source revision dismisses it.
    setPinned(id => {
      const item = current.current.items.find(row => row.id === id);
      return selectionChanged && item && externalSelection !== undefined && current.current.selectionKey(item) === externalSelection ? id : null;
    });
  }, [revision, externalSelection]);
  useEffect(() => { if (!enabled) { setHover(null); setPinned(null); } }, [enabled]);
  const item = enabled ? items.find(row => row.id === (pinned ?? hover)) : undefined;
  const dismiss = () => {
    setHover(null); setPinned(null);
    returningFocus.current = true;
    if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
    returningFocus.current = false;
  };
  return {
    item, hover, pinned,
    setHover: (id: string | null) => { if (!returningFocus.current && (enabled || id === null)) setHover(id); },
    select: (id: string, target?: HTMLElement | SVGElement) => {
      if (!enabled || !items.some(row => row.id === id)) return;
      if (target) trigger.current = target;
      setPinned(id);
    },
    dismiss,
    onKeyDown: (event: KeyboardEvent<HTMLElement | SVGElement>) => {
      if (event.key === 'Escape' && (pinned || hover)) {
        event.preventDefault(); event.stopPropagation(); dismiss();
      }
    },
  };
}
