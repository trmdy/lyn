import { AsyncLocalStorage } from "node:async_hooks"
import type { Adapter, Change, ChangeBatch, ExecutionContext, Reader } from "@lyn/core"
import { loadModule } from "libpg-query"
import pg from "pg"
import { LogicalReplicationService, PgoutputPlugin } from "pg-logical-replication"
import { buildCatalog, changeAffects, clearTemplates, readsOf, type Catalog, type ReadSet } from "./reads.ts"

export type { ReadSet, TableRead } from "./reads.ts"

export interface PostgresOptions {
  url: string
  role?: string
  publication?: string
  max?: number
}

interface Scope {
  adapterId: string
  client: pg.PoolClient
  reads: ReadSet | null
  catalog: Catalog
  tail: Promise<unknown>
  savepoints: number
}

const scope = new AsyncLocalStorage<Scope>()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const TRANSACTION_CONTROL = /^\s*(begin|start\s+transaction|commit|end|abort|rollback(?!\s+(?:work\s+|transaction\s+)?to\b))\b/i

function rewriteTransactionControl(text: string, current: Scope) {
  const match = TRANSACTION_CONTROL.exec(text)
  if (!match) return text
  const verb = match[1]!.toLowerCase()
  if (verb === "begin" || verb.startsWith("start")) return `savepoint lyn_${++current.savepoints}`
  if (verb === "commit" || verb === "end") return `release savepoint lyn_${current.savepoints--}`
  return `rollback to savepoint lyn_${current.savepoints--}`
}

function scopedQuery(current: Scope, config: unknown, values?: unknown) {
  const text = typeof config === "string" ? config : (config as { text: string }).text
  const params = (typeof config === "string" ? values : ((config as { values?: unknown[] }).values ?? values)) as unknown[] | undefined
  const rewritten = rewriteTransactionControl(text, current)
  if (current.reads && rewritten === text) {
    const reads = readsOf(text, params ?? [], current.catalog)
    current.reads.any ||= reads.any
    current.reads.tables.push(...reads.tables)
  }
  const query =
    rewritten === text ? config : typeof config === "string" ? rewritten : { ...(config as object), text: rewritten }
  const result = current.tail.then(() => current.client.query(query as any, values as any))
  current.tail = result.catch(() => {})
  return result
}

function scopedClient(current: Scope) {
  return new Proxy(current.client, {
    get(target, property, receiver) {
      if (property === "query") return (config: unknown, values?: unknown) => scopedQuery(current, config, values)
      if (property === "release") return () => {}
      return Reflect.get(target, property, receiver)
    },
  })
}

export class LynPool extends pg.Pool {
  adapterId = ""

  connectDirect(): Promise<pg.PoolClient> {
    return super.connect()
  }

  #scope() {
    const current = scope.getStore()
    if (current && current.adapterId !== this.adapterId)
      throw new Error(`lyn: this query uses ${this.adapterId} inside a handler running on ${current.adapterId}; use one database per handler`)
    return current
  }

  override query(...args: any[]): any {
    const current = this.#scope()
    if (!current) return (super.query as any)(...args)
    const callback = typeof args.at(-1) === "function" ? args.pop() : undefined
    const result = scopedQuery(current, args[0], args[1])
    if (!callback) return result
    result.then((value) => callback(undefined, value), (error) => callback(error))
  }

  override connect(...args: any[]): any {
    const current = this.#scope()
    if (!current) return (super.connect as any)(...args)
    const client = scopedClient(current)
    if (typeof args[0] === "function") return args[0](undefined, client, () => {})
    return Promise.resolve(client)
  }
}

class TempSlotPgoutput extends PgoutputPlugin {
  onSlotCreated: () => void = () => {}

  async start(client: pg.Client, slotName: string, lastLsn: string) {
    await client.query(`CREATE_REPLICATION_SLOT "${slotName}" TEMPORARY LOGICAL pgoutput`)
    this.onSlotCreated()
    return super.start(client, slotName, lastLsn)
  }
}

