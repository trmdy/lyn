import { applyRows, decode, encode, queryKey, type ServerFrame } from "@lyn/core/wire"

type Ref = { name: string }

export interface OptimisticStore {
  get<R>(query: Ref & { __types?: { result: R } }, args?: unknown): Awaited<R> | undefined
  set<R>(query: Ref & { __types?: { result: R } }, args: unknown, value: Awaited<R>): void
}

export type OptimisticUpdate<A> = (store: OptimisticStore, args: A) => void

export interface Entry {
  key: string
  name: string
  args: unknown
  sub?: number
  server?: { value: unknown; version: number }
  display: unknown
  error?: Error
  ready: Promise<void>
  resolveReady: () => void
  listeners: Set<() => void>
  refs: number
  gcTimer?: ReturnType<typeof setTimeout>
  subscribe: (listener: () => void) => () => void
}

interface PendingMutation {
  id: string
  args: unknown
  optimistic?: OptimisticUpdate<any>
  responded: boolean
}

export interface LynClientOptions {
  initial?: string
  fetchQuery?: (name: string, args: unknown) => Promise<unknown>
  baseUrl?: string
  gcTime?: number
}

export class LynClient {
  readonly #entries = new Map<string, Entry>()
  readonly #bySub = new Map<number, Entry>()
  readonly #fetchQuery?: LynClientOptions["fetchQuery"]
  readonly #baseUrl: string
  readonly #gcTime: number
  #pending: PendingMutation[] = []
  #nextSub = 1
  #clientId?: string
  #outgoing = { add: new Set<Entry>(), remove: new Set<number>() }
  #outgoingScheduled = false
  #resync?: { keys: Set<string>; mutations: Set<string> }
  #source?: EventSource

