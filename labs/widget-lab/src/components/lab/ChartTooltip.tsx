import { cloneElement, useId, type CSSProperties, type ReactElement } from 'react';
import { ObservationTooltip } from '../../renderer-extensions/observation-tooltip';
import type { TooltipDismissReason } from '../../renderer-extensions/tooltip-focus';
import './ChartTooltip.css';

type InspectorBody = {
  style?: CSSProperties;
  'aria-label'?: string;
  'data-tooltip-content'?: string;
};

/** Chart families own exact content; the canonical popup owns position and bounds. */
export function ChartTooltip({ children, pinned, onClose, onLeave, label }: {
  children: ReactElement<InspectorBody>;
  pinned: boolean;
  onClose: (reason?: TooltipDismissReason) => void;
  onLeave?: () => void;
  label?: string;
}) {
  const id = useId();
  return <ObservationTooltip id={id} pinned={pinned} onDismiss={onClose}
    onLeave={onLeave} label={label ?? children.props['aria-label']} className="lab-chart-tooltip">
    {cloneElement(children, {
      'data-tooltip-content': '',
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
  </ObservationTooltip>;
}
