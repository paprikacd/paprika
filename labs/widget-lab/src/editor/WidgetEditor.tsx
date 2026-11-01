import { hasIntrinsicChartLayout } from '../charts/intrinsic-chart-families';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Braces, ChartNoAxesCombined, Check, ChevronRight, Columns3, Database, Eye, FlaskConical, Redo2, Search, Settings2, Table2, Undo2, X } from 'lucide-react';
import { WidgetVisualization } from '../vendor/paprika/ui/src/features/insights/charts';
import { ChartCursorProvider } from '../vendor/paprika/ui/src/features/insights/chart-cursor';
import { widgetKind, type QueryResult, type Widget, type WidgetOptions } from '../vendor/paprika/ui/src/features/insights/schema';
import { getWidgetDefinition, useWidgetDefinitions, type WidgetConfigField } from '../vendor/paprika/ui/src/features/insights/widget-registry';
import { GammaButton } from '../vendor/paprika/ui/src/features/insights/gamma/button';
import { GammaInput, GammaTextarea } from '../vendor/paprika/ui/src/features/insights/gamma/input';
import { GammaSelect } from '../vendor/paprika/ui/src/features/insights/gamma/select';
import { GammaSwitch } from '../vendor/paprika/ui/src/features/insights/gamma/switch';
import { inheritGammaTheme } from '../vendor/paprika/ui/src/features/insights/gamma/inherit-theme';
import { lockBodyScroll } from '../vendor/paprika/ui/src/features/insights/gamma/scroll-lock';
import themeStyles from '../vendor/paprika/ui/src/features/insights/gamma/gamma-theme.module.css';
import { createEditorDraft, editorDataTable, editorStyleControls, editorVisualizations, revalidateEditorDraft, reviseEditorDraft, travelEditorDraft, updateWidgetOption, validateEditorWidget, visualizationCandidate, type EditorStyleControl } from './editor-model';
import { discoverRecordFields } from './field-bindings';
import { FieldMapping, SourceSchema } from './FieldMapping';
import './WidgetEditor.css';

export type WidgetEditorTab = 'data' | 'schema' | 'query' | 'config';
export interface WidgetEditorProps { widget: Widget; result: QueryResult; onApply: (widget: Widget) => void; onClose: () => void; initialTab?: WidgetEditorTab }

