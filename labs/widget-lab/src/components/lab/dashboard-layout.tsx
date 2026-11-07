import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

/**
 * Lab-only, route-scoped smart layout editing. Unlike a freeform translate,
 * grid-auto-flow owns packing and panels are never placed on top of each other.
 * Changes are presentation-only and never mutate widget/query schemas.
 */
export type PanelLayoutEdit = { order?: number; columns?: number; minHeight?: number };
export type DashboardLayoutEdits = Record<string, PanelLayoutEdit>;

type OriginalStyles = { position: string; order: string; gridColumn: string; minHeight: string; zIndex: string };
type Panel = { id: string; node: HTMLElement; index: number; original: OriginalStyles };
type Group = {
  node: HTMLElement;
  id: string;
  panels: Panel[];
  children: Array<{ node: HTMLElement; order: string }>;
  initialFlow: string;
  preview: string[] | null;
};
type PointerSession = { cancel: () => void };

const PANEL_SELECTOR = [
  '.ref-edge-metric', '.ref-rel-metric', '.ref-panel',
  '.lab-panel', '.lab-kpi', '.finance-panel',
  '.domain-metrics > section', '.catalog-preview',
].join(', ');

const SNAP_HEIGHT = 32;
const ease = 'cubic-bezier(.2,.83,.24,1)';
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function movePanel(ids: readonly string[], moved: string, anchor: string, after = false): string[] {
  if (moved === anchor || !ids.includes(moved) || !ids.includes(anchor)) return [...ids];
  const remaining = ids.filter(id => id !== moved);
  const index = remaining.indexOf(anchor) + (after ? 1 : 0);
  remaining.splice(index, 0, moved);
  return remaining;
}

export function snapColumnSpan(width: number, columnWidth: number, gap: number, columns: number): number {
  if (!(width > 0) || !(columnWidth > 0) || columns < 1) return 1;
  return clamp(Math.round((width + gap) / (columnWidth + gap)), 1, columns);
}

export function updatePanelLayout(
  previous: DashboardLayoutEdits, id: string, edit: PanelLayoutEdit,
): DashboardLayoutEdits {
  const next = { ...previous };
  const entry = Object.fromEntries(Object.entries(edit).filter(([, value]) => value !== undefined)) as PanelLayoutEdit;
  if (!Object.keys(entry).length) delete next[id];
  else next[id] = entry;
  return next;
}

function titleFor(panel: HTMLElement): string {
  return panel.getAttribute('aria-label')
    || panel.querySelector<HTMLElement>(':scope > header h2, :scope > header h3, :scope > header .lab-panel-title h2')?.textContent?.trim()
    || panel.querySelector<HTMLElement>('[data-widget-panel-actions]')?.getAttribute('data-widget-panel-actions')
    || 'Widget';
}
function parentSignature(parent: HTMLElement): string {
  const segments: string[] = [];
  let current: HTMLElement | null = parent;
  for (let depth = 0; depth < 5 && current && current !== document.body; depth++) {
    const tag = current.tagName.toLowerCase();
    const classes = [...current.classList].filter(c => !c.startsWith('gamma')).slice(0, 2).join('.');
    const siblings = current.parentElement ? [...current.parentElement.children].filter(e => e.tagName === current!.tagName) : [];
    segments.unshift(tag + '.' + classes + ':' + siblings.indexOf(current));
    current = current.parentElement;
  }
  return segments.join('/');
}

