import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

/**
 * Lab-only, route-local freeform layout editing. The source dashboards keep
 * their authored CSS grids and their data contracts. Offsets are applied as
 * individual CSS translates, so a chart's own transforms are never replaced.
 */
export type PanelLayoutEdit = {
  x: number;
  y: number;
  width?: number;
  height?: number;
};
export type DashboardLayoutEdits = Record<string, PanelLayoutEdit>;

type OriginalStyle = {
  position: string;
  translate: string;
  width: string;
  height: string;
  zIndex: string;
};

type TrackedPanel = {
  id: string;
  original: OriginalStyle;
};

const PANEL_SELECTOR = [
  '.ref-edge-metric',
  '.ref-rel-metric',
  '.ref-panel',
  '.lab-panel',
  '.lab-kpi',
  '.finance-panel',
  '.domain-metrics > section',
  '.catalog-chart-body',
].join(', ');

const GRID = 8;
const snap = (value: number) => Math.round(value / GRID) * GRID;
const isPanelLayout = (entry: PanelLayoutEdit) =>
  Boolean(entry.x || entry.y || entry.width || entry.height);

export function updatePanelLayout(
  previous: DashboardLayoutEdits,
  id: string,
  next: PanelLayoutEdit,
): DashboardLayoutEdits {
  if (!isPanelLayout(next)) {
    if (!(id in previous)) return previous;
    const copy = { ...previous };
    delete copy[id];
    return copy;
  }
  return { ...previous, [id]: next };
}

function titleFor(panel: HTMLElement): string {
  return panel.getAttribute('aria-label')
    || panel.querySelector<HTMLElement>(':scope > header h2, :scope > header .lab-panel-title h2')?.textContent?.trim()
    || panel.querySelector<HTMLElement>('[data-widget-panel-actions]')?.getAttribute('data-widget-panel-actions')
    || 'widget';
}

/** A useful conservative fallback for this preview's fixed reference artboards. */
function panelScale(panel: HTMLElement): number {
  const width = panel.getBoundingClientRect().width;
  return panel.offsetWidth > 0 && width > 0 ? width / panel.offsetWidth : 1;
}

function applyPanel(panel: HTMLElement, tracked: TrackedPanel, layout?: PanelLayoutEdit) {
  const { original } = tracked;
  panel.style.translate = layout && (layout.x || layout.y)
    ? String(layout.x) + 'px ' + String(layout.y) + 'px'
    : original.translate;
  // The reference's responsive CSS deliberately uses width:auto!important.
  // A user resize must win that rule, while reset restores the original CSS.
  panel.style.setProperty('width', layout?.width ? String(layout.width) + 'px' : original.width, layout?.width ? 'important' : '');
  panel.style.setProperty('height', layout?.height ? String(layout.height) + 'px' : original.height, layout?.height ? 'important' : '');
  panel.style.zIndex = layout ? '8' : original.zIndex;
}

/**
 * Works across reference, analytical and domain lenses without forcing their
 * heterogeneous authored panels into a second competing grid renderer.
 * Handles only exist in edit mode, and are scoped to the demo document.
 */
