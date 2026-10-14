import { randomUUID } from "node:crypto"
import pg from "pg"
import { LogicalReplicationService, PgoutputPlugin } from "pg-logical-replication"
import { registry, type Definition } from "../shared/registry.ts"
import {
  diffRows,
  encode,
  queryKey,
  stableStringify,
  type MutationRequest,
  type RowsPatch,
  type ServerFrame,
  type ServerMessage,
  type SubscribeRequest,
} from "../shared/wire.ts"
import { createDb, rowToCamel, toSnake, type Dep, type Executor } from "./db.ts"
import {
  createInvalidate,
  definitionsOfKind,
  setGlobalInvalidate,
  validate,
  type EffectDefinition,
  type Invalidation,
  type MutationCtx,
  type Session,
} from "./index.ts"

type Row = Record<string, unknown>

interface Change {
  table: string
  kind: "insert" | "update" | "delete" | "truncate"
  new?: Row
  old?: Row
}

interface Commit {
  xid: number
  lsn: string
  changes: Change[]
}

interface Connection {
  id: string
  session: Session | null
  sessionKey: string
  send: (frame: string) => void
  subs: Map<number, Group>
}

type Update =
  | { type: "data"; version: number; value: unknown }
  | { type: "patch"; from: number; version: number; patch: RowsPatch }
  | { type: "error"; message: string }

interface Group {
  key: string
  queryKey: string
  session: Session | null
  name: string
  args: unknown
  deps: Dep[]
  value: unknown
  encoded?: string
  version: number
  error?: string
  subscribers: Map<string, { connection: Connection; sub: number }>
}

export const sessionKey = (session: Session | null) => (session ? stableStringify(session) : "anonymous")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

function sameValue(a: unknown, b: unknown) {
  if (a === b) return true
  if (a instanceof Date || b instanceof Date) return new Date(a as any).getTime() === new Date(b as any).getTime()
  return a != null && b != null && String(a) === String(b)
}

function rowMatches(eq: Record<string, unknown>, row: Row | undefined) {
  if (!row) return false
  return Object.entries(eq).every(([column, value]) => !(column in row) || sameValue(row[column], value))
}

function depMatchesChange(dep: Dep, change: Change) {
  if (!("table" in dep) || dep.table !== change.table) return false
  if (change.kind === "truncate" || !dep.eq) return true
  return rowMatches(dep.eq, change.new) || rowMatches(dep.eq, change.old)
}

function depMatchesInvalidation(dep: Dep, invalidation: Invalidation) {
  if (invalidation.kind === "tag") return "tag" in dep && dep.tag === invalidation.tag
  if (invalidation.kind === "table") return "table" in dep && dep.table === toSnake(invalidation.table)
  return false
}

function snapshotIncludes(xid32: number, snapshot: string) {
  const [xminText, xmaxText, xipText] = snapshot.split(":")
  const xmin = BigInt(xminText!)
  const xmax = BigInt(xmaxText!)
  const inProgress = new Set((xipText ?? "").split(",").filter(Boolean).map(BigInt))
  const epoch = xmax >> 32n
  const low = xmax & 0xffffffffn
  let xid = (epoch << 32n) | BigInt(xid32)
  if (BigInt(xid32) > low) xid -= 1n << 32n
  return xid < xmin || (xid < xmax && !inProgress.has(xid))
}

async function resolveShallow(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return value
  const entries = await Promise.all(Object.entries(value).map(async ([key, inner]) => [key, await inner] as const))
  return Object.fromEntries(entries)
}

