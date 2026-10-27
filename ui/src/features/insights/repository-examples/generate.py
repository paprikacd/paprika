"""Regenerate portable examples from the reviewed, sanitized source inventories.
Run from repository root: python3 ui/src/features/insights/repository-examples/generate.py
The source repositories are never modified; optional authored static data is snapshotted separately.
"""
import copy
import itertools
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
OUT = Path(__file__).resolve().parent
DOC = ROOT / 'docs/design/insights/repository-examples'
SHORT = json.loads((DOC / 'shorted-sources.json').read_text())
UP = json.loads((DOC / 'uptime-sources.json').read_text())
CATALOG, FIXTURES = [], []
COLORS = ['#53876a', '#2d7ca6', '#bd8439', '#a86386']
PROVIDERS = {
 'prometheus': {'id':'source-shorted-prometheus','name':'Shorted source Prometheus','type':'prometheus','capabilities':['metrics']},
 'postgresql': {'id':'source-shorted-postgresql','name':'Shorted source PostgreSQL','type':'postgresql','capabilities':['metrics','records']},
 'shorted': {'id':'source-shorted-api','name':'Shorted application API','type':'shorted','capabilities':['metrics','records']},
 'uptime': {'id':'source-uptime-api','name':'Uptime organization API','type':'uptime','capabilities':['metrics','records']},
}

def slug(s): return re.sub('[^a-z0-9]+','-',str(s).lower()).strip('-')
def compact(v): return json.dumps(v,ensure_ascii=False,separators=(',',':'))
def template(v): return re.sub(r'"@@([a-zA-Z0-9_]+)@@"',r'{{\1}}',compact(v))
def frame(columns, rows):
 return {'columns':[{'key':k,'type':t,**({'unit':u[0]} if u else {})} for k,t,*u in columns], 'rows':rows}
def metric_fixture(key, title, base=20, labels=None, variation=0, trend=0):
 return {'id':key,'metric':'paprika_example_'+key.replace('-','_'),'series':[{'name':title,'labels':labels or {},'base':base,'variation':variation,'trend':trend}]}
def record_fixture(key, data): return {'id':key,'metric':'paprika_example_'+key.replace('-','_'),'records':data}
def make_entry(source,project='shorted',suffix=''):
 id=source.get('id',source.get('proposedExampleId'))+suffix
 paths=[d['path'] for d in source.get('sourceDocuments',[])] or source.get('sources',[])
 revision=SHORT['repository']['revision'] if project=='shorted' else UP['repository']['revision']
 title=source['title']
 base={'schemaVersion':1,'id':id,'title':title,'description':'Source-derived example; review its source coverage before using live data.','folder':f'Repository examples/{project.title()}','timeRange':'6h','refreshInterval':0,'widgets':[]}
 e={'id':id,'title':title,'project':project,'description':source.get('sourceProperties',{}).get('description',title)[:500],'source':{'revision':revision,'paths':paths},'sample':{'dashboards':[{**copy.deepcopy(base),'id':'example-'+id,'title':title+' · Sample'}],'savedQueries':[]},'live':{'dashboards':[copy.deepcopy(base)],'savedQueries':[]},'liveStatus':'ready','providers':[],'coverage':[],'limitations':[]}
 CATALOG.append(e)
 return e

def variables(e,defs):
 for mode in ['sample','live']:
  e[mode]['dashboards'][0]['variables']=copy.deepcopy(defs)

def coverage(e,key,title,kind,**extra):
 c={'sourceId':str(key),'sourceTitle':title,'sourceType':kind,'sampleWidgetIds':[],'liveWidgetIds':[],'status':'mapped','notes':[],**extra}
 e['coverage'].append(c);return c

