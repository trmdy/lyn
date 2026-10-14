import { registry, type Definition } from "../shared/registry.ts"
import { queryKey } from "../shared/wire.ts"
import type { ReadDb, Tables, WriteDb } from "./db.ts"

export interface Session {}

export type { ReadDb, ReadQuery, Tables, WriteDb, WriteQuery } from "./db.ts"

type ValidationResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<{ readonly message: string }> }

export interface Schema<T = unknown> {
  readonly "~standard": {
    readonly validate: (value: unknown) => ValidationResult<T> | Promise<ValidationResult<T>>
  }
}

type NoArgs = Record<string, never>

export interface QueryRef<A = any, R = any> {
  readonly kind?: "query"
  readonly name: string
  readonly __types?: { args: A; result: R }
}

export interface MutationRef<A = any, R = any> {
  readonly kind?: "mutation"
  readonly name: string
  readonly __types?: { args: A; result: R }
}

export interface ActionRef<A = any, R = any> {
  readonly kind?: "action"
  readonly name: string
  readonly __types?: { args: A; result: R }
}

export type Invalidation =
  | { kind: "tag"; tag: string }
  | { kind: "table"; table: string }
  | { kind: "query"; key: string }
  | { kind: "all" }

export interface Invalidate {
  <A>(query: QueryRef<A>, args: A): void
  tag(tag: string): void
  table(table: keyof Tables & string): void
  all(): void
}

export interface QueryCtx {
  db: ReadDb
  session: Session | null
  depends(tag: string): void
}

export interface MutationCtx {
  db: WriteDb
  session: Session | null
  invalidate: Invalidate
}

export interface ActionCtx {
  session: Session | null
  runQuery<A, R>(query: QueryRef<A, R>, args: A): Promise<R>
  runMutation<A, R>(mutation: MutationRef<A, R>, args: A): Promise<R>
  invalidate: Invalidate
}

export type Change<T> =
  | { kind: "insert"; new: T; old: undefined }
  | { kind: "update"; new: T; old: Partial<T> | undefined }
  | { kind: "delete"; new: undefined; old: Partial<T> | undefined }

export interface EffectDefinition {
  kind: "effect"
  name: string
  table: string
  on: Change<unknown>["kind"][]
  handler: (ctx: MutationCtx, change: Change<any>) => unknown
}

function define<T>(definition: Omit<Definition, "name">): T {
  return { ...definition, name: "" } as unknown as T
}

export function query<R, A = NoArgs>(definition: {
  args?: Schema<A>
  handler: (ctx: QueryCtx, args: A) => R | Promise<R>
}): QueryRef<A, R> {
  return define({ kind: "query", ...definition })
}

export function mutation<R, A = NoArgs>(definition: {
  args?: Schema<A>
  handler: (ctx: MutationCtx, args: A) => R | Promise<R>
}): MutationRef<A, R> {
  return define({ kind: "mutation", ...definition })
}

export function action<R, A = NoArgs>(definition: {
  args?: Schema<A>
  handler: (ctx: ActionCtx, args: A) => R | Promise<R>
}): ActionRef<A, R> {
  return define({ kind: "action", ...definition })
}

export function effect<T extends keyof Tables & string>(definition: {
  table: T
  on?: Change<unknown>["kind"][]
  handler: (ctx: MutationCtx, change: Change<Tables[T]>) => unknown
}): EffectDefinition {
  return define<EffectDefinition>({ kind: "effect", on: ["insert", "update", "delete"], ...definition } as Omit<Definition, "name">)
}

export function __register(moduleId: string, exports: Record<string, unknown>) {
  for (const [exportName, value] of Object.entries(exports)) {
    const definition = value as Definition | undefined
    if (!definition || typeof definition !== "object" || typeof definition.handler !== "function") continue
    definition.name = `${moduleId}:${exportName}`
    registry.set(definition.name, definition)
  }
}

export function definitionsOfKind<K extends Definition["kind"]>(kind: K) {
  return [...registry.values()].filter((definition) => definition.kind === kind)
}

export async function validate<A>(schema: Schema<A> | undefined, value: unknown): Promise<A> {
  if (!schema) return (value ?? {}) as A
  const result = await schema["~standard"].validate(value)
  if (result.issues) throw new Error(`Invalid arguments: ${result.issues.map((issue) => issue.message).join("; ")}`)
  return result.value
}

type GlobalWithEngine = typeof globalThis & { __lynInvalidate?: (invalidation: Invalidation) => void }

export function createInvalidate(push: (invalidation: Invalidation) => void): Invalidate {
  const invalidate = ((query: QueryRef, args: unknown) => push({ kind: "query", key: queryKey(query.name, args) })) as Invalidate
  invalidate.tag = (tag) => push({ kind: "tag", tag })
  invalidate.table = (table) => push({ kind: "table", table })
  invalidate.all = () => push({ kind: "all" })
  return invalidate
}

export function setGlobalInvalidate(push: (invalidation: Invalidation) => void) {
  ;(globalThis as GlobalWithEngine).__lynInvalidate = push
}

export const invalidate: Invalidate = createInvalidate((invalidation) => {
  const push = (globalThis as GlobalWithEngine).__lynInvalidate
  if (!push) throw new Error("lyn: no running engine to invalidate")
  push(invalidation)
})
