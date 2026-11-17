import { ChartWindowControls, useChartWindowSelection, type ChartWindowState } from '@insights/chart-window-controls';
import './lab-window-controls.css';

/**
 * Production's chart window (the handles, Apply, Undo and Reset) with the lab's scope note beside it. Production
 * states the zoom but not which series it changes, and each lab plot says so, so the note stays.
 */
export function LabWindowControls({ state, description }: { state: ChartWindowState; description?: string }) {
  const selection = useChartWindowSelection(state);
  return <div className="lab-window-controls">
    <ChartWindowControls state={state} selection={selection} />
    {description && <p className="lab-window-scope">{description}</p>}
  </div>;
}