def add(e,key,title,kind='metrics',visual='timeseries',unit='',fixture=None,live=None,provider='shorted',params=None,filter_columns=None,config=None,options=None,cov=None,notes=None,live_description=None):
 key=slug(key); wid=key[:72]; qid=(slug(e['id'])+'-'+key)[:70]; params=params or []
 fixture=fixture or metric_fixture(qid,title)
 fixture['id']=qid;fixture['metric']='paprika_example_'+qid.replace('-','_')
 # Parameter fixtures enumerate explicitly named sample options, never evaluate live languages.
 defs={v['name']:v for v in e['sample']['dashboards'][0].get('variables',[])}
 sampleparams=[p for p in params if p['type']=='string']
 if kind=='metrics' and sampleparams:
  combos=list(itertools.product(*[defs.get(p['name'],{}).get('options',[str(p.get('defaultValue',''))])[:10] for p in sampleparams]))[:100]
  original=fixture['series'];fixture['series']=[]
  for n,combo in enumerate(combos):
   for series in original:
    item=copy.deepcopy(series);item['labels'].update(dict(zip([p['name'] for p in sampleparams],combo)))
    item['name']=series['name']+' · '+' / '.join(combo)
    if item['base'] is not None: item['base']*=1+n*.12
    fixture['series'].append(item)
 FIXTURES.append(fixture)
 if kind=='records':
  selector={'fixture':fixture['metric']}
  if filter_columns: selector['filters']={column:'@@'+param+'@@' for param,column in filter_columns.items()}
  if fixture.get('portfolioParameters'):selector['parameters']={param:'@@'+param+'@@' for param in fixture['portfolioParameters'].values()}
  sq=template(selector)
 elif kind=='traces': sq='{ resource.paprika.fixture = '+json.dumps(fixture['metric'])+(' && resource.service.name = {{service}}' if any(p['name']=='service' for p in params) else '')+' }'
 else: sq=fixture['metric']+('{' + ','.join(p['name']+'={{'+p['name']+'}}' for p in sampleparams)+'}' if sampleparams else '')
 for mode,query in [('sample',sq),('live',live)]:
  if query is None: continue
  dest=e[mode]; index=len(dest['dashboards'][0]['widgets']); provider_id={'metrics':'example-prometheus','traces':'example-tempo','records':'example-records'}[kind] if mode=='sample' else PROVIDERS[provider]['id']
  id=('ex-' if mode=='sample' else 'src-')+qid
  bindings=[{'parameter':p['name'],'source':'variable','variable':p['name']} for p in params]
  metadata={'project':e['project'],'sourceRevision':e['source']['revision'],'sourcePath':(e['source']['paths'] or ['Paprika feature coverage'])[0][:256],'sourcePanel':str(cov['sourceId'] if cov else key)[:256],'dataMode':('source-authored static' if e['id']=='shorted-housing-feature' else 'synthetic sample') if mode=='sample' else 'live source'}
  saved={'schemaVersion':1,'id':id,'name':title.strip()[:120],'description':(('Source-authored static values for ' if e['id']=='shorted-housing-feature' else 'Illustrative sample for ') if mode=='sample' else 'Source query for ')+e['title'][:300],'tags':['repository-example',e['project'],mode],'metadata':metadata,'providerId':provider_id,'kind':kind,'query':query.strip()}
  if mode=='live' and live_description:saved['description']=live_description
  if params: saved['parameters']=params
  dest['savedQueries'].append(saved)
  widget={'id':wid,'title':title.strip()[:120],'type':visual,'providerId':provider_id,'query':query.strip(),'queryRef':{'id':id,**({'bindings':bindings} if bindings else {})},'unit':unit[:24],'options':{'showTooltip':True,'decimals':2,**(options or {})},'layout':{'x':(index%2)*6,'y':(index//2)*5,'w':6,'h':5}}
  if visual=='stat':widget['options'].setdefault('showSparkline',True)
  if config is not None:
   widget.update(type='plugin',pluginId=visual,dataKind=kind,config=config)
  dest['dashboards'][0]['widgets'].append(widget)
  if cov:cov[mode+'WidgetIds'].append(wid)
  if mode=='live' and PROVIDERS[provider] not in e['providers']:e['providers'].append(PROVIDERS[provider])
 if cov:
  if live is None:cov['status']='unsupported-live'
  if notes:cov['notes']+=notes
 return wid

def arrange_widgets(widgets):
 x,y,height=0,0,0
 for widget in widgets:
  compact=widget['type']=='stat'
  width,h=(3,3) if compact else (6,5)
  if x+width>12:y+=height;x=0;height=0
  widget['layout']={'x':x,'y':y,'w':width,'h':h}
  x+=width;height=max(height,h)
  if x==12:y+=height;x=0;height=0

def finish(e,history_limit=None):
 if any(provider['type']=='postgresql' for provider in e['providers']):e['limitations'].append('Live PostgreSQL requires a dedicated unprivileged reader role with SELECT on the source tables and verify-full TLS using a CA trusted by the gateway. Provider remapping alone does not provision credentials or trust.')
 if not e['live']['dashboards'][0]['widgets']:
  e.pop('live');e['liveStatus']='unavailable'
 elif any(c['status']=='unsupported-live' for c in e['coverage']): e['liveStatus']='partial'
 for mode in ['sample','live']:
  if mode in e:
   e[mode]['dashboards'][0]['description']=(('Authored historical data. ' if e['id']=='shorted-housing-feature' else 'Illustrative data. ') if mode=='sample' else 'Live provider reads. ')+e['description'][:430]
   if mode=='live' and history_limit:e[mode]['dashboards'][0]['description']=e[mode]['dashboards'][0]['description'][:350].rstrip('. ')+f'. History charts show the latest {history_limit} source observations. Source date filters apply; the dashboard time range does not rewrite this SQL.'
   arrange_widgets(e[mode]['dashboards'][0]['widgets'])

# All seven Grafana definitions, one saved query for each target including hidden targets.
for src in SHORT['examples'][:7]:
 e=make_entry(src)
 bounded_history=False
 e['limitations']=['Multi-target panels are split into individually inspectable widgets; their source grouping remains in coverage.','Grafana-only row groups, shared cursors, field overrides, reducers, panel links and annotations remain documented in the source inventory. Paprika uses its native latest-sample presentation.']+src.get('notes',[])
 vars=[]
 for v in src['variables']:
  if v['type']=='datasource':continue
  current=v.get('current',{}).get('value')
  options=[str(o['value']) for o in v.get('options',[]) if o.get('value') not in [None,'$__all']]
  if not options: options=['CBA','BHP','ZIP'] if v['name'] in ['stocks','top10shorts'] else ['postgres-demo'] if v['name']=='instance' else ['shorted'] if v['name']=='db' else ['postgres']
  default=options[0]
  vars.append({'name':v['name'],'label':v.get('label',v['name']),'defaultValue':default,'options':options})
  if v.get('multi') or v['type']=='query': e['limitations'].append(f"Variable {v['name']}: explicit single-value control replaces Grafana dynamic/multi-select discovery; original query and options retained in inventory.")
 variables(e,vars)
 for panel in src['panels']:
  ordinal=panel['sourceOrdinal']; title=panel['title']; typ=panel['type'];targets=panel['targets']
  if not targets:
   c=coverage(e,f'panel-{ordinal}',title,typ,sourcePointer=panel['sourcePointer'],status='source-only',notes=['Source row grouping is retained in the inventory.'] if typ=='row' else ['Source has no provider query.'])
   if typ!='row':
    data=frame([('title','string'),('description','string')],[[title,'Source placeholder narrative; no company facts are asserted.' if typ=='text' else 'Source Grafana News plugin. No configured feed was present in the portable definition.']])
    add(e,f'p{ordinal}',title,kind='records',visual='record-list',fixture=record_fixture('x',data),config={'title':'title','body':'description'},cov=c)
   continue
  for ti,target in enumerate(targets):
   key=f'p{ordinal}-t{ti}';expression=target.get('expression');lang=target['language'];ref=target.get('refId') or str(ti+1)
   c=coverage(e,key,title,typ,sourcePointer=target['sourcePointer'],language=lang,**({'sourceQuery':expression} if expression else {}))
   defaults=panel.get('presentation',{}).get('fieldConfig',{}).get('defaults',{})
   unit=defaults.get('unit', (panel.get('presentation',{}).get('yaxes') or [{}])[0].get('format',''))
   legend=target.get('settings',{}).get('legendFormat')
   for override in panel.get('presentation',{}).get('fieldConfig',{}).get('overrides',[]):
    if override.get('matcher',{}).get('id')=='byName' and override['matcher'].get('options')==legend:
     for prop in override.get('properties',[]):
      if prop.get('id')=='unit':unit=prop['value']
   unit={'none':'','short':'','percent':'%','percentunit':'ratio','bytes':'B','decbytes':'B','reqps':'req/s','ops':'ops/s','currencyUSD':'USD'}.get(unit,unit)
   options={'decimals':max(0,min(8,defaults.get('decimals',0 if typ=='stat' and unit=='' else 2) or 0))}
   if typ=='stat':options['showSparkline']=panel.get('presentation',{}).get('options',{}).get('graphMode','none')=='area'
   steps=defaults.get('thresholds',{}).get('steps',[])
   thresholds=[]
   for st in steps:
    if isinstance(st.get('value'),(int,float)):
     color=st.get('color','');color={'red':'#c34e4e','green':'#53876a','yellow':'#bd8439','orange':'#c77637','blue':'#2d7ca6'}.get(color,color)
     if re.fullmatch('#[a-fA-F0-9]{6}',color):thresholds.append({'value':st['value'],'color':color})
   if thresholds:options['thresholds']=thresholds[:12]
   visual={'graph':'timeseries','table-old':'table','barchart':'bar','bargauge':'bar','gauge':'threshold-gauge','piechart':'pie'}.get(typ,typ)
   config={} if visual in ['threshold-gauge','pie'] else None
   base=0 if any(t in title.lower() for t in ['corrupt','failed','error','blocked']) else 95 if 'ratio' in title.lower() else 25+ordinal*3+ti
   if unit=='ratio':base=.02 if 'error' in title.lower() else .95
   fixture=metric_fixture(key,title,base,variation=0 if typ=='stat' else max(abs(base)*.12,.01))
   params=[];live=expression;provider='prometheus';notes=[];live_description=None
   if expression:
    used=[v for v in vars if re.search(r'\$(?:\{)?'+re.escape(v['name'])+r'\b',expression)]
    params=[{'name':v['name'],'type':'string','defaultValue':v['defaultValue']} for v in used]
    if lang=='promql':
     live=expression.replace('$__rate_interval','5m').replace('$__interval','1m')
     if live!=expression:notes.append('Grafana adaptive interval macro is explicitly fixed to 5m/1m; exact source expression retained.')
     for v in used:
      # Replace complete quoted matcher values: saved-query binding emits the quotes safely.
      live=re.sub(r'''(["'])\$'''+re.escape(v['name'])+r'''\1''','{{'+v['name']+'}}',live)
      live=live.replace('${'+v['name']+'}','{{'+v['name']+'}}')
    elif lang=='sql-postgresql':
     provider='postgresql';sql=expression.strip().rstrip(';');sqlparams=[]
     for i,v in enumerate(used):sql=sql.replace('$'+v['name'],'$'+str(i+1));sqlparams.append('@@'+v['name']+'@@')
     projection={'value':'shorted percentage','labels':['metric']} if typ=='bargauge' else {'value':'value','time':'time','labels':['metric']}
     if 'time' in projection:
      # Bound the recent end of source history before the connector's row cap.
      # Keep the source query/filters intact inside the wrapper and restore
      # chronological order for charts after selecting the latest 100 rows.
      sql='SELECT * FROM (\n  SELECT * FROM (\n'+sql+'\n  ) AS source_history\n  ORDER BY "time" DESC NULLS LAST\n  LIMIT 100\n) AS recent_history\nORDER BY "time" ASC NULLS LAST'
      history_note='Live SQL history selects the latest 100 source observations, then orders them chronologically. Source stock/date filters remain intact; full history and dashboard-range filtering are not implied. The exact original SQL is retained in provenance.'
      notes.append(history_note)
      if history_note not in e['limitations']:e['limitations'].append(history_note)
      bounded_history=True
      live_description='Latest 100 source observations for '+e['title']+'. Source stock/date filters apply; the dashboard time range does not rewrite this SQL.'
     live=template({'sql':sql,'parameters':sqlparams,'projection':projection})
     notes.append('Grafana variable lists become one bound PostgreSQL parameter per selected stock; no SQL interpolation. '+('Source calculations and filters are retained.' if 'time' in projection else 'Source query is otherwise retained.'))
   else:
    notes.append('Grafana test-data gauge is explicitly synthetic and has no live provider equivalent.');live=None
   if len(targets)>1: notes.append(f'Split from source panel {ordinal}, target {ref}; sibling targets retain independent units and queries.')
   if target.get('settings',{}).get('hide'):notes.append('Source target is hidden; exposed here for complete query coverage.')
   if notes:c['status']='adapted'
   add(e,key,title+(f' · {ref}' if len(targets)>1 else ''),visual=visual,unit=unit,fixture=fixture,live=live,provider=provider,params=params,config=config,options=options,cov=c,notes=notes,live_description=live_description)
 finish(e,history_limit=100 if bounded_history else None)

# The checked-in My Dashboard preset and its separate eleven-widget coverage gallery.
def shorted_query(operation,args=None,value=None,time=None,labels=None):
 q={'operation':operation,'args':args or {}}
 if value:q['projection']={'value':value,**({'time':time} if time else {}),**({'labels':labels} if labels else {})}
 return template(q)
STOCKS=['CBA','BHP','CSL','WBC','ANZ']
shortrows=[[s,n,i,v] for s,n,i,v in [('CBA','Commonwealth Bank','Banks',1.24),('BHP','BHP Group','Materials',2.41),('CSL','CSL','Health Care',.84),('WBC','Westpac','Banks',1.72),('ANZ','ANZ Group','Banks',.96)]]
shortframe=frame([('product_code','string'),('name','string'),('industry','string'),('short_position','number','percent')],shortrows)
quotes=frame([('stock_code','string'),('close','number','AUD'),('change','number','AUD'),('change_percent','number','percent')],[[s,v,d,d/v*100] for s,v,d in [('CBA',135.2,1.2),('BHP',43.5,-.45),('CSL',282.5,2.5),('WBC',28.8,.35),('ANZ',29.2,.15)]])
correlations=frame([('stock_code','string'),('other_stock_code','string'),('correlation','number')],[[a,b,1 if a==b else round(.25+(i+j)*.08,2)] for i,a in enumerate(STOCKS[:3]) for j,b in enumerate(STOCKS[:3])])
news=frame([('headline','string'),('summary','string'),('source','string'),('sentiment','string'),('url','string'),('stock_code','string')],[['Illustrative trading update','Fictional sample article for dashboard rendering.','Sample feed','neutral','https://example.com/market-update','CBA'],['Illustrative market briefing','This is sample content, not financial advice or live reporting.','Sample feed','positive','https://example.com/briefing','BHP']])
my=make_entry(SHORT['examples'][7]);variables(my,[{'name':'period','defaultValue':'3M','options':['1M','3M','6M','1Y','2Y']}])
periodparam=[{'name':'period','type':'string','defaultValue':'3M'}]
for idx,p in enumerate(SHORT['examples'][7]['panels']):
 c=coverage(my,p['id'],p['title'],p['type'],sourcePointer=p['sourceSelector'],status='adapted',notes=['Native record view replaces the source component; row sparklines, stock search and nested tooltips remain source-only.'])
 add(my,'top-shorts' if idx==0 else 'industry',p['title'],kind='records',visual='record-table' if idx==0 else 'record-treemap',fixture=record_fixture('x',shortframe if idx==0 else frame([('product_code','string'),('industry','string'),('short_position','number')],[[r[0],r[2],r[3]] for r in shortrows])),live=shorted_query('top_shorts' if idx==0 else 'industry_treemap',{'period':'@@period@@','limit':10}),params=periodparam,config={'columns':['product_code','name','short_position'],'pageSize':10} if idx==0 else {'label':'product_code','group':'industry','value':'short_position'},cov=c)
my['limitations']=['Source period selection is retained for live reads. Sample records are fixed illustrative snapshots and do not imply period-derived calculations.','The treemap uses positive area; percentage-change sign coloring and nested sector layout are not identical to the source.'];finish(my)

src={'id':'shorted-widget-catalog','title':'Shorted widget collection','sourceDocuments':SHORT['examples'][7]['sourceDocuments']}
e=make_entry(src);variables(e,[{'name':'stock','label':'Stock','defaultValue':'CBA','options':STOCKS},{'name':'period','label':'Period','defaultValue':'3M','options':['1M','3M','6M','1Y']},{'name':'shares','label':'Holding shares (sample)','defaultValue':'100','options':['25','50','100']}])
stockparam=[{'name':'stock','type':'string','defaultValue':'CBA'}]
for case in SHORT['productWidgetCoverage']:
 typ=case['type'];title=typ.replace('_',' ').title();c=coverage(e,typ,title,typ,status='adapted',notes=case.get('notes',[])+['Source settings and full feature list remain in shorted-sources.json.'])
 if typ in ['TOP_SHORTS','SCREENER']:
  live=shorted_query('top_shorts' if typ=='TOP_SHORTS' else 'screener',{'limit':10})
  add(e,typ,title,kind='records',visual='record-table',fixture=record_fixture('x',shortframe if typ=='TOP_SHORTS' else frame([('stock_code','string'),('company_name','string'),('industry','string'),('short_pct','number'),('short_pct_change_4w','number')],[[r[0],r[1],r[2],r[3],-.12] for r in shortrows])),live=live,config={'pageSize':10},cov=c,notes=['The native ScreenStocks operation retains four-week change and reports truncated result universes.'] if typ=='SCREENER' else [])
 elif typ=='INDUSTRY_TREEMAP':add(e,typ,title,kind='records',visual='record-treemap',fixture=record_fixture('x',shortframe),live=shorted_query('industry_treemap'),config={'label':'product_code','group':'industry','value':'short_position'},cov=c)
 elif typ in ['STOCK_CHART','TIME_SERIES_ANALYSIS']:
  add(e,typ,title,unit='AUD' if typ=='STOCK_CHART' else '%',fixture=metric_fixture('x',title,135 if typ=='STOCK_CHART' else 1.4,variation=2 if typ=='STOCK_CHART' else .2),live=shorted_query('stock_prices' if typ=='STOCK_CHART' else 'stock_history',{'product_code':'@@stock@@','period':'@@period@@'},'close' if typ=='STOCK_CHART' else 'short_position','timestamp',['stock_code' if typ=='STOCK_CHART' else 'product_code']),params=stockparam+periodparam,cov=c,notes=['Raw source series retained. Normalization, moving averages, oscillators, brush controls and mixed axes are not implemented by this view.'])
 elif typ=='CORRELATION_MATRIX':add(e,typ,title,kind='records',visual='record-matrix',fixture=record_fixture('x',correlations),live=shorted_query('market_correlations',{'stock_codes':STOCKS[:3],'period':'3m'}),config={'x':'stock_code','y':'other_stock_code','value':'correlation','min':-1,'max':1},cov=c)
 elif typ=='NEWS_FEED':add(e,typ,title,kind='records',visual='record-list',fixture=record_fixture('x',news),live=shorted_query('market_news',{'limit':10}),config={'title':'headline','body':'summary','subtitle':'source','status':'sentiment','url':'url'},cov=c)
 elif typ=='PORTFOLIO_SUMMARY':
  data=frame([('stock_code','string'),('shares','number'),('price','number','AUD'),('value','number','AUD'),('day_change','number','AUD')],[[s,qty,p,round(qty*p,2),round(qty*d,2)] for s,qty,p,d in [('CBA',100,135.2,1.2),('BHP',50,43.5,-.45),('CSL',25,282.5,2.5),('WBC',80,28.8,.35),('WOW',40,35.1,.12)]])
  quantities={'CBA':100,'BHP':50,'CSL':25,'WBC':80,'WOW':40}
  holdingparams=[{'name':code.lower()+'_shares','type':'number','defaultValue':quantity} for code,quantity in quantities.items()]
  for mode in ['sample','live']: e[mode]['dashboards'][0]['variables'] += [{'name':p['name'],'label':p['name'].replace('_',' ').upper(),'defaultValue':str(p['defaultValue'])} for p in holdingparams]
  data=frame([('stock_code','string'),('quantity','number'),('close','number','AUD'),('market_value','number','AUD'),('day_change','number','AUD'),('change','number','AUD')],[[s,qty,price,qty*price,qty*change,change] for s,qty,price,change in [('CBA',100,135.2,1.2),('BHP',50,43.5,-.45),('CSL',25,282.5,2.5),('WBC',80,28.8,.35),('WOW',40,35.1,.12)]])
  holdingfixture=record_fixture('x',data);holdingfixture['portfolioParameters']={code:code.lower()+'_shares' for code in quantities}
  add(e,typ,title,kind='records',visual='record-table',fixture=holdingfixture,live=shorted_query('portfolio_positions',{'positions':[{'stock_code':code,'quantity':'@@'+code.lower()+'_shares@@'} for code in quantities]}),params=holdingparams,config={'columns':['stock_code','quantity','close','market_value','day_change'],'pageSize':10},cov=c,notes=['Explicit source default holdings and editable share variables are used with current quotes. No private portfolio is queried. Cost basis can be added in the saved query positions.'])
 elif typ=='SECTOR_PERFORMANCE':
  add(e,typ,title,fixture=metric_fixture('x','Financials',1.2,labels={'sector':'Financials'}),visual='bar',unit='%',live=shorted_query('sector_performance',value='performance',labels=['sector']),cov=c,notes=['Exact source representative baskets use current quote percentage changes; period is not a historical return. A missing constituent yields unknown aggregate rather than a fabricated zero.'])
 else:
  add(e,typ,title,kind='records',visual='record-table',fixture=record_fixture('x',quotes),live=shorted_query('market_quotes',{'stock_codes':STOCKS}),config={'pageSize':10},cov=c,notes=['Current quotes are retained. Add/remove/search and per-row historical sparklines are source controls requiring a separate adaptation.'])
e['limitations']=['This is the source widget catalog coverage collection, not an additional checked-in dashboard preset.','Live records use actual native RPCs; portfolio values derive only from explicit quantities, and sector values use the source representative baskets.'];finish(e)

# Housing static datasets are extracted once with their source revision/hash, not invented telemetry.
e=make_entry(SHORT['examples'][8]);housing=json.loads((OUT/'housing-data.json').read_text())
for p in SHORT['examples'][8]['panels']:
 c=coverage(e,p['id'],p['title'],p['component'],status='adapted',notes=['Source-authored static dataset; live refresh is not applicable to the baked history. Exact scalar values are preserved in this record adaptation.']+p.get('features',[]))
 data=housing[p['id']]
 configs={
 'bank-short-basket':{'x':'date','y':['CBA','WBC','NAB','ANZ']},
 'policy-price':{'x':'year','y':['house_price_index','investor_share'],'rightAxis':['investor_share'],'annotations':[{'x':1985,'label':'CGT introduced + NG quarantined'},{'x':1987,'label':'NG quarantine reversed'},{'x':1999,'label':'50% CGT discount'}]},
 'buying-power':{'x':'year','y':['debt_to_income','price_to_income'],'rightAxis':['price_to_income'],'annotations':[{'x':2014,'label':'APRA investor-credit growth cap'},{'x':2017,'label':'APRA interest-only lending cap'},{'x':2021,'label':'3pp serviceability buffer'}]},
 'borrowing-power':{'x':'rate','y':['aggressive','conservative']},
 'international-corrections':{'x':'year','y':['AUS','JPN','USA','CHN']},
 }
 add(e,p['id'],p['title'],kind='records',visual='records-line',fixture=record_fixture('x',data),config=configs[p['id']],cov=c)
 for suffix,title,config in ([('-percent','Bank short positions (%)',{'x':'date','y':['CBA','WBC','NAB','ANZ']})] if p['id']=='bank-short-basket' else [('-aligned','Housing corrections aligned to peak',{'x':'years_since_peak','y':['AUS','JPN','USA','CHN']})] if p['id']=='international-corrections' else []):
  add(e,p['id']+suffix,title,kind='records',visual='records-line',fixture=record_fixture('x',housing[p['id']+suffix]),config=config,cov=c)
 if p['id']=='policy-price':add(e,'policy-landlords','House prices and negatively geared landlords',kind='records',visual='records-line',fixture=record_fixture('x',data),config={'x':'year','y':['house_price_index','negatively_geared_landlords'],'rightAxis':['negatively_geared_landlords']},cov=c)
 c['status']='source-only';c['notes'].append('Authored static records preserve historical axes and source values. Source toggle alternatives are explicit sibling widgets; scenario slider is an exact precomputed rate curve.')
e['limitations']=['Housing source uses attributed baked histories, not an observability provider. The optional HousingService live tail is not implemented by the Shorted adapter.','Borrowing-power records enumerate the source elasticity model: illustrative scenarios, not forecasts. Historical dates and model constants are not shifted into a recent dashboard time range.'];finish(e)

# Industry source collection. All five channel identities and their actual records stay explicit.
e=make_entry(SHORT['examples'][9]);variables(e,[{'name':'industry','defaultValue':'Banks','options':['Banks','Materials','Health Care']}])
industryparam=[{'name':'industry','type':'string','defaultValue':'Banks'}]
for p in SHORT['examples'][9]['panels']:
 c=coverage(e,p['id'],p['title'],p['component'],status='adapted',notes=['The source channel contains bucket charts, entity rankings, source citations and derived counters. Records retain these fields; source formulas are preserved in inventory.'])
 metric=p.get('controls',[{}])[0].get('default','record_count')
 data=frame([('industry','string'),('signal_kind','string'),('metric_key','string'),('metric_label','string'),('unit','string'),('bucket_label','string'),('bucket_start','timestamp'),('total_value','number'),('record_count','number'),('entity_count','number'),('zero_value_count','number')],[[industry,p['id'],metric,p['title'],p.get('unit',''),year,f'{year[:4]}-07-01T00:00:00Z',value,120,8,2] for industry in ['Banks','Materials','Health Care'] for year,value in [('2022-23',3200000),('2023-24',3500000),('2024-25',3900000)]])
 add(e,p['id'],p['title'],kind='records',visual='record-table',fixture=record_fixture('x',data),live=shorted_query('industry_time_buckets',{'industry':'@@industry@@','signal_kind':p['id'],'metric_key':metric}),params=industryparam,filter_columns={'industry':'industry'},config={'columns':['signal_kind','metric_key','bucket_label','total_value','unit','entity_count'],'pageSize':20},cov=c,notes=['The native industry response is filtered by exact signal_kind and metric_key before row limiting. No SQL or arbitrary field expressions are accepted.'])
# Source attribution is a distinct source collection region, not discarded narrative.
c=coverage(e,'source-attribution','Sources and licences','attribution',status='adapted')
data=frame([('source_key','string'),('display_name','string'),('publisher','string'),('licence','string'),('source_url','string')],[['ato','Illustrative source register','Australian Taxation Office','Consult the source licence','https://www.ato.gov.au/']])
add(e,'sources','Sources and licences',kind='records',visual='record-table',fixture=record_fixture('x',data),live=shorted_query('industry_sources',{'industry':'@@industry@@'}),params=industryparam,config={'pageSize':10},cov=c)
e['limitations']=['Industry filter is shared across all live reads, and each channel selects its source metric. Source-derived counter formulas remain in the inventory; raw bucket values and entity counts are preserved.','Crowding overview uses a different industry profile aggregate; its exact transform is not implemented by this records adapter.'];finish(e)

# Protected admin reads use their own secret and fixed paths; freeform errors/log URLs are excluded.
e=make_entry(SHORT['examples'][10]);variables(e,[{'name':'environment','label':'Environment','defaultValue':'production','options':['production','development',''] }])
for p in SHORT['examples'][10]['panels']:
 c=coverage(e,p['id'],p['title'],p['type'],notes=['Uses adminToken-only fixed GET endpoints. Hostnames, execution IDs, log URIs and backend freeform error messages are intentionally omitted.'])
 op={'fleet-health':'admin_fleet','needs-attention':'admin_issues','jobs-overview':'admin_jobs','market-data-sync':'admin_sync'}[p['id']]
 if op=='admin_fleet':data=frame([('status','string'),('active_jobs','number'),('critical_jobs','number'),('overdue_jobs','number'),('warning_jobs','number'),('retired_jobs','number'),('stale','boolean')],[['degraded',4,0,0,1,1,False]])
 elif op=='admin_sync':data=frame([('run_id','string'),('status','string'),('started_at','timestamp'),('total_duration_seconds','number'),('shorts_records_updated','number'),('prices_records_updated','number'),('environment','string')],[['sample-run','success','2026-10-27T01:00:00Z',42.5,2400,1900,'production'],['sample-dev-run','success','2026-10-27T00:00:00Z',12.5,200,100,'development']])
 else:data=frame([('name','string'),('display_name','string'),('health','string'),('last_run_status','string'),('schedule_human','string'),('duration_seconds','number'),('retired','boolean'),('stale','boolean')],[['sample-sync','Market sync','warning','succeeded','Daily',42.5,False,False]])
 args={'environment':'@@environment@@','limit':20,'exclude_local':True} if op=='admin_sync' else {}
 params=[{'name':'environment','type':'string','defaultValue':'production'}] if op=='admin_sync' else []
 adminfixture=record_fixture('x',data)
 if op=='admin_sync':adminfixture['allFilterValues']={'environment':''}
 add(e,p['id'],p['title'],kind='records',visual='record-table',fixture=adminfixture,live=shorted_query(op,args),params=params,filter_columns={'environment':'environment'} if params else None,config={'pageSize':20},cov=c)
e['limitations']=['Live admin access requires an explicitly supplied adminToken credential; public API tokens are never forwarded to admin routes.','Retired jobs do not degrade fleet health. Stale source data remains visible. Interactive execution, cache flush and privileged log links are excluded.'];finish(e)

# Uptime application dashboards reuse the pinned-organization adapter and its exact scalar columns.
def uq(op,args=None,value=None,labels=None):
 q={'operation':op,'args':args or {}}
 if value:q['projection']={'value':value,**({'labels':labels} if labels else {})}
 return template(q)
for source in UP['primaryDashboards']:
 e=make_entry(source,'uptime');is_slo=source['proposedExampleId']=='uptime-slo';is_overview=source['proposedExampleId']=='uptime-overview'
 if is_slo:variables(e,[{'name':'windowDays','label':'SLO window (days)','defaultValue':'30','options':['7','14','30','60','90']}])
 params=[{'name':'windowDays','type':'number','defaultValue':30}] if is_slo else []
 args={'windowDays':'@@windowDays@@'} if is_slo else {}
 for p in source['panels']:
  k=p['id'];c=coverage(e,k,p['title'],p['type'],notes=[p.get('semantics','')]);value=None;op='overview' if is_overview else 'slo_summary' if is_slo else 'reliability_summary';data=None;visual='stat';config=None;unit=p.get('unit','')[:24]
  if is_overview:
   value={'services':'serviceCount','configured-monitors':'monitorCount','active-alerts':'activeAlertCount','loaded-security-results':'securityResultCount'}.get(k)
   if k=='service-signals':
    op='service_signals';visual='record-table';config={'pageSize':10};data=frame([('serviceId','string'),('serviceName','string'),('availability','string'),('enabledMonitorCount','number'),('responseTimeMs','number'),('securityScore','number'),('securityRisk','string')],[['svc-api','Public API','Healthy',3,84,92,'Low'],['svc-web','Web app','Needs attention',2,410,65,'Medium'],['svc-worker','Worker','Waiting for data',1,None,None,None]])
   elif k=='needs-attention':
    op='alert_events';visual='record-list';config={'title':'alertName','body':'status','subtitle':'triggeredAt'};data=frame([('alertName','string'),('status','string'),('triggeredAt','timestamp')],[['Web response latency','ALERT_EVENT_STATUS_TRIGGERED','2026-10-27T01:00:00Z']])
  elif is_slo:
   value={'total-services':'serviceCount','average-uptime':'averageUptime','sla-status':'onTrackCount','burn-alerts':'burnAlertCount'}.get(k)
   if not value:
    op='slo';visual='record-table';config={'pageSize':10};data=frame([('serviceId','string'),('serviceName','string'),('uptime','number'),('slaTarget','number'),('errorBudgetPercentage','number'),('errorBudgetRemaining','number'),('burnRate','number'),('burnStatus','string'),('slaBreached','boolean'),('totalChecks','number'),('failedChecks','number')],[['svc-api','Public API',99.97,99.9,70,30,30,'Sustainable',False,10000,3],['svc-web','Web app',99.5,99.9,0,0,300,'Critical',True,10000,50],['svc-worker','Worker',None,99.9,None,None,None,None,None,0,0]])
    c['notes'].append('Native repeated service cards/ranked burn bars become a sortable records table preserving the exact SLO fields. Missing observations stay null.')
  else:
   value={'health-score':'healthScore','critical-issues':'criticalCount','warnings':'warningCount','informational':'infoCount'}.get(k)
   if k=='executive-summary':
    visual='record-list';config={'title':'reportId','body':'summary','subtitle':'periodEnd'};data=frame([('reportId','string'),('summary','string'),('periodEnd','timestamp')],[['Sample report','Illustrative stored reliability summary. One service needs latency investigation.','2026-10-27T00:00:00Z']])
   elif k=='recommendations':
    op='reliability_insights';visual='record-list';config={'title':'title','body':'recommendation','subtitle':'affectedServices','status':'severity'};data=frame([('title','string'),('description','string'),('recommendation','string'),('affectedServices','string'),('severity','string')],[['Investigate latency','Illustrative warning only.','Inspect the slowest requests and their downstream traces.','Web app','warning']])
  if value:
   base=99.73 if value=='averageUptime' else 84 if value=='healthScore' else {'serviceCount':3,'monitorCount':6,'activeAlertCount':1,'securityResultCount':2,'onTrackCount':1,'burnAlertCount':1,'criticalCount':0,'warningCount':1,'infoCount':2}.get(value,1)
   add(e,k,p['title'],visual='threshold-gauge' if k=='health-score' else 'stat',unit='%' if 'Uptime' in p['title'] else '',fixture=metric_fixture('x',p['title'],base),live=uq(op,args,value),provider='uptime',params=params,config={} if k=='health-score' else None,cov=c,options={'decimals':2 if value=='averageUptime' else 0,'showSparkline':False},notes=['Current snapshot only; no historical samples are invented by the live adapter.'])
  else:
   if k=='sla-breaches':data['rows']=[row for row in data['rows'] if row[8] is True]
   add(e,k,p['title'],kind='records',visual=visual,fixture=record_fixture('x',data),live=uq(op,{**args,**({'breachedOnly':True} if k=='sla-breaches' else {})}),provider='uptime',params=params,config=config,cov=c)
 e['limitations']=['Organization membership is fixed by provider configuration. Source controls that mutate or generate data are excluded.']+source.get('limitations',[])
 if is_slo:e['limitations'].append('Live windowDays controls the native SLO read. Fixed sample records illustrate fields, not recalculated service history. SLA-status stat displays on-track count; source exact breach fields remain in the records table.')
 finish(e)

# A separate Paprika feature coverage collection fills capabilities absent from the source definitions.
e=make_entry({'id':'paprika-signal-features','title':'Signal interactions','sources':['ui/src/features/insights/repository-examples/generate.py']},'uptime');e['project']='paprika';e['source']['revision']='working-tree';e['providers']=[]
variables(e,[{'name':'service','label':'Service','defaultValue':'api','options':['api','worker']}])
params=[{'name':'service','type':'string','defaultValue':'api'}]
for key,title,visual,base,unit in [('requests','Request rate','timeseries',25,'req/s'),('errors','Error ratio','stat',.25,'%'),('latency','Latency','stat',82,'ms'),('states','Service status','status-history',1,'')]:
 c=coverage(e,key,title,'paprika-feature',notes=['Supplemental synthetic capability example, not a cloned source dashboard.'])
 add(e,key,title,visual=visual,unit=unit,fixture=metric_fixture('x',title,base,variation=0 if key=='states' else base*.05),params=params,config={} if visual=='status-history' else None,cov=c,options={'decimals':2,'showSparkline':True,'thresholds':[{'value':0,'color':'#c34e4e','label':'Unhealthy'},{'value':1,'color':'#53876a','label':'Healthy'}]} if key=='states' else {'decimals':2,'showSparkline':True})
f={'id':'x','metric':'paprika_example_x','traces':[{'traceId':'1'*32,'service':'api','operation':'GET /orders','durationMs':82.25,'status':'ok','offsetSeconds':5},{'traceId':'2'*32,'service':'worker','operation':'process job','durationMs':142.75,'status':'error','offsetSeconds':20}]}
c=coverage(e,'traces','Recent traces','paprika-feature');add(e,'traces','Recent traces',kind='traces',visual='traces',fixture=f,cov=c,params=params)
# Saved tooltip reads the hovered service using the same query definition.
widgets=e['sample']['dashboards'][0]['widgets'];latency=next(w for w in widgets if w['id']=='latency');requests=next(w for w in widgets if w['id']=='requests')
requests['options']['tooltipView']={'type':'stat','title':'Service latency','unit':'ms','decimals':2,'showSparkline':True,'source':{'type':'saved','ref':{'id':latency['queryRef']['id'],'bindings':[{'parameter':'service','source':'label','label':'service'}]}}}
e['limitations']=['Supplementary synthetic interaction coverage: shared variables, saved queries, hovered-label tooltip, stat sparklines, decimal precision, status history and traces.'];finish(e)

# Strong generator invariants; runtime schemas and query execution are also covered in TypeScript tests.
assert len(CATALOG)==16
assert len({e['id'] for e in CATALOG})==len(CATALOG)
assert len({f['metric'] for f in FIXTURES})==len(FIXTURES)
assert sum(1 for e in CATALOG[:7] for c in e['coverage'] if c.get('language'))==96
for e in CATALOG:
 for mode in ['sample','live']:
  if mode not in e:continue
  b=e[mode];assert len(b['dashboards'][0]['widgets'])<=48
  assert len(b['savedQueries'])==len(b['dashboards'][0]['widgets'])
  assert all(len(q['query'])<=8192 for q in b['savedQueries'])
for path,data in [(OUT/'catalog.json',CATALOG),(OUT/'fixtures.json',FIXTURES),(DOC/'source-coverage.json',{'version':1,'canonicalDashboardCount':14,'supplementalCollections':2,'sourceGrafanaTargets':96,'entries':[{k:e[k] for k in ['id','title','project','source','liveStatus','coverage','limitations']} for e in CATALOG]})]:
 path.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
print(f'Generated {len(CATALOG)} entries, {len(FIXTURES)} fixtures and all 96 Grafana targets.')
