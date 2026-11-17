import { useId, type ReactNode } from 'react';
import { Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { QueryResult, TooltipView, Widget, WidgetOptions } from '@insights/schema';
import { MetricDetails } from '@insights/metric-tooltip-content';
import { GammaButton } from '@insights/gamma/button';
import { GammaInput } from '@insights/gamma/input';
import { GammaSelect } from '@insights/gamma/select';
import { GammaSwitch } from '@insights/gamma/switch';
import { editorStyleControls } from './editor-model';
import './RichWidgetOptions.css';

export type OptionChange = <K extends keyof WidgetOptions>(key: K, value: WidgetOptions[K]) => void;
type Props = { widget: Widget; result: QueryResult; onOption: OptionChange };
const HEX = /^#[0-9a-f]{6}$/i;
const colour = (v?: string, fallback = '#428ff5') => v && HEX.test(v) ? v : fallback;

export function RichField({ label, children, help }: { label: string; children: ReactNode; help?: string }) {
  return <label className="rich-field"><span>{label}</span>{children}{help && <small>{help}</small>}</label>;
}
export function NumericSetting({ label, value, min, max, step = 1, placeholder, onChange, help }: {
  label: string; value?: number; min?: number; max?: number; step?: number; placeholder?: string; help?: string;
  onChange: (value: number | undefined) => void;
}) {
  return <RichField label={label} help={help}><GammaInput aria-label={label} type="number" min={min} max={max} step={step} size="sm"
    value={value ?? ''} placeholder={placeholder} onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}/></RichField>;
}
export function ColourSetting({ label, value, onChange }: {
  label: string; value?: string; onChange: (value: string | undefined) => void;
}) {
  return <RichField label={label}><div className="rich-color">
    <input aria-label={label} type="color" value={colour(value)} onChange={e => onChange(e.target.value)}/>
    <code>{value ?? 'Theme default'}</code>
    <GammaButton variant="quiet" size="sm" onClick={() => onChange(undefined)}><RotateCcw size={12}/>Reset</GammaButton>
  </div></RichField>;
}

export type PresentationPreset = 'focus' | 'investigate' | 'briefing';
/** Applies only options actually supported by the current rendering family. */
export function presentationPreset(widget: Widget, preset: PresentationPreset): Widget {
  const supported = editorStyleControls(widget);
  const options: WidgetOptions = { ...widget.options };
  if (supported.includes('tooltips')) {
    options.showTooltip = true;
    options.tooltipPlacement = preset === 'focus' ? 'top' : 'auto';
    options.tooltipOffset = preset === 'focus' ? 8 : 14;
    options.tooltipMaxWidth = preset === 'investigate' ? 480 : preset === 'briefing' ? 420 : 330;
    options.tooltipMaxHeight = preset === 'investigate' ? 640 : 460;
  }
  if (supported.includes('legend')) options.showLegend = preset !== 'focus';
  if (supported.includes('grid')) options.showGrid = preset === 'investigate';
  if (supported.includes('grid') && widget.type === 'timeseries') {
    options.gridX = preset === 'investigate';
    options.showZeroLine = preset === 'investigate';
  }
  if (widget.type === 'timeseries') {
    options.display = preset === 'briefing' ? 'area' : 'line';
    options.curve = preset === 'briefing' ? 'monotone' : 'linear';
    options.lineWidth = preset === 'focus' ? 2.5 : 1.75;
    if (preset === 'briefing') options.fillOpacity = .18;
  }
  if (widget.type === 'stat') {
    options.showSparkline = preset !== 'focus';
    options.sparklinePlacement = preset === 'briefing' ? 'side' : 'background';
  }
  return { ...widget, options };
}
export function PresentationPresets({ widget, onApply }: { widget: Widget; onApply: (widget: Widget) => void }) {
  return <section aria-label="Presentation presets" className="rich-presets">
    <p className="rich-note">Curated starting points. Source queries, mappings and any authored tooltip query are preserved.</p>
    <div className="rich-preset-grid">
      {([
        ['focus', 'Focus', 'Less chrome, stronger signal'],
        ['investigate', 'Investigate', 'Grids, legends, deeper inspection'],
        ['briefing', 'Briefing', 'Soft fills, narrative hierarchy'],
      ] as const).map(([id, name, description]) => <button type="button" className="rich-preset" key={id}
        aria-label={'Apply ' + name + ' presentation preset'} onClick={() => onApply(presentationPreset(widget, id))}>
        <span className={'rich-preset-art rich-preset-' + id} aria-hidden="true"><i/><i/><i/><i/></span>
        <strong>{name}</strong><small>{description}</small>
      </button>)}
    </div>
  </section>;
}

