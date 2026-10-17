/**
 * Paprika deployment figures. All text and geometry remain editable SVG.
 * Isometric platforms and resource solids use ../anatomy/iso-kit.mjs,
 * Anatomy, Copyright (c) 2026 Ryan, MIT; see ../anatomy/LICENSE.
 * These are static 2.5D illustrations of documented behavior, not fleet data.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { slabOf, solidSvg, iso } from '../anatomy/iso-kit.mjs';

const out = dirname(fileURLToPath(import.meta.url));
const C = { paper:'#f2f2f3', white:'#ffffff', ink:'#1d2d3d', text:'#293b4d', muted:'#566c80', rule:'#bac7d1', pale:'#e7f0f8', steel:'#5980a6', blue:'#416180', green:'#2f6955', greenPale:'#e2eee8', amber:'#986317', amberPale:'#fff0cf', red:'#a63d3d', redPale:'#fae8e5' };
const esc = s => String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const text = (x,y,s,cls='body',extra='') => `<text x="${x}" y="${y}" class="${cls}" ${extra.replace(/fill="([^"]+)"/g,'style="fill:$1"')}>${esc(s)}</text>`;
const multi = (x,y,lines,cls='body',leading=25) => lines.map((s,i)=>text(x,y+i*leading,s,cls)).join('');
const line = (points,{color=C.blue,dash=false,width=2,arrow=false}={}) => `<path d="${points.map((p,i)=>`${i?'L':'M'}${p.join(' ')}`).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" ${dash?'stroke-dasharray="5 6"':''} ${arrow?`marker-end="url(#${color===C.amber?'arrow-amber':color===C.red?'arrow-red':'arrow'})"`:''}/>`;
const chip = (x,y,w,s,tone='blue',small=false) => {
  const [fg,bg] = tone==='amber'?[C.amber,C.amberPale]:tone==='red'?[C.red,C.redPale]:tone==='green'?[C.green,C.greenPale]:[C.blue,C.pale];
  return `<rect x="${x}" y="${y}" width="${w}" height="${small?28:32}" rx="3" fill="${bg}" stroke="${fg}" stroke-opacity=".24"/>${text(x+w/2,y+(small?19:22),s,'chip',`text-anchor="middle" fill="${fg}"`)}`;
};
const status = (x,y,s,tone='green',size=18) => {
  const color=tone==='red'?C.red:tone==='amber'?C.amber:tone==='blue'?C.blue:C.green;
  const glyph=tone==='red'?'×':tone==='amber'?'Ⅱ':tone==='blue'?'·':'✓';
  return `<circle cx="${x}" cy="${y-6}" r="10" fill="${color}"/>${text(x,y-1,glyph,'status-glyph','text-anchor="middle"')}${text(x+18,y,s,'status',`fill="${color}" font-size="${size}"`)}`;
};
const documentIcon = (x,y,color=C.blue) => `<path d="M${x} ${y}h17l8 8v25h-25Z M${x+17} ${y}v8h8 M${x+6} ${y+16}h13 M${x+6} ${y+22}h13 M${x+6} ${y+28}h8" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`;
const branchIcon = (x,y) => `<path d="M${x} ${y}v31m0-13c0-12 23-3 23-16" fill="none" stroke="${C.blue}" stroke-width="2.5"/><circle cx="${x}" cy="${y}" r="4" fill="${C.white}" stroke="${C.blue}" stroke-width="2"/><circle cx="${x}" cy="${y+31}" r="4" fill="${C.white}" stroke="${C.blue}" stroke-width="2"/><circle cx="${x+23}" cy="${y+2}" r="4" fill="${C.white}" stroke="${C.blue}" stroke-width="2"/>`;
const card = (x,y,w,h,{title='',kicker='',icon='doc',tone='blue',body='',footer=''}={}) => {
  const edge=tone==='amber'?C.amber:tone==='red'?C.red:C.rule;
  const top=tone==='amber'?C.amberPale:tone==='red'?C.redPale:C.white;
  return `<g><path d="M${x} ${y}l7-7h${w}l-7 7Z" fill="${C.white}" stroke="${edge}"/><path d="M${x+w} ${y}l7-7v${h}l-7 7Z" fill="${C.pale}" stroke="${edge}"/><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" fill="${top}" stroke="${edge}" stroke-width="1.4"/>${kicker?text(x+18,y+26,kicker,'kicker'):''}${icon==='git'?branchIcon(x+22,y+48):icon==='none'?'':documentIcon(x+19,y+46,tone==='amber'?C.amber:C.blue)}${text(x+(icon==='none'?18:60),y+69,title,'card-title')}${h>=104?line([[x+18,y+86],[x+w-18,y+86]],{color:C.rule,width:1}):''}${body}${footer}</g>`;
};
function solid(paths, kind='paper') {
  const palettes={ paper:['#e7eef3','#d5dfe7','#dfe7ee','#edf2f6','#f9fbfc'], blue:['#355978','#284961','#345c7b','#477699','#7ba5c5'], dark:['#273c50','#182d3f','#233c52','#38566f','#55758f'], green:['#45735f','#315644','#3d6c57','#568974','#8eb5a0'], ghost:['#eef1f3','#e2e8ed','#e8eef2','#f4f6f7','#ffffff'], amber:['#b48a46','#8c672c','#a57f3d','#c69b50','#e6c47b'] };
  const p=palettes[kind]||palettes.paper;
  return `<g style="--anatomy-paper:${p[0]};--anatomy-shade-0:${p[1]};--anatomy-shade-1:${p[2]};--anatomy-shade-2:${p[3]};--anatomy-shade-3:${p[3]};--anatomy-top:${p[4]};--anatomy-hi:${C.blue};--anatomy-faint:#93a8b9">${solidSvg(paths,{tone:'hi',crease:'faint'})}</g>`;
}
function island(cx,cy,{w=230,pods=3,kind='blue',ghost=false,mini=false}={}) {
  const P={origin:[cx,cy],scale:w/230*.88,azimuth:45,elevation:30};
  let result=`<ellipse cx="${cx}" cy="${cy+30}" rx="${w*.49}" ry="${w*.13}" fill="${C.ink}" opacity=".045"/>`;
  result+=solid(slabOf({x:-80,y:-47,w:160,d:94,r:5},0,8,P,4,1),'paper');
  for(let i=0;i<pods;i++) {
    const x=-53+i*37,y=-12;
    result+=solid(slabOf({x,y,w:26,d:26,r:1},8,mini?22:30,P,2,0.5),ghost&&i===pods-1?'ghost':kind);
    const port=iso([x+13,y+26,19],P);
    result+=`<circle cx="${port[0]}" cy="${port[1]}" r="2" fill="${C.white}" opacity=".78"/>`;
  }
  const p=iso([53,38,8],P);
  result+=`<circle cx="${p[0]}" cy="${p[1]}" r="2.2" fill="${kind==='amber'?C.amber:C.green}"/>`;
  return result;
}
function fileStack(cx,cy,w=150) {
  const P={origin:[cx,cy],scale:w/150*.85,azimuth:45,elevation:30};
  let r='';
  for(let i=0;i<3;i++) r+=solid(slabOf({x:-47,y:-32,w:94,d:64,r:2},i*12,4,P,3,1),i===2?'blue':'paper');
  return r;
}
function jobIcon(x,y,kind='blue',scale=1) {
  const P={origin:[x,y],scale:.7*scale,azimuth:45,elevation:30};
  return solid(slabOf({x:-17,y:-17,w:34,d:34,r:1},0,37,P,2,.5),kind);
}
const region = (x,y,w,h,label,fill=C.white) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${fill}" fill-opacity=".65" stroke="${C.rule}" stroke-dasharray="4 5"/>${text(x+16,y+28,label,'region')}`;
function svg(name,w,h,title,desc,body) {
  const css=`text{font-family:Arial,Helvetica,sans-serif;fill:${C.text}}.body{font-size:18px}.small{font-size:16px;fill:${C.muted}}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:17px}.kicker{font-size:13px;font-weight:700;letter-spacing:1.2px;fill:${C.muted}}.card-title{font-size:23px;font-weight:700;fill:${C.ink}}.heading{font-size:29px;font-weight:700;fill:${C.ink}}.subtitle{font-size:18px;fill:${C.muted}}.region{font-size:14px;font-weight:700;letter-spacing:1px;fill:${C.blue}}.chip{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:15px;font-weight:600}.status{font-size:18px;font-weight:600}.status-glyph{fill:white;font-size:16px;font-weight:700}.big-number{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:44px;font-weight:600}.iso-fill{fill:var(--anatomy-paper);stroke:none}.iso-top{fill:var(--anatomy-top)}.iso-shade[data-shade="0"]{fill:var(--anatomy-shade-0)}.iso-shade[data-shade="1"]{fill:var(--anatomy-shade-1)}.iso-shade[data-shade="2"]{fill:var(--anatomy-shade-2)}.iso-shade[data-shade="3"]{fill:var(--anatomy-shade-3)}.iso-line{fill:none;stroke:var(--anatomy-hi);stroke-width:.8;stroke-linejoin:round}.iso-crease{stroke:var(--anatomy-faint);stroke-width:.6} ${w===600?'.body{font-size:23px}.small{font-size:20px}.mono{font-size:21px}.kicker{font-size:17px}.card-title{font-size:28px}.heading{font-size:32px}.subtitle{font-size:22px}.region{font-size:19px}.chip{font-size:19px}.status{font-size:22px}':''}`;
  const result=`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-labelledby="title desc"><title id="title">${esc(title)}</title><desc id="desc">${esc(desc)}</desc><!-- Isometric geometry: Anatomy, Copyright (c) 2026 Ryan, MIT. See ../anatomy/LICENSE. --><style>${css}</style><defs>${[['arrow',C.blue],['arrow-amber',C.amber],['arrow-red',C.red]].map(([id,color])=>`<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1L9 5L1 9" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>`).join('')}</defs><rect width="${w}" height="${h}" fill="${C.paper}"/>${body}</svg>\n`;
  writeFileSync(join(out,name+'.svg'),result);
  console.log(`${name}.svg · ${w}×${h} · ${Math.round(Buffer.byteLength(result)/1024)} KB`);
}

function deployment(mobile=false,focus=null) {
  const title='From source revision to observed deployment';
  const desc='Illustrative deployment lifecycle. An Application source is pinned to Git revision 9f3a2c1. An optional Pipeline runs configured work. A Release renders manifests and applies to a Kubernetes target selected by Stage.cluster. Target health and desired/live synchronization are observed separately.';
  const focusRect=(x,y,w,h)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${C.steel}" fill-opacity=".09" stroke="${C.blue}" stroke-width="2.6"/>`;
  const name=`deployment${focus?'-'+focus:''}${mobile?'-mobile':''}`;
  if(!mobile) {
    let r=text(40,44,title,'heading')+text(40,74,'One source identity. Configured work. A Release. Evidence from the target.','subtitle');
    r+=region(28,106,838,362,'PAPRIKA MANAGEMENT CLUSTER')+region(895,106,277,362,'KUBERNETES TARGET',C.pale);
    const bounds={source:[39,149,235,254],build:[313,149,233,254],apply:[586,149,233,254],observe:[906,149,250,296]};
    if(focus)r+=focusRect(...bounds[focus]);
    r+=line([[266,260],[319,260]],{arrow:true})+line([[536,260],[592,260]],{arrow:true})+line([[806,260],[916,260]],{arrow:true});
    r+=card(48,165,215,224,{title:'Application',kicker:'01 / SOURCE',icon:'git',body:multi(67,278,['source.git','revision: 9f3a2c1'],'mono',27)+text(67,351,'Values + parameters','small')});
    r+=card(322,165,212,224,{title:'Pipeline',kicker:'02 / OPTIONAL WORK',body:jobIcon(487,367)+multi(341,279,['build → test','configured steps'],'mono',27),footer:chip(341,344,103,'optional','blue',true)});
    r+=card(595,165,211,224,{title:'Release',kicker:'03 / RENDER + APPLY',body:multi(614,279,['Pinned Git SHA','Rendered YAML'],'body',27)+fileStack(704,363,98)});
    r+=text(830,242,'apply','small');
    r+=card(918,165,225,125,{title:'Deployment',kicker:'04 / LIVE RESOURCES',body:''})+island(1030,366,{w:222,pods:3})+text(1030,422,'Pods','small','text-anchor="middle"');
    r+=line([[1030,466],[1030,514],[156,514],[156,398]],{arrow:true,width:focus==='observe'?3.4:2});
    r+=`<rect x="420" y="497" width="365" height="35" fill="${C.paper}"/>`+text(602,522,'Observe health + desired/live sync','body','text-anchor="middle"');
    r+=chip(828,556,320,'Stage.cluster → target cluster','blue')+text(42,578,'Illustrative configuration · Pipeline work is optional; Stage selects the target.','small');
    svg(name,1200,620,title,desc,r);
  } else {
    let r=text(28,42,'Source → Release → target','heading')+multi(28,76,['A pinned revision becomes a deployment,','then Paprika observes the live resources.'],'subtitle',28);
    r+=region(20,135,560,428,'MANAGEMENT CLUSTER');
    const bounds={source:[46,180,510,126],build:[46,325,510,110],apply:[46,454,510,101]};
    if(focus&&focus!=='observe')r+=focusRect(...bounds[focus]);
    r+=line([[300,295],[300,332]],{arrow:true})+line([[300,424],[300,461]],{arrow:true});
    r+=card(55,192,484,104,{title:'Application',kicker:'01 / SOURCE',icon:'git',body:text(304,260,'Git SHA 9f3a2c1','mono')});
    r+=card(55,337,484,88,{title:'Pipeline',kicker:'02 / OPTIONAL WORK',body:text(263,404,'build → test','mono')});
    r+=card(55,466,484,78,{title:'Release',kicker:'03 / RENDER + APPLY',body:text(259,532,'Rendered YAML','mono')});
    r+=line([[300,564],[300,596]],{arrow:true})+text(324,588,'Stage.cluster','small');
    r+=region(20,610,560,218,'KUBERNETES TARGET',C.pale);
    if(focus==='observe')r+=focusRect(22,612,556,214);
    r+=island(408,747,{w:229,pods:3})+text(50,685,'Deployment','card-title')+text(50,716,'+ Pods','body');
    r+=line([[543,828],[543,882],[15,882],[15,245],[48,245]],{arrow:true,width:focus==='observe'?3.4:2})+text(67,862,'Observe health + desired/live sync','small');
    svg(name,600,910,title,desc,r);
  }
}

function pipeline(blocked=false,mobile=false) {
  const title=blocked?'A failed prerequisite stops dependent work':'Dependencies open a parallel test window';
  const desc=`Illustrative Pipeline with maxParallel two. Build succeeds, then unit-test and policy-test can run concurrently. ${blocked?'Policy-test fails and package cannot start.':'Both tests are running and package waits for both to succeed.'} Artifacts are declared output references, not automatic environment promotion.`;
  const testState=blocked?'Succeeded':'Running';
  const testTone=blocked?'green':'blue';
  if(!mobile) {
    let r=text(40,44,title,'heading')+text(40,74,'One Pipeline · each step runs as container work on the management cluster.','subtitle');
    r+=region(28,106,1144,404,'MANAGEMENT CLUSTER / PIPELINE EXECUTION');
    r+=chip(942,126,208,'maxParallel: 2','blue');
    r+=line([[267,304],[328,304],[328,229],[389,229]],{arrow:true})+line([[328,304],[328,397],[389,397]],{arrow:true});
    r+=line([[674,229],[751,229],[751,304],[875,304]],{arrow:true,color:blocked?C.red:C.blue,dash:blocked})+line([[674,397],[751,397],[751,304]],{color:blocked?C.red:C.blue,dash:blocked});
    r+=card(55,231,211,164,{title:'build',kicker:'STEP 01',icon:'none',body:jobIcon(218,359,'green')+status(80,355,'Succeeded')});
    r+=card(391,159,282,143,{title:'unit-test',kicker:'DEPENDS ON BUILD',icon:'none',body:jobIcon(624,268,blocked?'green':'blue')+status(417,264,testState,testTone)});
    r+=card(391,328,282,143,{title:'policy-test',kicker:'DEPENDS ON BUILD',icon:'none',tone:blocked?'red':'blue',body:jobIcon(624,437,blocked?'amber':'blue')+status(417,433,blocked?'Failed':'Running',blocked?'red':'blue')});
    r+=card(879,231,253,164,{title:'package',kicker:'DEPENDS ON BOTH TESTS',icon:'none',tone:blocked?'red':'blue',body:jobIcon(1080,359,'ghost')+status(904,355,blocked?'Blocked':'Waiting',blocked?'red':'amber')});
    r+=text(756,330,'depends','small');
    r+=`<rect x="40" y="540" width="1120" height="57" rx="3" fill="${C.white}" stroke="${C.rule}"/>`+documentIcon(56,551)+text(98,563,'DECLARED OUTPUT REFERENCE','kicker')+text(98,586,'artifacts[0].path: oci://registry.example/package:9f3a2c1','mono');
    svg(blocked?'pipeline-blocked':'pipeline-running',1200,620,title,desc,r);
  } else {
    let r=multi(28,40,blocked?['A failed test blocks','dependent work.']:['Build once. Run tests','in parallel.'],'heading',37)+text(28,120,'Illustrative Pipeline · maxParallel: 2','subtitle');
    r+=region(20,150,560,615,'MANAGEMENT CLUSTER');
    r+=line([[300,334],[300,370],[165,370],[165,410]],{arrow:true})+line([[300,370],[435,370],[435,410]],{arrow:true});
    r+=line([[165,552],[165,589],[300,589],[300,627]],{arrow:true,color:blocked?C.red:C.blue,dash:blocked})+line([[435,552],[435,589],[300,589]],{color:blocked?C.red:C.blue,dash:blocked});
    r+=card(155,220,282,114,{title:'build',kicker:'STEP 01',icon:'none',body:status(178,323,'Succeeded')});
    r+=card(48,414,231,140,{title:'unit-test',kicker:'DEPENDS: BUILD',icon:'none',body:status(70,529,testState,testTone)});
    r+=card(321,414,231,140,{title:'policy-test',kicker:'DEPENDS: BUILD',icon:'none',tone:blocked?'red':'blue',body:status(343,529,blocked?'Failed':'Running',blocked?'red':'blue')});
    r+=card(155,632,282,114,{title:'package',kicker:'DEPENDS: BOTH TESTS',icon:'none',tone:blocked?'red':'blue',body:status(178,735,blocked?'Blocked':'Waiting',blocked?'red':'amber')});
    r+=text(30,810,'Outputs are declared references.','body')+text(30,842,'Example: oci://…/package:9f3a2c1','small');
    svg(blocked?'pipeline-blocked-mobile':'pipeline-running-mobile',600,880,title,desc,r);
  }
}

function promotion(mobile=false) {
  const title='Promote a revision across separate Applications';
  const desc='Illustrative Git promotion. DEV, STG and PROD Application records live on the management cluster and each routes to its own target. Staging verification Jobs probe DEV before staging deploys SHA 9f3a2c1. Production verification Jobs probe STG. Production candidate 9f3a2c1 waits for manual approval while accepted revision 7d41f02 stays deployed. Jobs execute in the management cluster, not between remote clusters; no artifact is transferred.';
  if(!mobile) {
    let r=text(40,44,title,'heading')+text(40,74,'Each environment keeps its own configuration and deployment target.','subtitle');
    r+=region(28,105,1144,308,'PAPRIKA MANAGEMENT CLUSTER / APPLICATION RECORDS + VERIFICATION JOBS');
    r+=line([[331,235],[430,235]],{arrow:true})+line([[726,235],[825,235]],{arrow:true});
    r+=text(380,212,'same SHA','small','text-anchor="middle"')+text(777,212,'same SHA','small','text-anchor="middle"');
    const app=(x,env,name,mode,hold=false)=>card(x,158,274,140,{title:env+' / '+name,kicker:'APPLICATION',icon:'none',tone:hold?'amber':'blue',body:text(x+18,272,mode,'mono')});
    r+=app(54,'DEV','checkout-dev','GitOps / Auto')+app(449,'STG','checkout-stg','Promotion / Auto')+app(844,'PROD','checkout-prod','Promotion / Manual',true);
    r+=chip(71,316,238,'accepted 9f3a2c1','green')+chip(466,316,238,'accepted 9f3a2c1','green')+chip(861,316,238,'candidate 9f3a2c1','amber');
    r+=status(466,387,'Job: dev-smoke passed','green')+status(861,387,'Job: stg-smoke passed','green');
    // Downstream verification Jobs probe the upstream target, never the next target.
    r+=line([[450,384],[407,384],[407,474],[242,474],[242,540]],{dash:true,arrow:true})+line([[845,384],[802,384],[802,474],[637,474],[637,540]],{dash:true,arrow:true});
    r+=text(326,454,'probe DEV','small','text-anchor="middle"')+text(720,454,'probe STG','small','text-anchor="middle"');
    r+=line([[100,351],[100,494]],{arrow:true})+line([[495,403],[495,494]],{arrow:true})+line([[890,403],[890,494]],{arrow:true,color:C.amber,dash:true});
    r+=text(76,438,'deploy','small')+text(502,438,'deploy','small')+text(900,438,'held','small',`fill="${C.amber}"`);
    [191,586,981].forEach((x,i)=>{r+=region(x-154,492,308,163,['DEV TARGET','STG TARGET','PROD TARGET'][i],C.pale)+island(x,581,{w:215,pods:3,kind:i===2?'dark':'blue'})+text(x,638,i===2?'accepted 7d41f02':'deployed 9f3a2c1','mono','text-anchor="middle"');});
    r+=text(40,689,'Dotted probes run from management Jobs to upstream environments. PROD waits for candidate-specific approval.','small');
    svg('promotion',1200,720,title,desc,r);
  } else {
    let r=multi(28,40,['Separate Applications.','One candidate revision.'],'heading',37)+multi(28,120,['Verification Jobs run on the management cluster','and probe the upstream environment.'],'subtitle',28);
    const rows=[{y:186,env:'DEV',trigger:'GitOps / Auto',revision:'deployed 9f3a2c1',job:null},{y:462,env:'STG',trigger:'Promotion / Auto',revision:'deployed 9f3a2c1',job:'Job: dev-smoke → DEV'},{y:738,env:'PROD',trigger:'Promotion / Manual',revision:'accepted 7d41f02',job:'Job: stg-smoke → STG'}];
    for(let i=0;i<rows.length;i++){
      const a=rows[i],hold=i===2;
      r+=region(20,a.y,560,252,a.env+' APPLICATION → '+a.env+' TARGET',hold?C.amberPale:C.white);
      r+=card(43,a.y+54,288,112,{title:a.env+' Application',kicker:'MANAGEMENT RECORD',icon:'none',tone:hold?'amber':'blue',body:text(61,a.y+155,a.trigger,'mono')});
      r+=line([[337,a.y+120],[370,a.y+120]],{arrow:true,color:hold?C.amber:C.blue,dash:hold})+island(455,a.y+134,{w:170,pods:3,kind:hold?'dark':'blue',mini:true});
      r+=text(359,a.y+181,a.env+' cluster','small');
      r+=hold?chip(42,a.y+185,286,'candidate 9f3a2c1 · HOLD','amber'):chip(42,a.y+185,271,'accepted 9f3a2c1','green');
      if(hold)r+=text(358,a.y+216,'accepted 7d41f02','mono');
      if(a.job)r+=text(44,a.y+243,a.job,'small');
      if(i<2)r+=line([[300,a.y+253],[300,a.y+273]],{arrow:true});
    }
    r+=line([[339,705],[560,705],[560,320],[531,320]],{dash:true,arrow:true})+line([[339,981],[572,981],[572,596],[531,596]],{dash:true,arrow:true});
    r+=multi(28,1043,['PROD keeps its accepted release while awaiting approval.','A selected Git SHA is not an artifact transfer.'],'small',28);
    svg('promotion-mobile',600,1090,title,desc,r);
  }
}

function evidence(mobile=false) {
  const title='Compare desired configuration with live state';
  const desc='Synthetic desired/live comparison for apps/v1 Deployment api. The desired manifest requests three replicas while the live object has spec.replicas two. Synchronization reports a difference; health separately reports that two of two live replicas are ready. Neither signal replaces the other.';
  if(!mobile) {
    let r=text(40,44,title,'heading')+text(40,74,'Sync answers “does it match?” Health answers “is it working?”','subtitle');
    r+=card(49,144,350,257,{title:'Desired manifest',kicker:'MANIFEST EXCERPT',body:multi(70,260,['apiVersion: apps/v1','kind: Deployment','metadata: {name: api}','spec:'],'mono',27)+`<rect x="68" y="354" width="312" height="32" fill="${C.pale}"/>`+text(83,377,'replicas: 3','mono')});
    r+=card(794,144,350,257,{title:'Live object',kicker:'KUBERNETES OBJECT EXCERPT',body:multi(815,260,['apiVersion: apps/v1','kind: Deployment','metadata: {name: api}','spec:'],'mono',27)+`<rect x="813" y="354" width="312" height="32" fill="${C.redPale}"/>`+text(828,377,'replicas: 2','mono')});
    r+=line([[406,276],[470,276]],{arrow:true})+line([[787,276],[724,276]],{arrow:true});
    r+=`<rect x="473" y="204" width="248" height="194" rx="3" fill="${C.white}" stroke="${C.rule}"/>`+text(597,237,'FIELD DIFFERENCE','kicker','text-anchor="middle"')+text(597,282,'spec.replicas','mono','text-anchor="middle"')+text(544,343,'3','big-number',`text-anchor="middle" fill="${C.blue}"`)+text(597,337,'≠','card-title','text-anchor="middle"')+text(650,343,'2','big-number',`text-anchor="middle" fill="${C.red}"`)+text(597,377,'desired          live','small','text-anchor="middle"');
    r+=island(224,471,{w:240,pods:3})+island(970,471,{w:240,pods:2});
    r+=text(224,530,'3 requested replicas','small','text-anchor="middle"')+text(970,530,'2 live replicas','small','text-anchor="middle"');
    r+=chip(422,451,350,'Sync: different','red')+chip(422,500,350,'Health: 2/2 ready','green');
    r+=text(40,592,'Synthetic example · a healthy workload can still differ from its desired configuration.','small');
    svg('evidence',1200,620,title,desc,r);
  } else {
    let r=multi(28,40,['Desired and live are','separate evidence.'],'heading',37)+text(28,120,'Synthetic Deployment / api example','subtitle');
    r+=card(43,173,500,189,{title:'Desired manifest',kicker:'DECLARED CONFIGURATION',body:multi(63,290,['kind: Deployment','spec.replicas: 3'],'mono',35)})+fileStack(470,333,85);
    r+=line([[300,369],[300,414]],{arrow:true});
    r+=card(43,424,500,189,{title:'Live Kubernetes object',kicker:'OBSERVED STATE',body:multi(63,541,['kind: Deployment','spec.replicas: 2'],'mono',35)})+island(466,587,{w:132,pods:2,mini:true});
    r+=chip(43,658,500,'Sync: different · 3 requested / 2 live','red')+chip(43,720,500,'Health: 2/2 live replicas ready','green');
    r+=multi(28,800,['A workload can be healthy while its configuration','differs from the desired manifest.'],'small',28);
    svg('evidence-mobile',600,860,title,desc,r);
  }
}

deployment(); deployment(true);
for(const focus of ['source','build','apply','observe']){deployment(false,focus);deployment(true,focus);}
pipeline(); pipeline(false,true); pipeline(true); pipeline(true,true);
promotion(); promotion(true);
evidence(); evidence(true);
