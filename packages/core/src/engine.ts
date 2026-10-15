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
  outbox: ServerMessage[]
  flushing: boolean
  held: { message: ServerMessage; groups: Set<Group> }[]
}

type Update =
  | { type: "data"; version: number; value: unknown }
  | { type: "patch"; from: number; version: number; patch: RowsPatch }
  | { type: "error"; message: string }

type Evaluation =
  | { ok: true; value: unknown; encoded: string; reads: unknown; tags: string[] }
  | { ok: false; error: string; reads: unknown; tags: string[] }

type Work = { batch?: ChangeBatch; force?: boolean }

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
  evaluated: boolean
  running: boolean
  active: boolean
  queued: Work[]
  subscribers: Map<string, { connection: Connection; sub: number }>
}

interface PendingMutation {
  connectionId?: string
  mutationId: string
  at: number
  groups?: Set<Group>
  affected?: Set<Group>
}

const soon: (task: () => void) => void =
  typeof (globalThis as { setImmediate?: unknown }).setImmediate === "function"
    ? (task) => (globalThis as unknown as { setImmediate: (task: () => void) => void }).setImmediate(task)
    : (task) => setTimeout(task, 0)

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
  readonly #pending = new Map<string, PendingMutation>()
  #waveScheduled = false
  #retryDelay = 0
  #effects: Promise<unknown> = Promise.resolve()

  constructor(adapter: Adapter) {
    this.adapter = adapter
    this.ready = adapter.start((batch) => this.#receive(batch))
    setGlobalInvalidate((invalidation) => this.invalidate(invalidation))
  }

  get busy() {
    if (this.#waveScheduled) return true
    for (const group of this.#groups.values()) if (group.running || group.queued.length) return true
    for (const connection of this.#connections.values()) if (connection.outbox.length || connection.held.length) return true
    return false
  }

  async stop() {
    await this.adapter.stop()
    ;(globalThis as GlobalWithEngines).__lynEngines?.delete(this.adapter.id)
  }

  #receive(incoming: ChangeBatch) {
    const batch = incoming.resync ? { ...incoming, tokens: [...this.#pending.keys()] } : incoming
    const queued = new Set<Group>()
    for (const group of this.#groups.values()) {
      if (!group.running && !batch.resync && !this.adapter.affects(group.reads, batch)) continue
      group.queued.push({ batch, force: batch.resync })
      queued.add(group)
    }
    const now = Date.now()
    for (const [token, pending] of this.#pending) if (now - pending.at > 60_000) this.#settle(token, pending)
    for (const token of batch.tokens) {
      const pending = this.#pending.get(token)
      if (!pending || pending.groups) continue
      const connection = pending.connectionId ? this.#connections.get(pending.connectionId) : undefined
      pending.affected = new Set(connection ? [...connection.subs.values()].filter((group) => queued.has(group)) : [])
      pending.groups = new Set(pending.affected)
      if (!pending.groups.size) this.#settle(token, pending)
    }
    this.#runEffects([batch])
    this.#scheduleWave()
  }

  invalidate(invalidation: Invalidation) {
    for (const group of this.#groups.values()) {
      const matches =
        invalidation.kind === "all" ||
        (invalidation.kind === "query" && invalidation.key === group.queryKey) ||
        (invalidation.kind === "tag" && group.tags.includes(invalidation.tag))
      if (matches) group.queued.push({ force: true })
    }
    this.#scheduleWave()
  }

  #scheduleWave(delay = 0) {
    if (this.#waveScheduled) return
    this.#waveScheduled = true
    const start = () => {
      this.#waveScheduled = false
      this.#startWave()
    }
    if (delay) setTimeout(start, delay)
    else soon(start)
  }

  #startWave() {
    const work = new Map<Group, Work[]>()
    for (const group of this.#groups.values()) {
      if (group.running || !group.queued.length) continue
      work.set(group, group.queued.splice(0))
      group.running = true
    }
    if (!work.size) return
    const after = [...new Set([...work.values()].flat().flatMap((item) => (item.batch ? [item.batch] : [])))]
    this.#runWave(work, after)
  }

  async #runWave(work: Map<Group, Work[]>, after: ChangeBatch[]) {
    try {
      await this.adapter.snapshot(after, (read) =>
        Promise.all([...work].map(async ([group, covered]) => this.#finish(group, covered, await this.#evaluate(group, read)))),
      )
      this.#retryDelay = 0
    } catch (error) {
      for (const [group, covered] of work) {
        if (!group.running) continue
        group.running = false
        group.queued.unshift(...covered)
      }
      this.#retryDelay = Math.min(5_000, this.#retryDelay * 2 || 100)
      console.error(`[lyn] re-running queries failed, retrying in ${this.#retryDelay}ms:`, error)
      this.#scheduleWave(this.#retryDelay)
    }
  }

  #finish(group: Group, covered: Work[], evaluation: Evaluation) {
    group.running = false
    if (!group.active) return
    const update = this.#apply(group, evaluation)
    if (update) for (const { connection, sub } of group.subscribers.values()) this.#deliver(connection, { ...update, sub } as ServerMessage, group)
    const rerun = group.queued.filter((item) => item.force || !item.batch || this.adapter.affects(group.reads, item.batch))
    const skipped = group.queued.filter((item) => !rerun.includes(item))
    group.queued = rerun
    for (const item of [...covered, ...skipped]) if (item.batch) this.#satisfied(group, item.batch)
    if (rerun.length) this.#scheduleWave()
  }

  #satisfied(group: Group, batch: ChangeBatch) {
    for (const token of batch.tokens) {
      const pending = this.#pending.get(token)
      if (pending?.groups?.delete(group) && !pending.groups.size) this.#settle(token, pending)
    }
  }

  #settle(token: string, pending: PendingMutation) {
    this.#pending.delete(token)
    const connection = pending.connectionId ? this.#connections.get(pending.connectionId) : undefined
    if (!connection) return
    connection.held.push({ message: { type: "settled", mutations: [pending.mutationId] }, groups: pending.affected ?? new Set() })
    this.#release(connection)
  }

  #blocked(connection: Connection, groups: Set<Group>) {
    for (const pending of this.#pending.values()) {
      if (pending.connectionId !== connection.id || !pending.affected) continue
      for (const group of groups) if (pending.affected.has(group)) return true
    }
    return false
  }

  #deliver(connection: Connection, message: ServerMessage, group: Group) {
    const groups = new Set([group])
    if (this.#blocked(connection, groups)) connection.held.push({ message, groups })
    else this.#enqueue(connection, message)
  }

  #release(connection: Connection) {
    const still: typeof connection.held = []
    for (const item of connection.held) {
      if (this.#blocked(connection, item.groups)) still.push(item)
      else this.#enqueue(connection, item.message)
    }
    connection.held = still
  }

  #enqueue(connection: Connection, message: ServerMessage) {
    connection.outbox.push(message)
    if (connection.flushing) return
    connection.flushing = true
    soon(() => {
      connection.flushing = false
      const messages = connection.outbox.splice(0)
      if (messages.length && this.#connections.get(connection.id) === connection) connection.send(encode({ messages } satisfies ServerFrame))
    })
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
    group.evaluated = true
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
    const connection: Connection = {
      id: crypto.randomUUID(),
      session,
      sessionKey: sessionKey(session),
      send,
      subs: new Map(),
      outbox: [],
      flushing: false,
      held: [],
    }
    this.#connections.set(connection.id, connection)
    return connection
  }

  async disconnect(connectionId: string) {
    const connection = this.#connections.get(connectionId)
    if (!connection) return
    for (const sub of [...connection.subs.keys()]) this.#detach(connection, sub)
    this.#connections.delete(connectionId)
  }

  #detach(connection: Connection, sub: number) {
    const group = connection.subs.get(sub)
    if (!group) return
    connection.subs.delete(sub)
    group.subscribers.delete(`${connection.id}:${sub}`)
    if ([...group.subscribers.values()].some((subscriber) => subscriber.connection === connection)) return
    for (const [token, pending] of this.#pending)
      if (pending.connectionId === connection.id && pending.groups?.delete(group) && !pending.groups.size) this.#settle(token, pending)
    if (group.subscribers.size) return
    group.active = false
    this.#groups.delete(group.key)
  }

  async subscribe(request: SubscribeRequest, session: Session | null) {
    await this.ready
    const connection = this.#connections.get(request.clientId)
    if (!connection) throw new Error("lyn: unknown client")
    if (connection.sessionKey !== sessionKey(session)) throw new Error("lyn: session changed; reconnect the event stream")
    for (const sub of request.remove) this.#detach(connection, sub)
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
          evaluated: false,
          running: false,
          active: true,
          queued: [{ force: true }],
          subscribers: new Map(),
        }
        this.#groups.set(key, group)
      }
      group.subscribers.set(`${connection.id}:${sub}`, { connection, sub })
      connection.subs.set(sub, group)
      if (group.evaluated)
        this.#deliver(
          connection,
          group.error
            ? { type: "error", sub, message: group.error }
            : { type: "data", sub, version: group.version, value: group.value },
          group,
        )
    }
    this.#scheduleWave()
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
          this.#pending.set(writeToken, { connectionId: request.clientId, mutationId: request.mutationId, at: Date.now() })
          flushInvalidations()
        },
      )
      flushInvalidations()
      return { result: result.value, settled: result.token === undefined }
    } catch (error) {
      if (token !== undefined) this.#pending.delete(token)
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
