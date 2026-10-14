import { parse, stringify } from "devalue"

export const encode = (value: unknown): string => stringify(value)
export const decode = <T = any>(text: string): T => parse(text) as T

export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  )
}

export const queryKey = (name: string, args: unknown): string => `${name}|${stableStringify(args ?? {})}`

type RowId = string | number
type Row = Record<string, unknown> & { id: RowId }

export interface RowsPatch {
  order: RowId[]
  upsert: Row[]
}

export type ServerMessage =
  | { type: "data"; sub: number; version: number; value: unknown }
  | { type: "patch"; sub: number; from: number; version: number; patch: RowsPatch }
  | { type: "error"; sub: number; message: string }
  | { type: "settled"; mutations: string[] }

export interface ServerFrame {
  lsn?: string
  messages: ServerMessage[]
}

export interface SubscribeRequest {
  clientId: string
  add: { sub: number; name: string; args: unknown }[]
  remove: number[]
}

export interface MutationRequest {
  clientId?: string
  mutationId: string
  name: string
  args: unknown
}

function isRows(value: unknown): value is Row[] {
  if (!Array.isArray(value)) return false
  const ids = new Set<RowId>()
  for (const row of value) {
    if (!row || typeof row !== "object") return false
    const id = (row as Row).id
    if ((typeof id !== "string" && typeof id !== "number") || ids.has(id)) return false
    ids.add(id)
  }
  return true
}

export function diffRows(previous: unknown, next: unknown): RowsPatch | null {
  if (!isRows(previous) || !isRows(next)) return null
  const before = new Map(previous.map((row) => [row.id, encode(row)]))
  return {
    order: next.map((row) => row.id),
    upsert: next.filter((row) => before.get(row.id) !== encode(row)),
  }
}

export function applyRows(previous: unknown, patch: RowsPatch): Row[] {
  const byId = new Map((previous as Row[]).map((row) => [row.id, row]))
  for (const row of patch.upsert) byId.set(row.id, row)
  return patch.order.map((id) => byId.get(id)!)
}
