import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { ChartTooltip } from '../../renderer-extensions/chart-tooltip';
import { useLabMotion } from './motion';
import './DomainPrimitives.css';

/** Shared chart inspector chrome; exact evidence remains owned by its chart. */
export function DomainInspector({ title, children, onClose, pinned = true }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  pinned?: boolean;
}) {
  const { reduced } = useLabMotion();
  return <ChartTooltip pinned={pinned} onClose={onClose} label={`${title} details`}>
    <section className="domain-inspector" data-pinned={pinned} data-motion={reduced ? 'reduced' : 'auto'} aria-label={`${title} details`}>
      <header><div><small>{pinned ? 'Selected evidence' : 'Inspecting · click or Enter to pin'}</small><strong>{title}</strong></div>
        <button aria-label={`Close ${title} details`} onClick={onClose}><X size={14}/></button>
      </header>
      {children}
    </section>
  </ChartTooltip>;
}
