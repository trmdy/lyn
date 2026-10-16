import { readFile, writeFile } from 'node:fs/promises'
import pg from 'pg'

const file = process.argv[2]
if (!file) throw new Error('usage: node engine-results.ts result.json [database-url]')
const result = JSON.parse(await readFile(file, 'utf8'))
const client = new pg.Client({ connectionString: process.argv[3] ?? process.env.BENCH_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:56291/lyn_engine_bench' })
const needsDatabase = result.writes.records.some((r: { commitMs?: number }) => !r.commitMs)
if (needsDatabase) await client.connect()
const bySeq = new Map<number, { seq: number; t: number; respondedAt: number; index: number }>()
for (let i = 0; i < result.writes.records.length; i += 1000) {
  const part = result.writes.records.slice(i, i + 1000)
  const rows = needsDatabase ? await client.query('select x,extract(epoch from pg_xact_commit_timestamp(x::xid))*1000 as t from unnest($1::text[]) x', [part.map((r: { xid: string }) => r.xid)]) : { rows: part.map((r: { xid: string; commitMs: number }) => ({ x: r.xid, t: r.commitMs })) }
  const ts = new Map<string, number>(rows.rows.map((r: { x: string; t: string }) => [r.x, Number(r.t)]))
  for (const r of part) {
    if (!ts.get(r.xid)) throw new Error(`missing commit timestamp ${r.xid}`)
    bySeq.set(r.seq, { seq: r.seq, t: ts.get(r.xid)!, respondedAt: r.at, index: 0 })
    r.commitMs = ts.get(r.xid)
  }
}
if (needsDatabase) await client.end()
const buckets = result.mix === 'precise' ? Math.ceil(result.groups / 3) : 1
const timelines = Array.from({ length: buckets }, () => [] as { seq: number; t: number; respondedAt: number; index: number }[])
for (const w of bySeq.values()) timelines[result.mix === 'precise' ? (w.seq - 1) % buckets : 0].push(w)
for (const timeline of timelines) {
  timeline.sort((a, b) => a.respondedAt - b.respondedAt)
  timeline.forEach((w, i) => { w.index = i })
}
const cursors = new Uint32Array(result.groups)
const delivered = new Map<number, { count: number; last: number; first: number }>()
const ahead = new Map<number, Set<number>>()
const record = (seq: number, at: number) => {
  const d = delivered.get(seq) ?? { count: 0, last: 0, first: Infinity }
  d.count++; d.last = Math.max(d.last, at); d.first = Math.min(d.first, at)
  delivered.set(seq, d)
}
for (const o of result.observations) {
  const visible = bySeq.get(o.seq)
  if (!visible) continue
  const timeline = timelines[result.mix === 'precise' ? Math.floor(o.sub / 3) : 0]
  const done = ahead.get(o.sub) ?? new Set<number>()
  ahead.set(o.sub, done)
  while (cursors[o.sub] < timeline.length && timeline[cursors[o.sub]].respondedAt + 1 <= visible.t) {
    const commit = timeline[cursors[o.sub]++]
    if (!done.delete(commit.seq)) record(commit.seq, o.at)
  }
  if (visible.index >= cursors[o.sub] && !done.has(visible.seq)) {
    done.add(visible.seq)
    record(visible.seq, o.at)
  }
}
const all: number[] = [], first: number[] = [], early: number[] = [], late: number[] = []
let incomplete = 0
for (const w of bySeq.values()) {
  const grp = (w.seq - 1) % buckets
  const expected = result.mix === 'precise' ? Math.min(3, result.groups - grp * 3) : result.groups
  const d = delivered.get(w.seq)
  if (!d || d.count !== expected) { incomplete++; continue }
  const elapsed = d.last - w.t
  all.push(elapsed); first.push(d.first - w.t)
  if (w.seq < result.writes.finished / 3) early.push(elapsed)
  if (w.seq > result.writes.finished * 2 / 3) late.push(elapsed)
}
const q = (xs: number[]) => {
  xs.sort((a, b) => a - b)
  return Object.fromEntries([['p50', .5], ['p95', .95], ['p99', .99], ['max', 1]].map(([k, v]) => [k, xs[Math.max(0, Math.ceil(xs.length * Number(v)) - 1)] ?? null]))
}
const firstWriteAt = result.writes.records.reduce((v: number, r: { at: number }) => Math.min(v, r.at), Infinity)
const lastWriteAt = result.writes.records.reduce((v: number, r: { at: number }) => Math.max(v, r.at), 0)
let lastDeliveryAt = 0
for (const o of result.observations) lastDeliveryAt = Math.max(lastDeliveryAt, o.at)
result.observedDrainMs = Math.max(0, lastDeliveryAt - lastWriteAt)
result.processingWritesPerSecond = result.writes.finished / ((Math.max(lastWriteAt, lastDeliveryAt) - firstWriteAt) / 1000)
result.processingRerunsPerSecond = result.evaluations / ((Math.max(lastWriteAt, lastDeliveryAt) - firstWriteAt) / 1000)
result.analysisVersion = 2
result.coverage = { completeWrites: all.length, incompleteWrites: incomplete, allMs: q(all), firstMs: q(first), earlyMs: q(early), lateMs: q(late) }
const { observations, writes, ...summary } = result
await writeFile(file, JSON.stringify(result))
console.log(JSON.stringify(summary))
