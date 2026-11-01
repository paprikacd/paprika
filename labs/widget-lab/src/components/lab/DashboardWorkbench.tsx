import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Braces, Check, Database, Pencil, RotateCcw } from 'lucide-react';
import { WidgetEditor, type WidgetEditorTab } from '../../editor/WidgetEditor';
import type { QueryResult, Widget } from '../../vendor/paprika/ui/src/features/insights/schema';
import { GammaActionMenu, type GammaActionMenuItem } from '../../vendor/paprika/ui/src/features/insights/gamma/action-menu';
import { GammaButton } from '../../vendor/paprika/ui/src/features/insights/gamma/button';
import { mergeDomainWidget } from './domain-widget';
import './DashboardWorkbench.css';

export type EditDashboardWidget = (widget: Widget, result: QueryResult, apply: (next: Widget) => void, initialTab?: WidgetEditorTab) => void;
type PanelSource = { widget: Widget; result: QueryResult };
type EditSession = { id: string; key: number; tab: WidgetEditorTab };
type Workbench = {
  overrides: Record<string, Widget>;
  apply: (widget: Widget) => void;
  reset: (id: string) => void;
  resetAll: () => void;
  editMode: boolean;
  setEditMode: (editing: boolean) => void;
  editing: EditSession | null;
  open: (id: string, tab: WidgetEditorTab) => void;
  close: () => void;
  dismiss: (id: string) => void;
};
const WorkbenchContext = createContext<Workbench | null>(null);

/** One route-local owner for applied Widget overrides and the active editor. */
export function DashboardWorkbench({ children }: { children: ReactNode }) {
  const [overrides, setOverrides] = useState<Record<string, Widget>>({});
  const [editMode, setEditMode] = useState(false);
  const [editing, setEditing] = useState<EditSession | null>(null);
  const session = useRef(0);
  const apply = useCallback((widget: Widget) => setOverrides(previous => ({ ...previous, [widget.id]: widget })), []);
  const reset = useCallback((id: string) => setOverrides(previous => { const next = { ...previous }; delete next[id]; return next; }), []);
  const resetAll = useCallback(() => { setOverrides({}); setEditing(null); }, []);
  const open = useCallback((id: string, tab: WidgetEditorTab) => setEditing({ id, tab, key: ++session.current }), []);
  const close = useCallback(() => setEditing(null), []);
  const dismiss = useCallback((id: string) => setEditing(previous => previous?.id === id ? null : previous), []);
  const value = useMemo(() => ({ overrides, apply, reset, resetAll, editMode, setEditMode, editing, open, close, dismiss }), [overrides, apply, reset, resetAll, editMode, editing, open, close, dismiss]);
  return <WorkbenchContext.Provider value={value}>{children}</WorkbenchContext.Provider>;
}

/** Presentation follows the edited renderer; live query scope and linked selection stay with the lens. */
export function useDashboardPanels(onEdit?: EditDashboardWidget) {
  const workbench = useContext(WorkbenchContext);
  const [localOverrides, setLocalOverrides] = useState<Record<string, Widget>>({});
  const overrides = workbench?.overrides ?? localOverrides;
  const apply = workbench?.apply ?? ((next: Widget) => setLocalOverrides(previous => ({ ...previous, [next.id]: next })));
  const reset = workbench?.reset ?? ((id: string) => setLocalOverrides(previous => { const next = { ...previous }; delete next[id]; return next; }));
  const cache = useRef(new Map<string, { source: Widget; override: Widget | null; selection: string; widget: Widget }>());
  const current = (source: Widget, selection?: Widget['config']) => {
    const override = overrides[source.id] ?? null, selectionKey = JSON.stringify(selection ?? null);
    const prior = cache.current.get(source.id);
    if (prior?.source === source && prior.override === override && prior.selection === selectionKey) return prior.widget;
    const widget = !override && !selection ? source : mergeDomainWidget(source, override, selection);
    cache.current.set(source.id, { source, override, selection: selectionKey, widget });
    return widget;
  };
  const actionsFor = (widget: Widget, result: QueryResult) => <WidgetPanelActions widget={widget} result={result} onApply={apply} onReset={() => reset(widget.id)} modified={!!overrides[widget.id]} onEdit={onEdit}/>;
  const actions = (panel: PanelSource, selection?: Widget['config']) => actionsFor(current(panel.widget, selection), panel.result);
  return { current, actions, actionsFor, apply, reset, overrides, closeEditor: workbench?.close ?? (() => {}) };
}