function Field({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return <div className="we-field"><label><span>{label}</span>{children}</label>{help && <small>{help}</small>}</div>;
}
function OptionGroup({ title, keywords, search, children }: { title: string; keywords: string; search: string; children: ReactNode }) {
  if (search && !`${title} ${keywords}`.toLowerCase().includes(search.toLowerCase())) return null;
  return <details className="we-option-group" open={!!search || title === 'Panel options' || title === 'Visualization' || title === 'Field bindings' || title === 'Tooltip'}><summary><ChevronRight size={13}/>{title}</summary><div>{children}</div></details>;
}

/** Shared runtime preferences, kept separate from legend and source configuration. */
export function TooltipSettings({ options, onChange }: {
  options?: WidgetOptions;
  onChange: <K extends keyof WidgetOptions>(key: K, value: WidgetOptions[K]) => void;
}) {
  const enabled = options?.showTooltip !== false;
  const compact = options?.inspectorDensity === 'compact';
  return <>
    <GammaSwitch label="Show tooltips" description="Inspect exact observations with a pointer or keyboard." checked={enabled} onChange={value => onChange('showTooltip', value)}/>
    <p className="we-tooltip-help">Tooltips follow the pointer. Click or press Enter to pin an observation; Escape dismisses it. Keyboard inspection anchors to the focused mark.</p>
    <fieldset className="we-tooltip-settings" disabled={!enabled} aria-label="Tooltip appearance and placement">
      <Field label="Density"><GammaSelect aria-label="Tooltip density" value={options?.inspectorDensity ?? 'comfortable'} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} onValueChange={value => onChange('inspectorDensity', value as 'comfortable' | 'compact')} size="sm"/></Field>
      <Field label="Preferred placement" help="Flips or moves inward when the preferred side would leave the viewport."><GammaSelect aria-label="Tooltip placement" value={options?.tooltipPlacement ?? 'auto'} options={[{ value: 'auto', label: 'Automatic' }, { value: 'top', label: 'Above' }, { value: 'right', label: 'Right' }, { value: 'bottom', label: 'Below' }, { value: 'left', label: 'Left' }]} onValueChange={value => onChange('tooltipPlacement', value === 'auto' ? undefined : value as WidgetOptions['tooltipPlacement'])} size="sm"/></Field>
      <Field label="Pointer gap (px)" help="Leave blank for the 12 px default. Pinned tooltips keep their anchor."><GammaInput aria-label="Tooltip pointer gap" type="number" min={0} max={40} step={1} value={options?.tooltipOffset ?? ''} placeholder="12" onChange={event => onChange('tooltipOffset', event.target.value === '' ? undefined : Number(event.target.value))} size="sm"/></Field>
      <div className="we-field-pair">
        <Field label="Maximum width (px)"><GammaInput aria-label="Tooltip maximum width" type="number" min={220} max={640} step={1} value={options?.tooltipMaxWidth ?? ''} placeholder={compact ? '292' : '330'} onChange={event => onChange('tooltipMaxWidth', event.target.value === '' ? undefined : Number(event.target.value))} size="sm"/></Field>
        <Field label="Maximum height (px)"><GammaInput aria-label="Tooltip maximum height" type="number" min={160} max={800} step={1} value={options?.tooltipMaxHeight ?? ''} placeholder="560" onChange={event => onChange('tooltipMaxHeight', event.target.value === '' ? undefined : Number(event.target.value))} size="sm"/></Field>
      </div>
      <p className="we-tooltip-help">Blank limits use {compact ? '292' : '330'} × 560 px. The visible viewport takes priority; longer details scroll inside the tooltip.</p>
    </fieldset>
    {!enabled && <p className="we-tooltip-help">Your appearance settings are retained while tooltips are off.</p>}
  </>;
}