  constructor(options: LynClientOptions = {}) {
    this.#fetchQuery = options.fetchQuery
    this.#baseUrl = options.baseUrl ?? ""
    this.#gcTime = options.gcTime ?? 10_000
    if (options.initial)
      for (const [name, args, value] of decode<[string, unknown, unknown][]>(options.initial)) {
        const entry = this.#create(name, args)
        entry.server = { value, version: 0 }
        entry.display = value
        entry.resolveReady()
      }
    if (!this.#fetchQuery && typeof EventSource !== "undefined") this.#connect()
  }

  entry(name: string, args: unknown): Entry {
    return this.#entries.get(queryKey(name, args)) ?? this.#create(name, args)
  }

  retain(entry: Entry) {
    entry.refs++
    clearTimeout(entry.gcTimer)
    return () => {
      entry.refs--
      if (!entry.refs) this.#scheduleGc(entry)
    }
  }

  dehydrate(): string {
    return encode([...this.#entries.values()].filter((entry) => entry.server).map((entry) => [entry.name, entry.args, entry.server!.value]))
  }

  async mutate<A, R>(name: string, args: A, optimistic?: OptimisticUpdate<A>): Promise<R> {
    const pending: PendingMutation = { id: crypto.randomUUID(), args, optimistic, responded: false }
    this.#pending.push(pending)
    if (optimistic) this.#recompute()
    try {
      const body = await this.#post("mutate", { clientId: this.#clientId, mutationId: pending.id, name, args })
      pending.responded = true
      if (body.settled) this.#drop(pending.id)
      else setTimeout(() => this.#drop(pending.id), 15_000)
      return body.result
    } catch (error) {
      this.#drop(pending.id)
      throw error
    }
  }

  async action<A, R>(name: string, args: A): Promise<R> {
    return (await this.#post("action", { name, args })).result
  }

  #create(name: string, args: unknown): Entry {
    const key = queryKey(name, args)
    let resolve!: () => void
    const ready = Object.assign(new Promise<void>((done) => (resolve = done)), { status: "pending" })
    const resolveReady = () => {
      ready.status = "fulfilled"
      resolve()
    }
    const entry: Entry = {
      key,
      name,
      args,
      display: undefined,
      ready,
      resolveReady,
      listeners: new Set(),
      refs: 0,
      subscribe: (listener) => {
        entry.listeners.add(listener)
        return () => entry.listeners.delete(listener)
      },
    }
    this.#entries.set(key, entry)
    this.#scheduleGc(entry)
    if (this.#fetchQuery) {
      this.#fetchQuery(name, args).then(
        (value) => {
          entry.server = { value, version: 0 }
          entry.display = value
          resolveReady()
        },
        (error) => {
          entry.error = error instanceof Error ? error : new Error(String(error))
          resolveReady()
        },
      )
    } else if (this.#clientId) {
      this.#queueSubscribe(entry)
    }
    return entry
  }

  #scheduleGc(entry: Entry) {
    if (this.#fetchQuery) return
    clearTimeout(entry.gcTimer)
    entry.gcTimer = setTimeout(() => {
      if (entry.refs) return
      this.#entries.delete(entry.key)
      this.#outgoing.add.delete(entry)
      if (entry.sub !== undefined) {
        this.#bySub.delete(entry.sub)
        this.#outgoing.remove.add(entry.sub)
        this.#flushOutgoingSoon()
      }
    }, this.#gcTime)
  }

  #queueSubscribe(entry: Entry) {
    if (entry.sub !== undefined) this.#bySub.delete(entry.sub)
    entry.sub = this.#nextSub++
    this.#bySub.set(entry.sub, entry)
    this.#outgoing.add.add(entry)
    this.#flushOutgoingSoon()
  }

  #flushOutgoingSoon() {
    if (this.#outgoingScheduled) return
    this.#outgoingScheduled = true
    queueMicrotask(() => {
      this.#outgoingScheduled = false
      const add = [...this.#outgoing.add].map((entry) => ({ sub: entry.sub!, name: entry.name, args: entry.args }))
      const remove = [...this.#outgoing.remove]
      this.#outgoing = { add: new Set(), remove: new Set() }
      if (!this.#clientId || (!add.length && !remove.length)) return
      this.#post("subscribe", { clientId: this.#clientId, add, remove }).catch((error) =>
        console.error("[lyn] subscribe failed", error),
      )
    })
  }

  reconnect() {
    this.#source?.close()
    this.#connect()
  }

  #connect() {
    const source = new EventSource(`${this.#baseUrl}/_lyn/events`)
    this.#source = source
    source.addEventListener("hello", (event) => this.#onHello(JSON.parse((event as MessageEvent).data).clientId))
    source.addEventListener("frame", (event) => this.#onFrame(decode<ServerFrame>((event as MessageEvent).data)))
  }

  #onHello(clientId: string) {
    const reconnect = this.#clientId !== undefined
    this.#clientId = clientId
    this.#bySub.clear()
    this.#outgoing = { add: new Set(), remove: new Set() }
    if (reconnect)
      this.#resync = {
        keys: new Set(this.#entries.keys()),
        mutations: new Set(this.#pending.filter((pending) => pending.responded).map((pending) => pending.id)),
      }
    for (const entry of this.#entries.values()) this.#queueSubscribe(entry)
  }

  #onFrame(frame: ServerFrame) {
    const touched = new Set<Entry>()
    for (const message of frame.messages) {
      if (message.type === "settled") {
        for (const id of message.mutations) this.#drop(id, false)
        continue
      }
      const entry = this.#bySub.get(message.sub)
      if (!entry) continue
      if (message.type === "patch" && entry.server?.version !== message.from) {
        this.#queueSubscribe(entry)
        continue
      }
      if (message.type === "data") entry.server = { value: message.value, version: message.version }
      if (message.type === "patch") entry.server = { value: applyRows(entry.server!.value, message.patch), version: message.version }
      entry.error = message.type === "error" ? new Error(message.message) : undefined
      entry.resolveReady()
      this.#resync?.keys.delete(entry.key)
      touched.add(entry)
    }
    if (this.#resync && !this.#resync.keys.size) {
      for (const id of this.#resync.mutations) this.#drop(id, false)
      this.#resync = undefined
    }
    this.#recompute(touched)
  }

  #drop(id: string, recompute = true) {
    const before = this.#pending.length
    this.#pending = this.#pending.filter((pending) => pending.id !== id)
    if (recompute && this.#pending.length !== before) this.#recompute()
  }

  #recompute(touched = new Set<Entry>()) {
    const layer = new Map<string, unknown>()
    const store: OptimisticStore = {
      get: (query, args) => {
        const key = queryKey(query.name, args)
        return (layer.has(key) ? layer.get(key) : this.#entries.get(key)?.server?.value) as any
      },
      set: (query, args, value) => {
        layer.set(queryKey(query.name, args), value)
      },
    }
    for (const pending of this.#pending) {
      try {
        pending.optimistic?.(store, pending.args)
      } catch (error) {
        console.error("[lyn] optimistic update failed", error)
      }
    }
    for (const entry of this.#entries.values()) {
      const display = layer.has(entry.key) ? layer.get(entry.key) : entry.server?.value
      if (display !== entry.display) {
        entry.display = display
        touched.add(entry)
      }
    }
    for (const entry of touched) for (const listener of entry.listeners) listener()
  }

  async #post(route: string, body: unknown) {
    if (this.#fetchQuery) throw new Error("lyn: mutations and actions are not available during server rendering")
    const response = await fetch(`${this.#baseUrl}/_lyn/${route}`, { method: "POST", body: encode(body) })
    const result = decode(await response.text())
    if (!response.ok) throw new Error(result.error)
    return result
  }
}