function gridColumns(node: HTMLElement): number {
  const template = getComputedStyle(node).gridTemplateColumns;
  const repeat = template.match(/repeat\(\s*(\d+)/);
  if (repeat) return Math.max(1, Number(repeat[1]));
  const widths = template.match(/\d+(?:\.\d+)?px/g);
  if (widths?.length) return widths.length;
  return Math.max(1, node.clientWidth >= 1120 ? 12 : node.clientWidth >= 550 ? 2 : 1);
}
function gridColumnWidth(node: HTMLElement): { count: number; unit: number; gap: number } {
  const count = gridColumns(node);
  const css = getComputedStyle(node);
  const gap = Number.parseFloat(css.columnGap) || 0;
  return { count, gap, unit: Math.max(1, (node.getBoundingClientRect().width - gap * (count - 1)) / count) };
}

/** CSS display:contents keeps supporting panels in the outer visual grid even
 * when their React parent is only a structural wrapper. */
function visualParent(node: HTMLElement): HTMLElement | null {
  let parent = node.parentElement;
  while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement;
  return parent;
}
function visualChildren(parent: HTMLElement): HTMLElement[] {
  const flatten = (element: Element): HTMLElement[] =>
    element instanceof HTMLElement && getComputedStyle(element).display === 'contents'
      ? [...element.children].flatMap(flatten)
      : element instanceof HTMLElement ? [element] : [];
  return [...parent.children].flatMap(flatten);
}

function originalStyle(node: HTMLElement): OriginalStyles {
  return {
    position: node.style.position, order: node.style.order, gridColumn: node.style.gridColumn,
    minHeight: node.style.minHeight, zIndex: node.style.zIndex,
  };
}
function savedOrder(group: Group, edits: DashboardLayoutEdits): string[] {
  return [...group.panels].sort((a, b) =>
    (edits[a.id]?.order ?? a.index) - (edits[b.id]?.order ?? b.index) || a.index - b.index,
  ).map(p => p.id);
}
function applyGroup(group: Group, order: readonly string[], edits: DashboardLayoutEdits, active: boolean) {
  const customized = group.panels.some(p => edits[p.id] !== undefined);
  group.node.style.gridAutoFlow = (active || customized) ? 'row dense' : group.initialFlow;
  // Reserve the original slots occupied by toolbar, captions and other fixed children.
  const slots = group.panels.map(p => group.children.findIndex(c => c.node === p.node));
  const activeOrder = new Map(order.map((id, i) => [id, slots[i]]));
  for (let i = 0; i < group.children.length; i++) {
    const child = group.children[i];
    const entry = group.panels.find(p => p.node === child.node);
    child.node.style.order = (active || customized) ? String(entry ? activeOrder.get(entry.id) ?? i : i) : child.order;
  }
  for (const panel of group.panels) {
    const edit = edits[panel.id];
    panel.node.style.gridColumn = edit?.columns ? 'span ' + Math.min(edit.columns, gridColumns(group.node)) : panel.original.gridColumn;
    panel.node.style.minHeight = edit?.minHeight ? edit.minHeight + 'px' : panel.original.minHeight;
  }
}

function springLayout(group: Group, mutate: () => void, focus?: HTMLElement) {
  if (reducedMotion()) { mutate(); return; }
  const before = new Map(group.panels.map(p => [p.node, p.node.getBoundingClientRect()] as const));
  mutate();
  for (const { node } of group.panels) {
    const prior = before.get(node);
    if (!prior) continue;
    const current = node.getBoundingClientRect();
    const x = prior.left - current.left;
    const y = prior.top - current.top;
    if (Math.abs(x) < 2 && Math.abs(y) < 2) continue;
    if (typeof node.animate !== 'function') continue;
    node.getAnimations?.().filter(a => (a as Animation & { id?: string }).id === 'dashboard-grid-snap').forEach(a => a.cancel());
    const animation = node.animate(
      [{ transform: 'translate3d(' + x + 'px,' + y + 'px,0)', opacity: .82 }, { transform: 'translate3d(0,0,0)', opacity: 1 }],
      { duration: 265, easing: ease },
    );
    animation.id = 'dashboard-grid-snap';
  }
  if (focus && typeof focus.animate === 'function') {
    focus.animate([{ scale: '1.015' }, { scale: '1' }], { duration: 260, easing: ease });
  }
}

function saveOrder(
  group: Group, order: readonly string[], edits: DashboardLayoutEdits,
): DashboardLayoutEdits {
  let next = { ...edits };
  const natural = group.panels.map(p => p.id);
  const changed = order.some((id, i) => id !== natural[i]);
  for (const panel of group.panels) {
    const current = next[panel.id] ?? {};
    next = updatePanelLayout(next, panel.id, { ...current, order: changed ? order.indexOf(panel.id) : undefined });
  }
  return next;
}

function nearestTarget(group: Group, source: Panel, x: number, y: number) {
  let result: Panel | null = null;
  let distance = Infinity;
  for (const panel of group.panels) {
    if (panel === source) continue;
    const rect = panel.node.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    const score = Math.hypot(dx, dy);
    if (score < distance) { distance = score; result = panel; }
  }
  return distance < 160 ? result : null;
}

export function useDashboardLayoutEditing(
  editMode: boolean, edits: DashboardLayoutEdits, setEdits: Dispatch<SetStateAction<DashboardLayoutEdits>>,
) {
  const editsRef = useRef(edits);
  const groupsRef = useRef(new Map<HTMLElement, Group>());
  const sessionRef = useRef<PointerSession | null>(null);
  editsRef.current = edits;

  useEffect(() => {
    for (const group of groupsRef.current.values()) {
      if (!sessionRef.current) group.preview = null;
      applyGroup(group, group.preview ?? savedOrder(group, edits), edits, editMode);
    }
  }, [edits, editMode]);

  useEffect(() => {
    let scheduled = false;
    let observer: MutationObserver | null = null;
    const groups = groupsRef.current;

    const commit = (next: DashboardLayoutEdits) => {
      editsRef.current = next;
      setEdits(next);
    };
    const cleanTarget = (group: Group) => {
      for (const p of group.panels) delete p.node.dataset.layoutDropTarget;
    };
    const controls = (group: Group, panel: Panel, mode: 'move' | 'resize') => {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'dashboard-layout-control dashboard-layout-' + mode;
      handle.dataset.layoutControl = mode;
      handle.textContent = mode === 'move' ? '⠿ Move' : '◢';
      handle.setAttribute('aria-label', (mode === 'move' ? 'Move ' : 'Resize ') + titleFor(panel.node));
      handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown ArrowLeft ArrowRight');
      handle.title = mode === 'move'
        ? 'Drag between tiles to snap into place, or use arrow keys to reorder'
        : 'Drag to resize in grid columns and 32px vertical steps; arrow keys resize precisely';

      const announce = (message: string) => {
        const status = document.querySelector<HTMLElement>('[data-dashboard-layout-live]');
        if (status) status.textContent = message;
      };
      const putOrder = (next: string[], applyAnimation = true) => {
        const update = () => {
          group.preview = next;
          applyGroup(group, next, editsRef.current, true);
        };
        if (applyAnimation) springLayout(group, update);
        else update();
      };

      handle.addEventListener('keydown', event => {
        if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const step = event.shiftKey ? 3 : 1;
        const direction = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
        const order = group.preview ?? savedOrder(group, editsRef.current);
        if (mode === 'move' && !event.altKey) {
          const index = order.indexOf(panel.id);
          const next = [...order];
          const swap = clamp(index + direction * step, 0, next.length - 1);
          next.splice(index, 1);
          next.splice(swap, 0, panel.id);
          putOrder(next);
          commit(saveOrder(group, next, editsRef.current));
          group.preview = null;
          announce(titleFor(panel.node) + ' snapped to slot ' + (swap + 1));
        } else {
          const spec = gridColumnWidth(group.node);
          const current = editsRef.current[panel.id] ?? {};
          const natural = panel.node.getBoundingClientRect();
          const columns = current.columns ?? snapColumnSpan(natural.width, spec.unit, spec.gap, spec.count);
          const minHeight = current.minHeight ?? Math.max(72, Math.round(natural.height / SNAP_HEIGHT) * SNAP_HEIGHT);
          const resized = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
            ? { ...current, columns: clamp(columns + direction * step, 1, spec.count) }
            : { ...current, minHeight: Math.max(72, minHeight + direction * step * SNAP_HEIGHT) };
          const next = updatePanelLayout(editsRef.current, panel.id, resized);
          springLayout(group, () => applyGroup(group, group.preview ?? savedOrder(group, next), next, true));
          commit(next);
          announce(titleFor(panel.node) + ' resized to the grid');
        }
      });

      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        sessionRef.current?.cancel();
        const pointerId = event.pointerId;
        const firstX = event.clientX;
        const firstY = event.clientY;
        const initial = group.preview ?? savedOrder(group, editsRef.current);
        const original = editsRef.current[panel.id] ?? {};
        const initialRect = panel.node.getBoundingClientRect();
        const spec = gridColumnWidth(group.node);
        const startSpan = original.columns ?? snapColumnSpan(initialRect.width, spec.unit, spec.gap, spec.count);
        const startHeight = original.minHeight ?? Math.max(72, Math.ceil(initialRect.height / SNAP_HEIGHT) * SNAP_HEIGHT);
        let preview = [...initial];
        let sizeEdit: PanelLayoutEdit = { ...original };
        let cancelled = false;
        let lastTarget = '';
        let moveFrame = 0;
        let lastPointer: PointerEvent | null = null;
        const ghost = document.createElement('div');
        ghost.className = 'dashboard-layout-drag-ghost';
        // The ghost lives at document.body to escape panel overflow. Copy its
        // resolved Gamma tokens so scoped light/dark themes survive the portal.
        const theme = getComputedStyle(panel.node);
        for (const token of [
          '--gamma-bg', '--gamma-surface', '--gamma-surface-2',
          '--gamma-ink', '--gamma-muted', '--gamma-border', '--gamma-chart-1',
        ]) {
          const value = theme.getPropertyValue(token).trim();
          if (value) ghost.style.setProperty(token, value);
        }
        ghost.setAttribute('aria-hidden', 'true');
        ghost.innerHTML = '<span class="dashboard-layout-ghost-symbol">⠿</span><span class="dashboard-layout-ghost-text"></span><span class="dashboard-layout-ghost-meta">SMART GRID · SNAP</span>';
        ghost.querySelector<HTMLElement>('.dashboard-layout-ghost-text')!.textContent = titleFor(panel.node);
        document.body.appendChild(ghost);
        panel.node.dataset.layoutInteracting = mode;
        if (mode === 'move') panel.node.dataset.layoutSource = 'true';
        const pointGhost = (x: number, y: number) => {
          ghost.style.transform = 'translate3d(' + (x + 12) + 'px,' + (y + 14) + 'px,0)';
        };
        pointGhost(firstX, firstY);
        if (handle.setPointerCapture) handle.setPointerCapture(pointerId);

        const processMove = () => {
          moveFrame = 0;
          const p = lastPointer;
          if (!p || cancelled) return;
          pointGhost(p.clientX, p.clientY);
          if (p.clientY < 52) window.scrollBy?.(0, -14);
          else if (p.clientY > window.innerHeight - 52) window.scrollBy?.(0, 14);
          if (mode === 'move') {
            const target = nearestTarget(group, panel, p.clientX, p.clientY);
            if (!target) { cleanTarget(group); return; }
            const rect = target.node.getBoundingClientRect();
            const after = rect.width >= group.node.getBoundingClientRect().width * .45
              ? p.clientY > rect.top + rect.height / 2
              : Math.abs(p.clientY - rect.top - rect.height / 2) > rect.height * .45
                ? p.clientY > rect.top + rect.height / 2
                : p.clientX > rect.left + rect.width / 2;
            const key = target.id + ':' + after;
            if (key === lastTarget) return;
            lastTarget = key;
            const next = movePanel(preview, panel.id, target.id, after);
            if (next.some((id, i) => id !== preview[i])) {
              preview = next;
              putOrder(next);
            }
            cleanTarget(group);
            target.node.dataset.layoutDropTarget = 'true';
          } else {
            const dx = (p.clientX - firstX) / (initialRect.width / (panel.node.offsetWidth || initialRect.width) || 1);
            const dy = (p.clientY - firstY) / (initialRect.height / (panel.node.offsetHeight || initialRect.height) || 1);
            const width = initialRect.width + dx;
            const columns = snapColumnSpan(width, spec.unit, spec.gap, spec.count);
            const minHeight = Math.max(72, Math.round((startHeight + dy) / SNAP_HEIGHT) * SNAP_HEIGHT);
            if (sizeEdit.columns === columns && sizeEdit.minHeight === minHeight) return;
            sizeEdit = { ...original, columns, minHeight };
            const staged = updatePanelLayout(editsRef.current, panel.id, sizeEdit);
            springLayout(group, () => applyGroup(group, preview, staged, true));
            ghost.querySelector<HTMLElement>('.dashboard-layout-ghost-meta')!.textContent =
              columns + ' / ' + spec.count + ' COLUMNS · ' + minHeight + 'PX';
          }
        };
        const onMove = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return;
          lastPointer = e;
          if (!moveFrame) moveFrame = requestAnimationFrame(processMove);
        };
        const cleanup = () => {
          cancelAnimationFrame(moveFrame);
          window.removeEventListener('pointermove', onMove, true);
          window.removeEventListener('pointerup', onEnd, true);
          window.removeEventListener('pointercancel', onCancel, true);
          if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId);
          ghost.remove();
          delete panel.node.dataset.layoutSource;
          delete panel.node.dataset.layoutInteracting;
          cleanTarget(group);
          sessionRef.current = null;
        };
        const onEnd = (e: PointerEvent) => {
          if (e.pointerId !== pointerId || cancelled) return;
          // Use the last pointer coordinates, even if the final RAF did not run.
          lastPointer = e;
          processMove();
          cleanup();
          if (mode === 'move') {
            commit(saveOrder(group, preview, editsRef.current));
            group.preview = null;
            applyGroup(group, savedOrder(group, editsRef.current), editsRef.current, true);
            announce(titleFor(panel.node) + ' snapped into position. Other panels packed automatically.');
          } else {
            const next = updatePanelLayout(editsRef.current, panel.id, sizeEdit);
            commit(next);
            group.preview = null;
            springLayout(group, () => applyGroup(group, savedOrder(group, next), next, true), panel.node);
            announce(titleFor(panel.node) + ' resized and neighbouring panels packed.');
          }
          if (!reducedMotion() && typeof panel.node.animate === 'function') {
            panel.node.animate([{ scale: '1.024' }, { scale: '1' }], { duration: 250, easing: ease });
          }
        };
        const onCancel = (e: PointerEvent) => {
          if (e.pointerId !== pointerId) return;
          cancelled = true;
          cleanup();
          springLayout(group, () => {
            group.preview = null;
            applyGroup(group, initial, editsRef.current, true);
          });
          announce('Layout change cancelled');
        };
        sessionRef.current = { cancel: () => onCancel({ pointerId } as PointerEvent) };
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onEnd, true);
        window.addEventListener('pointercancel', onCancel, true);
      });
      panel.node.appendChild(handle);
    };

    const sync = () => {
      scheduled = false;
      const all = Array.from(document.querySelectorAll<HTMLElement>(PANEL_SELECTOR));
      const outer = all.filter(p => !all.some(other => other !== p && other.contains(p)));
      const candidates = outer.filter(p => {
        const parent = visualParent(p);
        if (!parent || p.closest('[role="dialog"],[aria-modal="true"]')) return false;
        const display = getComputedStyle(parent).display;
        return display === 'grid' || display === 'inline-grid';
      });
      const parents = new Set(candidates.map(p => visualParent(p)!));
      for (const parent of parents) {
        const selected = candidates.filter(p => visualParent(p) === parent);
        if (selected.length < 2) continue;
        let group = groups.get(parent);
        if (!group) {
          const id = parentSignature(parent);
          const named = new Map<string, number>();
          const panels = selected.map((node, index) => {
            const title = titleFor(node);
            const instance = named.get(title) ?? 0;
            named.set(title, instance + 1);
            return {
              id: id + '::' + title + ':' + instance, node, index, original: originalStyle(node),
            } satisfies Panel;
          });
          group = {
            node: parent, id, panels,
            children: visualChildren(parent).map(node => ({ node, order: node.style.order })),
            initialFlow: parent.style.gridAutoFlow, preview: null,
          };
          groups.set(parent, group);
        }
        parent.dataset.dashboardSnapGrid = editMode ? 'true' : 'false';
        applyGroup(group, group.preview ?? savedOrder(group, editsRef.current), editsRef.current, editMode);
        for (const panel of group.panels) {
          if (!panel.node.isConnected) continue;
          if (editMode) {
            if (!panel.node.style.position && getComputedStyle(panel.node).position === 'static') panel.node.style.position = 'relative';
            panel.node.dataset.dashboardLayoutPanel = 'true';
            if (!panel.node.querySelector(':scope > [data-layout-control="move"]')) controls(group, panel, 'move');
            if (!panel.node.querySelector(':scope > [data-layout-control="resize"]')) controls(group, panel, 'resize');
          }
        }
      }
      for (const [node, group] of groups) {
        if (node.isConnected) continue;
        for (const p of group.panels) p.node.removeAttribute('data-dashboard-layout-panel');
        groups.delete(node);
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
      sessionRef.current?.cancel();
      for (const group of groups.values()) {
        for (const panel of group.panels) {
          panel.node.querySelectorAll(':scope > [data-layout-control]').forEach(button => button.remove());
          panel.node.removeAttribute('data-dashboard-layout-panel');
          delete panel.node.dataset.layoutInteracting;
          delete panel.node.dataset.layoutDropTarget;
          delete panel.node.dataset.layoutSource;
          if (!editsRef.current[panel.id]) panel.node.style.position = panel.original.position;
        }
        group.preview = null;
        delete group.node.dataset.dashboardSnapGrid;
        applyGroup(group, savedOrder(group, editsRef.current), editsRef.current, false);
      }
    };
  }, [editMode, setEdits]);
}

