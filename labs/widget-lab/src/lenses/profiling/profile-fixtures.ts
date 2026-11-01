import type { QueryResult, RecordFrame, Widget } from '../../renderer-extensions/schema';
import { encodeFlamebearer, profileFromStacks, profileToRecords, samplesToRecords, type Profile, type StackSample } from '../../charts/profiling/profile-model';

export type ProfileFixtureId = 'postgres-cpu' | 'go-cpu' | 'python-cpu' | 'go-alloc';
export const PROFILE_FIXTURES = [
  { id: 'postgres-cpu', label: 'orders-db · PostgreSQL CPU', service: 'orders-db', runtime: 'PostgreSQL 17 · native' },
  { id: 'go-cpu', label: 'checkout-api · Go CPU', service: 'checkout-api', runtime: 'Go · net/http + pgx' },
  { id: 'python-cpu', label: 'forecast-worker · Python CPU', service: 'forecast-worker', runtime: 'Python · pandas + NumPy' },
  { id: 'go-alloc', label: 'checkout-api · Go allocations', service: 'checkout-api', runtime: 'Go · allocated bytes' },
] as const;

const postgres = [
 ['PostgresMain','exec_simple_query','PortalRun','ExecutorRun','ExecProcNode','ExecHashJoin','ExecHash','ExecSeqScan','heap_getnext'],
 ['PostgresMain','exec_simple_query','PortalRun','ExecutorRun','ExecProcNode','ExecHashJoin','ExecHash','ExecSeqScan','slot_deform_heap_tuple'],
 ['PostgresMain','exec_simple_query','PortalRun','ExecutorRun','ExecProcNode','ExecHashJoin','ExecScanHashBucket','ExecQual'],
 ['PostgresMain','exec_simple_query','PortalRun','ExecutorRun','ExecProcNode','ExecHashJoin','ExecScanHashBucket','hash_any'],
 ['PostgresMain','exec_simple_query','PortalRun','ExecutorRun','ExecProcNode','ExecSort','tuplesort_performsort','qsort_tuple'],
 ['PostgresMain','exec_simple_query','PortalRun','ExecutorRun','ExecProcNode','ExecSort','tuplesort_puttupleslot'],
 ['PostgresMain','exec_simple_query','PortalRun','ExecutorRun','ExecProcNode','ExecAgg','advance_aggregates'],
 ['PostgresMain','exec_simple_query','PortalRun','ExecutorRun','printtup','pq_putmessage','internal_putbytes'],
 ['PostgresMain','exec_simple_query','pg_plan_queries','planner','subquery_planner','query_planner'],
 ['PostgresMain','exec_simple_query','pg_parse_query','raw_parser','base_yyparse'],
 ['PostgresMain','exec_simple_query','PortalRun','ExecutorRun','ExecProcNode','ExecIndexScan','index_getnext_slot'],
 ['PostgresMain','exec_simple_query','PortalRun','ExecutorRun','ExecProcNode','ExecHashJoin','ExecHash','ExecSeqScan','heap_getnext','pg_pread'],
];
const go = [
 ['runtime.goexit','net/http.(*conn).serve','net/http.serverHandler.ServeHTTP','checkout.(*Handler).Create','checkout.(*Service).Quote','pricing.Calculate','decimal.(*Decimal).Mul','math/big.nat.mul'],
 ['runtime.goexit','net/http.(*conn).serve','net/http.serverHandler.ServeHTTP','checkout.(*Handler).Create','checkout.(*Service).Quote','pricing.Calculate','decimal.(*Decimal).Round'],
 ['runtime.goexit','net/http.(*conn).serve','net/http.serverHandler.ServeHTTP','checkout.(*Handler).Create','checkout.(*Service).Persist','pgx.(*Conn).Exec','pgconn.(*PgConn).ExecParams','pgproto3.(*Bind).Encode'],
 ['runtime.goexit','net/http.(*conn).serve','net/http.serverHandler.ServeHTTP','checkout.(*Handler).Create','checkout.(*Service).Persist','pgx.(*Conn).Exec','pgconn.(*PgConn).receiveMessage','pgproto3.(*Backend).Receive'],
 ['runtime.goexit','net/http.(*conn).serve','net/http.serverHandler.ServeHTTP','checkout.(*Handler).Create','encoding/json.(*Encoder).Encode','encoding/json.structEncoder.encode','encoding/json.stringEncoder'],
 ['runtime.goexit','net/http.(*conn).serve','net/http.serverHandler.ServeHTTP','checkout.(*Handler).Create','encoding/json.(*Encoder).Encode','encoding/json.mapEncoder.encode','sort.Slice'],
 ['runtime.goexit','net/http.(*conn).serve','net/http.serverHandler.ServeHTTP','checkout.(*Handler).Create','encoding/json.(*Decoder).Decode','encoding/json.(*decodeState).object','reflect.New'],
 ['runtime.goexit','net/http.(*conn).serve','crypto/tls.(*Conn).Read','crypto/tls.(*Conn).readRecordOrCCS','crypto/aes.(*gcmAsm).Open'],
 ['runtime.goexit','runtime.gcBgMarkWorker','runtime.gcDrain','runtime.scanobject','runtime.findObject'],
 ['runtime.goexit','runtime.gcBgMarkWorker','runtime.gcDrain','runtime.greyobject'],
 ['runtime.goexit','net/http.(*conn).serve','net/http.serverHandler.ServeHTTP','checkout.(*Handler).Create','runtime.mallocgc','runtime.nextFreeFast'],
 ['runtime.goexit','net/http.(*conn).serve','net/http.serverHandler.ServeHTTP','checkout.(*Handler).Create','checkout.(*Service).Quote','pricing.Calculate','decimal.(*Decimal).Mul','math/big.nat.mul','runtime.memmove'],
];
const python = [
 ['threading._bootstrap','worker.run','forecast.predict','features.build','pandas.DataFrame.groupby','pandas.GroupBy.aggregate','numpy.core._multiarray_umath.reduce'],
 ['threading._bootstrap','worker.run','forecast.predict','features.build','pandas.DataFrame.merge','pandas._libs.join.inner_join'],
 ['threading._bootstrap','worker.run','forecast.predict','model.transform','numpy.linalg.solve','dgesv','dgetrf'],
 ['threading._bootstrap','worker.run','forecast.predict','model.transform','numpy.dot','cblas_dgemm'],
 ['threading._bootstrap','worker.run','forecast.predict','features.build','pandas.to_datetime','pandas._libs.tslibs.strptime.array_strptime'],
 ['threading._bootstrap','worker.run','forecast.predict','serialize.write','json.dumps','json.encoder.iterencode','_json.make_encoder'],
 ['threading._bootstrap','worker.run','forecast.predict','features.build','pandas.read_parquet','pyarrow.parquet.read_table'],
 ['threading._bootstrap','worker.run','queue.consume','json.loads','json.decoder.raw_decode'],
 ['threading._bootstrap','worker.run','forecast.predict','features.validate','numpy.isfinite'],
 ['threading._bootstrap','worker.run','forecast.predict','features.build','pandas.DataFrame.groupby','pandas.GroupBy.aggregate','numpy.core._multiarray_umath.reduce','PyObject_Malloc'],
 ['threading._bootstrap','worker.run','forecast.predict','serialize.write','requests.Session.post','urllib3.connectionpool.urlopen'],
 ['threading._bootstrap','worker.run','forecast.predict','model.transform','numpy.linalg.solve','dgesv','dgetrs'],
];

