import { parseArgs } from "node:util"
import { __register, Engine, mutation, query, type Reader, type Session } from "@lyn/core"
import { applyRows, decode, encode, type ServerFrame } from "@lyn/core/wire"
import pg from "pg"
import { postgres } from "../src/index.ts"

const { values: flags } = parseArgs({
  options: {
    seed: { type: "string" },
    steps: { type: "string", default: "300" },
    url: { type: "string", default: process.env.FUZZ_DATABASE_URL ?? "postgres://postgres@localhost:54329/lyn_fuzz" },
    verbose: { type: "boolean", default: false },
  },
})

const seed = Number(flags.seed ?? Math.floor(Math.random() * 2 ** 31))
const steps = Number(flags.steps)
const url = flags.url!
const role = "lyn_fuzz_app"

function mulberry32(state: number) {
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = mulberry32(seed)
const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
const chance = (p: number) => random() < p
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const grp = () => int(1, 4)
const id = () => int(1, 16)
const val = () => int(0, 9)

const SCHEMA = `
  drop view if exists flagged;
  drop table if exists groups, items, items_default, owned, barrier cascade;
  drop function if exists fuzz_double(int);
  drop function if exists flagged_in(int);
  create table groups (id int primary key, name text not null);
  create table items (id int primary key, grp int not null, flag boolean not null default false, val int not null default 0, tag text);
  create table items_default (id int primary key, grp int not null, val int not null default 0);
  create table owned (id int primary key, owner int not null, val int not null default 0);
  create table barrier (id int primary key, n int not null);
  alter table groups replica identity full;
  alter table items replica identity full;
  alter table owned replica identity full;
  alter table barrier replica identity full;
  create view flagged as select * from items where flag;
  create function fuzz_double(int) returns int language sql immutable as $$ select $1 * 2 $$;
  create function flagged_in(g int) returns int language sql stable as $$ select count(*)::int from items where grp = g and flag $$;
  insert into barrier values (1, 0);
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = '${role}') then create role ${role} nologin; end if;
  end $$;
  grant usage on schema public to ${role};
  grant select, insert, update, delete, truncate on all tables in schema public to ${role};
  alter table owned enable row level security;
  create policy own on owned
    using (owner = (nullif(current_setting('lyn.session', true), '')::jsonb ->> 'owner')::int)
    with check (owner = (nullif(current_setting('lyn.session', true), '')::jsonb ->> 'owner')::int);
`

interface QuerySpec {
  sql: string
  args: () => unknown[]
}

const QUERIES: Record<string, QuerySpec> = {
  byGroup: { sql: `select * from items where grp = $1 order by id`, args: () => [grp()] },
  byGroupFlag: { sql: `select id, val from items where grp = $1 and flag = $2 order by id`, args: () => [grp(), chance(0.5)] },
  byIds: { sql: `select * from items where id in ($1, $2, $3) order by id`, args: () => [id(), id(), id()] },
  byGroupsAny: { sql: `select id, grp from items where grp = any($1) order by id`, args: () => [[grp(), grp()]] },
  groupTotals: {
    sql: `select g.id, g.name, count(i.id)::int as n, coalesce(sum(i.val), 0)::int as total
          from groups g left join items i on i.grp = g.id group by g.id order by g.id`,
    args: () => [],
  },
  groupsWithFlagged: { sql: `select * from groups where id in (select grp from items where flag = true) order by id`, args: () => [] },
  cteCount: { sql: `with x as (select * from items where grp = $1) select count(*)::int as n from x`, args: () => [grp()] },
  orQuery: { sql: `select id from items where grp = $1 or val > $2 order by id`, args: () => [grp(), val()] },
  viewQuery: { sql: `select id from flagged where grp = $1 order by id`, args: () => [grp()] },
  defaultIdentity: { sql: `select * from items_default where grp = $1 order by id`, args: () => [grp()] },
  defaultIdentityById: { sql: `select * from items_default where id = $1`, args: () => [id()] },
  byId: { sql: `select * from items where id = $1`, args: () => [id()] },
  topValues: { sql: `select id, val from items order by val desc, id limit 3`, args: () => [] },
  tagConst: { sql: `select id from items where tag = 'a' order by id`, args: () => [] },
  castParam: { sql: `select id from items where grp = $1::int and val >= 0 order by id`, args: () => [grp()] },
  correlated: {
    sql: `select g.id, (select count(*) from items i where i.grp = g.id and i.flag)::int as flagged from groups g order by g.id`,
    args: () => [],
  },
  userFunction: { sql: `select id, fuzz_double(val) as doubled from items where grp = $1 order by id`, args: () => [grp()] },
  hiddenRead: { sql: `select g.id, flagged_in(g.id) as flagged from groups g order by g.id`, args: () => [] },
  owned: { sql: `select * from owned order by id`, args: () => [] },
  ownedByVal: { sql: `select id from owned where val = $1 order by id`, args: () => [val()] },
  drizzleStyle: {
    sql: `select "id", "grp" from "items" where ("items"."grp" = $1 and "items"."flag" = $2) order by "items"."id"`,
    args: () => [grp(), chance(0.5)],
  },
  aliasJoin: { sql: `select i.id, g.name from items i join groups g on g.id = i.grp where g.id = $1 order by i.id`, args: () => [grp()] },
  notExists: { sql: `select g.id from groups g where not exists (select 1 from items i where i.grp = g.id) order by g.id`, args: () => [] },
  union: {
    sql: `select id from items where grp = $1 union select id from items_default where grp = $1 order by id`,
    args: () => [grp()],
  },
}

type Statement = { sql: string; params: unknown[] }

const WRITES: (() => Statement)[] = [
  () => ({ sql: `insert into items (id, grp, flag, val, tag) values ($1, $2, $3, $4, $5) on conflict do nothing`, params: [id(), grp(), chance(0.5), val(), pick(["a", "b", null])] }),
  () => ({ sql: `update items set grp = $2 where id = $1`, params: [id(), grp()] }),
  () => ({ sql: `update items set flag = not flag where id = $1`, params: [id()] }),
  () => ({ sql: `update items set val = $2, tag = $3 where id = $1`, params: [id(), val(), pick(["a", "b", null])] }),
  () => ({ sql: `update items set flag = not flag where grp = $1`, params: [grp()] }),
  () => ({ sql: `update items set id = $2 where id = $1 and not exists (select 1 from items where id = $2)`, params: [id(), id()] }),
  () => ({ sql: `delete from items where id = $1`, params: [id()] }),
  () => ({ sql: `insert into groups (id, name) values ($1, $2) on conflict (id) do update set name = excluded.name`, params: [grp(), `g${val()}`] }),
  () => ({ sql: `delete from groups where id = $1`, params: [grp()] }),
  () => ({ sql: `insert into items_default (id, grp, val) values ($1, $2, $3) on conflict do nothing`, params: [id(), grp(), val()] }),
  () => ({ sql: `update items_default set grp = $2 where id = $1`, params: [id(), grp()] }),
  () => ({ sql: `update items_default set id = $2 where id = $1 and not exists (select 1 from items_default where id = $2)`, params: [id(), id()] }),
  () => ({ sql: `delete from items_default where id = $1`, params: [id()] }),
  () => ({ sql: `insert into owned (id, owner, val) values ($1, $2, $3) on conflict do nothing`, params: [id(), int(1, 2), val()] }),
  () => ({ sql: `update owned set owner = $2 where id = $1`, params: [id(), int(1, 2)] }),
  () => ({ sql: `update owned set val = $2 where id = $1`, params: [id(), val()] }),
  () => ({ sql: `delete from owned where id = $1`, params: [id()] }),
]

const SESSIONS: (Session | null)[] = [null, { owner: 1 }, { owner: 2 }]

interface SubState {
  name: string
  args: unknown[]
  value?: unknown
  version?: number
}

interface FakeClient {
  session: Session | null
  connection: { id: string }
  subs: Map<number, SubState>
  settled: Map<string, Map<string, string>>
  nextSub: number
}

const failures: string[] = []
const subKey = (client: { connection: { id: string } }, sub: number) => `${client.connection.id}:${sub}`
const log: string[] = []
const record = (line: string) => {
  log.push(line)
  if (log.length > 40) log.shift()
  if (flags.verbose) console.log(line)
}

async function setup() {
  const admin = new pg.Client({ connectionString: url.replace(/\/[^/]*$/, "/postgres") })
  await admin.connect()
  const database = new URL(url).pathname.slice(1)
  const exists = await admin.query("select 1 from pg_database where datname = $1", [database])
  if (!exists.rowCount) await admin.query(`create database "${database}"`)
  await admin.end()

  const client = new pg.Client({ connectionString: url })
  await client.connect()
  await client.query(SCHEMA)
  for (let g = 1; g <= 4; g++) await client.query("insert into groups values ($1, $2)", [g, `g${g}`])
  for (let i = 1; i <= 12; i++)
    await client.query("insert into items values ($1, $2, $3, $4, $5)", [i, grp(), chance(0.5), val(), pick(["a", "b", null])])
  for (let i = 1; i <= 8; i++) await client.query("insert into items_default values ($1, $2, $3)", [i, grp(), val()])
  for (let i = 1; i <= 8; i++) await client.query("insert into owned values ($1, $2, $3)", [i, int(1, 2), val()])
  return client
}

async function main() {
  console.log(`[fuzz] seed=${seed} steps=${steps}`)
  const direct = await setup()
  const adapter = postgres({ url, role, max: 10 })

  let reruns = 0
  let deliveredChanges = 0
  const snapshot = adapter.snapshot.bind(adapter)
  adapter.snapshot = (after, run) =>
    snapshot(after, (read) =>
      run(((context, task) => {
        if (after.length) reruns++
        return read(context, task)
      }) as Reader),
    )

  for (const [name, spec] of Object.entries(QUERIES))
    __register("fuzz", { [name]: query({ handler: async (_, args: { p: unknown[] }) => (await adapter.pool.query(spec.sql, args.p)).rows }) })
  __register("fuzz", {
    barrier: query({ handler: async () => (await adapter.pool.query("select n from barrier where id = 1")).rows[0]?.n }),
    exec: mutation({
      handler: async (_, args: { statements: Statement[] }) => {
        for (const statement of args.statements) await adapter.pool.query(statement.sql, statement.params)
      },
    }),
  })

  const engine = Engine.for(adapter)
  await engine.ready

  const clients: FakeClient[] = SESSIONS.map((session) => {
    const client: FakeClient = { session, connection: { id: "" }, subs: new Map(), settled: new Map(), nextSub: 1 }
    client.connection = engine.connect((frame) => {
      const settledNow: string[] = []
      for (const message of decode<ServerFrame>(frame).messages) {
        if (message.type === "settled") {
          settledNow.push(...message.mutations)
          continue
        }
        const state = client.subs.get(message.sub)
        if (!state) continue
        if (message.type === "error") failures.push(`query error in ${state.name}(${JSON.stringify(state.args)}): ${message.message}`)
        else if (message.type === "data") {
          if (state.version !== undefined) deliveredChanges++
          state.value = message.value
          state.version = message.version
        } else {
          if (state.version !== message.from)
            failures.push(`patch for ${state.name} expected version ${state.version} but was from ${message.from}`)
          deliveredChanges++
          state.value = applyRows(state.value, message.patch)
          state.version = message.version
        }
      }
      if (!settledNow.length) return
      const seen = new Map([...client.subs].map(([sub, state]) => [subKey(client, sub), encode(state.value)] as const))
      for (const mutationId of settledNow) client.settled.set(mutationId, seen)
    }, session)
    return client
  })

  const subscribe = async (client: FakeClient, name: string, args: unknown[]) => {
    const sub = client.nextSub++
    client.subs.set(sub, { name, args })
    await engine.subscribe({ clientId: client.connection.id, add: [{ sub, name: `fuzz:${name}`, args: { p: args } }], remove: [] }, client.session)
  }

  for (const client of clients)
    for (const name of Object.keys(QUERIES)) {
      await subscribe(client, name, QUERIES[name]!.args())
      if (chance(0.5)) await subscribe(client, name, QUERIES[name]!.args())
    }
  await subscribe(clients[0]!, "barrier", [])
  const barrierSub = [...clients[0]!.subs.entries()].find(([, state]) => state.name === "barrier")![0]

  let barrierValue = 0
  const barrier = async () => {
    barrierValue++
    await direct.query("update barrier set n = $1 where id = 1", [barrierValue])
    const deadline = Date.now() + 10_000
    while (clients[0]!.subs.get(barrierSub)!.value !== barrierValue) {
      if (Date.now() > deadline) throw new Error(`engine did not deliver barrier ${barrierValue} within 10s`)
      await sleep(2)
    }
  }

  const expected = async (session: Session | null, sql: string, params: unknown[]) => {
    await direct.query("begin")
    try {
      await direct.query("select set_config('lyn.session', $1, true), set_config('role', $2, true)", [session ? JSON.stringify(session) : "", role])
      return (await direct.query(sql, params)).rows
    } finally {
      await direct.query("rollback")
    }
  }

  const verify = async (moment: string, seen?: Map<string, string>) => {
    for (const client of clients)
      for (const [sub, state] of client.subs) {
        if (state.name === "barrier") continue
        const want = await expected(client.session, QUERIES[state.name]!.sql, state.args)
        const actual = seen ? seen.get(subKey(client, sub)) : encode(state.value)
        if (actual !== undefined && encode(want) !== actual)
          failures.push(
            `${moment}: ${state.name}(${JSON.stringify(state.args)}) as ${JSON.stringify(client.session)}\n` +
              `  sql:      ${QUERIES[state.name]!.sql.replace(/\s+/g, " ")}\n` +
              `  expected: ${JSON.stringify(want)}\n  actual:   ${seen ? actual : JSON.stringify(state.value)}`,
          )
      }
  }

  const statements = () => Array.from({ length: int(1, 3) }, () => pick(WRITES)())

  const writers = new pg.Pool({ connectionString: url, max: 6 })
  const externalWrite = async () => {
    const batch = statements()
    record(`external: ${batch.map((s) => `${s.sql.split(" ").slice(0, 3).join(" ")} ${JSON.stringify(s.params)}`).join(" ; ")}`)
    const writer = await writers.connect()
    try {
      await writer.query("begin")
      for (const statement of batch) await writer.query(statement.sql, statement.params)
      await writer.query("commit")
    } catch {
      await writer.query("rollback")
    } finally {
      writer.release()
    }
  }

  const engineMutation = async (checkSettle: boolean) => {
    const client = pick(clients)
    const batch = statements()
    const mutationId = crypto.randomUUID()
    record(`mutate as ${JSON.stringify(client.session)}: ${batch.map((s) => `${s.sql.split(" ").slice(0, 3).join(" ")} ${JSON.stringify(s.params)}`).join(" ; ")}`)
    let result
    try {
      result = await engine.mutate({ clientId: client.connection.id, mutationId, name: "fuzz:exec", args: { statements: batch } }, client.session)
    } catch {
      return
    }
    if (!checkSettle || result.settled) return
    const deadline = Date.now() + 10_000
    while (!client.settled.has(mutationId)) {
      if (Date.now() > deadline) return failures.push(`mutation ${mutationId} never settled`)
      await sleep(1)
    }
    await verify("at settle", client.settled.get(mutationId))
  }

  const churn = async () => {
    const client = pick(clients)
    const candidates = [...client.subs.entries()].filter(([, state]) => state.name !== "barrier")
    const [sub] = pick(candidates)
    client.subs.delete(sub)
    await engine.subscribe({ clientId: client.connection.id, add: [], remove: [sub] }, client.session)
    const name = pick(Object.keys(QUERIES))
    record(`churn: ${client.subs.size} subs, adding ${name}`)
    await subscribe(client, name, QUERIES[name]!.args())
  }

  const truncate = async () => {
    record("external: truncate items")
    await direct.query("truncate items")
  }

  const started = Date.now()
  for (let step = 1; step <= steps && !failures.length; step++) {
    const roll = random()
    if (roll < 0.35) await externalWrite()
    else if (roll < 0.7) await engineMutation(true)
    else if (roll < 0.85)
      await Promise.all(Array.from({ length: int(2, 6) }, () => (chance(0.5) ? externalWrite() : engineMutation(false))))
    else if (roll < 0.97) await churn()
    else await truncate()
    await barrier()
    await verify(`after step ${step}`)
    if (step % 50 === 0) console.log(`[fuzz] step ${step}/${steps}`)
  }

  const subscriptions = clients.reduce((total, client) => total + client.subs.size, 0)
  console.log(
    `[fuzz] ${failures.length ? "FAILED" : "passed"} in ${((Date.now() - started) / 1000).toFixed(1)}s · ${subscriptions} subscriptions · ` +
      `${reruns} re-runs · ${deliveredChanges} delivered changes (${reruns ? Math.round((deliveredChanges / reruns) * 100) : 100}% of re-runs changed a result)`,
  )
  if (failures.length) {
    console.log(`\n[fuzz] replay with: --seed=${seed} --steps=${steps}\n\nrecent operations:\n  ${log.join("\n  ")}\n`)
    for (const failure of failures.slice(0, 5)) console.log(`✗ ${failure}\n`)
  }
  await engine.stop()
  await writers.end()
  await direct.end()
  process.exit(failures.length ? 1 : 0)
}

await main()
