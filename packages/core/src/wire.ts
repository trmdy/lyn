import { parse, stringify, unflatten } from "devalue"

export const encode = (value: unknown): string => stringify(value)
export async function fingerprint(encoded: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

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
  | { type: "data"; group: number; sub?: number; version: number; value: unknown }
  | { type: "unchanged"; group: number; sub: number; version: number }
  | { type: "patch"; group: number; from: number; version: number; patch: RowsPatch }
  | { type: "error"; group: number; sub?: number; message: string }
  | { type: "settled"; mutations: string[] }

export const frameOf = (encodedMessages: string[]) => `[${encodedMessages.join(",")}]`

export const decodeFrame = (frame: string): ServerMessage[] =>
  (JSON.parse(frame) as unknown[]).map((message) => unflatten(message as number | unknown[]) as ServerMessage)

export type RoutedMessage =
  | (Exclude<ServerMessage, { type: "settled" }> & { sub: number })
  | Extract<ServerMessage, { type: "settled" }>

export function createRouter() {
  const subsByGroup = new Map<number, Set<number>>()
  const groupBySub = new Map<number, number>()
  const forget = (sub: number) => {
    const group = groupBySub.get(sub)
    if (group === undefined) return
    groupBySub.delete(sub)
    const subs = subsByGroup.get(group)
    if (subs?.delete(sub) && !subs.size) subsByGroup.delete(group)
  }
  return {
    route(frame: string): RoutedMessage[] {
      const routed: RoutedMessage[] = []
      for (const message of decodeFrame(frame)) {
        if (message.type === "settled") routed.push(message)
        else if ("sub" in message && message.sub !== undefined) {
          if (groupBySub.get(message.sub) !== message.group) {
            forget(message.sub)
            groupBySub.set(message.sub, message.group)
            let subs = subsByGroup.get(message.group)
            if (!subs) subsByGroup.set(message.group, (subs = new Set()))
            subs.add(message.sub)
          }
          routed.push(message as RoutedMessage)
        } else for (const sub of subsByGroup.get(message.group) ?? []) routed.push({ ...message, sub })
      }
      return routed
    },
    forget,
    reset() {
      subsByGroup.clear()
      groupBySub.clear()
    },
  }
}

export interface SubscribeRequest {
  clientId: string
  add: { sub: number; name: string; args: unknown; fingerprint?: string }[]
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