/** Authored samples: elapsed weights are integer multiples of the 100 Hz interval. */
export function buildProfileFixture(id: ProfileFixtureId = 'postgres-cpu') {
 const meta = PROFILE_FIXTURES.find(item => item.id === id)!;
 const paths = id === 'postgres-cpu' ? postgres : id === 'python-cpu' ? python : go;
 const samples: StackSample[] = []; let time = 0;
 for (let i = 0; i < 360; i++) {
   // Repeated work within short runs makes time order meaningfully different from cost order.
   const segment = Math.floor(i / 8), primary = (segment * 17 + Math.floor(segment / 7) * 3) % paths.length;
   const path = paths[i % 8 < 6 ? primary : (primary + i % 3 + 1) % paths.length];
   const duration = (4 + (i * 7 % 9)) * 10;
   samples.push({ id: `${id}-${i}`, start: time, end: time + duration, stack: [...path], thread: id === 'python-cpu' ? 'worker-1' : id === 'postgres-cpu' ? 'backend-1842' : 'CPU 0 · checkout-api' }); time += duration;
 }
 const allocations = id === 'go-alloc';
 const profile = profileFromStacks(samples.map((sample, i) => ({ stack: sample.stack, value: allocations ? (sample.end - sample.start) / 10 * (16 + i % 11) * 1024 : (sample.end - sample.start) / 10 })), `${meta.service} · ${allocations ? 'allocated bytes' : 'CPU samples'}`, allocations ? 'bytes' : 'samples', 100);
 profile.source = 'Synthetic Pyroscope Flamebearer v1';
 const raw = encodeFlamebearer(profile);
 return { meta, profile, samples: allocations ? null : samples, raw, extent: time, folded: allocations ? null : collapsedProfile(profile) };
}