function serialized(client: pg.PoolClient): Executor {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    query(text, params) {
      const result = tail.then(() => client.query(text, params))
      tail = result.catch(() => {})
      return result
    },
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

export class Engine {
  readonly pool: pg.Pool
  readonly #databaseUrl: string
  readonly #role?: string
  readonly #groups = new Map<string, Group>()
  readonly #connections = new Map<string, Connection>()
  readonly #pendingMutations = new Map<number, { connectionId?: string; mutationId: string; at: number }>()
  readonly #warnedTables = new Set<string>()
  #commits: Commit[] = []
  #invalidations: Invalidation[] = []
  #openCommit?: Commit
  #queue: Promise<unknown> = Promise.resolve()
  #flushScheduled = false
  #replication?: LogicalReplicationService
  #closed = false

  constructor(databaseUrl: string, options: { role?: string } = {}) {
    this.#databaseUrl = databaseUrl
    this.#role = options.role
    this.pool = new pg.Pool({ connectionString: databaseUrl, max: 20 })
  }

  async start() {
    await this.pool.query(
      `do $$ begin
         if not exists (select 1 from pg_publication where pubname = 'lyn') then
           create publication lyn for all tables;
         end if;
       end $$`,
    )
    await this.#startReplication()
    setGlobalInvalidate((invalidation) => this.invalidate(invalidation))
  }

  async close() {
    this.#closed = true
    await this.#replication?.destroy()
    await this.pool.end()
  }

  async #startReplication() {
    const plugin = new TempSlotPgoutput({ protoVersion: 1, publicationNames: ["lyn"] })
    const slotCreated = new Promise<void>((resolve) => (plugin.onSlotCreated = resolve))
    const replication = new LogicalReplicationService(
      { connectionString: this.#databaseUrl },
      { acknowledge: { auto: true, timeoutSeconds: 10 } },
    )
    this.#replication = replication
    replication.on("data", (_lsn, message) => this.#onWal(message))
    let restarting = false
    const restart = (error: unknown) => {
      if (this.#closed || restarting) return
      restarting = true
      console.error("[lyn] replication stream lost, restarting:", errorMessage(error))
      replication.destroy().finally(async () => {
        await sleep(1000)
        await this.#startReplication().catch((e) => console.error("[lyn] replication restart failed:", errorMessage(e)))
        this.invalidate({ kind: "all" })
      })
    }
    replication.on("error", restart)
    const slotName = `lyn_${process.pid}_${Date.now().toString(36)}`
    replication.subscribe(plugin, slotName).then(() => restart(new Error("stream ended")), restart)
    await slotCreated
  }

  #onWal(message: any) {
    switch (message.tag) {
      case "begin":
        this.#openCommit = { xid: message.xid, lsn: message.commitLsn, changes: [] }
        return
      case "relation":
        if (message.replicaIdentity !== "full" && !this.#warnedTables.has(message.name)) {
          this.#warnedTables.add(message.name)
          console.warn(
            `[lyn] table "${message.name}" has REPLICA IDENTITY ${message.replicaIdentity.toUpperCase()}; ` +
              `updates and deletes match subscriptions conservatively. Use REPLICA IDENTITY FULL for precise invalidation.`,
          )
        }
        return
      case "insert":
        this.#openCommit?.changes.push({ table: message.relation.name, kind: "insert", new: message.new })
        return
      case "update": {
        const keyColumns: string[] = message.relation.keyColumns ?? []
        const old = message.old ?? message.key ?? Object.fromEntries(keyColumns.map((column) => [column, message.new[column]]))
        this.#openCommit?.changes.push({ table: message.relation.name, kind: "update", new: message.new, old })
        return
      }
      case "delete":
        this.#openCommit?.changes.push({ table: message.relation.name, kind: "delete", old: message.old ?? message.key })
        return
      case "truncate":
        for (const relation of message.relations) this.#openCommit?.changes.push({ table: relation.name, kind: "truncate" })
        return
      case "commit":
        if (this.#openCommit) this.#commits.push(this.#openCommit)
        this.#openCommit = undefined
        this.#scheduleFlush()
        return
    }
  }

  invalidate(invalidation: Invalidation) {
    this.#invalidations.push(invalidation)
    this.#scheduleFlush()
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(task)
    this.#queue = next.catch(() => {})
    return next
  }

  #scheduleFlush() {
    if (this.#flushScheduled) return
    this.#flushScheduled = true
    this.#serial(async () => {
      this.#flushScheduled = false
      await this.#flush()
    }).catch((error) => console.error("[lyn] flush failed:", error))
  }

  async #flush() {
    const commits = this.#commits.splice(0)
    const invalidations = this.#invalidations.splice(0)
    if (!commits.length && !invalidations.length) return

    const affected = [...this.#groups.values()].filter((group) => this.#isAffected(group, commits, invalidations))
    const outbox = new Map<Connection, ServerMessage[]>()
    const post = (connection: Connection, message: ServerMessage) => {
      const messages = outbox.get(connection) ?? []
      messages.push(message)
      outbox.set(connection, messages)
    }

    if (affected.length) {
      await this.#withSnapshot(
        commits.map((commit) => commit.xid),
        async (exec) => {
          for (const group of affected) {
            const update = await this.#run(group, exec)
            if (!update) continue
            for (const { connection, sub } of group.subscribers.values()) post(connection, { ...update, sub } as ServerMessage)
          }
        },
      )
    }

    const now = Date.now()
    const settledByConnection = new Map<Connection, string[]>()
    for (const commit of commits) {
      const pending = this.#pendingMutations.get(commit.xid)
      if (!pending) continue
      this.#pendingMutations.delete(commit.xid)
      const connection = pending.connectionId ? this.#connections.get(pending.connectionId) : undefined
      if (connection) settledByConnection.set(connection, [...(settledByConnection.get(connection) ?? []), pending.mutationId])
    }
    for (const [xid, pending] of this.#pendingMutations) if (now - pending.at > 60_000) this.#pendingMutations.delete(xid)
    for (const [connection, mutations] of settledByConnection) post(connection, { type: "settled", mutations })

    const lsn = commits.at(-1)?.lsn
    for (const [connection, messages] of outbox) connection.send(encode({ lsn, messages } satisfies ServerFrame))

    this.#runEffects(commits)
  }

  #isAffected(group: Group, commits: Commit[], invalidations: Invalidation[]) {
    for (const invalidation of invalidations) {
      if (invalidation.kind === "all") return true
      if (invalidation.kind === "query" && invalidation.key === group.queryKey) return true
      if (group.deps.some((dep) => depMatchesInvalidation(dep, invalidation))) return true
    }
    for (const commit of commits)
      for (const change of commit.changes) if (group.deps.some((dep) => depMatchesChange(dep, change))) return true
    return false
  }

  async #withSnapshot<T>(xids: number[], task: (exec: Executor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      for (let attempt = 0; ; attempt++) {
        await client.query("begin isolation level repeatable read read only")
        const { rows } = await client.query("select pg_current_snapshot()::text as snapshot")
        if (attempt >= 200 || xids.every((xid) => snapshotIncludes(xid, rows[0].snapshot))) {
          try {
            return await task(serialized(client))
          } finally {
            await client.query("commit")
          }
        }
        await client.query("rollback")
        await sleep(1)
      }
    } finally {
      client.release()
    }
  }

  #definition(name: string, kind: Definition["kind"]) {
    const definition = registry.get(name)
    if (!definition || definition.kind !== kind) throw new Error(`lyn: unknown ${kind} "${name}"`)
    return definition
  }

  async #actAs(exec: Executor, session: Session | null) {
    await exec.query("select set_config('lyn.session', $1, true), set_config('role', $2, true)", [
      session ? JSON.stringify(session) : "",
      this.#role ?? "none",
    ])
  }

  async #execute(name: string, args: unknown, exec: Executor, session: Session | null, deps: Dep[] = []) {
    const definition = this.#definition(name, "query")
    const validArgs = await validate(definition.args as any, args)
    await this.#actAs(exec, session)
    const value = await resolveShallow(
      await definition.handler(
        {
          db: createDb({ exec, deps, readOnly: true }),
          depends: (tag: string) => deps.push({ tag }),
          session,
        },
        validArgs,
      ),
    )
    return value
  }

  async #run(group: Group, exec: Executor): Promise<Update | null> {
    const deps: Dep[] = []
    try {
      const value = await this.#execute(group.name, group.args, exec, group.session, deps)
      group.deps = deps
      const encoded = encode(value)
      if (encoded === group.encoded && !group.error) return null
      const patch = group.encoded === undefined || group.error ? null : diffRows(group.value, value)
      const from = group.version
      group.value = value
      group.encoded = encoded
      group.version++
      group.error = undefined
      return patch ? { type: "patch", from, version: group.version, patch } : { type: "data", version: group.version, value }
    } catch (error) {
      if (deps.length) group.deps = deps
      group.error = errorMessage(error)
      return { type: "error", message: group.error }
    }
  }

  runQuery(name: string, args: unknown, session: Session | null) {
    return this.#withSnapshot([], (exec) => this.#execute(name, args, exec, session))
  }

  connect(send: (frame: string) => void, session: Session | null): Connection {
    const connection: Connection = { id: randomUUID(), session, sessionKey: sessionKey(session), send, subs: new Map() }
    this.#connections.set(connection.id, connection)
    return connection
  }

  disconnect(connectionId: string) {
    return this.#serial(async () => {
      const connection = this.#connections.get(connectionId)
      if (!connection) return
      for (const sub of connection.subs.keys()) this.#detach(connection, sub)
      this.#connections.delete(connectionId)
    })
  }

  #detach(connection: Connection, sub: number) {
    const group = connection.subs.get(sub)
    if (!group) return
    connection.subs.delete(sub)
    group.subscribers.delete(`${connection.id}:${sub}`)
    if (!group.subscribers.size) this.#groups.delete(group.key)
  }

  subscribe(request: SubscribeRequest, session: Session | null) {
    return this.#serial(async () => {
      const connection = this.#connections.get(request.clientId)
      if (!connection) throw new Error("lyn: unknown client")
      if (connection.sessionKey !== sessionKey(session)) throw new Error("lyn: session changed; reconnect the event stream")
      for (const sub of request.remove) this.#detach(connection, sub)
      const messages: ServerMessage[] = []
      for (const { sub, name, args } of request.add) {
        this.#detach(connection, sub)
        const key = `${queryKey(name, args)}@${connection.sessionKey}`
        let group = this.#groups.get(key)
        if (!group) {
          group = {
            key,
            queryKey: queryKey(name, args),
            session: connection.session,
            name,
            args,
            deps: [],
            value: undefined,
            version: 0,
            subscribers: new Map(),
          }
          await this.#withSnapshot([], (exec) => this.#run(group!, exec))
          this.#groups.set(key, group)
        }
        group.subscribers.set(`${connection.id}:${sub}`, { connection, sub })
        connection.subs.set(sub, group)
        messages.push(
          group.error
            ? { type: "error", sub, message: group.error }
            : { type: "data", sub, version: group.version, value: group.value },
        )
      }
      if (messages.length) connection.send(encode({ messages } satisfies ServerFrame))
    })
  }

  async mutate(request: MutationRequest, session: Session | null) {
    const definition = this.#definition(request.name, "mutation")
    const args = await validate(definition.args as any, request.args)
    let xid: number | undefined
    const { result, invalidations } = await this.#inTransaction(session, async (ctx, client) => {
      const result = await definition.handler(ctx, args)
      const { rows } = await client.query("select pg_current_xact_id_if_assigned()::text as xid")
      if (rows[0].xid) {
        xid = Number(BigInt(rows[0].xid) & 0xffffffffn)
        this.#pendingMutations.set(xid, { connectionId: request.clientId, mutationId: request.mutationId, at: Date.now() })
      }
      return result
    }).catch((error) => {
      if (xid !== undefined) this.#pendingMutations.delete(xid)
      throw error
    })
    for (const invalidation of invalidations) this.invalidate(invalidation)
    return { result, settled: xid === undefined }
  }

  async #inTransaction<T>(session: Session | null | "system", task: (ctx: MutationCtx, exec: Executor) => Promise<T>) {
    const client = await this.pool.connect()
    const exec = serialized(client)
    const invalidations: Invalidation[] = []
    try {
      await client.query("begin")
      if (session !== "system") await this.#actAs(exec, session)
      const ctx: MutationCtx = {
        db: createDb({ exec, deps: [], readOnly: false }),
        session: session === "system" ? null : session,
        invalidate: createInvalidate((invalidation) => invalidations.push(invalidation)),
      }
      const result = await task(ctx, exec)
      await client.query("commit")
      return { result, invalidations }
    } catch (error) {
      await client.query("rollback").catch(() => {})
      throw error
    } finally {
      client.release()
    }
  }

  async act(name: string, rawArgs: unknown, session: Session | null) {
    const definition = this.#definition(name, "action")
    const args = await validate(definition.args as any, rawArgs)
    return definition.handler(
      {
        session,
        runQuery: (query: { name: string }, queryArgs: unknown) => this.runQuery(query.name, queryArgs, session),
        runMutation: async (mutation: { name: string }, mutationArgs: unknown) =>
          (await this.mutate({ name: mutation.name, args: mutationArgs, mutationId: randomUUID() }, session)).result,
        invalidate: createInvalidate((invalidation) => this.invalidate(invalidation)),
      },
      args,
    )
  }

  #runEffects(commits: Commit[]) {
    const effects = definitionsOfKind("effect") as unknown as EffectDefinition[]
    if (!effects.length) return
    for (const commit of commits)
      for (const change of commit.changes) {
        if (change.kind === "truncate") continue
        for (const effect of effects) {
          if (toSnake(effect.table) !== change.table || !effect.on.includes(change.kind)) continue
          const event = {
            kind: change.kind,
            new: change.new && rowToCamel(change.new),
            old: change.old && rowToCamel(change.old),
          } as any
          this.#inTransaction("system", async (ctx) => effect.handler(ctx, event))
            .then(({ invalidations }) => invalidations.forEach((invalidation) => this.invalidate(invalidation)))
            .catch((error) => console.error(`[lyn] effect ${effect.name} failed:`, error))
        }
      }
  }
}
