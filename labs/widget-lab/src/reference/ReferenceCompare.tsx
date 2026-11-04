import { useEffect, useRef, useState } from 'react';
import './ReferenceCompare.css';

export interface ReferenceCompareProps {
  study: 'edge' | 'reliability';
  onClose: () => void;
}

/** An opt-in registered source overlay; never part of the dashboard rendering. */
export function ReferenceCompare({ study, onClose }: ReferenceCompareProps) {
  const [opacity, setOpacity] = useState(50);
  const [visible, setVisible] = useState(true);
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const returnTarget = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onCloseRef.current();
    };
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
      if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
    };
  }, []);

  const source = study === 'edge' ? 'edge-watch.png' : 'reliability-room.png';
  return <>
    <div className="ref-compare-source" aria-hidden="true" style={{ opacity: visible ? opacity / 100 : 0 }}>
      <img src={`${import.meta.env.BASE_URL}reference/${source}`} width={1592} height={988} alt="" draggable={false}/>
    </div>
    <section className="ref-compare-controls" aria-label="Reference comparison controls">
      <div className="ref-compare-heading"><h2>Reference comparison</h2><button ref={closeButton} className="ref-compare-close" type="button" onClick={onClose} aria-label="Close reference comparison" title="Close comparison (Escape)">×</button></div>
      <label className="ref-compare-label" htmlFor="ref-source-opacity">Source overlay <output htmlFor="ref-source-opacity">{visible ? opacity : 0}%</output></label>
      <input id="ref-source-opacity" type="range" min={0} max={100} step={1} value={opacity} aria-valuetext={`${opacity}% source opacity${visible ? '' : ', source hidden'}`} aria-describedby="ref-source-explanation" title="0% shows the implementation. 100% shows the supplied reference. This is an opacity control, not a fidelity score." onChange={event => { setOpacity(Number(event.target.value)); setVisible(true); }}/>
      <div className="ref-compare-endpoints" aria-hidden="true"><span>Implementation</span><span>Reference</span></div>
      <div className="ref-compare-actions"><span id="ref-source-explanation">Same 1592 × 988 canvas</span><button type="button" onClick={() => setVisible(value => !value)} aria-pressed={visible}>{visible ? 'Hide source' : 'Show source'}</button></div>
    </section>
  </>;
}
