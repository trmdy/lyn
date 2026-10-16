import { parseArgs } from 'node:util'
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { __register, Engine, query, mutation } from '@lyn/core'
import { createRouter } from '@lyn/core/wire'
import pg from 'pg'
import { loadModule } from 'libpg-query'
import { PostgresAdapter } from '../src/index.ts'
import { analyze, readsOf, buildCatalog, clearTemplates } from '../src/reads.ts'

const { values: f } = parseArgs({ options: Object.fromEntries(Object.entries({ mode:'sustain', coverage:'off', 'writer-cpus':'4-7', url:process.env.BENCH_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:55483/lyn_codex', groups:'100', mix:'precise', rate:'100', seconds:'15', readers:'4', pool:'20', writers:'8', runs:'5', out:'/tmp/lyn-perf-engine/run-codex-55483', name:'trial' }).map(([k, v]) => [k, {type:'string', default:v}])) })
const n = (key: string) => Number(f[key])
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const stats = (xs: number[]) => { xs.sort((a,b)=>a-b); return { count:xs.length, p50:xs[Math.floor(xs.length*.5)], p95:xs[Math.floor(xs.length*.95)], p99:xs[Math.floor(xs.length*.99)], max:xs.at(-1) } }
const log = (x: unknown) => console.log(JSON.stringify(x))
mkdirSync(f.out!, { recursive: true })
const url = f.url!
const groups = n('groups')
const buckets = f.mix === 'precise' ? Math.ceil(groups/3) : 1

if (f.mode === 'writer') {
  const clients = await Promise.all(Array.from({length:n('writers')}, async () => { const c = new pg.Client({connectionString:url}); await c.connect(); return c }))
  const events: {seq:number,xid:string,ack:number}[] = []
  let seq=0, active=0, rejected=0
  const start = Date.now(), parentPid=process.ppid
  const tasks = new Set<Promise<void>>()
  while (Date.now()-start < n('seconds')*1000 && process.ppid===parentPid) {
    const due = Math.floor((Date.now()-start)*n('rate')/1000)
    while(seq < due) {
      const s = ++seq
      if(active >= n('writers')) { rejected++; continue }
      const c = clients.pop()!
      active++
      const task = (async () => {
        const bucket = s % buckets
        const sql = s%2 ? 'insert into perf_items (id,bucket,seq,val) values ($1,$2,$1,1) returning xmin::text as xid' : 'update perf_items set seq=$1,val=val+1 where id= -1-$2 returning xmin::text as xid'
        const r = await c.query(sql,[s,bucket])
        events.push({seq:s,xid:r.rows[0].xid,ack:Date.now()})
      })().finally(()=>{active--;clients.push(c);tasks.delete(task)})
      tasks.add(task)
    }
    await sleep(1)
  }
  await Promise.all(tasks)
  const commits = await clients[0]!.query('select x, extract(epoch from pg_xact_commit_timestamp(x::xid))*1000 as ms from unnest($1::text[]) x',[events.map(e=>e.xid)])
  const times = new Map(commits.rows.map(r=>[r.x,Number(r.ms)]))
  writeFileSync(`${f.out}/${f.name}-writes.json`,JSON.stringify({start,end:Date.now(),rejected,events:events.map(e=>({...e,commit:times.get(e.xid)}))}))
  await Promise.all(clients.map(c=>c.end()))
  process.exit(0)
}

if(f.mode === 'tracker') {
  await loadModule()
  const catalog=buildCatalog({tables:['perf_items'],views:[],policies:[],functions:[]})
  const sql='select max(seq) as seq from perf_items where bucket = $1'
  const adapter=new PostgresAdapter({url})
  for(let repeat=0;repeat<5;repeat++) {
    for(const kind of ['analyze','uncached','cached']) {
      const count=kind==='cached'?100000:5000
      let checksum=0
      const start=performance.now()
      for(let i=0;i<count;i++) { if(kind==='analyze') checksum+=analyze(sql,catalog).reads.length; else { if(kind==='uncached') clearTemplates(); checksum+=Number(readsOf(sql,[i],catalog).tables[0]?.eq?.bucket?.[0]) } }
      log({mode:'tracker',repeat,kind,ns:(performance.now()-start)*1e6/count,checksum})
    }
    for(const k of [100,1000,10000,50000]) {
      const sets=Array.from({length:k},(_,i)=>readsOf(sql,[i],catalog))
      const batch={tokens:[],changes:[{source:'perf_items',kind:'update' as const,new:{bucket:'7'},old:{bucket:'7'}}]}
      let hits=0
      const start=performance.now()
      for(let j=0;j<100;j++) for(const set of sets) if(adapter.affects(set,batch)) hits++
      log({mode:'tracker',repeat,groups:k,scanMs:(performance.now()-start)/100,hits})
    }
  }
  process.exit(0)
}

const admin = new pg.Client({connectionString:url})
await admin.connect()
await admin.query('drop table if exists perf_items, perf_dim; create table perf_items(id int primary key,bucket int not null,seq int not null,val int not null); create index on perf_items(bucket); alter table perf_items replica identity full; create table perf_dim(id int primary key); insert into perf_dim values(1); alter table perf_dim replica identity full')
await admin.query('insert into perf_items select -1-i,i,0,0 from generate_series(0,$1::int-1) i',[buckets])
const adapter = new PostgresAdapter({url,readers:n('readers'),max:n('pool'),publication:'lyn_codex_perf'})
let position='0/0', batches=0, reruns=0
const startAdapter=adapter.start.bind(adapter)
adapter.start=cb=>startAdapter(batch=>{if(batch.position) position=String(batch.position);batches++;cb(batch)})
__register('throughput',{
  live:query({handler:async (_,a:{bucket:number,variant:number})=>{
    reruns++
    const sql=f.mix==='precise'?'select coalesce(max(seq),0)::int as seq, sum(val)::text as value from perf_items where bucket=$1':a.variant%3===0?'select coalesce(max(seq),0)::int as seq, sum(val)::text as value from perf_items':a.variant%3===1?'select coalesce(max(p.seq),0)::int as seq, sum(p.val)::text as value from perf_items p join perf_dim d on d.id=1':'select seq, val::text as value from perf_items order by seq desc limit 1'
    const measuredSql=f.coverage==='on'?sql.replace(' from ', ', pg_current_snapshot()::text as snapshot from '):sql
    return (await adapter.pool.query(measuredSql,f.mix==='precise'?[a.bucket]:[])).rows[0]
  }}),
  write:mutation({handler:async()=>{await adapter.pool.query('update perf_items set seq=seq+1,val=val+1 where id=-1')}})
})
const engine=new Engine(adapter)
await engine.ready
const seen=new Map<number,number>()
const latest=new Map<number,{seq:number,value:string}>()
const deliveries: {sub:number,seq:number,time:number,snapshot?:string}[]=[]
let recording=false, errors=0
const router=createRouter()
const connection=engine.connect(frame=>{
  const time=Date.now()
  for(const m of router.route(frame)) {
    if(m.type==='error') {errors++;console.error(m);continue}
    if(m.type==='data') { const seq=(m.value as {seq:number}).seq; seen.set(m.sub,seq); latest.set(m.sub,m.value as {seq:number,value:string}); if(recording) deliveries.push({sub:m.sub,seq,time,snapshot:(m.value as {snapshot?:string}).snapshot}) }
  }
},null)
await engine.subscribe({clientId:connection.id,remove:[],add:Array.from({length:groups},(_,i)=>({sub:i,name:'throughput:live',args:{bucket:Math.floor(i/3),variant:i}}))},null)
const wait=async(test:()=>boolean,timeout=120000)=>{const end=Date.now()+timeout;while(!test()){if(Date.now()>end)throw Error('timeout');await sleep(5)}}
await wait(()=>seen.size===groups&&!engine.busy)
log({ready:true,groups,mix:f.mix,rss:process.memoryUsage().rss,profileStartUs:Number(process.hrtime.bigint()/1000n)})
recording=true
if(f.mode==='fanout') {
  const lasts=[]
  for(let i=0;i<n('runs');i++) {
    deliveries.length=0
    await admin.query('begin')
    const r=await admin.query('update perf_items set seq=seq+1,val=val+1 where id=-1 returning xmin::text as xid')
    await admin.query('commit')
    await wait(()=>deliveries.length===groups&&!engine.busy)
    const t=Number((await admin.query('select extract(epoch from pg_xact_commit_timestamp($1::xid))*1000 as ms',[r.rows[0].xid])).rows[0].ms)
    const lat=deliveries.map(d=>d.time-t)
    lasts.push(Math.max(...lat))
    log({mode:'fanout',groups,readers:n('readers'),pool:n('pool'),run:i,latency:stats(lat)})
  }
  log({mode:'fanout-summary',groups,readers:n('readers'),pool:n('pool'),last:stats(lasts)})
} else {
  const samples:unknown[]=[]
  let sampling=false
  const baseRuns=reruns, baseBatches=batches, cpu=process.cpuUsage(), start=Date.now()
  const timer=setInterval(async()=>{
    if(sampling)return
    sampling=true
    try {const received=position;const r=await admin.query('select pg_current_wal_lsn()::text as current, greatest(0,pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn))::float8 as lag',[received]);if(received==='0/0')r.rows[0].lag=null;const sample={at:Date.now()-start,reruns:reruns-baseRuns,batches:batches-baseBatches,...r.rows[0],received,rss:process.memoryUsage().rss,heap:process.memoryUsage().heapUsed};samples.push(sample);appendFileSync(`${f.out}/${f.name}-telemetry.jsonl`,JSON.stringify(sample)+'\n')} finally{sampling=false}
  },1000)
  const child=spawn('taskset',['-c',f['writer-cpus']!,process.execPath,import.meta.filename,...process.argv.slice(2).filter(x=>!x.startsWith('--mode=')),'--mode=writer'],{stdio:'inherit'})
  await new Promise<void>((resolve,reject)=>{child.on('exit',code=>code===0?resolve():reject(Error(`writer ${code}`)));child.on('error',reject)})
  const writeEnd=Date.now()
  const {readFileSync}=await import('node:fs')
  const writes=JSON.parse(readFileSync(`${f.out}/${f.name}-writes.json`,'utf8'))
  await wait(()=>batches-baseBatches>=writes.events.length&&!engine.busy,120000)
  await sleep(100)
  clearInterval(timer)
  while(sampling)await sleep(5)
  const usage=process.cpuUsage(cpu)
  const bySeq=new Map<number,number>(writes.events.map((e:any)=>[e.seq,e.commit]))
  const observed=new Set<number>()
  const latencies:number[]=[]
  for(const d of deliveries){const t=bySeq.get(d.seq);if(t!==undefined){latencies.push(d.time-t);observed.add(d.seq)}}
  const result={profileEndUs:Number(process.hrtime.bigint()/1000n),mode:'sustain',groups,mix:f.mix,rate:n('rate'),seconds:n('seconds'),readers:n('readers'),pool:n('pool'),writes:writes.events.length,writesPerSecond:writes.events.length/n('seconds'),rejected:writes.rejected,observedWrites:observed.size,latency:stats(latencies),rerunsPerSecond:(reruns-baseRuns)/((Date.now()-start)/1000),cpuPercent:(usage.user+usage.system)/((Date.now()-start)*10),rssMB:process.memoryUsage().rss/1048576,peakRssMB:process.resourceUsage().maxRSS/1024,drainMs:Date.now()-writes.end,exitObservedDrainMs:Date.now()-writeEnd,errors,samples}
  writeFileSync(`${f.out}/${f.name}-delivery.json`,JSON.stringify(deliveries))
  const expected=await admin.query(f.mix==='precise'?'select bucket, coalesce(max(seq),0)::int as seq,sum(val)::text as value from perf_items group by bucket':'select 0 as bucket,coalesce(max(seq),0)::int as seq,sum(val)::text as value from perf_items')
  const expectedByBucket=new Map(expected.rows.map(r=>[r.bucket,r]))
  const top=(await admin.query('select seq,val::text as value from perf_items order by seq desc limit 1')).rows[0]
  let mismatches=0
  for(let i=0;i<groups;i++) {
    const wanted=f.mix==='precise'?expectedByBucket.get(Math.floor(i/3)):i%3===2?top:expectedByBucket.get(0)
    const actual=latest.get(i)
    if(actual?.seq!==wanted.seq||actual?.value!==wanted.value)mismatches++
  }
  log({...result,mismatches})
  if(mismatches||errors)throw Error('delivery correctness check failed')
  const beforeMutation=batches
  await engine.mutate({name:'throughput:write',args:{},mutationId:'smoke'},null)
  await wait(()=>batches>beforeMutation&&!engine.busy)
  await sleep(50)
}
await engine.stop()
await admin.end()