export function WidgetEditor({ widget, result, onApply, onClose, initialTab = 'data' }: WidgetEditorProps) {
  const id = useId(), anchor = useRef<HTMLSpanElement>(null), root = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const optionSearch = useRef<HTMLInputElement>(null);
  const rendererDrafts = useRef(new Map<string, Widget>());
  if (!rendererDrafts.current.size) { const initial = getWidgetDefinition(widget); if (initial) rendererDrafts.current.set(initial.id, widget); }
  const [draftState, setState] = useState(() => createEditorDraft(widget, result));
  const [search, setSearch] = useState(''), [tab, setTab] = useState<WidgetEditorTab>(initialTab);
  const [tableView, setTableView] = useState(false), [previewWidth, setPreviewWidth] = useState<'fill' | 'narrow'>('fill');
  const [dataSearch, setDataSearch] = useState(''), [page, setPage] = useState(0);
  const [source, setSource] = useState(''), [sourceError, setSourceError] = useState(''), [sourceDirty, setSourceDirty] = useState(false);
  const definitions = useWidgetDefinitions(), kind = widgetKind(widget);
  const state = useMemo(() => revalidateEditorDraft(draftState, kind, result), [draftState, kind, result]);
  const previewMatchesResult = useMemo(() => state.errors.length === 0 || !!validateEditorWidget(state.preview, kind, result).widget, [state, kind, result]);
  const definition = getWidgetDefinition(state.draft);
  const choices = useMemo(() => { const available=editorVisualizations(state.draft,result,definitions); const original=getWidgetDefinition(widget); return original&&!available.some(item=>item.id===original.id)?[original,...available]:available; }, [state.draft, result, definitions, widget]);
  const data = useMemo(() => editorDataTable(result), [result]);
  const columns = useMemo(() => discoverRecordFields(result), [result]);
  const bindingFields = definition?.configFields?.filter(field => field.binding) ?? [];
  const displayFields = definition?.configFields?.filter(field => !field.binding) ?? [];
  const filteredRows = useMemo(() => data.rows.filter(row => !dataSearch || row.some(value => String(value ?? 'missing').toLowerCase().includes(dataSearch.toLowerCase()))), [data.rows, dataSearch]);
  const pages = Math.max(1, Math.ceil(filteredRows.length / 20)), safePage = Math.min(page, pages - 1);
  const dirty = JSON.stringify(state.draft) !== JSON.stringify(widget);
  const valid = state.errors.length === 0 && !sourceDirty;
  const controls = editorStyleControls(state.draft, definition);
  const supports = (control: EditorStyleControl) => controls.includes(control);
  const timeSeries = state.draft.type === 'timeseries';
  const revise = (next: Widget) => { setState(previous => reviseEditorDraft(revalidateEditorDraft(previous, kind, result), next, kind, result)); };
  const travel = (direction: 'undo' | 'redo') => { setState(previous => travelEditorDraft(revalidateEditorDraft(previous, kind, result), direction, kind, result)); };
  function option<K extends keyof WidgetOptions>(key: K, value: WidgetOptions[K]) { revise(updateWidgetOption(state.draft, key, value)); }
  const config = (key: string, value: string | number | boolean | undefined) => {
    const next = { ...state.draft.config }; if (value === undefined) delete next[key]; else next[key] = value;
    revise({ ...state.draft, config: next });
  };
  const switchVisualization = (value: string) => {
    const next = choices.find(choice => choice.id === value);
    if (!next) return;
    if (definition) rendererDrafts.current.set(definition.id, structuredClone(state.draft));
    revise(visualizationCandidate(state.draft, next, rendererDrafts.current.get(next.id)));
  };

  useLayoutEffect(() => anchor.current && root.current ? inheritGammaTheme(anchor.current, root.current) : undefined, []);
  useEffect(() => {
    const prior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = lockBodyScroll(); closeButton.current?.focus({ preventScroll: true });
    return () => { release(); if (prior?.isConnected) prior.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { if (!sourceDirty) setSource(JSON.stringify({ options: state.draft.options ?? {}, config: state.draft.config ?? {} }, null, 2)); }, [state.draft, sourceDirty]);

  const table = <div className="we-data-scroll" role="region" aria-label="Loaded result table" tabIndex={0}><table><thead><tr>{data.columns.map((column,index)=><th key={`${column}-${index}`}>{column}</th>)}</tr></thead><tbody>{filteredRows.slice(safePage*20,safePage*20+20).map((row,rowIndex)=><tr key={rowIndex}>{row.map((value,index)=><td key={index} title={value===null?'Missing observation':String(value)} className={typeof value === 'number' ? 'is-number' : ''}>{value === null ? <span className="we-null" title="Missing observation">No data</span> : String(value)}</td>)}</tr>)}</tbody></table>{filteredRows.length===0&&<p className="we-empty">No loaded rows match this search.</p>}</div>;
  const pluginField = (field: WidgetConfigField) => {
    const value=Object.prototype.hasOwnProperty.call(state.draft.config??{},field.key)?state.draft.config?.[field.key]:definition?.defaultConfig?.[field.key];
    if(field.kind==='boolean')return <GammaSwitch key={field.key} label={field.label} description={field.help} checked={value===true} onChange={next=>config(field.key,next)}/>;
    return <Field key={field.key} label={field.label} help={field.help}>{field.kind==='select'?<GammaSelect aria-label={field.label} value={String(value??'')} options={field.options??[]} onValueChange={next=>config(field.key,next)} size="sm"/>:<GammaInput aria-label={field.label} type={field.kind==='number'?'number':'text'} value={typeof value==='number'||typeof value==='string'?value:''} min={field.min} max={field.max} step={field.step} placeholder={field.placeholder} onChange={event=>config(field.key,event.target.value===''?undefined:field.kind==='number'?Number(event.target.value):event.target.value)} size="sm"/>}</Field>;
  };

  const body=<div ref={root} className={`${themeStyles.scope} obs-app widget-editor`} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} onKeyDown={event=>{
    if(event.defaultPrevented)return;
    if(event.key==='Escape') { const nested=(event.target as Element).closest('[role=dialog],[role=listbox],[role=tooltip]'); if(nested&&nested!==root.current)return; event.stopPropagation(); onClose(); return; }
    if(event.key!=='Tab'||!root.current?.contains(document.activeElement))return;
    const focusable=Array.from(root.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]')).filter(element=>element.getClientRects().length>0);
    const first=focusable[0],last=focusable.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  }}>
    <header className="we-header">
      <GammaButton ref={closeButton} variant="quiet" iconOnly aria-label="Close chart editor and discard draft" onClick={onClose}><ArrowLeft size={18}/></GammaButton>
      <div className="we-heading"><h1 id={`${id}-title`}>{widget.title}</h1><span>Panel editor · {definition?.label}</span></div>
      <span className={`we-draft-state ${dirty||sourceDirty?'is-dirty':''}`}><i/>{dirty||sourceDirty?'Unapplied changes':'No changes'}</span>
      <div className="we-history"><GammaButton size="sm" variant="quiet" iconOnly aria-label="Undo edit" disabled={!state.past.length||sourceDirty} onClick={()=>travel('undo')}><Undo2 size={15}/></GammaButton><GammaButton size="sm" variant="quiet" iconOnly aria-label="Redo edit" disabled={!state.future.length||sourceDirty} onClick={()=>travel('redo')}><Redo2 size={15}/></GammaButton></div>
      <GammaButton size="sm" variant="secondary" onClick={onClose}>Discard</GammaButton>
      <GammaButton size="sm" variant="primary" disabled={!valid||!dirty} onClick={()=>{const checked=validateEditorWidget(state.draft,kind,result);if(checked.widget){onApply(checked.widget);onClose();}else{setState(previous=>revalidateEditorDraft(previous,kind,result));}}}><Check size={14}/>Apply changes</GammaButton>
    </header>
    <div className="we-layout">
      <main className="we-workbench">
        <div className="we-preview-toolbar"><span><Eye size={14}/>Live preview</span><div className="we-segment" role="group" aria-label="Editor preview mode"><button aria-pressed={!tableView} onClick={()=>setTableView(false)}>Chart</button><button aria-pressed={tableView} onClick={()=>setTableView(true)}>Table</button></div><div className="we-segment we-preview-size" role="group" aria-label="Editor preview width"><button aria-pressed={previewWidth==='fill'} onClick={()=>setPreviewWidth('fill')}>Fill</button><button aria-pressed={previewWidth==='narrow'} onClick={()=>setPreviewWidth('narrow')}>390px</button></div><span className="we-source-badge"><FlaskConical size={13}/>Synthetic data</span></div>
        <section className={`we-preview ${previewWidth==='narrow'?'is-narrow':''}`} aria-label="Live chart preview">
          <header><h2>{state.preview.title}</h2><span>{state.preview.unit}</span></header>
          {state.preview.description&&<p className="we-preview-description">{state.preview.description}</p>}
          <div className="we-chart" data-editor-family={getWidgetDefinition(state.preview)?.id} data-editor-expanded={!tableView&&hasIntrinsicChartLayout(state.preview)}>{tableView?table:previewMatchesResult?<ChartCursorProvider><WidgetVisualization widget={state.preview} result={result}/></ChartCursorProvider>:<p className="we-empty">The current result does not match the preview configuration. Review field bindings or switch to Table to inspect the loaded data.</p>}</div>
        </section>
        {state.errors.length>0&&<div className="we-errors" role="alert"><strong>{previewMatchesResult?'Preview keeps the last valid configuration.':'Configuration needs attention before preview or Apply.'}</strong>{state.errors.map((error,index)=><p key={index}>{error}</p>)}</div>}
        <section className="we-data-workspace" aria-label="Panel data and query">
          <div className="we-data-tabs" role="tablist" aria-label="Panel data workspace">
            {([['data','Data',Table2],['schema','Fields',Columns3],['query','Query',Database],['config','Configuration',Braces]] as const).map(([value,label,Icon])=><button key={value} role="tab" aria-selected={tab===value} tabIndex={tab===value?0:-1} onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const values=['data','schema','query','config'] as const;const next=event.key==='Home'?values[0]:event.key==='End'?values[3]:values[(values.indexOf(value)+(event.key==='ArrowRight'?1:3))%4];setTab(next);document.getElementById(`${id}-${next}-tab`)?.focus();}}} aria-controls={`${id}-${value}`} id={`${id}-${value}-tab`} onClick={()=>setTab(value)}><Icon size={14}/>{label}{value==='data'&&<span>{data.total.toLocaleString()}</span>}</button>)}
            <span className="we-local-note">Session edits reset when leaving this dashboard.</span>
          </div>
          <div role="tabpanel" id={`${id}-${tab}`} aria-labelledby={`${id}-${tab}-tab`}>
            {tab==='data'&&<><div className="we-data-toolbar"><div className="we-data-search"><Search size={14}/><GammaInput aria-label="Search loaded data preview" placeholder="Search loaded rows…" value={dataSearch} onChange={event=>{setDataSearch(event.target.value);setPage(0);}} size="sm"/></div><span>{result.records?'Records':result.series?`${result.series.length} series`:'Traces'} · exact source values{data.capped?' · first 500 rows shown':''}</span></div>{table}<footer className="we-data-pagination"><span>{filteredRows.length?`${safePage*20+1}–${Math.min((safePage+1)*20,filteredRows.length)} of ${filteredRows.length}`:'0 rows'}{data.capped?` · ${data.total.toLocaleString()} in source`:''}</span><button disabled={safePage===0} onClick={()=>setPage(safePage-1)}>Previous</button><button disabled={safePage>=pages-1} onClick={()=>setPage(safePage+1)}>Next</button></footer></>}
            {tab==='schema'&&<SourceSchema columns={columns} definition={definition} config={state.draft.config} result={result}/>}
            {tab==='query'&&<div className="we-query-panel"><div className="we-query-meta"><span>Data source<strong>{widget.providerId}</strong></span><span>Result kind<strong>{kind}</strong></span><span>Connection<strong>Loaded fixture</strong></span></div><div className="we-query-heading"><span className="we-query-letter">A</span><strong>Source query</strong><span>Read only</span></div><pre className="we-query-code"><code>{widget.query}</code></pre><p>This preview uses the loaded synthetic result. Presentation edits do not run a query or change source observations.</p></div>}
            {tab==='config'&&<div className="we-code-panel"><div><strong>Visualization settings</strong><span>Options and plugin configuration share the same validation as the guided editor.</span></div><GammaTextarea aria-label="Visualization configuration JSON" spellCheck={false} value={source} onChange={event=>{setSource(event.target.value);setSourceDirty(true);setSourceError('');}}/><footer><span>{sourceDirty?'JSON changes need validation before Apply.':'Validated settings'}</span><GammaButton size="sm" disabled={!sourceDirty} onClick={()=>{setSourceDirty(false);setSourceError('');setSource(JSON.stringify({options:state.draft.options??{},config:state.draft.config??{}},null,2));}}>Revert JSON</GammaButton><GammaButton size="sm" variant="primary" disabled={!sourceDirty} onClick={()=>{
              try{const parsed=JSON.parse(source);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).some(key=>key!=='options'&&key!=='config'))throw new Error('Use only options and config objects.');const next={...state.draft,options:parsed.options??{},...(state.draft.type==='plugin'?{config:parsed.config??{}}:{})};if(state.draft.type!=='plugin'&&parsed.config&&Object.keys(parsed.config).length)throw new Error('Built-in charts do not accept plugin config.');const checked=validateEditorWidget(next,kind,result);if(!checked.widget)throw new Error(checked.errors.join('\n'));revise(checked.widget);setSourceDirty(false);setSourceError('');}catch(error){setSourceError(error instanceof Error?error.message:'Invalid JSON.');}
            }}>Validate and preview</GammaButton></footer>{sourceError&&<p className="we-source-error" role="alert">{sourceError}</p>}</div>}
          </div>
        </section>
      </main>
      <aside className="we-options" aria-label="Chart options">
        <div className="we-options-heading"><Settings2 size={15}/><strong>Chart options</strong><span>{definition?.dataKind}</span></div>
        <div className="we-options-search"><Search size={15}/><GammaInput ref={optionSearch} aria-label="Search chart options" placeholder="Search options…" value={search} onChange={event=>setSearch(event.target.value)} size="sm"/>{search&&<GammaButton size="sm" variant="quiet" iconOnly aria-label="Clear option search" onClick={()=>{optionSearch.current?.focus();setSearch('');}}><X size={14}/></GammaButton>}</div>
        {sourceDirty&&<p className="we-code-pending">Validate or revert the JSON draft to continue with guided options.</p>}
        <fieldset disabled={sourceDirty} className="we-options-fields">
          <OptionGroup title="Visualization" keywords="type chart renderer line bar table treemap map stat" search={search}><GammaSelect aria-label="Visualization type" searchable value={definition?.id??''} options={choices.map(choice=>({value:choice.id,label:choice.label,description:choice.description,icon:<ChartNoAxesCombined size={16}/>}))} onValueChange={switchVisualization}/><p className="we-option-description">{definition?.description}</p>{choices.length>1&&<p className="we-compatible-note">{choices.length} compatible visualizations · settings retained while switching</p>}</OptionGroup>
          <OptionGroup title="Panel options" keywords="title name description" search={search}><Field label="Title"><GammaInput aria-label="Panel title" value={state.draft.title} maxLength={120} onChange={event=>revise({...state.draft,title:event.target.value})} size="sm"/></Field><Field label="Description"><GammaTextarea aria-label="Panel description" value={state.draft.description??''} maxLength={500} rows={2} placeholder="What does this panel explain?" onChange={event=>revise({...state.draft,description:event.target.value})}/></Field></OptionGroup>
          {(supports('unit')||supports('decimals'))&&<OptionGroup title="Value formatting" keywords="unit decimals precision" search={search}>{supports('unit')&&<Field label="Unit" help="Labels the source value; changing this does not convert it."><GammaInput aria-label="Display unit" value={state.draft.unit} maxLength={24} onChange={event=>revise({...state.draft,unit:event.target.value})} size="sm"/></Field>}{supports('decimals')&&<Field label="Decimal places"><GammaInput aria-label="Decimal places" type="number" min={0} max={8} value={state.draft.options?.decimals??''} placeholder="Automatic" onChange={event=>option('decimals',event.target.value===''?undefined:Number(event.target.value))} size="sm"/></Field>}</OptionGroup>}
          {(timeSeries||supports('color')||state.draft.type==='stat')&&<OptionGroup title="Graph styles" keywords="line area curve interpolation fill opacity color sparkline width" search={search}>{timeSeries&&<><Field label="Draw style"><GammaSelect aria-label="Draw style" value={state.draft.options?.display??'line'} options={[{value:'line',label:'Line'},{value:'area',label:'Area'}]} onValueChange={value=>option('display',value as 'line'|'area')} size="sm"/></Field><Field label="Interpolation"><GammaSelect aria-label="Interpolation" value={state.draft.options?.curve??'linear'} options={[{value:'linear',label:'Linear'},{value:'step',label:'Step'},{value:'monotone',label:'Monotone'}]} onValueChange={value=>option('curve',value as 'linear'|'step'|'monotone')} size="sm"/></Field><Field label="Line width"><GammaInput aria-label="Line width" type="number" step={0.25} min={0.5} max={8} value={state.draft.options?.lineWidth??1.5} onChange={event=>option('lineWidth',Number(event.target.value))} size="sm"/></Field>{state.draft.options?.display==='area'&&<><Field label="Fill style"><GammaSelect aria-label="Fill style" value={state.draft.options?.fillStyle??'solid'} options={[{value:'solid',label:'Solid'},{value:'gradient',label:'Gradient toward zero'}]} onValueChange={value=>option('fillStyle',value as 'solid'|'gradient')} size="sm"/></Field><Field label="Fill opacity"><input aria-label="Fill opacity" type="range" min="0" max="1" step="0.02" value={state.draft.options?.fillOpacity??.2} onChange={event=>option('fillOpacity',Number(event.target.value))}/><output>{Math.round((state.draft.options?.fillOpacity??.2)*100)}%</output></Field></>}</>}{supports('color')&&<Field label="Primary series color"><div className="we-color-field"><input type="color" aria-label="Primary series color" value={state.draft.color??'#00b8d9'} onChange={event=>revise({...state.draft,color:event.target.value})}/><code>{state.draft.color??'Theme default'}</code><button onClick={()=>revise({...state.draft,color:undefined})}>Reset</button></div></Field>}{state.draft.type==='stat'&&<GammaSwitch label="Show history" checked={state.draft.options?.showSparkline!==false} onChange={value=>option('showSparkline',value)}/>}</OptionGroup>}
          {supports('legend')&&<OptionGroup title="Legend" keywords="legend series labels" search={search}><GammaSwitch label="Show legend" checked={state.draft.options?.showLegend!==false} onChange={value=>option('showLegend',value)}/></OptionGroup>}
          {supports('tooltips')&&<OptionGroup title="Tooltip" keywords="tooltip inspector inspection hover mouse pointer cursor pin density compact comfortable placement gap offset width height size" search={search}><TooltipSettings options={state.draft.options} onChange={option}/></OptionGroup>}
          {supports('grid')&&<OptionGroup title="Axes and grid" keywords="axis min max domain grid zero label" search={search}><GammaSwitch label="Horizontal grid" checked={state.draft.options?.showGrid!==false} onChange={value=>option('showGrid',value)}/>{timeSeries&&<><GammaSwitch label="Vertical grid" checked={state.draft.options?.gridX===true} onChange={value=>option('gridX',value)}/><GammaSwitch label="Emphasize zero" checked={state.draft.options?.showZeroLine===true} onChange={value=>option('showZeroLine',value)}/></>}{(timeSeries||state.draft.type==='bar')&&<div className="we-field-pair"><Field label="Minimum"><GammaInput aria-label="Axis minimum" type="number" value={state.draft.options?.min??''} placeholder="Auto" onChange={event=>option('min',event.target.value===''?undefined:Number(event.target.value))} size="sm"/></Field><Field label="Maximum"><GammaInput aria-label="Axis maximum" type="number" value={state.draft.options?.max??''} placeholder="Auto" onChange={event=>option('max',event.target.value===''?undefined:Number(event.target.value))} size="sm"/></Field></div>}{timeSeries&&<><Field label="X axis label"><GammaInput aria-label="X axis label" value={state.draft.options?.xAxisLabel??''} onChange={event=>option('xAxisLabel',event.target.value)} size="sm"/></Field><Field label="Y axis label"><GammaInput aria-label="Y axis label" value={state.draft.options?.yAxisLabel??''} onChange={event=>option('yAxisLabel',event.target.value)} size="sm"/></Field></>}</OptionGroup>}
          {!!bindingFields.length&&definition&&<OptionGroup title="Field bindings" keywords={`source mapping columns types units ${bindingFields.map(field=>field.label).join(' ')}`} search={search}><p className="we-option-description">Choose from the loaded source. Unit changes require a source conversion.</p>{bindingFields.map(field=><FieldMapping key={field.key} field={field} definition={definition} config={state.draft.config} result={result} columns={columns} onChange={value=>config(field.key,value)}/>)}</OptionGroup>}
          {!!displayFields.length&&<OptionGroup title="Data display" keywords={displayFields.map(field=>field.label).join(' ')} search={search}>{displayFields.map(pluginField)}</OptionGroup>}
        </fieldset>
        <footer className="we-options-footer"><Check size={13}/>{state.errors.length?'Review validation above':'Typed configuration'}<span>{definition?.id}</span></footer>
      </aside>
    </div>
  </div>;
  return <><span ref={anchor} hidden/>{createPortal(body,document.body)}</>;
}