const XID_SPACE = 1n << 32n

export function snapshotIncludes(xid32: number, snapshot: string) {
  const [xminText, xmaxText, xipText] = snapshot.split(":")
  const xmin = BigInt(xminText!)
  const xmax = BigInt(xmaxText!)
  const inProgress = new Set((xipText ?? "").split(",").filter(Boolean).map(BigInt))
  let delta = (BigInt(xid32) - (xmax % XID_SPACE) + XID_SPACE) % XID_SPACE
  if (delta >= XID_SPACE / 2n) delta -= XID_SPACE
  const xid = xmax + delta
  return xid < xmin || (xid < xmax && !inProgress.has(xid))
}

const sourceName = (schema: string, name: string) => (schema === "public" ? name : `${schema}.${name}`)

export class PostgresAdapter implements Adapter {
  readonly id: string
  readonly pool: LynPool
  readonly #options: PostgresOptions
  readonly #publication: string
  #catalog: Catalog = buildCatalog({ tables: [], views: [], policies: [], functions: [] })
  #catalogTimer?: ReturnType<typeof setInterval>
  readonly #warned = new Set<string>()
  #replication?: LogicalReplicationService
  #open?: { xid: number; lsn: string; changes: Change[] }
  #onChanges: (batch: ChangeBatch) => void = () => {}
  #leaderClient?: pg.Client
  #leaderRetry?: ReturnType<typeof setTimeout>
  #stopped = false

  constructor(options: PostgresOptions) {
    this.#options = options
    this.#publication = options.publication ?? "lyn"
    this.id = `postgres:${options.url}#role=${options.role ?? ""}&publication=${this.#publication}`
    this.pool = new LynPool({ connectionString: options.url, max: options.max ?? 20 })
    this.pool.adapterId = this.id
  }

  sql = async <R = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<R[]> => {
    const text = strings.reduce((acc, part, i) => acc + `$${i}` + part)
    return (await this.pool.query(text, values)).rows as R[]
  }

  async start(onChanges: (batch: ChangeBatch) => void) {
    this.#onChanges = onChanges
    await loadModule()
    await this.pool.query(
      `do $$ begin
         if not exists (select 1 from pg_publication where pubname = '${this.#publication}') then
           create publication ${this.#publication} for all tables;
         end if;
       end $$`,
    )
    await this.refreshCatalog()
    this.#catalogTimer = setInterval(() => this.refreshCatalog().catch(() => {}), 30_000)
    this.#catalogTimer.unref?.()
    await this.#startReplication()
    await this.#claimLeadership()
  }