export function collapsedProfile(profile: Profile) {
 if(profile.unit!=='samples'||profile.sampleRate!==100||profile.frames.some(frame=>frame.parentId===null&&frame.self>0))throw new Error('Folded export is available for 100 Hz sample profiles with named stacks. Use JSON to retain other units, rates or unknown stacks.');
 const byId = new Map(profile.frames.map(frame => [frame.id, frame]));
 return profile.frames.filter(frame => frame.self > 0).map(frame => { const stack: string[] = []; let current: typeof frame | undefined = frame; while (current?.parentId) { stack.unshift(current.label); current = byId.get(current.parentId); } return `${stack.join(';')} ${frame.self}`; }).join('\n');
}

export function speedscopeFile(samples: readonly StackSample[], title = 'Paprika synthetic sampled CPU') {
 const names = [...new Set(samples.flatMap(sample => sample.stack))];
 return { $schema: 'https://www.speedscope.app/file-format-schema.json', name: title, exporter: 'Paprika Widget Lab · deterministic mock', shared: { frames: names.map(name => ({ name })) }, profiles: [...new Set(samples.map(sample => sample.thread))].map(thread => {
   const entries = samples.filter(sample => sample.thread === thread).sort((a, b) => a.start - b.start);
   if(entries.some((sample,index)=>index>0&&Math.abs(sample.start-entries[index-1].end)>1e-7))throw new Error('Speedscope sampled export requires contiguous intervals. Use the original records to preserve sampling gaps.');
   return { type: 'sampled', name: thread, unit: 'milliseconds', startValue: entries[0]?.start ?? 0, endValue: entries.at(-1)?.end ?? 0, samples: entries.map(sample => sample.stack.map(name => names.indexOf(name))), weights: entries.map(sample => sample.end - sample.start) };
 }) };
}

export type ProfilePanel = { widget: Widget; result: QueryResult };
export function profilePanel(profile: Profile): ProfilePanel { return { widget: { id: 'query-profile', title: 'CPU profile · aggregated call stacks', type: 'plugin', pluginId: 'profile-flamegraph', dataKind: 'records', providerId: 'synthetic-profile', query: 'mock:pyroscope/select-merge-profile', unit: '', layout: { x: 0, y: 0, w: 9, h: 5 }, config: { orientation: 'icicle', rowHeight: 25, showValues: true, colorBy: 'package' }, options: { showTooltip: true } }, result: { records: profileToRecords(profile) } }; }
export function samplePanel(samples: readonly StackSample[]): ProfilePanel { return { widget: { id: 'query-flamechart', title: 'Sampled flamechart · elapsed time', type: 'plugin', pluginId: 'sampled-flamechart', dataKind: 'records', providerId: 'synthetic-profile', query: 'mock:speedscope/sampled-thread', unit: 'ms', layout: { x: 0, y: 0, w: 12, h: 5 }, config: { rowHeight: 24, showLabels: true }, options: { showTooltip: true } }, result: { records: samplesToRecords(samples) } }; }

export const QUERY_PLAN: RecordFrame = {
 columns: [ { key:'id',type:'string' },{ key:'parent',type:'string' },{ key:'label',type:'string' },{ key:'relation',type:'string' },{ key:'actualMs',type:'number',unit:'ms' },{ key:'rows',type:'number' },{ key:'estimatedRows',type:'number' },{ key:'loops',type:'number' } ],
 rows: [ ['limit',null,'Limit','top 100 orders',96.8,100,100,1],['sort','limit','Sort','total_amount DESC',96.6,100,8500,1],['join','sort','Hash Join','orders.customer_id = customers.id',89.4,8640,8500,1],['scan','join','Seq Scan','orders · paid in last 30 days',64.2,8640,8500,1],['hash','join','Hash','customer index',12.8,4200,4000,1],['customers','hash','Seq Scan','customers · active',9.6,4200,4000,1] ]
};
export function queryPlanPanel(): ProfilePanel { return { widget: { id:'query-plan',title:'Query plan · representative execution',type:'plugin',pluginId:'query-plan',dataKind:'records',providerId:'synthetic-profile',query:'mock:postgres/explain-analyze',unit:'ms',layout:{x:0,y:0,w:4,h:5},config:{showEstimates:true},options:{showTooltip:true} },result:{records:QUERY_PLAN} }; }
