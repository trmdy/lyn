export type Kind = "query" | "mutation" | "action" | "effect"

export interface Definition {
  kind: Kind
  name: string
  args?: unknown
  handler: (ctx: any, args: any) => unknown
  [extra: string]: unknown
}

type GlobalWithRegistry = typeof globalThis & { __lynRegistry?: Map<string, Definition> }

export const registry: Map<string, Definition> = ((globalThis as GlobalWithRegistry).__lynRegistry ??= new Map())