  async stop() {
    this.#stopped = true
    clearInterval(this.#catalogTimer)
    clearTimeout(this.#leaderRetry)
    await this.#leaderClient?.end().catch(() => {})
    await this.#replication?.destroy()
    await this.pool.end()
  }

  isLeader() {
    return this.#leaderClient !== undefined
  }

  affects(reads: unknown, batch: ChangeBatch) {
    const readSet = reads as ReadSet | undefined
    if (batch.resync) return true
    if (!readSet || readSet.any) return batch.changes.length > 0
    return batch.changes.some((change) => readSet.tables.some((read) => changeAffects(read, change)))
  }

  async snapshot<T>(after: ChangeBatch[], run: (read: Reader) => Promise<T>): Promise<T> {
    const xids = after.flatMap((batch) => batch.tokens).map(Number)
    const client = await this.pool.connectDirect()
    try {
      const deadline = Date.now() + 10_000
      for (let attempt = 0; ; attempt++) {
        await client.query("begin isolation level repeatable read read only")
        const { rows } = await client.query("select pg_current_snapshot()::text as snapshot")
        if (xids.every((xid) => snapshotIncludes(xid, rows[0].snapshot))) break
        await client.query("rollback")
        if (Date.now() > deadline) throw new Error(`lyn: committed transactions ${xids.join(", ")} never became visible`)
        await sleep(Math.min(50, 1 + attempt))
      }
      const read: Reader = async (context, task) => {
        const current: Scope = {
          adapterId: this.id,
          client,
          reads: { any: false, tables: [] },
          catalog: this.#catalog,
          tail: Promise.resolve(),
          savepoints: 0,
        }
        await client.query("savepoint lyn_read")
        try {
          await this.#applyContext(client, context)
          const value = await scope.run(current, task)
          await current.tail
          await client.query("release savepoint lyn_read")
          return { ok: true, value, reads: current.reads }
        } catch (error) {
          await client.query("rollback to savepoint lyn_read").catch(() => {})
          return { ok: false, error, reads: current.reads }
        }
      }
      try {
        return await run(read)
      } finally {
        await client.query("commit").catch(() => {})
      }
    } finally {
      client.release()
    }
  }

  async write<T>(context: ExecutionContext, run: () => Promise<T>, beforeCommit?: (token: string) => void) {
    const client = await this.pool.connectDirect()
    try {
      await client.query("begin")
      await this.#applyContext(client, context)
      const current: Scope = { adapterId: this.id, client, reads: null, catalog: this.#catalog, tail: Promise.resolve(), savepoints: 0 }
      const value = await scope.run(current, run)
      await current.tail
      const { rows } = await client.query("select pg_current_xact_id_if_assigned()::text as xid")
      const token = rows[0].xid ? String(Number(BigInt(rows[0].xid) & 0xffffffffn)) : undefined
      if (token) {
        await client.query("select pg_logical_emit_message(true, 'lyn', '')")
        beforeCommit?.(token)
      }
      await client.query("commit")
      return { value, token }
    } catch (error) {
      await client.query("rollback").catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async #applyContext(client: pg.PoolClient, context: ExecutionContext) {
    const session = context.system || !context.session ? "" : JSON.stringify(context.session)
    const role = context.system ? "none" : (this.#options.role ?? "none")
    await client.query("select set_config('lyn.session', $1, true), set_config('role', $2, true)", [session, role])
  }

  async refreshCatalog() {
    const [tables, views, policies, functions] = await Promise.all([
      this.pool.query("select schemaname, tablename from pg_publication_tables where pubname = $1", [this.#publication]),
      this.pool.query(
        `select schemaname, viewname, definition from pg_views where schemaname not in ('pg_catalog', 'information_schema')`,
      ),
      this.pool.query(
        `select n.nspname, c.relname, pg_get_expr(p.polqual, p.polrelid) as using
         from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
         where p.polqual is not null`,
      ),
      this.pool.query(
        `select n.nspname, p.proname, l.lanname, p.prosrc from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
         where n.nspname not in ('pg_catalog', 'information_schema')`,
      ),
    ])
    this.#catalog = buildCatalog({
      tables: tables.rows.map((row: { schemaname: string; tablename: string }) => sourceName(row.schemaname, row.tablename)),
      views: views.rows.map((row: { schemaname: string; viewname: string; definition: string }) => ({
        name: sourceName(row.schemaname, row.viewname),
        definition: row.definition,
      })),
      policies: policies.rows.map((row: { nspname: string; relname: string; using: string }) => ({
        table: sourceName(row.nspname, row.relname),
        using: row.using,
      })),
      functions: functions.rows.map((row: { nspname: string; proname: string; lanname: string; prosrc: string }) => ({
        name: `${row.nspname}.${row.proname}`,
        language: row.lanname,
        body: row.prosrc,
      })),
    })
    clearTemplates()
  }

  async #startReplication() {
    const plugin = new TempSlotPgoutput({ protoVersion: 1, publicationNames: [this.#publication], messages: true })
    const slotCreated = new Promise<void>((resolve) => (plugin.onSlotCreated = resolve))
    const replication = new LogicalReplicationService(
      { connectionString: this.#options.url },
      { acknowledge: { auto: true, timeoutSeconds: 10 } },
    )
    this.#replication = replication
    replication.on("data", (_lsn, message) => this.#onWal(message))
    let started = false
    let restarting = false
    const restart = (error: unknown) => {
      if (this.#stopped || restarting || !started) return
      restarting = true
      console.error("[lyn] replication stream lost, restarting:", errorMessage(error))
      replication.destroy().finally(() => this.#recoverReplication())
    }
    replication.on("error", restart)
    const subscription = replication.subscribe(plugin, `lyn_${process.pid}_${Date.now().toString(36)}`)
    try {
      await Promise.race([
        slotCreated,
        subscription.then(() => {
          throw new Error("replication stream ended before it started")
        }),
      ])
    } catch (error) {
      await replication.destroy().catch(() => {})
      throw error
    }
    started = true
    subscription.then(() => restart(new Error("stream ended")), restart)
  }

  async #recoverReplication() {
    for (let attempt = 0; !this.#stopped; attempt++) {
      await sleep(Math.min(30_000, 1000 * 2 ** attempt))
      try {
        await this.#startReplication()
        this.#onChanges({ tokens: [], changes: [], resync: true })
        return
      } catch (error) {
        console.error("[lyn] replication restart failed:", errorMessage(error))
      }
    }
  }

  #onWal(message: any) {
    const push = (change: Change) => this.#open?.changes.push(change)
    switch (message.tag) {
      case "begin":
        this.#open = { xid: message.xid, lsn: message.commitLsn, changes: [] }
        return
      case "relation": {
        const name = sourceName(message.schema, message.name)
        if (!this.#catalog.tables.has(name)) this.refreshCatalog().catch(() => {})
        if (message.replicaIdentity !== "full" && !this.#warned.has(name)) {
          this.#warned.add(name)
          console.warn(
            `[lyn] table "${name}" has REPLICA IDENTITY ${message.replicaIdentity.toUpperCase()}; ` +
              `updates and deletes match subscriptions conservatively. Use REPLICA IDENTITY FULL for precise invalidation.`,
          )
        }
        return
      }
      case "insert":
        push({ source: sourceName(message.relation.schema, message.relation.name), kind: "insert", new: message.new })
        return
      case "update": {
        const keyColumns: string[] = message.relation.keyColumns ?? []
        const old = message.old ?? message.key ?? Object.fromEntries(keyColumns.map((column) => [column, message.new[column]]))
        push({ source: sourceName(message.relation.schema, message.relation.name), kind: "update", new: message.new, old })
        return
      }
      case "delete":
        push({ source: sourceName(message.relation.schema, message.relation.name), kind: "delete", old: message.old ?? message.key })
        return
      case "truncate":
        for (const relation of message.relations) push({ source: sourceName(relation.schema, relation.name), kind: "truncate" })
        return
      case "commit": {
        const open = this.#open
        this.#open = undefined
        if (open) this.#onChanges({ tokens: [String(open.xid)], changes: open.changes, position: open.lsn })
        return
      }
    }
  }

  async #claimLeadership() {
    if (this.#stopped) return
    const client = new pg.Client({ connectionString: this.#options.url })
    const retry = () => {
      if (this.#leaderClient === client) this.#leaderClient = undefined
      client.end().catch(() => {})
      if (!this.#stopped) this.#leaderRetry = setTimeout(() => this.#claimLeadership(), 5_000)
    }
    client.on("error", retry)
    try {
      await client.connect()
      const { rows } = await client.query("select pg_try_advisory_lock(hashtext($1)) as claimed", [`lyn:effects:${this.#publication}`])
      if (!rows[0].claimed) return retry()
      this.#leaderClient = client
    } catch {
      retry()
    }
  }
}

export function postgres(options: PostgresOptions) {
  return new PostgresAdapter(options)
}