/** Preserve advanced provider/saved-source bindings when switching miniature chart types. */
export function changeTooltipMiniType(view: TooltipView | undefined, type: 'none' | 'timeseries' | 'bar' | 'stat'): TooltipView | undefined {
  if (type === 'none') return undefined;
  return { ...(view ?? {}), type, source: view?.source ?? { type: 'series' }, height: view?.height ?? 120 };
}

export function TooltipContentControls({ widget, result, onOption }: Props) {
  const options = widget.options;
  const series = result.series?.[0];
  const point = series?.points.findLast(p => typeof p.value === 'number' && Number.isFinite(p.value)) ?? series?.points.at(-1);
  const view = options?.tooltipView;
  const supportsMetricContent = ['timeseries','bar','stat','table'].includes(widget.type);
  const supportsMiniChart = ['timeseries','bar','table','heatmap'].includes(widget.type);
  const types = [
    { value: 'none', label: 'No mini chart' },
    { value: 'timeseries', label: 'Mini history' },
    { value: 'bar', label: 'Mini bars' },
    { value: 'stat', label: 'Mini statistic' },
  ];
  if (view && !types.some(item => item.value === view.type)) types.push({ value:view.type, label:'Existing ' + view.type + ' (JSON)' });
  const reviseView = (patch: Partial<TooltipView>) => view && onOption('tooltipView', { ...view, ...patch });
  return <div className="rich-section">
    <div className="rich-section-title"><strong>Tooltip content</strong><span>Source-aware</span></div>
    {!supportsMetricContent && <p className="rich-note">This renderer owns its observation content. Common placement and size settings above apply, while its registered Data display fields and validated Configuration JSON control renderer-specific details.</p>}
    {supportsMetricContent && <>
    <RichField label="Heading" help="Blank uses the panel title.">
      <GammaInput aria-label="Tooltip heading" size="sm" maxLength={120} value={options?.tooltipTitle ?? ''}
        placeholder={widget.title} onChange={e => onOption('tooltipTitle', e.target.value || undefined)}/>
    </RichField>
    <div className="rich-pair">
      <RichField label="Value caption"><GammaInput aria-label="Tooltip value caption" size="sm" maxLength={80}
        value={options?.tooltipValueLabel ?? ''} placeholder="Observed value" onChange={e => onOption('tooltipValueLabel', e.target.value || undefined)}/></RichField>
      <NumericSetting label="Tooltip precision" value={options?.tooltipDecimals} min={0} max={8} placeholder="Inherit"
        onChange={v => onOption('tooltipDecimals', v)}/>
    </div>
    <GammaSwitch label="Include unit" checked={options?.tooltipShowUnit !== false}
      description="Exact source values remain available even when the display unit is hidden."
      onChange={v => onOption('tooltipShowUnit', v)}/>
    </>}
    {supportsMiniChart && !!result.series?.length && <section className="rich-subchart">
      <div className="rich-section-title"><strong>Embedded mini-chart</strong><span>Inside the tooltip</span></div>
      <RichField label="Type"><GammaSelect aria-label="Tooltip mini-chart type" size="sm" value={view?.type ?? 'none'}
        options={types} onValueChange={value => onOption('tooltipView', changeTooltipMiniType(view, value as 'none' | 'timeseries' | 'bar' | 'stat'))}/></RichField>
      {view && <>
        <div className="rich-pair">
          <RichField label="Height"><GammaSelect aria-label="Tooltip mini-chart height" size="sm" value={String(view.height ?? 120)}
            options={[80,120,160,200,320].map(height => ({value:String(height),label:height + 'px'}))}
            onValueChange={v => reviseView({ height:Number(v) as TooltipView['height'] })}/></RichField>
          <NumericSetting label="Mini-chart precision" value={view.decimals} min={0} max={8} placeholder="Inherit"
            onChange={v => reviseView({ decimals:v })}/>
        </div>
        <RichField label="Mini-chart heading">
          <GammaInput aria-label="Tooltip mini-chart heading" size="sm" value={view.title ?? ''} maxLength={120}
            placeholder="Historical context" onChange={e => reviseView({ title:e.target.value || undefined })}/>
        </RichField>
        <div className="rich-switches">
          <GammaSwitch label="Mini axes" checked={view.showAxis !== false} onChange={v => reviseView({ showAxis:v })}/>
          <GammaSwitch label="Mini grid" checked={view.showGrid === true} onChange={v => reviseView({ showGrid:v })}/>
          <GammaSwitch label="Mini legend" checked={view.showLegend === true} onChange={v => reviseView({ showLegend:v })}/>
        </div>
        {view.source && view.source.type !== 'series' && <p className="rich-note">An advanced {view.source.type} tooltip source is configured. Edit its query or variable bindings in Configuration JSON. The synthetic preview does not execute provider queries.</p>}
        <p className="rich-note">The actual mini chart uses bounded data from the current series. Hover or focus the chart preview to inspect it.</p>
      </>}
    </section>}
    <section className="rich-tooltip-preview" aria-label="Tooltip content preview">
      <div className="rich-section-title"><strong>Content sample</strong><span>Loaded fixture</span></div>
      {series ? <MetricDetails widget={widget} series={series} index={0} point={point} unit={widget.unit}
        description="Selected synthetic observation" timestampFirst/> :
        result.records ? <div className="rich-record-preview"><strong>{options?.tooltipTitle || widget.title}</strong>
          {result.records.columns.slice(0,5).map((column,i) => <div key={column.key}><span>{column.label ?? column.key}</span>
            <b>{String(result.records?.rows[0]?.[i] ?? 'No data')}</b></div>)}
          {!result.records.rows.length && <span>No loaded records</span>}
        </div> :
        <p className="rich-note">{result.traces?.length ? 'Inspect a trace span in the live chart to see its exact details.' : 'No loaded observations.'}</p>}
      <p className="rich-note">Content preview only. Actual collision handling, pinning and mini visualization are available in the live chart.</p>
    </section>
  </div>;
}

