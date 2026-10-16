import { parseArgs } from "node:util"
import { __register, Engine, query, type Session } from "@lyn/core"
import { createRouter } from "@lyn/core/wire"
import pg from "pg"
import { postgres } from "../src/index.ts"

const { values: flags } = parseArgs({
  options: {
    url: { type: "string", default: process.env.BENCH_DATABASE_URL ?? "postgres://postgres@localhost:54329/lyn_bench" },
    slow: { type: "string", default: "300" },
    runs: { type: "string", default: "5" },
  },
})

const url = flags.url!
const slowMs = Number(flags.slow)
const runs = Number(flags.runs)
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

async function setup() {
  const admin = new pg.Client({ connectionString: url.replace(/\/[^/]*$/, "/postgres") })
  await admin.connect()
  const database = new URL(url).pathname.slice(1)
  if (!(await admin.query("select 1 from pg_database where datname = $1", [database])).rowCount) await admin.query(`create database "${database}"`)
  await admin.end()
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  await client.query(`
    drop table if exists items, heavy;
    create table items (id int primary key, grp int not null, val int not null);
    create index on items (grp);
    create table heavy (id int primary key, val int not null);
    alter table items replica identity full;
    alter table heavy replica identity full;
    insert into items select i, i % 1000, i % 97 from generate_series(1, 20000) i;
    insert into heavy values (1, 0);
  `)
  return client
}

async function main() {
  const direct = await setup()
  const adapter = postgres({ url, max: 20 })
  __register("bench", {
    byGroup: query({ handler: async (_, a: { grp: number }) => (await adapter.pool.query("select sum(val)::int as n from items where grp = $1", [a.grp])).rows[0] }),
    broad: query({ handler: async (_, a: { upTo: number }) => (await adapter.pool.query("select sum(val)::int as n from items where id <= $1", [a.upTo])).rows[0] }),
    slow: query({
      handler: async () => (await adapter.pool.query(`select pg_sleep(${slowMs / 1000}), max(val) as v from heavy`)).rows[0],
    }),
  })
  const engine = Engine.for(adapter)
  await engine.ready

  const arrivals = new Map<number, number>()
  let nextSub = 1
  const subsByName = new Map<number, string>()
  const router = createRouter()
  const connection = engine.connect((frame) => {
    const now = performance.now()
    for (const message of router.route(frame)) if ("sub" in message && message.type !== "error") arrivals.set(message.sub, now)
  }, null as Session | null)
  const subscribe = async (name: string, args: unknown) => {
    const sub = nextSub++
    subsByName.set(sub, name)
    await engine.subscribe({ clientId: connection.id, add: [{ sub, name: `bench:${name}`, args }], remove: [] }, null)
    return sub
  }
  const unsubscribe = (subs: number[]) => engine.subscribe({ clientId: connection.id, add: [], remove: subs }, null)
  const waitFor = async (subs: number[], since: number, timeout = 30_000) => {
    const deadline = performance.now() + timeout
    while (subs.some((sub) => (arrivals.get(sub) ?? 0) < since)) {
      if (performance.now() > deadline) throw new Error("timed out waiting for updates")
      await sleep(1)
    }
    return subs.map((sub) => arrivals.get(sub)! - since)
  }

  console.log(`[bench] slow query = ${slowMs}ms, median of ${runs} runs\n`)

  for (const fanout of [1, 50, 200, 1000]) {
    const subs: number[] = []
    for (let i = 0; i < fanout; i++) subs.push(await subscribe("broad", { upTo: 10 + i }))
    const firsts: number[] = []
    const lasts: number[] = []
    for (let run = 0; run < runs; run++) {
      const since = performance.now()
      await direct.query("update items set val = val + 1 where id = $1", [1 + run])
      const latencies = await waitFor(subs, since)
      firsts.push(Math.min(...latencies))
      lasts.push(Math.max(...latencies))
    }
    console.log(`fan-out ${String(fanout).padStart(4)} queries affected by one write: first update ${median(firsts).toFixed(0)}ms, last ${median(lasts).toFixed(0)}ms`)
    await unsubscribe(subs)
  }

  const fast = await subscribe("byGroup", { grp: 7 })
  const slow = await subscribe("slow", {})
  const fastAlone: number[] = []
  const fastWithSlow: number[] = []
  for (let run = 0; run < runs; run++) {
    let since = performance.now()
    await direct.query("update items set val = val + 1 where id = 7")
    fastAlone.push((await waitFor([fast], since))[0]!)
    since = performance.now()
    await direct.query("begin; update items set val = val + 1 where id = 7; update heavy set val = val + 1 where id = 1; commit")
    fastWithSlow.push((await waitFor([fast], since))[0]!)
    await waitFor([slow], since)
  }
  console.log(`\nslow neighbour: fast query alone ${median(fastAlone).toFixed(0)}ms, same batch as a ${slowMs}ms query ${median(fastWithSlow).toFixed(0)}ms`)

  const nextBatch: number[] = []
  const subscribeDuring: number[] = []
  for (let run = 0; run < runs; run++) {
    const since = performance.now()
    await direct.query("update heavy set val = val + 1 where id = 1")
    await sleep(20)
    const afterSlowStarted = performance.now()
    await direct.query("update items set val = val + 1 where id = 7")
    const subscribeStarted = performance.now()
    const fresh = await subscribe("byGroup", { grp: 100 + run })
    subscribeDuring.push((await waitFor([fresh], subscribeStarted))[0]!)
    nextBatch.push((await waitFor([fast], afterSlowStarted))[0]!)
    await waitFor([slow], since)
    await unsubscribe([fresh])
  }
  console.log(`next batch while a slow batch runs: unrelated update ${median(nextBatch).toFixed(0)}ms`)
  console.log(`subscribe while a slow batch runs: initial data ${median(subscribeDuring).toFixed(0)}ms`)

  await engine.stop()
  await direct.end()
}

await main()
