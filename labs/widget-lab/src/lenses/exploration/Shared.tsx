import { useState, type ReactNode } from 'react';
import { Pencil } from 'lucide-react';
import { Panel } from '../../components/lab/StudyPrimitives';
import { WidgetVisualization } from '../../vendor/paprika/ui/src/features/insights/charts';
import type { Widget } from '../../vendor/paprika/ui/src/features/insights/schema';
import type { DrilldownContext } from '../../vendor/paprika/ui/src/features/insights/drilldown';
import type { EditLensWidget } from '../LensStudio';
import type { ExplorationPanel } from './data';
import './lenses.css';

export function ExplorationHeader({name,eyebrow,children}:{name:string;eyebrow:string;children?:ReactNode}){return <header className="xp-heading"><div><p>PAPRIKA / {eyebrow}</p><h1>{name}</h1></div><div className="xp-scope">{children}</div><span className="xp-synthetic"><i/>Concept · synthetic data</span></header>;}
export function MetricRibbon({items}:{items:{label:string;value:ReactNode;detail?:ReactNode;tone?:string}[]}){return <div className="xp-metrics">{items.map(item=><section key={item.label}><span>{item.label}</span><strong style={{color:item.tone}}>{item.value}</strong>{item.detail&&<small>{item.detail}</small>}</section>)}</div>;}
export function ExplorationWidgetPanel({panel,onEdit,onContextChange,linkedConfig,subtitle,className='',children}:{panel:ExplorationPanel;onEdit?:EditLensWidget;onContextChange?:(context:DrilldownContext)=>void;linkedConfig?:Widget['config'];subtitle?:ReactNode;className?:string;children?:ReactNode}){
 const [override,setOverride]=useState<Widget|null>(null);
 const current=override??panel.widget;
 const localConfig=Object.fromEntries(Object.entries(current.config??{}).filter(([key])=>!['selectedSource','selectedTarget','selectedId','activeIds'].includes(key)));
 const widget=linkedConfig&&current.pluginId===panel.widget.pluginId?{...current,config:{...localConfig,...linkedConfig}}:current;
 return <Panel title={widget.title} className={className} subtitle={subtitle} actions={onEdit&&<button className="xp-edit" aria-label={`Edit ${widget.title}`} onClick={()=>onEdit(widget,panel.result,setOverride)}><Pencil size={12}/><span>Edit</span></button>}><div className="xp-widget"><WidgetVisualization widget={widget} result={panel.result} onContextChange={onContextChange}/></div>{children}</Panel>;
}