export function StatSettings({ widget, onOption }: Omit<Props,'result'>) {
  if (widget.type !== 'stat') return null;
  const opt=widget.options;
  const hasRange = opt?.min !== undefined && opt.max !== undefined && opt.min < opt.max;
  return <div className="rich-section">
    <GammaSwitch label="Show sparkline" checked={opt?.showSparkline !== false} onChange={v => onOption('showSparkline',v)}/>
    {opt?.showSparkline !== false && <RichField label="History placement"><GammaSelect size="sm" aria-label="Sparkline placement"
      value={opt?.sparklinePlacement ?? 'background'} options={[{value:'background',label:'Background'},{value:'side',label:'Beside value'}]}
      onValueChange={v => onOption('sparklinePlacement',v as WidgetOptions['sparklinePlacement'])}/></RichField>}
    <RichField label="Metric icon"><GammaSelect aria-label="Stat icon" size="sm" value={opt?.statIcon ?? 'none'}
      options={[{value:'none',label:'None'},...(['arrow-up','arrow-down','shield','network','activity','target','pie'] as const)
        .map(v => ({value:v,label:v.replace('-', ' ')}))]}
      onValueChange={v => onOption('statIcon',v === 'none' ? undefined : v as WidgetOptions['statIcon'])}/></RichField>
    <div className="rich-pair">
      <NumericSetting label="Stat minimum" value={opt?.min} onChange={v=>onOption('min',v)} placeholder="Auto"/>
      <NumericSetting label="Stat maximum" value={opt?.max} onChange={v=>onOption('max',v)} placeholder="Auto"/>
    </div>
    <fieldset className="rich-option-fieldset" disabled={!hasRange}><GammaSwitch label="Value progress bar" checked={opt?.showStatBar === true}
      description={hasRange ? 'Position the latest value against the explicit axis limits.' : 'Set the statistic minimum and maximum first.'}
      onChange={v => onOption('showStatBar',v)}/></fieldset>
    <NumericSetting label="Stale after (seconds)" value={opt?.staleAfterSeconds} min={1} max={2678400}
      placeholder="Disabled" onChange={v => onOption('staleAfterSeconds',v)} help="Indicate an old final observation."/>
  </div>;
}