export function useDashboardLayoutEditing(
  editMode: boolean,
  edits: DashboardLayoutEdits,
  setEdits: Dispatch<SetStateAction<DashboardLayoutEdits>>,
) {
  const trackedRef = useRef(new Map<HTMLElement, TrackedPanel>());
  const editsRef = useRef(edits);

  useEffect(() => {
    editsRef.current = edits;
    for (const [panel, tracked] of trackedRef.current) {
      if (panel.isConnected) applyPanel(panel, tracked, edits[tracked.id]);
    }
  }, [edits]);

  useEffect(() => {
    if (!editMode) return;

    let scheduled = false;
    let observer: MutationObserver | undefined;
    const tracked = trackedRef.current;

    const createControl = (panel: HTMLElement, record: TrackedPanel, mode: 'move' | 'resize') => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dashboard-layout-control dashboard-layout-' + mode;
      button.dataset.layoutControl = mode;
      button.textContent = mode === 'move' ? '⠿ Move' : '◢';
      const label = titleFor(panel);
      button.setAttribute('aria-label', (mode === 'move' ? 'Move ' : 'Resize ') + label);
      button.title = mode === 'move'
        ? 'Drag to reposition. Arrow keys nudge by 8px (Shift: 32px); Alt+arrows resize.'
        : 'Drag to resize. Arrow keys resize by 8px (Shift: 32px).';
      button.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight');

      const commit = (next: PanelLayoutEdit) => {
        setEdits(previous => updatePanelLayout(previous, record.id, next));
      };

      button.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const amount = event.shiftKey ? 32 : GRID;
        const dx = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0;
        const dy = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0;
        const current = editsRef.current[record.id] ?? { x: 0, y: 0 };
        const resize = mode === 'resize' || event.altKey;
        const next: PanelLayoutEdit = resize
          ? {
              ...current,
              width: Math.max(180, (current.width ?? panel.offsetWidth) + dx),
              height: Math.max(72, (current.height ?? panel.offsetHeight) + dy),
            }
          : { ...current, x: current.x + dx, y: current.y + dy };
        editsRef.current = updatePanelLayout(editsRef.current, record.id, next);
        applyPanel(panel, record, next);
        commit(next);
      });

      button.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        const start = editsRef.current[record.id] ?? { x: 0, y: 0 };
        const scale = panelScale(panel);
        const width = panel.offsetWidth;
        const height = panel.offsetHeight;
        const originX = event.clientX, originY = event.clientY;
        let next: PanelLayoutEdit = { ...start };
        let active = true;
        panel.dataset.layoutInteracting = mode;
        button.setPointerCapture(event.pointerId);

        const moving = (moveEvent: PointerEvent) => {
          if (!active || moveEvent.pointerId !== event.pointerId) return;
          const dx = snap((moveEvent.clientX - originX) / scale);
          const dy = snap((moveEvent.clientY - originY) / scale);
          if (mode === 'move') {
            next = { ...start, x: start.x + dx, y: start.y + dy };
          } else {
            next = {
              ...start,
              width: Math.max(180, snap(width + dx)),
              height: Math.max(72, snap(height + dy)),
            };
          }
          applyPanel(panel, record, next);
        };

        const end = (endEvent: PointerEvent) => {
          if (!active || endEvent.pointerId !== event.pointerId) return;
          active = false;
          delete panel.dataset.layoutInteracting;
          button.removeEventListener('pointermove', moving);
          button.removeEventListener('pointerup', end);
          button.removeEventListener('pointercancel', cancel);
          if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
          editsRef.current = updatePanelLayout(editsRef.current, record.id, next);
          commit(next);
        };

        const cancel = (cancelEvent: PointerEvent) => {
          if (!active || cancelEvent.pointerId !== event.pointerId) return;
          active = false;
          delete panel.dataset.layoutInteracting;
          button.removeEventListener('pointermove', moving);
          button.removeEventListener('pointerup', end);
          button.removeEventListener('pointercancel', cancel);
          if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
          applyPanel(panel, record, start);
        };

        button.addEventListener('pointermove', moving);
        button.addEventListener('pointerup', end);
        button.addEventListener('pointercancel', cancel);
      });

      panel.appendChild(button);
    };

    const sync = () => {
      scheduled = false;
      const all = Array.from(document.querySelectorAll<HTMLElement>(PANEL_SELECTOR));
      // Don't offer a second drag handle inside an already editable host.
      const panels = all.filter(panel => !all.some(other => other !== panel && other.contains(panel)));
      panels.forEach((panel, index) => {
        let record = tracked.get(panel);
        if (!record) {
          record = {
            id: 'panel-' + index + ':' + titleFor(panel),
            original: {
              position: panel.style.position,
              translate: panel.style.translate,
              width: panel.style.width,
              height: panel.style.height,
              zIndex: panel.style.zIndex,
            },
          };
          tracked.set(panel, record);
        }
        if (!panel.style.position && getComputedStyle(panel).position === 'static') {
          panel.style.position = 'relative';
        }
        panel.dataset.dashboardLayoutPanel = 'true';
        applyPanel(panel, record, editsRef.current[record.id]);
        if (!panel.querySelector(':scope > [data-layout-control="move"]')) createControl(panel, record, 'move');
        if (!panel.querySelector(':scope > [data-layout-control="resize"]')) createControl(panel, record, 'resize');
      });
      for (const panel of tracked.keys()) {
        if (!panel.isConnected) tracked.delete(panel);
      }
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(sync);
    };

    sync();
    observer = new MutationObserver(schedule);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer?.disconnect();
      for (const panel of tracked.keys()) {
        panel.querySelectorAll(':scope > [data-layout-control]').forEach(button => button.remove());
        panel.removeAttribute('data-dashboard-layout-panel');
        delete panel.dataset.layoutInteracting;
      }
    };
  }, [editMode, setEdits]);
}

