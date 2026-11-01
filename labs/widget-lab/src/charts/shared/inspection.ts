import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { resolveInspectionState } from './inspection-state';

/** One inspection lifecycle for compound charts. Selection never mutates source data. */
export function useInspection<T extends { id: string }>(items: T[], revision: unknown, enabled = true, externalSelection?: string, selectionKey: (item: T) => string = item => item.id) {
  const [hover, setHover] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const trigger = useRef<HTMLElement | SVGElement | null>(null);
  const returningFocus = useRef(false);
  const previous = useRef({ revision, externalSelection });
  const resolved = resolveInspectionState({ hover, pinned }, previous.current,
    { revision, externalSelection }, items, enabled, selectionKey);
  useEffect(() => {
    previous.current = { revision, externalSelection };
    if (resolved.hover !== hover) setHover(resolved.hover);
    if (resolved.pinned !== pinned) setPinned(resolved.pinned);
  }, [revision, externalSelection, hover, pinned, resolved.hover, resolved.pinned]);
  const item = enabled ? items.find(row => row.id === (resolved.pinned ?? resolved.hover)) : undefined;
  const dismiss = () => {
    setHover(null); setPinned(null);
    returningFocus.current = true;
    if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
    returningFocus.current = false;
  };
  return {
    item, hover: resolved.hover, pinned: resolved.pinned,
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
