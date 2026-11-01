import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Ban, ChevronDown, Clock3, MoreVertical, Search } from 'lucide-react';
import { useDemoReplay, useLabMotion } from '../components/lab/motion';
import { Dot, MiniTrace, NetworkMark, RefPanel, RefSelect } from './ReferenceShared';
import { ReferenceTimeseries } from './ReferenceCharts';
import { EdgeSupporting } from './EdgeSupporting';
import './ReferenceEdge.css';
import {edgeMetricIngress,edgeMetricEgress,edgeMetricBlocked,edgeMetricConnections} from './reference-mini-profiles';
const metricTraces=[edgeMetricIngress,edgeMetricEgress,edgeMetricBlocked,edgeMetricConnections];
const GATEWAY_NOTE='Single traced profile: the reference fixture has one gateway trace, so no second gateway is offered.';

const DESTINATIONS=[['104.18.24.10',428.12,18.3],['151.101.1.69',312.47,13.4],['8.8.8.8',198.31,8.5],['1.1.1.1',162.09,6.9],['13.107.4.50',126.61,5.4],['52.85.214.33',98.14,4.2],['93.184.216.34',84.37,3.6],['203.0.113.77',73.21,3.1],['185.199.110.153',62.48,2.7],['172.217.18.142',58.33,2.5]] as const;
const EVENTS=[['2024-05-29','13:35:12','203.0.113.77 (AS64496)','10.42.0.15:443','geo-block: country',124],['2024-05-29','13:33:48','198.51.100.23 (AS45102)','172.16.5.10:80','rule: sql-injection',37],['2024-05-29','13:32:10','45.133.32.11 (AS201011)','10.42.1.8:8080','rule: scanner-detect',221],['2024-05-29','13:29:03','103.21.244.9 (AS131072)','10.42.0.22:22','geo-block: tor-exit',18]] as const;