export function LabelSettings({ widget, onOption }: Omit<Props,'result'>) {
  if (widget.type !== 'bar' && widget.type !== 'heatmap') return null;
  return <div className="rich-section">
    <GammaSwitch label="Show category labels" checked={widget.options?.showLabels !== false} onChange={v => onOption('showLabels',v)}/>
    <GammaSwitch label="Show values" checked={widget.options?.showValues !== false} onChange={v => onOption('showValues',v)}/>
  </div>;
}

export function AppearanceSettings({ widget, onOption }: Omit<Props,'result'>) {
  return <div className="rich-section">
    <p className="rich-note">The Gamma surface and text palette adapt to the active light/dark theme unless overridden.</p>
    <ColourSetting label="Panel background" value={widget.options?.background} onChange={v => onOption('background',v)}/>
    <ColourSetting label="Panel text" value={widget.options?.textColor} onChange={v => onOption('textColor',v)}/>
  </div>;
}

export function SeriesColourSettings({ widget, result, onOption }: Props) {
  const labelList=useId(), valueList=useId();
  if (!result.series?.length || widget.type !== 'timeseries') return null;
  const rules=widget.options?.seriesColors ?? [];
  const entries=result.series.flatMap(series => Object.entries(series.labels));
  const first=entries[0];
  const save=(next: typeof rules) => onOption('seriesColors',next.length ? next : undefined);
  const patch=(i:number,part:Partial<(typeof rules)[number]>) => save(rules.map((r,j)=>i===j?{...r,...part}:r));
  return <div className="rich-section">
    <p className="rich-note">Bind a colour to an exact provider label and value. Rules survive series reordering.</p>
    <datalist id={labelList}>{[...new Set(entries.map(([label])=>label))].map(v=><option key={v} value={v}/>)}</datalist>
    <datalist id={valueList}>{[...new Set(entries.map(([,value])=>value))].map(v=><option key={v} value={v}/>)}</datalist>
    {rules.map((rule,i)=><div className="rich-rule" key={i}>
      <div className="rich-rule-title"><strong>Rule {i+1}</strong><GammaButton variant="quiet" size="sm" iconOnly aria-label={'Remove series colour rule ' + (i+1)}
        onClick={()=>save(rules.filter((_,j)=>i!==j))}><Trash2 size={13}/></GammaButton></div>
      <div className="rich-pair">
        <RichField label="Source label"><GammaInput aria-label={'Series colour rule '+(i+1)+' label'} list={labelList} size="sm" value={rule.label} onChange={e=>patch(i,{label:e.target.value})}/></RichField>
        <RichField label="Exact value"><GammaInput aria-label={'Series colour rule '+(i+1)+' value'} list={valueList} size="sm" value={rule.value} onChange={e=>patch(i,{value:e.target.value})}/></RichField>
      </div>
      <ColourSetting label={'Series colour rule '+(i+1)+' colour'} value={rule.color} onChange={v=>patch(i,{color:v??'#428ff5'})}/>
    </div>)}
    <GammaButton size="sm" variant="secondary" disabled={!first || rules.length>=24}
      onClick={()=>first && save([...rules,{label:first[0],value:first[1],color:colour(widget.color)}])}><Plus size={13}/>Add series colour</GammaButton>
    {!first && <p className="rich-note">No source label/value pairs are present in this fixture.</p>}
  </div>;
}