export function widgetPanelMenu(open: (tab: WidgetEditorTab) => void, reset: () => void, modified: boolean): GammaActionMenuItem[] {
  return [
    { id: 'edit', label: 'Edit panel', description: 'Preview and apply presentation changes.', icon: <Pencil size={14}/>, onSelect: () => open('data') },
    { id: 'data', label: 'Inspect loaded data', description: 'Exact values from this panel’s current result.', icon: <Database size={14}/>, onSelect: () => open('data') },
    { id: 'config', label: 'View configuration', description: 'Validated options and renderer configuration.', icon: <Braces size={14}/>, onSelect: () => open('config') },
    { id: 'reset', label: 'Reset panel edits', description: 'Restore this panel’s default presentation.', disabled: !modified, icon: <RotateCcw size={14}/>, onSelect: reset },
  ];
}

/** Menus and editor share the same current widget/result, including after scope changes. */
export function WidgetPanelActions({ widget, result, onApply, onReset, modified = false, onEdit }: {
  widget: Widget; result: QueryResult; onApply: (next: Widget) => void; onReset: () => void; modified?: boolean; onEdit?: EditDashboardWidget;
}) {
  const workbench = useContext(WorkbenchContext);
  const dismiss = workbench?.dismiss;
  useEffect(() => () => dismiss?.(widget.id), [dismiss, widget.id]);
  if (!workbench && !onEdit) return null;
  const open = (tab: WidgetEditorTab) => workbench ? workbench.open(widget.id, tab) : onEdit?.(widget, result, onApply, tab);
  const items = widgetPanelMenu(open, onReset, modified);
  const editing = workbench?.editing?.id === widget.id ? workbench.editing : null;
  return <div className="dashboard-panel-actions" data-widget-panel-actions={widget.id} data-edited={modified || undefined}>
    {modified && <span className="dashboard-panel-edited" title="Presentation changed in this dashboard session">Edited</span>}
    {(workbench?.editMode ?? true) && <GammaButton size="sm" variant="ghost" aria-label={`Edit ${widget.title}`} onClick={() => open('data')}><Pencil size={12}/><span>Edit</span></GammaButton>}
    <GammaActionMenu label={`Actions for ${widget.title}`} items={items}/>
    {editing && <WidgetEditor key={editing.key} widget={widget} result={result} initialTab={editing.tab} onApply={onApply} onClose={workbench!.close}/>}
  </div>;
}

/** Editing mode reveals direct panel controls; Done retains the applied session edits. */
export function DashboardEditControls() {
  const workbench = useContext(WorkbenchContext);
  if (!workbench) return null;
  const count = Object.keys(workbench.overrides).length;
  return <div className="dashboard-edit-controls" data-dashboard-workbench="true">
    <GammaButton size="sm" variant={workbench.editMode ? 'secondary' : 'ghost'} aria-pressed={workbench.editMode} onClick={() => workbench.setEditMode(!workbench.editMode)} title="Reveal panel editing controls. Applied changes last until you leave this dashboard.">{workbench.editMode ? <Check size={13}/> : <Pencil size={13}/>}{workbench.editMode ? 'Done editing' : 'Edit dashboard'}</GammaButton>
    {(count > 0 || workbench.editMode) && <span className="dashboard-session-edits" role="status">{count ? `${count} session edit${count === 1 ? '' : 's'}` : 'Session edits'}</span>}
    <GammaActionMenu label="Dashboard actions" items={[{ id: 'reset', label: 'Reset session edits', description: 'Restore the default presentation of every panel.', icon: <RotateCcw size={14}/>, disabled: count === 0, onSelect: workbench.resetAll }]}/>
  </div>;
}
