import { parseArgs } from 'node:util'
import { spawn } from 'node:child_process'
import { writeFile, readFile, appendFile } from 'node:fs/promises'
import { once } from 'node:events'
import pg from 'pg'
import { loadModule, parseSync } from 'libpg-query'
import { Engine, __register, query, mutation } from '@lyn/core'
import { decode, type ServerFrame } from '@lyn/core/wire'
import { postgres } from '../src/index.ts'
import { analyze, buildCatalog, clearTemplates, readsOf } from '../src/reads.ts'

const { values: f } = parseArgs({ options: Object.fromEntries(Object.entries({ mode: 'load', url: process.env.BENCH_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:56291/lyn_engine_bench', groups: '100', mix: 'precise', rate: '100', seconds: '10', readers: '4', pool: '40', writers: '4', runs: '5', out: '/tmp/lyn-perf-engine', cpus: '4-7' }).map(([k, v]) => [k, { type: 'string' as const, default: v }])) })
const n = (key: string) => Number(f[key])
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const now = () => performance.timeOrigin + performance.now()
const quantiles = (xs: number[]) => {
  xs.sort((a, b) => a - b)
  return Object.fromEntries([['p50', .5], ['p95', .95], ['p99', .99], ['max', 1]].map(([k, q]) => [k, xs[Math.max(0, Math.ceil(xs.length * Number(q)) - 1)] ?? null]))
}
const admin = new pg.Client({ connectionString: f.url })
await admin.connect()
const buckets = f.mix === 'precise' ? Math.ceil(n('groups') / 3) : 16

if (f.mode === 'writer') {
  const clients = await Promise.all(Array.from({ length: n('writers') }, async () => {
    const c = new pg.Client({ connectionString: f.url }); await c.connect(); return c
  }))
  const records: { seq: number; xid: string; at: number }[] = []
  let issued = 0, finished = 0, pending = 0, maxPending = 0
  const start = performance.now()
  await Promise.all(clients.map(async (c, w) => {
    let i = w
    while (i < n('rate') * n('seconds')) {
      const target = start + i * 1000 / n('rate')
      if (target >= start + n('seconds') * 1000) break
      if (performance.now() < target) await sleep(Math.max(0, target - performance.now()))
      const seq = i + 1, grp = i % buckets
      issued++; pending++; maxPending = Math.max(maxPending, pending)
      const sql = i % 2 === 0
        ? 'insert into items(id,grp,val,seq) values ($1,$2,1,$3) returning xmin::text as xid'
        : 'update items set val=val+1,seq=$2 where id=$1 returning xmin::text as xid'
      const r = await c.query(sql, i % 2 === 0 ? [buckets + seq, grp, seq] : [grp, seq])
      records.push({ seq, xid: r.rows[0].xid, at: now() })
      pending--; finished++; i += clients.length
    }
  }))
  const elapsed = performance.now() - start
  await writeFile(`${f.out}/writes-${process.ppid}.json`, JSON.stringify({ records, issued, finished, maxPending, elapsed }))
  await Promise.all(clients.map(c => c.end()))
  await admin.end()
  process.exit(0)
}

if (f.mode === 'micro') {
  await loadModule()
  const catalog = buildCatalog({ tables: ['items', 'labels'], views: [], policies: [], functions: [] })
  const adapter = postgres({ url: f.url! })
  const shapes = ['select sum(val), max(seq) from items where grp=$1', 'select sum(i.val), max(i.seq) from items i join labels l on l.id=i.grp', 'select sum(val),max(seq) from items']
  const bench = (name: string, count: number, task: (i: number) => unknown) => {
    for (let i = 0; i < Math.min(count, 1000); i++) task(i)
    const samples: number[] = []
    for (let r = 0; r < 5; r++) {
      const t = performance.now()
      for (let i = 0; i < count; i++) task(i)
      samples.push((performance.now() - t) * 1e6 / count)
    }
    console.log(JSON.stringify({ mode: 'micro', name, nsPerOperation: quantiles(samples) }))
  }
  for (const sql of shapes) {
    bench(`parse:${sql}`, 5000, () => parseSync(sql))
    bench(`analyze:${sql}`, 5000, () => analyze(sql, catalog))
    bench(`readsCached:${sql}`, 100000, i => readsOf(sql, [i], catalog))
    bench(`readsUncached:${sql}`, 5000, () => { clearTemplates(); return readsOf(sql, [1], catalog) })
  }
  for (const count of [100, 1000, 10000, 50000]) {
    const sets = Array.from({ length: count }, (_, i) => readsOf(shapes[0], [i], catalog))
    const batch = { tokens: ['1'], changes: [{ source: 'items', kind: 'update' as const, new: { grp: '42' }, old: { grp: '42' } }] }
    let matches = 0
    bench(`affectsScan:${count}`, Math.max(20, Math.floor(1000000 / count)), () => { for (const reads of sets) matches += Number(adapter.affects(reads, batch)) })
    console.log(JSON.stringify({ count, matches }))
  }
  await admin.end()
  process.exit(0)
}

await admin.query('drop table if exists items,labels; create table items(id int primary key,grp int not null,val int not null,seq int not null); create index on items(grp); alter table items replica identity full; create table labels(id int primary key);')
await admin.query('insert into items select i,i,0,0 from generate_series(0,$1::int-1) i', [buckets])
await admin.query('insert into labels select generate_series(0,$1::int-1)', [buckets])
const adapter = postgres({ url: f.url!, readers: n('readers'), max: n('pool') })
let evaluations = 0, batches = 0, position = '0/0', changes = 0, matchCalls = 0
const originalStart = adapter.start.bind(adapter)
adapter.start = cb => originalStart(batch => { batches++; changes += batch.changes.length; position = String(batch.position ?? position); cb(batch) })
const originalAffects = adapter.affects.bind(adapter)
adapter.affects = (reads, batch) => { matchCalls++; return originalAffects(reads, batch) }
__register('engineLoad', {
  precise: query({ handler: async (_, a: { grp: number; variant: number }) => {
    evaluations++
    return (await adapter.pool.query('select sum(val)::float8 as total,max(seq)::int as seq from items where grp=$1', [a.grp])).rows[0]
  } }),
  broad: query({ handler: async (_, a: { grp: number; variant: number }) => {
    evaluations++
    const sql = a.variant % 3 === 0 ? 'select sum(val)::float8 as total,max(seq)::int as seq from items'
      : a.variant % 3 === 1 ? 'select sum(i.val)::float8 as total,max(i.seq)::int as seq from items i join labels l on l.id=i.grp'
      : 'select sum(val)::float8 as total,max(seq)::int as seq from items where grp <= $1'
    return (await adapter.pool.query(sql, a.variant % 3 === 2 ? [buckets] : [])).rows[0]
  } }),
  write: mutation({ handler: async () => { await adapter.pool.query('update items set val=val+1,seq=seq+1 where id=0') } }),
})
const engine = new Engine(adapter)
await engine.ready
let initial = 0, errors = 0, deliveries = 0, collect = false
const observations: { seq: number; at: number; sub: number }[] = []
const arrivals = new Map<number, number>()
const settled = new Set<string>()
const connection = engine.connect(frame => {
  const at = now()
  for (const m of decode<ServerFrame>(frame).messages) {
    if (m.type === 'settled') for (const id of m.mutations) settled.add(id)
    if (m.type === 'error') { errors++; console.error(JSON.stringify(m)); continue }
    if (m.type === 'data') {
      initial++; arrivals.set(m.sub, at)
      if (collect) { deliveries++; observations.push({ seq: (m.value as { seq: number }).seq, at, sub: m.sub }) }
    }
  }
}, null)
await engine.subscribe({ clientId: connection.id, add: Array.from({ length: n('groups') }, (_, i) => ({ sub: i, name: `engineLoad:${f.mix}`, args: { grp: f.mix === 'precise' ? Math.floor(i / 3) : i, variant: i % 3 } })), remove: [] }, null)
const waitIdle = async (timeout: number) => {
  const start = performance.now()
  while (engine.busy) { if (performance.now() - start > timeout) return false; await sleep(5) }
  return true
}
const initializationProbe = n('pool') < n('readers') ? setInterval(() => console.log(JSON.stringify({ event: 'initializing', delivered: initial, expected: n('groups'), poolTotal: adapter.pool.totalCount, poolIdle: adapter.pool.idleCount, poolWaiting: adapter.pool.waitingCount })), 3000) : undefined
if (!await waitIdle(180000) || initial !== n('groups') || errors) throw new Error(`initialization failed: ${initial}/${f.groups}, errors=${errors}`)
clearInterval(initializationProbe)
console.log(JSON.stringify({ event: 'ready', pid: process.pid, groups: n('groups'), mix: f.mix, rss: process.memoryUsage().rss }))
if (f.mode === 'fanout') {
  const times: number[] = [], firsts: number[] = []
  for (let r = 0; r < n('runs'); r++) {
    arrivals.clear()
    const result = await admin.query('update items set val=val+1,seq=seq+1 where id=0 returning xmin::text as xid')
    const timestamp = await admin.query('select extract(epoch from pg_xact_commit_timestamp($1::xid))*1000 as t', [result.rows[0].xid])
    const commit = Number(timestamp.rows[0].t)
    const deadline = performance.now() + 180000
    while (arrivals.size < n('groups') && performance.now() < deadline) await sleep(2)
    if (!await waitIdle(180000) || arrivals.size !== n('groups')) throw new Error(`fanout missing ${arrivals.size}`)
    times.push(Math.max(...arrivals.values()) - commit); firsts.push(Math.min(...arrivals.values()) - commit)
  }
  console.log(JSON.stringify({ mode: 'fanout', groups: n('groups'), readers: n('readers'), pool: n('pool'), allMs: quantiles(times), firstMs: quantiles(firsts), evaluations, rss: process.memoryUsage().rss }))
} else if (f.mode === 'mutation') {
  collect = true
  const t = performance.now()
  for (let i = 0; i < n('runs'); i++) {
    await engine.mutate({ name: 'engineLoad:write', args: {}, clientId: connection.id, mutationId: String(i) }, null)
    const deadline = performance.now() + 180000
    while (!settled.has(String(i)) && performance.now() < deadline) await sleep(1)
    if (!settled.has(String(i))) throw new Error(`mutation ${i} did not settle`)
  }
  console.log(JSON.stringify({ mode: 'mutation', runs: n('runs'), elapsed: performance.now() - t, errors }))
} else {
  collect = true; evaluations = 0; batches = 0; matchCalls = 0; changes = 0
  const cpu = process.cpuUsage(), start = performance.now()
  const startHrUs = Number(process.hrtime.bigint() / 1000n)
  const telemetry: unknown[] = []
  let sampling = false
  const sample = async () => {
    if (sampling) return
    sampling = true
    try {
      const p = position
      const r = await admin.query('select pg_current_wal_lsn()::text as current, pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)::float8 as bytes', [p])
      const u = process.cpuUsage(cpu)
      const point = { seconds: (performance.now() - start) / 1000, evaluations, batches, changes, matchCalls, deliveries, received: p, current: r.rows[0].current, lagBytes: r.rows[0].bytes, cpuMs: (u.user + u.system) / 1000, rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed, waiting: adapter.pool.waitingCount }
      telemetry.push(point)
      await appendFile(`${f.out}/telemetry-${process.pid}.jsonl`, JSON.stringify(point) + '\n')
    } finally { sampling = false }
  }
  const timer = setInterval(() => void sample(), 1000)
  const args = Object.entries(f).filter(([k]) => k !== 'mode').flatMap(([k, v]) => [`--${k}`, String(v)])
  const child = spawn('taskset', ['-c', f.cpus!, process.execPath, import.meta.filename, '--mode', 'writer', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
  const [exit] = await once(child, 'exit')
  if (exit !== 0) throw new Error(`writer exit ${exit}`)
  const writerEnd = performance.now()
  const writes = JSON.parse(await readFile(`${f.out}/writes-${process.pid}.json`, 'utf8'))
  const deadline = performance.now() + 60000
  while ((changes < writes.finished || engine.busy) && performance.now() < deadline) await sleep(10)
  const drained = changes === writes.finished && !engine.busy
  const endHrUs = Number(process.hrtime.bigint() / 1000n)
  const drainMs = Math.max(0, now() - writes.records.reduce((v: number, r: { at: number }) => Math.max(v, r.at), 0))
  await sleep(100)
  clearInterval(timer)
  while (sampling) await sleep(5)
  await sample()
  const commits = new Map<number, number>()
  for (let i = 0; i < writes.records.length; i += 1000) {
    const part = writes.records.slice(i, i + 1000)
    const result = await admin.query('select x,extract(epoch from pg_xact_commit_timestamp(x::xid))*1000 as t from unnest($1::text[]) x', [part.map((r: { xid: string }) => r.xid)])
    const ts = new Map(result.rows.map((r: { x: string; t: string }) => [r.x, Number(r.t)]))
    for (const r of part) commits.set(r.seq, ts.get(r.xid)!)
  }
  const seen = new Set<string>(), latency: number[] = []
  for (const o of observations) {
    const key = `${o.sub}:${o.seq}`
    if (seen.has(key) || !commits.has(o.seq)) continue
    seen.add(key); latency.push(o.at - commits.get(o.seq)!)
  }
  const result = { mode: 'load', startHrUs, endHrUs, elapsedSeconds: (performance.now() - start) / 1000, groups: n('groups'), mix: f.mix, rate: n('rate'), readers: n('readers'), pool: n('pool'), seconds: n('seconds'), writes: writes.finished, writerSeconds: writes.elapsed / 1000, writesPerSecond: writes.finished / (writes.elapsed / 1000), drainMs, drained, evaluations, rerunsPerSecond: evaluations / ((writerEnd - start) / 1000), deliveries, latencySamples: latency.length, latencyMs: quantiles(latency), errors, telemetry }
  await writeFile(`${f.out}/result-${process.pid}.json`, JSON.stringify({ ...result, observations, writes }, null, 2))
  console.log(JSON.stringify(result))
}
await engine.disconnect(connection.id)
await engine.stop()
await admin.end()