export function ReferenceEdge({onTools,onSearch,adaptive=false}:{onTools:()=>void;onSearch:()=>void;adaptive?:boolean}) {
  const gateway='edge-01', [phase,setPhase]=useState(0), [rule,setRule]=useState('All rules'), [traffic,setTraffic]=useState('All traffic'),[chosen,setChosen]=useState<string|null>(null);
  const motion=useLabMotion(); useDemoReplay(()=>setPhase(value=>(value+1)%100000));
  const cards=useMemo(()=>[
    {label:'Ingress traffic',value:'842.15',unit:'Mb/s',color:'#00d9ef',Icon:ArrowDown,seed:1},
    {label:'Egress traffic',value:'218.46',unit:'Mb/s',color:'#9a6afa',Icon:ArrowUp,seed:6},
    {label:'Blocked traffic',value:'2.14',unit:'%',color:'#ff4e43',Icon:Ban,seed:12},
    {label:'Active connections',value:'18,432',unit:'',color:'#ffbd32',Icon:NetworkMark,seed:23},
  ],[]);
  const rows=traffic==='Top 5 destinations'?DESTINATIONS.slice(0,5):DESTINATIONS;
  const events=rule==='All rules'?EVENTS:EVENTS.filter(row=>row[4]===rule);
  return <div className="ref-edge">
    <div className="ref-edge-toolbar">
      <div className="ref-edge-field ref-edge-gateway" title={GATEWAY_NOTE}><span>Gateway</span><RefSelect label="Gateway" value={gateway} options={[gateway]} disabled title={GATEWAY_NOTE}/></div>
      <div className="ref-edge-field ref-edge-region"><span>Region</span><RefSelect label="Region" value="All regions" options={['All regions']}/></div>
      <div className="ref-edge-field ref-edge-range"><span>Time range</span><RefSelect label="Time range" value="Last 30 minutes" options={['Last 30 minutes']}/></div>
      <div className="ref-edge-field ref-edge-resolution"><span>Resolution</span><RefSelect label="Resolution" value="1 min avg" options={['1 min avg']}/></div>
      <div className="ref-edge-global"><Clock3 size={21}/><RefSelect label="Global time range" value="Last 30 minutes" options={['Last 30 minutes']}/></div>
      <button className="ref-live ref-replay-neutral ref-edge-demo" aria-label={motion.replaying?'Pause demo replay':'Play demo replay'} aria-pressed={motion.replaying} title="Play the authored Edge fixture; one synthetic minute advances every 1.8 seconds" onClick={motion.toggleReplay}><Dot color="#7d95a3"/>Demo data</button>
      <i className="ref-edge-divider"/><button className="ref-icon-button ref-edge-search" aria-label="Search dashboard" onClick={onSearch}><Search size={23}/></button><button className="ref-icon-button ref-edge-menu" aria-label="Dashboard options" onClick={onTools}><MoreVertical size={23}/></button>
    </div>
    {cards.map(({Icon,...card},index)=><section className={`ref-edge-metric ref-edge-metric-${index}`} key={card.label} aria-label={card.label}>
      <div className="ref-edge-metric-icon" style={{color:index===3?'#00c5ee':card.color,background:`${index===3?'#00c5ee':card.color}19`}}><Icon size={31}/></div>
      <div className="ref-edge-metric-label">{card.label}</div><div className="ref-edge-metric-value">{card.value}<span>{card.unit}</span></div>
      <div className="ref-edge-metric-period">Fixture value</div>
      <div className="ref-edge-metric-spark"><MiniTrace values={[...metricTraces[index]]} color={card.color} height={30} min={0} max={30}/></div>
    </section>)}
    <RefPanel title="Network traffic (ingress / egress)" className="ref-edge-traffic" info="Reference concept fixture. Cyan is inbound and violet is mirrored outbound. The plotted profiles and authored labels reproduce the supplied artwork; this study is independent of the analytical lab. Open query details for provenance." action={<div className="ref-edge-plot-controls"><RefSelect label="Traffic panel time range" value="Last 30 minutes" options={['Last 30 minutes']}/><RefSelect label="Traffic panel resolution" value="1 min avg" options={['1 min avg']}/></div>}><ReferenceTimeseries kind="edge" gateway={gateway} phase={phase}/></RefPanel>
    <RefPanel title="Top destinations" className="ref-edge-destinations" scrollLabel="Destination records" action={<RefSelect label="Destination traffic filter" value={traffic} options={['All traffic','Top 5 destinations']} onChange={setTraffic}/>} info="Authored reference destination values. Bar lengths use a common 740 Mb/s capacity; shares are copied concept labels from a separate destination population. These figures are not reconciled against the ingress headline.">
      <table className="ref-edge-destination-table"><colgroup><col style={{width:37}}/><col style={{width:142}}/><col style={{width:95}}/><col style={{width:148}}/><col style={{width:57}}/></colgroup><thead><tr><th>#</th><th>Destination</th><th>Traffic</th><th aria-label="Traffic comparison"/><th>%</th></tr></thead><tbody>{rows.map(([destination,value,share],i)=><tr key={destination} className={chosen===destination?'ref-edge-row-selected':''} onClick={()=>setChosen(chosen===destination?null:destination)}><td>{i+1}</td><td><button onClick={event=>{event.stopPropagation();setChosen(chosen===destination?null:destination);}}>{destination}</button></td><td>{value.toFixed(2)} Mb/s</td><td><div className="ref-edge-destination-track"><i style={{width:`${value/740*100}%`}}/></div></td><td>{share.toFixed(1)}%</td></tr>)}</tbody></table>
      {chosen&&<div className="ref-edge-destination-detail" role="status"><strong>{chosen}</strong><span>Selected destination · synthetic fixture</span><button aria-label="Clear destination selection" onClick={()=>setChosen(null)}>×</button></div>}
    </RefPanel>
    <EdgeSupporting adaptive={adaptive}/>
    <RefPanel title="Recent blocked requests" className="ref-edge-events" scrollLabel="Blocked request records" action={<RefSelect label="Blocked request rule filter" value={rule} options={['All rules',...EVENTS.map(row=>row[4])]} onChange={setRule}/>}>
      <table className="ref-edge-events-table"><colgroup><col style={{width:220}}/><col style={{width:301}}/><col style={{width:244}}/><col style={{width:360}}/><col style={{width:133}}/><col/></colgroup><thead><tr><th>Time (UTC)</th><th>Source</th><th>Destination</th><th>Rule</th><th>Count</th><th>Status</th></tr></thead><tbody>{events.map(row=><tr key={row[1]}><td><span>{row[0]}</span><span>{row[1]}</span></td><td>{row[2]}</td><td>{row[3]}</td><td>{row[4]}</td><td>{row[5]}</td><td><Dot color="#ff5145"/><span>Blocked</span></td></tr>)}</tbody></table>
    </RefPanel>
  </div>;
}
