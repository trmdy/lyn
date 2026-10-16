import http from 'node:http'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
const require = createRequire(new URL('../examples/timetrack/package.json', import.meta.url))
const { Pool } = require('pg')
const { encode, decode } = await import('../packages/core/src/wire.ts')
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 })
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity })
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4501'
const pid = Number(process.env.SERVER_PID)
const cpu = () => { const s=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(' '); return (Number(s[13])+Number(s[14]))*10 }
const rss = () => Number(fs.readFileSync(`/proc/${pid}/status`,'utf8').match(/VmRSS:\s+(\d+)/)[1])*1024
const sleep = ms => new Promise(r=>setTimeout(r,ms))
function stats(a) { a.sort((a,b)=>a-b); const q=p=>a[Math.min(a.length-1,Math.max(0,Math.ceil(a.length*p)-1))]??null; return {n:a.length,p50:q(.5),p95:q(.95),p99:q(.99),max:q(1)} }
function req(path, cookie, body) {
 return new Promise((resolve,reject)=>{
  const data=body===undefined?undefined:encode(body)
  const r=http.request(new URL(path,base),{agent,method:data?'POST':'GET',headers:{...(cookie?{cookie}:{}),...(data?{'content-type':'application/x-devalue','content-length':Buffer.byteLength(data)}:{})}},res=>{
   let text='';res.setEncoding('utf8');res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,text}))
  });r.on('error',reject);r.setTimeout(60000,()=>r.destroy(new Error('timeout')));r.end(data)
 })
}
const users=(await pool.query('select id,name from users order by name')).rows
const cookies=await Promise.all(users.map(async u=>{
 const r=await fetch(base+'/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({userId:u.id})});if(r.status!==204)throw Error('login');return r.headers.get('set-cookie').split(';')[0]
}))
const entry=(await pool.query("select id from time_entries where user_id=$1 and started_at >= '2026-10-12' and ended_at < '2026-10-19' order by started_at limit 1",[users[0].id])).rows[0].id
const mode=process.argv[2]
const samples = value => { if(process.env.SAMPLES_FILE) fs.writeFileSync(process.env.SAMPLES_FILE, JSON.stringify(value)) }
if(mode==='http') {
 const path=process.argv[3]??'/week/2026-10-12',c=Number(process.argv[4]??1),seconds=Number(process.argv[5]??15)
 await req(path,path==='/'?null:cookies[0]);const lat=[],errors={};let bytes=0
 const startUs=Number(process.hrtime.bigint()/1000n);const start=performance.now(),before=cpu(),end=start+seconds*1000
 await Promise.all(Array.from({length:c},async()=>{while(performance.now()<end){const t=performance.now();try {const r=await req(path,path==='/'?null:cookies[0]);if(r.status!==200)errors[r.status]=(errors[r.status]??0)+1;else {lat.push(performance.now()-t);bytes+=Buffer.byteLength(r.text)}}catch(e){errors[e.message]=(errors[e.message]??0)+1}}}))
 const elapsed=(performance.now()-start)/1000
 console.log(JSON.stringify({mode,path,c,elapsed,profileWindow:{startUs,endUs:Number(process.hrtime.bigint()/1000n)},rps:lat.length/elapsed,latency:stats(lat),cpuMsPerRequest:(cpu()-before)/lat.length,bytesPerRequest:bytes/lat.length,errors,rss:rss()}));samples({latency:lat})
} else {
 const target=Number(process.argv[3]??1000), clients=[],first=[],complete=[],subLat=[];let errors=0,unexpected=0,frames=0
 const settleWaiters=new Map();const pending=new Map(),settles=new Map(),delivery=[],settledLat=[],httpLat=[]
 function open(i) {
  const user=i<target/2||i%5===0?0:1+i%49
  const start=i<target/2?'2026-10-12':['2026-09-21','2026-09-28','2026-10-05','2026-10-12'][i%4]
  const c={i,user,start,cookie:cookies[user],affected:user===0&&start==='2026-10-12',seen:new Set(),ready:false};clients.push(c)
  return new Promise((resolve,reject)=>{
   const t=performance.now();let buffer='',hello=false,seen=new Set()
   const r=http.get(new URL('/_lyn/events',base),{agent:false,headers:{cookie:c.cookie}},res=>{
    res.setEncoding('utf8');res.on('data',chunk=>{
     buffer+=chunk;let at
     while((at=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,at);buffer=buffer.slice(at+2);const data=frame.split('\n').filter(x=>x.startsWith('data: ')).map(x=>x.slice(6)).join('\n');if(!data)continue
      if(frame.includes('event: hello')){
       c.id=JSON.parse(data).clientId;hello=true
       const names=['src/team:me','src/team:members','src/team:workingNow','src/entries:recentAlerts','src/entries:running','src/catalog:pickable','src/entries:week']
       const st=performance.now();req('/_lyn/subscribe',c.cookie,{clientId:c.id,add:names.map((name,sub)=>({sub,name,args:sub===6?{start:c.start}:{}})),remove:[]}).then(r=>{if(r.status!==200||decode(r.text).error){errors++;reject(Error(r.text))}subLat.push(performance.now()-st)}).catch(reject)
      }else {
       frames++;const arrived=performance.now(),f=decode(data)
       for(const m of f.messages){
        if(m.type==='error'){errors++;if(!c.ready)reject(Error(m.message));continue}
        if(m.type==='settled'){for(const id of m.mutations){const t=settles.get(id);if(t!==undefined){settledLat.push(performance.now()-t);settles.delete(id);settleWaiters.get(id)?.();settleWaiters.delete(id)}}continue}
        if(!c.ready){if(seen.size===0)first.push(performance.now()-t);seen.add(m.sub);if(seen.size===7){c.ready=true;complete.push(performance.now()-t);resolve(c)}}
        else {
         const rows=m.type==='patch'?m.patch.upsert:Array.isArray(m.value)?m.value:[]
         for(const row of rows){if(m.sub===6&&row.id===entry)c.lastDescription=row.description;const p=pending.get(row.description);if(p&&m.sub===6&&!c.seen.has(row.description)){c.seen.add(row.description);p.received++;delivery.push(arrived-p.t);if(!c.affected)unexpected++}}
         if(!c.affected&&pending.size)unexpected++
        }
       }
      }
     }
    });res.on('error',()=>errors++)
   });c.request=r;r.on('error',reject);setTimeout(()=>{if(!c.ready)reject(Error(`SSE readiness timeout ${i} hello=${hello}`))},120000).unref()
  })
 }
 await pool.query('update time_entries set description=$1 where id=$2',[`prime-${process.pid}`,entry]);await sleep(1000)
 const before=rss(),t=performance.now()
 for(let i=0;i<target;i+=50)await Promise.all(Array.from({length:Math.min(50,target-i)},(_,j)=>open(i+j)))
 await sleep(3000)
 console.log(JSON.stringify({mode:'capacity',target,seconds:(performance.now()-t)/1000,connectionsPerSec:target/((performance.now()-t-3000)/1000),first:stats(first),allData:stats(complete),subscribe:stats(subLat),rssBefore:before,rssAfter:rss(),bytesPerConnection:(rss()-before)/target,errors}))
 if(mode==='capacity')samples({first,allData:complete,subscribe:subLat})
 if(mode==='throughput'){
  const concurrency=Number(process.argv[4]??1),seconds=Number(process.argv[5]??15),lat=[],httpTimes=[];let failures=0,count=0
  const start=performance.now(),beforeCpu=cpu(),end=start+seconds*1000
  await Promise.all(Array.from({length:concurrency},async(_,worker)=>{
   while(performance.now()<end){
    const id=crypto.randomUUID(),t=performance.now(),client=clients[worker%clients.length]
    const settled=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('settle timeout')),60000);settleWaiters.set(id,()=>{clearTimeout(timer);resolve()})})
    settles.set(id,t)
    try {const r=await req('/_lyn/mutate',cookies[0],{clientId:client.id,mutationId:id,name:'src/entries:updateEntry',args:{id:entry,description:id}});httpTimes.push(performance.now()-t);if(r.status!==200||decode(r.text).error)throw Error(r.text);await settled;lat.push(performance.now()-t);count++}catch(e){failures++;console.error(e.message);break}
   }
  }))
  const elapsed=(performance.now()-start)/1000
  console.log(JSON.stringify({mode:'throughput',target,concurrency,elapsed,rps:count/elapsed,settled:stats(lat),http:stats(httpTimes),failures,cpuMsPerMutation:(cpu()-beforeCpu)/count}));samples({settled:lat,http:httpTimes})
 }
 if(mode==='writes'||mode==='mutation'){
  const source=process.argv[4]??'mutate',rate=Number(process.argv[5]??10),seconds=Number(process.argv[6]??10),jobs=[];let sent=0,late=[]
  const startUs=Number(process.hrtime.bigint()/1000n);const start=performance.now(),beforeCpu=cpu(),count=rate*seconds
  for(let k=0;k<count;k++){
   const due=start+k*1000/rate;await sleep(Math.max(0,due-performance.now()));late.push(performance.now()-due)
   const token=`perf-${process.pid}-${k}`,id=crypto.randomUUID(),t=performance.now();pending.set(token,{t,received:0});sent++
   if(source==='sql') jobs.push(pool.query('update time_entries set description=$1 where id=$2',[token,entry]).catch(()=>errors++))
   else {settles.set(id,t);jobs.push(req('/_lyn/mutate',cookies[0],{clientId:clients[0].id,mutationId:id,name:'src/entries:updateEntry',args:{id:entry,description:token}}).then(r=>{httpLat.push(performance.now()-t);if(r.status!==200||decode(r.text).error)errors++}).catch(()=>errors++))}
  }
  await Promise.all(jobs);await sleep(5000)
  const finalDescription=(await pool.query('select description from time_entries where id=$1',[entry])).rows[0].description
  const staleFinal=clients.filter(c=>c.affected&&c.lastDescription!==finalDescription).length
  let received=0,missing=0;const expected=clients.filter(c=>c.affected).length
  for(const p of pending.values()){received+=p.received;missing+=Math.max(0,expected-p.received)}
  console.log(JSON.stringify({mode:'writes',profileWindow:{startUs,endUs:Number(process.hrtime.bigint()/1000n)},target,source,rate,seconds,sent,expectedPerWrite:expected,received,missing,delivery:stats(delivery),http:stats(httpLat),settled:stats(settledLat),unsettled:settles.size,staleFinal,unexpected,errors,scheduleLag:stats(late),cpuMsPerWrite:(cpu()-beforeCpu)/sent,rss:rss()}));samples({delivery,http:httpLat,settled:settledLat,scheduleLag:late})
 }
 for(const c of clients)c.request.destroy()
 await sleep(500)
}
await pool.end();agent.destroy()
