import type { Adapter, ChangeBatch, Reader } from "./adapter.ts"
import {
  createInvalidate,
  LynError,
  publicMessage,
  setGlobalInvalidate,
  validate,
  type EffectDefinition,
  type Invalidation,
  type MutationCtx,
  type Session,
} from "./index.ts"
import { registry, type Definition } from "./registry.ts"
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
} from "./wire.ts"

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

type Evaluation =
  | { ok: true; value: unknown; encoded: string; reads: unknown; tags: string[] }
  | { ok: false; error: string; reads: unknown; tags: string[] }

interface Group {
  key: string
  queryKey: string
  session: Session | null
  name: string
  args: unknown
  reads: unknown
  tags: string[]
  value: unknown
  encoded?: string
  version: number
  error?: string
  subscribers: Map<string, { connection: Connection; sub: number }>
}

const sessionKey = (session: Session | null) => (session ? stableStringify(session) : "anonymous")

async function resolveShallow(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return value
  const entries = await Promise.all(Object.entries(value).map(async ([key, inner]) => [key, await inner] as const))
  return Object.fromEntries(entries)
}

type GlobalWithEngines = typeof globalThis & { __lynEngines?: Map<string, Engine> }

export class Engine {
  static for(adapter: Adapter): Engine {
    const engines = ((globalThis as GlobalWithEngines).__lynEngines ??= new Map())
    let engine = engines.get(adapter.id)
    if (!engine) {
      engine = new Engine(adapter)
      engines.set(adapter.id, engine)
    }
    return engine
  }

  static all(): Engine[] {
    return [...((globalThis as GlobalWithEngines).__lynEngines?.values() ?? [])]
  }

  readonly adapter: Adapter
  readonly ready: Promise<void>
  readonly #groups = new Map<string, Group>()
  readonly #connections = new Map<string, Connection>()
  readonly #pendingMutations = new Map<string, { connectionId?: string; mutationId: string; at: number }>()
  #batches: ChangeBatch[] = []
  #invalidations: Invalidation[] = []
  #queue: Promise<unknown> = Promise.resolve()
  #flushScheduled = false
  #retryDelay = 0
  #effects: Promise<unknown> = Promise.resolve()

  constructor(adapter: Adapter) {
    this.adapter = adapter
    this.ready = adapter.start((batch) => {
      this.#batches.push(batch)
      this.#scheduleFlush()
    })
    setGlobalInvalidate((invalidation) => this.invalidate(invalidation))
  }

  async stop() {
    await this.adapter.stop()
    ;(globalThis as GlobalWithEngines).__lynEngines?.delete(this.adapter.id)
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
    const startedAt = Date.now()
    const batches = this.#batches.splice(0)
    const invalidations = this.#invalidations.splice(0)
    if (!batches.length && !invalidations.length) return

    const affected = [...this.#groups.values()].filter((group) => this.#isAffected(group, batches, invalidations))
    const evaluations = new Map<Group, Evaluation>()
    try {
      if (affected.length)
        await this.adapter.snapshot(batches, async (read) => {
          for (const group of affected) evaluations.set(group, await this.#evaluate(group, read))
        })
    } catch (error) {
      this.#batches.unshift(...batches)
      this.#invalidations.unshift(...invalidations)
      this.#retryDelay = Math.min(5_000, this.#retryDelay * 2 || 100)
      console.error(`[lyn] flush failed, retrying in ${this.#retryDelay}ms:`, error)
      setTimeout(() => this.#scheduleFlush(), this.#retryDelay)
      return
    }
    this.#retryDelay = 0

    const outbox = new Map<Connection, ServerMessage[]>()
    const post = (connection: Connection, message: ServerMessage) => {
      const messages = outbox.get(connection) ?? []
      messages.push(message)
      outbox.set(connection, messages)
    }
    for (const [group, evaluation] of evaluations) {
      const update = this.#apply(group, evaluation)
      if (!update) continue
      for (const { connection, sub } of group.subscribers.values()) post(connection, { ...update, sub } as ServerMessage)
    }

    const resync = batches.some((batch) => batch.resync)
    const tokens = new Set(batches.flatMap((batch) => batch.tokens))
    const settled = new Map<Connection, string[]>()
    for (const [token, pending] of this.#pendingMutations) {
      const done = tokens.has(token) || (resync && pending.at <= startedAt)
      const expired = startedAt - pending.at > 60_000
      if (!done && !expired) continue
      this.#pendingMutations.delete(token)
      const connection = pending.connectionId ? this.#connections.get(pending.connectionId) : undefined
      if (done && connection) settled.set(connection, [...(settled.get(connection) ?? []), pending.mutationId])
    }
    for (const [connection, mutations] of settled) post(connection, { type: "settled", mutations })

    const position = batches.at(-1)?.position
    for (const [connection, messages] of outbox) connection.send(encode({ lsn: position, messages } satisfies ServerFrame))

    this.#runEffects(batches)
  }

  #isAffected(group: Group, batches: ChangeBatch[], invalidations: Invalidation[]) {
    for (const invalidation of invalidations) {
      if (invalidation.kind === "all") return true
      if (invalidation.kind === "query" && invalidation.key === group.queryKey) return true
      if (invalidation.kind === "tag" && group.tags.includes(invalidation.tag)) return true
    }
    return batches.some((batch) => this.adapter.affects(group.reads, batch))
  }

  #definition(name: string, kind: Definition["kind"]) {
    const definition = registry.get(name)
    if (!definition || definition.kind !== kind) throw new LynError(`lyn: unknown ${kind} "${name}"`)
    return definition
  }

  async #execute(name: string, args: unknown, session: Session | null, read: Reader, tags: string[] = []) {
    const definition = this.#definition(name, "query")
    const validArgs = await validate(definition.args as any, args)
    return read({ session }, async () =>
      resolveShallow(await definition.handler({ session, depends: (tag: string) => tags.push(tag) }, validArgs)),
    )
  }

