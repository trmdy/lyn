import type { Session } from "./index.ts"

export interface ExecutionContext {
  session: Session | null
  system?: boolean
}

export type Row = Record<string, unknown>

export interface Change {
  source: string
  kind: "insert" | "update" | "delete" | "truncate"
  new?: Row
  old?: Row
}

export interface ChangeBatch {
  tokens: string[]
  changes: Change[]
  position?: string
}

export type ReadResult<T> = { ok: true; value: T; reads: unknown } | { ok: false; error: unknown; reads: unknown }

export type Reader = <T>(context: ExecutionContext, run: () => Promise<T>) => Promise<ReadResult<T>>

export interface Adapter {
  readonly id: string
  start(onChanges: (batch: ChangeBatch) => void): Promise<void>
  stop(): Promise<void>
  snapshot<T>(after: ChangeBatch[], run: (read: Reader) => Promise<T>): Promise<T>
  write<T>(context: ExecutionContext, run: () => Promise<T>, beforeCommit?: (token: string) => void): Promise<{ value: T; token?: string }>
  affects(reads: unknown, batch: ChangeBatch): boolean
  isLeader(): boolean
}
