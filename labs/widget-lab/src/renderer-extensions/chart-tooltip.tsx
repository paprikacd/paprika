import { cloneElement, useLayoutEffect, useId, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { ObservationTooltip } from '@insights/observation-tooltip';
import type { TooltipDismissReason } from '@insights/tooltip-focus';
import type { TooltipPlacementOptions } from '@insights/tooltip-position';
import './chart-tooltip.css';

type InspectorBody = {
  style?: CSSProperties;
  'aria-label'?: string;
  'data-tooltip-content'?: string;
  'data-lab-inspector'?: string;
};

/** Whether a target sits in a lab inspector. Focus moving between a chart and its own inspector is not a dismissal. */
export function isInspectorTarget(target: EventTarget | null | undefined): boolean {
  return typeof Element !== 'undefined' && target instanceof Element && !!target.closest('[data-lab-inspector]');
}

/**
 * A lab family's inspector, drawn by production's observation owner: one panel per scope, the Escape stack, focus
 * restore and the page-wide single preview all come from ObservationTooltip. The family supplies the content only.
 *
 * Production requires an anchor element, and the lab's families do not pass one. The hidden marker below
 * the family's own markup finds it: the anchor is the element the inspector is mounted in.
 */
export function ChartTooltip({ children, pinned, onClose, onLeave, label, options }: {
  children: ReactElement<InspectorBody>;
  pinned: boolean;
  onClose: (reason?: TooltipDismissReason) => void;
  onLeave?: () => void;
  label?: string;
  options?: TooltipPlacementOptions;
}) {
  const id = useId();
  const marker = useRef<HTMLSpanElement>(null);
  const [anchor, setAnchor] = useState<Element | null>(null);
  useLayoutEffect(() => {
    const host = marker.current?.parentElement ?? null;
    if (host !== anchor) setAnchor(host);
  });
  return <>
    <span ref={marker} hidden aria-hidden="true" data-inspector-anchor="" />
    {anchor && <ObservationTooltip id={id} anchor={anchor} pinned={pinned} role={pinned ? 'region' : 'tooltip'}
      ariaLabel={label ?? children.props['aria-label']} className="lab-chart-tooltip" options={options}
      onDismiss={onClose} onLeave={onLeave}>
      {cloneElement(children, {
        'data-tooltip-content': '',
        'data-lab-inspector': '',
        // Retained family styles describe content, never a second positioning system.
        style: {
          ...children.props.style,
          position: 'relative', inset: 'auto', width: '100%', height: 'auto', minWidth: 0,
          maxWidth: 'none', maxHeight: 'none', margin: 0, padding: 0,
          border: 0, borderRadius: 0, boxShadow: 'none', background: 'transparent',
          boxSizing: 'border-box', animation: 'none', transform: 'none',
          pointerEvents: 'auto', overflow: 'visible',
        },
      })}
    </ObservationTooltip>}
  </>;
}
