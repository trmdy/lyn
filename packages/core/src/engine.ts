import type { Adapter, ChangeBatch, Reader, ReadIndex } from "./adapter.ts"
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
  fingerprint,
  encode,
  frameOf,
  queryKey,
  stableStringify,
  type MutationRequest,
  type RowsPatch,
  type ServerMessage,
  type SubscribeRequest,
} from "./wire.ts"

interface Outgoing {
  text: string
  frame?: string
}

interface Connection {
  id: string
  session: Session | null
  sessionKey: string
  send: (frame: string, shared: boolean) => void
  subs: Map<number, Group>
  outbox: Outgoing[]
  flushing: boolean
  held: { message: Outgoing; group?: Group; settles?: PendingMutation }[]
  pending: Set<PendingMutation>
}

interface Subscriber {
  connection: Connection
  sub: number
  fingerprint?: string
  bound: boolean
}

type Update =
  | { type: "data"; version: number; value: unknown }
  | { type: "patch"; from: number; version: number; patch: RowsPatch }
  | { type: "error"; message: string }

type Evaluation =
  | { ok: true; value: unknown; encoded: string; fingerprint?: string; reads: unknown; tags: string[] }
  | { ok: false; error: string; reads: unknown; tags: string[] }

type Work = { batch?: ChangeBatch; force?: boolean }

interface Group {
  id: number
  key: string
  queryKey: string
  session: Session | null
  name: string
  args: unknown
  reads: unknown
  readsKey?: string
  startedAt: number
  tags: string[]
  value: unknown
  encoded?: string
  fingerprint?: { encoded: string; value: string }
  version: number
  error?: string
  evaluated: boolean
  running: boolean
  active: boolean
  queued: Work[]
  awaitingFingerprint: number
  subscribers: Map<string, Subscriber>
}

interface PendingMutation {
  token: string
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

const MAX_QUEUED = 64

const outgoing = (message: ServerMessage): Outgoing => ({ text: encode(message) })

class LinearIndex<K> implements ReadIndex<K> {
  readonly #adapter: Adapter
  readonly #reads = new Map<K, unknown>()

  constructor(adapter: Adapter) {
    this.#adapter = adapter
  }

  set(key: K, reads: unknown) {
    this.#reads.set(key, reads)
  }

  delete(key: K) {
    this.#reads.delete(key)
  }

