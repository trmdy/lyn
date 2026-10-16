import { registry, type Definition } from "./registry.ts"
import { queryKey } from "./wire.ts"
import type { Change } from "./adapter.ts"

export type { Adapter, Change, ChangeBatch, ExecutionContext, Reader, ReadIndex, ReadResult, Row } from "./adapter.ts"
export { Engine } from "./engine.ts"

export interface Register {}

export class LynError extends Error {
  override name = "LynError"
}

const production = () => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === "production"

export function publicMessage(error: unknown) {
  if (error instanceof Error && error.name === "LynError") return error.message
  console.error(error)
  return production() ? "Internal server error" : error instanceof Error ? error.message : String(error)
}

export type Session = Register extends { session: infer S } ? S : Record<string, unknown>

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
  | { kind: "query"; key: string }
  | { kind: "all" }

export interface Invalidate {
  <A>(query: QueryRef<A>, args: A): void
  tag(tag: string): void
  all(): void
}

export interface QueryCtx {
  session: Session | null
  depends(tag: string): void
}

export interface MutationCtx {
  session: Session | null
  invalidate: Invalidate
}

export interface ActionCtx {
  session: Session | null
  runQuery<A, R>(query: QueryRef<A, R>, args: A): Promise<Awaited<R>>
  runMutation<A, R>(mutation: MutationRef<A, R>, args: A): Promise<Awaited<R>>
  invalidate: Invalidate
}

type RowChangeKind = "insert" | "update" | "delete"

export interface EffectDefinition {
  kind: "effect"
  name: string
  table: string
  on: RowChangeKind[]
  handler: (ctx: MutationCtx, change: Change) => unknown
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

export function effect(definition: {
  table: string
  on?: RowChangeKind[]
  handler: (ctx: MutationCtx, change: Change) => unknown
}): EffectDefinition {
  return define({ kind: "effect", on: ["insert", "update", "delete"], ...definition } as Omit<Definition, "name">)
}

export function __register(moduleId: string, exports: Record<string, unknown>) {
  for (const [exportName, value] of Object.entries(exports)) {
    const definition = value as Definition | undefined
    if (!definition || typeof definition !== "object" || typeof definition.handler !== "function") continue
    definition.name = `${moduleId}:${exportName}`
    registry.set(definition.name, definition)
  }
}

export async function validate<A>(schema: Schema<A> | undefined, value: unknown): Promise<A> {
  if (!schema) return (value ?? {}) as A
  const result = await schema["~standard"].validate(value)
  if (result.issues) throw new LynError(`Invalid arguments: ${result.issues.map((issue) => issue.message).join("; ")}`)
  return result.value
}

export function createInvalidate(push: (invalidation: Invalidation) => void): Invalidate {
  const invalidate = ((query: QueryRef, args: unknown) => push({ kind: "query", key: queryKey(query.name, args) })) as Invalidate
  invalidate.tag = (tag) => push({ kind: "tag", tag })
  invalidate.all = () => push({ kind: "all" })
  return invalidate
}

type GlobalWithInvalidate = typeof globalThis & { __lynInvalidate?: (invalidation: Invalidation) => void }

export function setGlobalInvalidate(push: (invalidation: Invalidation) => void) {
  ;(globalThis as GlobalWithInvalidate).__lynInvalidate = push
}

export const invalidate: Invalidate = createInvalidate((invalidation) => {
  const push = (globalThis as GlobalWithInvalidate).__lynInvalidate
  if (!push) throw new Error("lyn: no running engine to invalidate")
  push(invalidation)
})