export function ThresholdSettings({ widget, onOption }: Omit<Props,'result'>) {
  if (widget.type !== 'stat' && widget.type !== 'heatmap') return null;
  const rules=widget.options?.thresholds??[];
  const save=(next: typeof rules)=>onOption('thresholds',next.length?next:undefined);
  const patch=(i:number,part:Partial<(typeof rules)[number]>)=>save(rules.map((r,j)=>i===j?{...r,...part}:r));
  return <div className="rich-section">
    <p className="rich-note">Ascending threshold values set the colour of matching states. The schema checks order and duplicates.</p>
    {rules.map((rule,i)=><div className="rich-rule" key={i}>
      <div className="rich-rule-title"><strong>Threshold {i+1}</strong><GammaButton size="sm" variant="quiet" iconOnly aria-label={'Remove threshold '+(i+1)}
        onClick={()=>save(rules.filter((_,j)=>i!==j))}><Trash2 size={13}/></GammaButton></div>
      <div className="rich-pair">
        <NumericSetting label={'Threshold '+(i+1)+' value'} value={rule.value} onChange={v=>v!==undefined&&patch(i,{value:v})}/>
        <ColourSetting label={'Threshold '+(i+1)+' colour'} value={rule.color} onChange={v=>patch(i,{color:v??'#428ff5'})}/>
      </div>
      <RichField label="Caption"><GammaInput aria-label={'Threshold '+(i+1)+' caption'} size="sm" value={rule.label??''}
        maxLength={80} onChange={e=>patch(i,{label:e.target.value||undefined})}/></RichField>
    </div>)}
    <GammaButton size="sm" variant="secondary" disabled={rules.length>=12}
      onClick={()=>save([...rules,{value:rules.length?rules[rules.length-1].value+1:0,color:'#d69c54',label:'Threshold '+(rules.length+1)}])}>
      <Plus size={13}/>Add threshold</GammaButton>
  </div>;
}

export function AdvancedAxisSettings({ widget, onOption }: Omit<Props,'result'>) {
  if (widget.type !== 'timeseries') return null;
  const opt=widget.options, rules=opt?.referenceLines??[];
  const save=(next:typeof rules)=>onOption('referenceLines',next.length?next:undefined);
  const patch=(i:number,part:Partial<(typeof rules)[number]>)=>save(rules.map((r,j)=>i===j?{...r,...part}:r));
  return <div className="rich-section">
    <div className="rich-pair">
      <RichField label="Time scale"><GammaSelect size="sm" aria-label="Time scale" value={opt?.timeAxis??'linear'}
        options={[{value:'linear',label:'Elapsed'},{value:'calendar',label:'Calendar'}]}
        onValueChange={v=>onOption('timeAxis',v as WidgetOptions['timeAxis'])}/></RichField>
      <RichField label="Y-axis unit"><GammaSelect size="sm" aria-label="Y-axis unit display" value={opt?.axisUnit??'auto'}
        options={[{value:'auto',label:'Automatic'},{value:'ticks',label:'Tick labels'},{value:'caption',label:'Plot caption'}]}
        onValueChange={v=>onOption('axisUnit',v as WidgetOptions['axisUnit'])}/></RichField>
    </div>
    <div className="rich-pair">
      <NumericSetting label="Left plot inset (px)" min={8} max={240} value={opt?.plotInsetLeft} placeholder="Auto" onChange={v=>onOption('plotInsetLeft',v)}/>
      <NumericSetting label="Right plot inset (px)" min={8} max={120} value={opt?.plotInsetRight} placeholder="Auto" onChange={v=>onOption('plotInsetRight',v)}/>
    </div>
    <p className="rich-note">Insets align multiple charts. Calendar ticks respect the dashboard/viewer timezone.</p>
    <div className="rich-section-title"><strong>Reference lines</strong><span>{rules.length}/8</span></div>
    {rules.map((rule,i)=><div className="rich-rule" key={i}>
      <div className="rich-rule-title"><strong>Line {i+1}</strong><GammaButton size="sm" variant="quiet" iconOnly aria-label={'Remove reference line '+(i+1)} onClick={()=>save(rules.filter((_,j)=>i!==j))}><Trash2 size={13}/></GammaButton></div>
      <div className="rich-pair">
        <NumericSetting label={'Reference line '+(i+1)+' value'} value={rule.value} onChange={v=>v!==undefined&&patch(i,{value:v})}/>
        <ColourSetting label={'Reference line '+(i+1)+' colour'} value={rule.color} onChange={v=>patch(i,{color:v})}/>
      </div>
      <RichField label="Caption"><GammaInput aria-label={'Reference line '+(i+1)+' caption'} size="sm" maxLength={80} value={rule.label??''}
        onChange={e=>patch(i,{label:e.target.value||undefined})}/></RichField>
    </div>)}
    <GammaButton size="sm" variant="secondary" disabled={rules.length>=8} onClick={()=>save([...rules,{value:0,label:'Reference '+(rules.length+1)}])}><Plus size={13}/>Add reference line</GammaButton>
  </div>;
}