  match(batch: ChangeBatch, visit: (key: K) => void) {
    for (const [key, reads] of this.#reads) if (this.#adapter.affects(reads, batch)) visit(key)
  }
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
  readonly #pending = new Map<string, PendingMutation>()
  readonly #index: ReadIndex<Group>
  readonly #waiting = new Set<Group>()
  readonly #running = new Set<Group>()
  readonly #log: ChangeBatch[] = []
  #logStart = 0
  #nextSeq = 0
  readonly #runningSince = new Map<number, number>()
  #nextGroupId = 1
  #lastExpiry = 0
  readonly #flushQueue = new Set<Connection>()
  #flushScheduled = false
  #waveScheduled = false
  #retryDelay = 0
  #effects: Promise<unknown> = Promise.resolve()

  constructor(adapter: Adapter) {
    this.adapter = adapter
    this.#index = adapter.createIndex?.<Group>() ?? new LinearIndex<Group>(adapter)
    this.ready = adapter.start((batch) => this.#receive(batch))
    setGlobalInvalidate((invalidation) => this.invalidate(invalidation))
  }

  get busy() {
    if (this.#waveScheduled || this.#running.size || this.#waiting.size) return true
    for (const connection of this.#connections.values()) if (connection.outbox.length || connection.held.length) return true
    return false
  }

  async stop() {
    await this.adapter.stop()
    ;(globalThis as GlobalWithEngines).__lynEngines?.delete(this.adapter.id)
  }

  #queue(group: Group, work: Work) {
    if (group.queued.length >= MAX_QUEUED) {
      const tokens = new Set(group.queued.flatMap((item) => item.batch?.tokens ?? []))
      for (const token of work.batch?.tokens ?? []) tokens.add(token)
      group.queued = [{ force: true, batch: { tokens: [...tokens], changes: [] } }]
    } else group.queued.push(work)
    if (!group.running) this.#waiting.add(group)
  }

  #receive(incoming: ChangeBatch) {
    const batch = incoming.resync ? { ...incoming, tokens: [...this.#pending.keys()] } : incoming
    const work: Work = { batch, force: batch.resync }
    const queued = new Set<Group>()
    const add = (group: Group) => {
      if (queued.has(group)) return
      queued.add(group)
      this.#queue(group, work)
    }
    if (this.#running.size) this.#log.push(batch)
    else this.#logStart++
    this.#nextSeq++
    if (batch.resync) for (const group of this.#groups.values()) add(group)
    else this.#index.match(batch, add)
    const now = Date.now()
    if (now - this.#lastExpiry > 1_000) {
      this.#lastExpiry = now
      for (const [token, pending] of this.#pending) if (now - pending.at > 60_000) this.#settle(token, pending)
    }
    for (const token of batch.tokens) {
      const pending = this.#pending.get(token)
      if (!pending || pending.groups) continue
      const connection = pending.connectionId ? this.#connections.get(pending.connectionId) : undefined
      pending.affected = new Set(connection ? [...connection.subs.values()].filter((group) => queued.has(group)) : [])
      pending.groups = new Set(pending.affected)
      if (!pending.groups.size) this.#settle(token, pending)
      else connection?.pending.add(pending)
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
      if (matches) this.#queue(group, { force: true })
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
    for (const group of this.#waiting) {
      this.#waiting.delete(group)
      if (group.running || !group.queued.length || !group.active) continue
      work.set(group, group.queued.splice(0))
      group.running = true
      group.startedAt = this.#nextSeq
      this.#running.add(group)
    }
    if (!work.size) return
    this.#runningSince.set(this.#nextSeq, (this.#runningSince.get(this.#nextSeq) ?? 0) + work.size)
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
        this.#stopRunning(group)
        group.queued.unshift(...covered)
        if (group.active) this.#waiting.add(group)
      }
      this.#retryDelay = Math.min(5_000, this.#retryDelay * 2 || 100)
      console.error(`[lyn] re-running queries failed, retrying in ${this.#retryDelay}ms:`, error)
      this.#scheduleWave(this.#retryDelay)
    }
  }

  #stopRunning(group: Group) {
    group.running = false
    this.#running.delete(group)
    const remaining = (this.#runningSince.get(group.startedAt) ?? 1) - 1
    if (remaining > 0) this.#runningSince.set(group.startedAt, remaining)
    else this.#runningSince.delete(group.startedAt)
    const oldest = this.#runningSince.keys().next()
    const keepFrom = oldest.done ? this.#nextSeq : oldest.value
    if (keepFrom > this.#logStart) {
      this.#log.splice(0, keepFrom - this.#logStart)
      this.#logStart = keepFrom
    }
  }

  #recheckSinceStart(group: Group) {
    const queued = new Set(group.queued.map((item) => item.batch))
    for (let index = Math.max(0, group.startedAt - this.#logStart); index < this.#log.length; index++) {
      const batch = this.#log[index]!
      if (queued.has(batch) || !this.adapter.affects(group.reads, batch)) continue
      group.queued.push({ batch })
      for (const token of batch.tokens) {
        const pending = this.#pending.get(token)
        const connection = pending?.connectionId ? this.#connections.get(pending.connectionId) : undefined
        if (!pending?.groups || !connection || ![...connection.subs.values()].includes(group)) continue
        pending.groups.add(group)
        pending.affected?.add(group)
        connection.pending.add(pending)
      }
    }
  }

  #finish(group: Group, covered: Work[], evaluation: Evaluation) {
    const readsBefore = group.readsKey
    if (!group.active) return this.#stopRunning(group)
    const update = this.#apply(group, evaluation)
    if (group.readsKey !== readsBefore) this.#recheckSinceStart(group)
    this.#stopRunning(group)
    if (update) {
      const shared = outgoing({ ...update, group: group.id } as ServerMessage)
      const sharedSent = new Set<Connection>()
      for (const subscriber of group.subscribers.values()) {
        const { connection, sub } = subscriber
        let message = shared
        if (update.type !== "error" && subscriber.fingerprint !== undefined && subscriber.fingerprint === group.fingerprint?.value)
          message = outgoing({ type: "unchanged", group: group.id, sub, version: group.version })
        else if (!subscriber.bound)
          message = outgoing(
            update.type === "error"
              ? { type: "error", group: group.id, sub, message: update.message }
              : { type: "data", group: group.id, sub, version: group.version, value: group.value },
          )
        if (subscriber.fingerprint !== undefined) group.awaitingFingerprint--
        subscriber.fingerprint = undefined
        subscriber.bound = true
        if (message === shared) {
          if (sharedSent.has(connection)) continue
          sharedSent.add(connection)
        }
        this.#deliver(connection, message, group)
      }
    }
    const rerun = group.queued.filter((item) => item.force || !item.batch || this.adapter.affects(group.reads, item.batch))
    const skipped = group.queued.filter((item) => !rerun.includes(item))
    group.queued = rerun
    for (const item of [...covered, ...skipped]) if (item.batch) this.#satisfied(group, item.batch)
    if (rerun.length) {
      this.#waiting.add(group)
      this.#scheduleWave()
    }
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
    connection.pending.delete(pending)
    connection.held.push({ message: outgoing({ type: "settled", mutations: [pending.mutationId] }), settles: pending })
    this.#release(connection)
  }

  #blocked(connection: Connection, groups: Iterable<Group>) {
    if (!connection.pending.size) return false
    for (const pending of connection.pending) for (const group of groups) if (pending.affected?.has(group)) return true
    return false
  }

  #deliver(connection: Connection, message: Outgoing, group: Group) {
    if (connection.pending.size && this.#blocked(connection, [group])) connection.held.push({ message, group })
    else this.#enqueue(connection, message)
  }

  #release(connection: Connection) {
    const still: typeof connection.held = []
    for (const item of connection.held) {
      const groups = item.group ? [item.group] : (item.settles?.affected ?? [])
      if (this.#blocked(connection, groups)) still.push(item)
      else this.#enqueue(connection, item.message)
    }
    connection.held = still
  }

  #enqueue(connection: Connection, message: Outgoing) {
    connection.outbox.push(message)
    if (connection.flushing) return
    connection.flushing = true
    this.#flushQueue.add(connection)
    if (this.#flushScheduled) return
    this.#flushScheduled = true
    soon(() => {
      this.#flushScheduled = false
      const queued = [...this.#flushQueue]
      this.#flushQueue.clear()
      for (const connection of queued) this.#flush(connection)
    })
  }

  #flush(connection: Connection) {
    connection.flushing = false
    const messages = connection.outbox.splice(0)
    if (!messages.length || this.#connections.get(connection.id) !== connection) return
    if (messages.length === 1) connection.send((messages[0]!.frame ??= frameOf([messages[0]!.text])), true)
    else connection.send(frameOf(messages.map((item) => item.text)), false)
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
      const encoded = encode(result.value)
      return {
        ok: true,
        value: result.value,
        encoded,
        fingerprint: group.awaitingFingerprint > 0 ? await fingerprint(encoded) : undefined,
        reads: result.reads,
        tags,
      }
    } catch (error) {
      return { ok: false, error: publicMessage(error), reads: undefined, tags }
    }
  }

  #apply(group: Group, evaluation: Evaluation): Update | null {
    const readsKey = evaluation.reads === undefined ? undefined : stableStringify(evaluation.reads)
    if (readsKey !== group.readsKey || readsKey === undefined) this.#index.set(group, evaluation.reads)
    group.reads = evaluation.reads
    group.readsKey = readsKey
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
    group.fingerprint = evaluation.fingerprint === undefined ? undefined : { encoded: evaluation.encoded, value: evaluation.fingerprint }
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

  render(session: Session | null) {
    let closed = false
    let snapshot: Promise<void> | undefined
    let reader: Promise<Reader> | undefined
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const pending = new Set<Promise<unknown>>()
    const runQuery = (name: string, args: unknown) => {
      if (closed) return Promise.reject(new Error("lyn: render is closed"))
      if (!reader) {
        let available!: (read: Reader) => void
        let failed!: (error: unknown) => void
        reader = new Promise<Reader>((resolve, reject) => { available = resolve; failed = reject })
        snapshot = this.adapter.snapshot([], async (read) => {
          available(read)
          await finished
          await Promise.allSettled(pending)
        })
        snapshot.catch(failed)
      }
      const result = reader.then(async (read) => {
        const result = await this.#execute(name, args, session, read)
        if (!result.ok) throw result.error
        return result.value
      })
      pending.add(result)
      result.then(() => pending.delete(result), () => pending.delete(result))
      return result
    }
    return {
      runQuery,
      close: async () => {
        closed = true
        finish()
        await snapshot
      },
    }
  }

  async #fingerprintOf(group: Group) {
    const encoded = group.encoded
    if (encoded === undefined) return undefined
    if (group.fingerprint?.encoded === encoded) return group.fingerprint.value
    const value = await fingerprint(encoded)
    if (group.encoded === encoded) group.fingerprint = { encoded, value }
    return group.encoded === encoded ? value : undefined
  }

  connect(send: (frame: string, shared: boolean) => void, session: Session | null): Connection {
    const connection: Connection = {
      id: crypto.randomUUID(),
      session,
      sessionKey: sessionKey(session),
      send,
      subs: new Map(),
      outbox: [],
      flushing: false,
      held: [],
      pending: new Set(),
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
    const key = `${connection.id}:${sub}`
    if (group.subscribers.get(key)?.fingerprint !== undefined) group.awaitingFingerprint--
    group.subscribers.delete(key)
    for (const other of connection.subs.values()) if (other === group) return
    for (const pending of [...connection.pending])
      if (pending.groups?.delete(group) && !pending.groups.size) this.#settle(pending.token, pending)
    if (group.subscribers.size) return
    group.active = false
    this.#groups.delete(group.key)
    this.#index.delete(group)
    this.#waiting.delete(group)
  }

  async subscribe(request: SubscribeRequest, session: Session | null) {
    await this.ready
    const connection = this.#connections.get(request.clientId)
    if (!connection) throw new Error("lyn: unknown client")
    if (connection.sessionKey !== sessionKey(session)) throw new Error("lyn: session changed; reconnect the event stream")
    for (const sub of request.remove) this.#detach(connection, sub)
    for (const { sub, name, args, fingerprint } of request.add) {
      this.#detach(connection, sub)
      const key = `${queryKey(name, args)}@${connection.sessionKey}`
      let group = this.#groups.get(key)
      if (!group) {
        group = {
          id: this.#nextGroupId++,
          key,
          queryKey: queryKey(name, args),
          session: connection.session,
          name,
          args,
          reads: undefined,
          startedAt: 0,
          tags: [],
          value: undefined,
          version: 0,
          evaluated: false,
          running: false,
          active: true,
          queued: [{ force: true }],
          awaitingFingerprint: 0,
          subscribers: new Map(),
        }
        this.#groups.set(key, group)
        this.#index.set(group, undefined)
        this.#waiting.add(group)
      }
      const subscriber: Subscriber = { connection, sub, fingerprint: group.evaluated ? undefined : fingerprint, bound: false }
      if (subscriber.fingerprint !== undefined) group.awaitingFingerprint++
      group.subscribers.set(`${connection.id}:${sub}`, subscriber)
      connection.subs.set(sub, group)
      if (group.evaluated) {
        const unchanged = !group.error && fingerprint !== undefined && fingerprint === (await this.#fingerprintOf(group))
        if (connection.subs.get(sub) !== group) continue
        subscriber.bound = true
        this.#deliver(
          connection,
          outgoing(
            group.error
              ? { type: "error", group: group.id, sub, message: group.error }
              : unchanged
                ? { type: "unchanged", group: group.id, sub, version: group.version }
                : { type: "data", group: group.id, sub, version: group.version, value: group.value },
          ),
          group,
        )
      }
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
          this.#pending.set(writeToken, { token: writeToken, connectionId: request.clientId, mutationId: request.mutationId, at: Date.now() })
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
