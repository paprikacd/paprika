import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Bell, ChartNoAxesColumnIncreasing, Database, FileText, LayoutGrid, Search, Settings, X } from 'lucide-react';
import { ChartCursorProvider } from '../vendor/paprika/ui/src/features/insights/chart-cursor';
import gammaTheme from '../vendor/paprika/ui/src/features/insights/gamma/gamma-theme.module.css';
import { useLabMotion } from '../components/lab/motion';
import { PaprikaMark, NetworkMark } from './ReferenceShared';
import { ReferenceEdge } from './ReferenceEdge';
import { ReferenceReliability } from './ReferenceReliability';
import { ReferenceCompare } from './ReferenceCompare';
import './reference-base.css';
import './reference-responsive.css';
import { lensRoutes } from '../lenses/lens-routes';

export function ReferenceStudio() {
  const [study,setStudy]=useState(location.hash==='#reliability'?'reliability':'edge'),[actual,setActual]=useState(false),[compare,setCompare]=useState(false),[tools,setTools]=useState(false),[modal,setModal]=useState<'search'|'data'|'events'|null>(null),[search,setSearch]=useState(''),[width,setWidth]=useState(document.documentElement.clientWidth);
  const viewportRef=useRef<HTMLDivElement>(null);
  const [previewWidth,setPreviewWidth]=useState<number|null>(null);
  const motion=useLabMotion();
  useEffect(()=>{const change=()=>{setStudy(location.hash==='#reliability'?'reliability':'edge');setTools(false);setCompare(false);setModal(null);};window.addEventListener('hashchange',change);return()=>window.removeEventListener('hashchange',change);},[]);
  useLayoutEffect(()=>{
    const host=viewportRef.current?.parentElement;
    if(!host)return;
    const measure=()=>setWidth(Math.max(1,Math.floor(host.getBoundingClientRect().width)));
    measure();
    const observer=new ResizeObserver(measure);
    observer.observe(host);
    return()=>observer.disconnect();
  },[]);
  useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setTools(false);setModal(null);}};document.addEventListener('keydown',escape);return()=>document.removeEventListener('keydown',escape);},[]);
  const layoutWidth=Math.min(width,previewWidth??width);
  const reflow=!actual&&!compare;
  const scale=reflow?1:actual?1:Math.min(1,layoutWidth/1592);
  const preview=(next:number|null)=>{setPreviewWidth(next);setActual(false);setCompare(false);setTools(false);};
  const entries=[
    {label:'Edge Watch',href:'#edge'},
    {label:'Reliability Room',href:'#reliability'},
    {label:'Finance · portfolio allocation and returns',href:'#finance'},
    {label:'Website · traffic and experience',href:'#website'},
    {label:'Infrastructure · fleet and connectivity',href:'#infrastructure'},
    {label:'Market Risk · portfolio exposure and attribution',href:'#market-risk'},
    {label:'Inference Fleet · GPUs and request routing',href:'#inference-fleet'},
    {label:'Incident Room · telemetry and traces',href:'#incident-room'},
    {label:'Grid Operations · network and power balance',href:'#grid-operations'},
    ...lensRoutes.filter(item=>['New studies','Domain studies','SRE investigations'].includes(item.group)).map(item=>({label:item.label,href:`#${item.id}`})),
    {label:'Chart library',href:'#charts'},
    {label:'edge-01',href:'#edge'},
    {label:'uptime-api',href:'#reliability'},
    {label:'Network traffic',href:'#edge'},
    {label:'Incident calendar',href:'#reliability'},
  ].filter(item=>item.label.toLowerCase().includes(search.toLowerCase()));
  return <div ref={viewportRef} className="ref-viewport" data-actual={actual} data-layout={reflow?'reflow':'literal'} data-preview={previewWidth??undefined} style={{height:reflow?undefined:988*scale,width:previewWidth&&!actual?layoutWidth:undefined,marginInline:previewWidth?'auto':undefined}}>
    {previewWidth!==null&&<div className="ref-preview-bar"><span>Viewport preview · {layoutWidth}px</span><button onClick={()=>preview(null)}>Return to auto</button></div>}
    <div className={`${gammaTheme.scope} ref-app`} data-study={study} data-layout={reflow?'reflow':'literal'} data-density={layoutWidth<640?'mobile':layoutWidth<1200?'tablet':'desktop'} data-insights-theme="dark" data-motion={motion.reduced?'reduced':'auto'} style={{transform:reflow?'none':`scale(${scale})`,'--ref-layout-width':`${layoutWidth}px`} as CSSProperties}>
    <h1 className="ref-page-title">PAPRIKA / {study==='edge'?'EDGE WATCH':'RELIABILITY ROOM'}</h1><p className="ref-page-subtitle">Concept • synthetic data{study==='edge'?' (demo)':''}</p><div className="ref-outer-frame"/>
    <aside className="ref-rail" aria-label="Paprika navigation"><a className="ref-rail-logo" href="#edge" aria-label="Paprika Edge Watch"><PaprikaMark/></a><nav>
      <a className={study==='edge'?'ref-rail-selected':undefined} href="#edge" aria-current={study==='edge'?'page':undefined} aria-label="Edge Watch" title="Edge Watch"><LayoutGrid size={26} fill="currentColor" strokeWidth={0}/></a>
      <a className={study==='reliability'?'ref-rail-selected':undefined} href="#reliability" aria-current={study==='reliability'?'page':undefined} aria-label="Reliability Room" title="Reliability Room"><ChartNoAxesColumnIncreasing size={27}/></a>
      <button aria-label="Reference data sources" title="Reference data" onClick={()=>setModal('data')}><Database size={25}/></button>
      <button aria-label="Search dashboards" title="Search" onClick={()=>setModal('search')}><Search size={25}/></button>
      <button aria-label="Incident evidence" title="Incident evidence" onClick={()=>{location.hash='#reliability';}}><Bell size={26}/></button>
      <a href="#edge" aria-label="Network connections" title="Network connections"><NetworkMark size={26}/></a>
      <button aria-label="Reference notes" title="Reference notes" onClick={()=>setModal('data')}><FileText size={25}/></button>
      <button aria-label="View settings" title="View settings" onClick={()=>setTools(value=>!value)}><Settings size={26}/></button>
    </nav></aside>
    <ChartCursorProvider>{study==='edge'?<ReferenceEdge adaptive={reflow} onTools={()=>setTools(value=>!value)} onSearch={()=>setModal('search')}/>:<ReferenceReliability adaptive={reflow}/>}</ChartCursorProvider>
    {tools&&<div className="ref-tools-menu" role="dialog" aria-label="Reference view settings"><strong>Reference studies</strong><a href="#edge">Edge Watch</a><a href="#reliability">Reliability Room</a><hr/><button onClick={()=>{setPreviewWidth(null);setActual(v=>!v);setTools(false);}}>{actual?'Responsive auto':'Actual size · 1592 × 988'}</button><button onClick={()=>preview(768)}>Tablet preview · 768px</button><button onClick={()=>preview(390)}>Mobile preview · 390px</button>{previewWidth!==null&&<button onClick={()=>preview(null)}>Responsive auto</button>}<button onClick={()=>{setPreviewWidth(null);setCompare(true);setTools(false);}}>Compare to reference</button><button onClick={()=>motion.setPreference(motion.preference==='reduced'?'auto':'reduced')}>Motion · {motion.reduced?'Reduced':'Auto'}</button><button onClick={()=>{setModal('data');setTools(false);}}>Reference fixture notes</button><hr/><strong>Dashboard lenses</strong><a href="#finance">Finance · allocation & returns</a><a href="#website">Website · traffic & experience</a><a href="#infrastructure">Infrastructure · fleet & connectivity</a><a href="#market-risk">Market Risk · exposure & attribution</a><a href="#inference-fleet">Inference Fleet · GPUs & routing</a><a href="#incident-room">Incident Room · telemetry & traces</a><a href="#grid-operations">Grid Operations · network & dispatch</a>{lensRoutes.filter(item=>['New studies','Domain studies','SRE investigations'].includes(item.group)).map(item=><a key={item.id} href={`#${item.id}`}>{item.label}</a>)}<hr/><a href="#charts">Chart library · working examples</a><a href="#lab-edge">Interactive analytical lab</a><a href="https://chatgpt.com/space/page_6ae45780924881918c18270064f72c2c" target="_blank" rel="noreferrer">Design references</a></div>}
    {compare&&<ReferenceCompare study={study as 'edge'|'reliability'} onClose={()=>{setCompare(false);document.querySelector<HTMLButtonElement>('[aria-label="View settings"]')?.focus({preventScroll:true});}}/>}
    {modal&&<div className="ref-modal-backdrop" onClick={()=>setModal(null)}><section className="ref-modal" role="dialog" aria-modal="true" aria-label={modal==='search'?'Find a dashboard':'Reference fixture notes'} onClick={e=>e.stopPropagation()}><header><h2>{modal==='search'?'Find a dashboard':'Reference fixture notes'}</h2><button aria-label="Close dialog" onClick={()=>setModal(null)}><X size={20}/></button></header>{modal==='search'?<><input autoFocus value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search a dashboard, widget or service"/>{entries.map(entry=><p key={entry.label}><a href={entry.href} onClick={()=>setModal(null)}>{entry.label}</a></p>)}</>:<><p>These editable HTML and SVG studies reconstruct the two supplied 1592 × 988 concept images. The default open inspectors, sample labels, line profiles and table values follow that artwork.</p><p>The data is an authored visual fixture. Hidden trace segments are reconstructed, and several illustrative source numbers do not form one reconciled query population. The earlier analytical lab retains its separately tested telemetry and SLO contracts.</p><p>Maps use public-domain Natural Earth geometry with explicitly synthetic connection locations. Reference typography uses open-source Barlow and Roboto.</p><div className="ref-modal-links"><a href="#lab-edge">Open analytical lab</a><button onClick={()=>{setActual(v=>!v);setModal(null);}}>{actual?'Fit to window':'View at 1592 × 988'}</button></div></>}</section></div>}
  </div></div>;
}