  async #evaluate(group: Group, read: Reader): Promise<Evaluation> {
    const tags: string[] = []
    try {
      const result = await this.#execute(group.name, group.args, group.session, read, tags)
      if (!result.ok) return { ok: false, error: publicMessage(result.error), reads: undefined, tags }
      return { ok: true, value: result.value, encoded: encode(result.value), reads: result.reads, tags }
    } catch (error) {
      return { ok: false, error: publicMessage(error), reads: undefined, tags }
    }
  }

  #apply(group: Group, evaluation: Evaluation): Update | null {
    group.reads = evaluation.reads
    group.tags = evaluation.tags
    if (!evaluation.ok) {
      if (group.error === evaluation.error) return null
      group.error = evaluation.error
      return { type: "error", message: evaluation.error }
    }
    if (evaluation.encoded === group.encoded && !group.error) return null
    const patch = group.encoded === undefined || group.error ? null : diffRows(group.value, evaluation.value)
    const from = group.version
    group.value = evaluation.value
    group.encoded = evaluation.encoded
    group.version++
    group.error = undefined
    return patch
      ? { type: "patch", from, version: group.version, patch }
      : { type: "data", version: group.version, value: evaluation.value }
  }

  async runQuery(name: string, args: unknown, session: Session | null) {
    const result = await this.adapter.snapshot([], (read) => this.#execute(name, args, session, read))
    if (!result.ok) throw result.error
    return result.value
  }

  connect(send: (frame: string) => void, session: Session | null): Connection {
    const connection: Connection = { id: crypto.randomUUID(), session, sessionKey: sessionKey(session), send, subs: new Map() }
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
      const created: Group[] = []
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
            reads: undefined,
            tags: [],
            value: undefined,
            version: 0,
            subscribers: new Map(),
          }
          this.#groups.set(key, group)
          created.push(group)
        }
        group.subscribers.set(`${connection.id}:${sub}`, { connection, sub })
        connection.subs.set(sub, group)
      }
      try {
        if (created.length)
          await this.adapter.snapshot([], async (read) => {
            for (const group of created) this.#apply(group, await this.#evaluate(group, read))
          })
      } catch (error) {
        for (const { sub } of request.add) this.#detach(connection, sub)
        throw error
      }
      for (const [sub, group] of connection.subs) {
        if (!request.add.some((add) => add.sub === sub)) continue
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
    const invalidations: Invalidation[] = []
    const ctx: MutationCtx = { session, invalidate: createInvalidate((invalidation) => invalidations.push(invalidation)) }
    const flushInvalidations = () => invalidations.splice(0).forEach((invalidation) => this.invalidate(invalidation))
    let token: string | undefined
    try {
      const result = await this.adapter.write(
        { session },
        async () => definition.handler(ctx, args),
        (writeToken) => {
          token = writeToken
          this.#pendingMutations.set(writeToken, { connectionId: request.clientId, mutationId: request.mutationId, at: Date.now() })
          flushInvalidations()
        },
      )
      flushInvalidations()
      return { result: result.value, settled: result.token === undefined }
    } catch (error) {
      if (token !== undefined) this.#pendingMutations.delete(token)
      throw error
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
          (await this.mutate({ name: mutation.name, args: mutationArgs, mutationId: crypto.randomUUID() }, session)).result,
        invalidate: createInvalidate((invalidation) => this.invalidate(invalidation)),
      },
      args,
    )
  }

  #runEffects(batches: ChangeBatch[]) {
    if (!this.adapter.isLeader()) return
    const effects = [...registry.values()].filter((definition) => definition.kind === "effect") as unknown as EffectDefinition[]
    if (!effects.length) return
    for (const change of batches.flatMap((batch) => batch.changes)) {
      if (change.kind === "truncate") continue
      for (const effect of effects) {
        if (effect.table !== change.source || !effect.on.includes(change.kind)) continue
        const invalidations: Invalidation[] = []
        const ctx: MutationCtx = { session: null, invalidate: createInvalidate((invalidation) => invalidations.push(invalidation)) }
        this.#effects = this.#effects
          .then(() => this.adapter.write({ session: null, system: true }, async () => effect.handler(ctx, change)))
          .then(() => invalidations.forEach((invalidation) => this.invalidate(invalidation)))
          .catch((error) => console.error(`[lyn] effect ${effect.name} failed:`, error))
      }
    }
  }
}
