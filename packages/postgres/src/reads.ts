import type { ChangeBatch, ReadIndex } from "@lyn/core"
import { parseSync } from "libpg-query"

type Row = Record<string, unknown>

type ValueSource = { param: number; spread?: boolean } | { value: unknown }

interface TemplateRead {
  table: string
  eq: Record<string, ValueSource[]>
}

interface Template {
  any: boolean
  reads: TemplateRead[]
}

export interface TableRead {
  table: string
  eq?: Record<string, unknown[]>
}

export interface ReadSet {
  any: boolean
  tables: TableRead[]
}

export interface CatalogInput {
  tables: string[]
  views: { name: string; definition: string }[]
  policies: { table: string; using: string }[]
  functions: { name: string; language: string; body: string }[]
}

export interface Catalog {
  tables: Set<string>
  relationDeps(name: string): string[] | null
  functionDeps(name: string): string[] | null
}

type Node = Record<string, any>

const tableName = (schema: string | undefined, name: string) => (schema && schema !== "public" ? `${schema}.${name}` : name)

function walk(node: unknown, visit: (key: string, value: Node) => void) {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit))
  if (!node || typeof node !== "object") return
  for (const [key, value] of Object.entries(node)) {
    if (value && typeof value === "object") {
      if (!Array.isArray(value)) visit(key, value)
      walk(value, visit)
    }
  }
}

const functionName = (call: Node) => (call.funcname as Node[]).map((part) => part.String?.sval).join(".")

function references(sql: string): { relations: string[]; functions: string[] } | null {
  let tree: Node
  try {
    tree = parseSync(sql)
  } catch {
    return null
  }
  const relations = new Set<string>()
  const functions = new Set<string>()
  walk(tree, (key, value) => {
    if (key === "RangeVar") relations.add(tableName(value.schemaname, value.relname))
    if (key === "FuncCall") functions.add(functionName(value))
  })
  return { relations: [...relations], functions: [...functions] }
}

export function buildCatalog(input: CatalogInput): Catalog {
  const tables = new Set(input.tables)
  const views = new Map(input.views.map((view) => [view.name, view.definition]))
  const policies = new Map<string, string[]>()
  for (const policy of input.policies) policies.set(policy.table, [...(policies.get(policy.table) ?? []), policy.using])
  const functions = new Map<string, { language: string; body: string }[]>()
  for (const fn of input.functions) {
    for (const key of [fn.name, fn.name.split(".").at(-1)!])
      functions.set(key, [...(functions.get(key) ?? []), { language: fn.language, body: fn.body }])
  }

  const relationCache = new Map<string, string[] | null>()
  const functionCache = new Map<string, string[] | null>()

  const union = (parts: (string[] | null)[]) => (parts.some((part) => part === null) ? null : [...new Set(parts.flat() as string[])])

  const expand = (found: { relations: string[]; functions: string[] } | null, seen: Set<string>): string[] | null =>
    found ? union([...found.relations.map((name) => relationDeps(name, seen)), ...found.functions.map((name) => functionDeps(name, seen))]) : null

  function relationDeps(name: string, seen: Set<string>): string[] | null {
    if (seen.has(`r:${name}`)) return []
    seen.add(`r:${name}`)
    if (tables.has(name)) return union([[name], ...(policies.get(name) ?? []).map((using) => expand(references(`select 1 where ${using}`), seen))])
    if (views.has(name)) return expand(references(views.get(name)!), seen)
    return null
  }

  function functionDeps(name: string, seen: Set<string>): string[] | null {
    const definitions = functions.get(name) ?? functions.get(name.split(".").at(-1)!)
    if (!definitions) return []
    if (seen.has(`f:${name}`)) return []
    seen.add(`f:${name}`)
    return union(definitions.map((fn) => (fn.language === "sql" ? expand(references(fn.body), seen) : null)))
  }

  const cached = (cache: Map<string, string[] | null>, resolve: (name: string, seen: Set<string>) => string[] | null) => (name: string) => {
    if (!cache.has(name)) cache.set(name, resolve(name, new Set()))
    return cache.get(name)!
  }

  return { tables, relationDeps: cached(relationCache, relationDeps), functionDeps: cached(functionCache, functionDeps) }
}

function constantOf(node: Node | undefined): ValueSource | null {
  if (!node) return null
  if (node.TypeCast) return constantOf(node.TypeCast.arg)
  if (node.ParamRef) return { param: node.ParamRef.number }
  const constant = node.A_Const
  if (!constant || constant.isnull) return null
  if (constant.ival) return { value: constant.ival.ival ?? 0 }
  if (constant.sval) return { value: constant.sval.sval }
  if (constant.boolval) return { value: constant.boolval.boolval ?? false }
  if (constant.fval) return { value: constant.fval.fval }
  return null
}

function columnOf(node: Node | undefined): string[] | null {
  const fields = node?.ColumnRef?.fields as Node[] | undefined
  if (!fields?.every((field) => field.String)) return null
  return fields.map((field) => field.String.sval as string)
}

function conjuncts(where: Node | undefined): Node[] {
  if (!where) return []
  if (where.BoolExpr?.boolop === "AND_EXPR") return (where.BoolExpr.args as Node[]).flatMap(conjuncts)
  return [where]
}

function equalities(where: Node | undefined): { column: string[]; values: ValueSource[] }[] {
  const found: { column: string[]; values: ValueSource[] }[] = []
  for (const conjunct of conjuncts(where)) {
    const expr = conjunct.A_Expr
    if (!expr || expr.name?.[0]?.String?.sval !== "=") continue
    if (expr.kind === "AEXPR_OP") {
      const left = columnOf(expr.lexpr)
      const right = columnOf(expr.rexpr)
      const value = left ? constantOf(expr.rexpr) : right ? constantOf(expr.lexpr) : null
      if ((left ?? right) && value) found.push({ column: (left ?? right)!, values: [value] })
    } else if (expr.kind === "AEXPR_IN") {
      const column = columnOf(expr.lexpr)
      const items = (expr.rexpr?.List?.items ?? []) as Node[]
      const values = items.map(constantOf)
      if (column && values.length && values.every(Boolean)) found.push({ column, values: values as ValueSource[] })
    } else if (expr.kind === "AEXPR_OP_ANY") {
      const column = columnOf(expr.lexpr)
      const value = constantOf(expr.rexpr)
      if (column && value && "param" in value) found.push({ column, values: [{ param: value.param, spread: true }] })
    }
  }
  return found
}

function fromRelations(items: Node[] | undefined, into: Node[] = []): Node[] {
  for (const item of items ?? []) {
    if (item.RangeVar) into.push(item.RangeVar)
    else if (item.JoinExpr) fromRelations([item.JoinExpr.larg, item.JoinExpr.rarg], into)
  }
  return into
}

export function analyze(sql: string, catalog: Catalog): Template {
  const template: Template = { any: false, reads: [] }
  let tree: Node
  try {
    tree = parseSync(sql)
  } catch (error) {
    console.warn(`[lyn] could not parse SQL, so it will re-run on every change: ${error instanceof Error ? error.message : error}`)
    return { any: true, reads: [] }
  }

  const cteNames = new Set<string>()
  walk(tree, (key, value) => {
    if (key === "CommonTableExpr") cteNames.add(value.ctename)
  })
  const isCte = (relation: Node) => !relation.schemaname && cteNames.has(relation.relname)
  const read = (relation: Node, eq: Record<string, ValueSource[]> = {}) => {
    const name = tableName(relation.schemaname, relation.relname)
    if (isCte(relation) && !catalog.tables.has(name) && catalog.relationDeps(name) === null) return
    const deps = catalog.relationDeps(name)
    if (deps === null) {
      template.any = true
      return
    }
    for (const dep of deps) template.reads.push({ table: dep, eq: dep === name && !isCte(relation) ? eq : {} })
  }

  const scoped = new Set<Node>()
  walk(tree, (key, value) => {
    if (key !== "SelectStmt") return
    const relations = fromRelations(value.fromClause)
    const byAlias = new Map<string, Node>()
    for (const relation of relations) {
      byAlias.set(relation.alias?.aliasname ?? relation.relname, relation)
      scoped.add(relation)
    }
    const soleRelation = value.fromClause?.length === 1 && value.fromClause[0].RangeVar ? relations[0] : undefined
    const eqByRelation = new Map<Node, Record<string, ValueSource[]>>()
    for (const { column, values } of equalities(value.whereClause)) {
      const name = column.at(-1)!
      const qualifier = column.at(-2)
      const relation = qualifier ? byAlias.get(qualifier) : soleRelation
      if (!relation) continue
      const eq = eqByRelation.get(relation) ?? {}
      eq[name] ??= values
      eqByRelation.set(relation, eq)
    }
    for (const relation of relations) read(relation, eqByRelation.get(relation))
  })

  walk(tree, (key, value) => {
    if (key === "RangeVar" && !scoped.has(value)) read(value)
    if (key === "FuncCall") {
      const deps = catalog.functionDeps(functionName(value))
      if (deps === null) template.any = true
      else for (const dep of deps) template.reads.push({ table: dep, eq: {} })
    }
  })

  return template
}

const templates = new Map<string, Template>()

export function readsOf(sql: string, params: unknown[], catalog: Catalog): ReadSet {
  let template = templates.get(sql)
  if (!template) {
    template = analyze(sql, catalog)
    templates.set(sql, template)
  }
  const resolve = (source: ValueSource) =>
    "value" in source
      ? [source.value]
      : source.spread && Array.isArray(params[source.param - 1])
        ? (params[source.param - 1] as unknown[])
        : [params[source.param - 1]]
  return {
    any: template.any,
    tables: template.reads.map(({ table, eq }) => {
      const entries = Object.entries(eq)
      return entries.length
        ? { table, eq: Object.fromEntries(entries.map(([column, sources]) => [column, sources.flatMap(resolve)])) }
        : { table }
    }),
  }
}

export function clearTemplates() {
  templates.clear()
}

const TRUE = new Set(["true", "t", "yes", "y", "on"])
const FALSE = new Set(["false", "f", "no", "n", "off"])

function canonical(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.getTime()
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number" || typeof value === "bigint") return Number(value)
  const text = String(value).trim().toLowerCase()
  if (TRUE.has(text)) return "true"
  if (FALSE.has(text)) return "false"
  if (text !== "" && Number.isFinite(Number(text))) return Number(text)
  const time = Date.parse(text)
  return /^\d{4}-\d{2}-\d{2}/.test(text) && Number.isFinite(time) ? time : text
}

function sameValue(a: unknown, b: unknown) {
  const left = canonical(a)
  const right = canonical(b)
  return left === null || right === null || left === right
}

function rowMatches(eq: Record<string, unknown[]>, row: Row | undefined) {
  if (!row) return false
  return Object.entries(eq).every(([column, values]) => !(column in row) || values.some((value) => sameValue(row[column], value)))
}

export function changeAffects(read: TableRead, change: { source: string; kind: string; new?: Row; old?: Row }) {
  if (read.table !== change.source) return false
  if (change.kind === "truncate" || !read.eq) return true
  return rowMatches(read.eq, change.new) || rowMatches(read.eq, change.old)
}

class Buckets<K> {
  readonly #sets = new Map<string, Set<K>>()

  add(bucket: string, key: K) {
    let set = this.#sets.get(bucket)
    if (!set) this.#sets.set(bucket, (set = new Set()))
    set.add(key)
  }

  remove(bucket: string, key: K) {
    const set = this.#sets.get(bucket)
    if (set?.delete(key) && !set.size) this.#sets.delete(bucket)
  }

  get(bucket: string): Iterable<K> {
    return this.#sets.get(bucket) ?? []
  }
}

type IndexedChange = ChangeBatch["changes"][number]

export class ReadsIndex<K> implements ReadIndex<K> {
  readonly #entries = new Map<K, { reads: ReadSet | undefined; buckets: [Buckets<K>, string][] }>()
  readonly #any = new Set<K>()
  readonly #byTable = new Buckets<K>()
  readonly #wholeTable = new Buckets<K>()
  readonly #byColumn = new Buckets<K>()
  readonly #nulls = new Buckets<K>()
  readonly #byValue = new Buckets<K>()
  readonly #columns = new Map<string, Map<string, number>>()

  set(key: K, reads: unknown) {
    this.delete(key)
    const readSet = reads as ReadSet | undefined
    const buckets: [Buckets<K>, string][] = []
    const add = (target: Buckets<K>, bucket: string) => {
      target.add(bucket, key)
      buckets.push([target, bucket])
    }
    if (!readSet || readSet.any) this.#any.add(key)
    else
      for (const read of readSet.tables) {
        add(this.#byTable, read.table)
        const column = read.eq ? Object.keys(read.eq)[0] : undefined
        if (column === undefined) {
          add(this.#wholeTable, read.table)
          continue
        }
        const slot = `${read.table}\0${column}`
        add(this.#byColumn, slot)
        this.#countColumn(read.table, column, 1)
        for (const value of read.eq![column]!) {
          const normal = canonical(value)
          if (normal === null) add(this.#nulls, slot)
          else add(this.#byValue, `${slot}\0${typeof normal}:${normal}`)
        }
      }
    this.#entries.set(key, { reads: readSet, buckets })
  }

  delete(key: K) {
    const entry = this.#entries.get(key)
    if (!entry) return
    this.#entries.delete(key)
    this.#any.delete(key)
    for (const [target, bucket] of entry.buckets) target.remove(bucket, key)
    for (const read of entry.reads?.any ? [] : (entry.reads?.tables ?? [])) {
      const column = read.eq ? Object.keys(read.eq)[0] : undefined
      if (column !== undefined) this.#countColumn(read.table, column, -1)
    }
  }

  match(batch: ChangeBatch, visit: (key: K) => void) {
    if (batch.resync) {
      for (const key of this.#entries.keys()) visit(key)
      return
    }
    if (!batch.changes.length) return
    const seen = new Set<K>()
    const accept = (key: K) => {
      if (seen.has(key)) return
      seen.add(key)
      visit(key)
    }
    for (const key of this.#any) accept(key)
    for (const change of batch.changes) {
      if (change.kind === "truncate") {
        for (const key of this.#byTable.get(change.source)) accept(key)
        continue
      }
      for (const key of this.#wholeTable.get(change.source)) accept(key)
      for (const [column] of this.#columns.get(change.source) ?? []) {
        for (const key of this.#candidates(change, column)) if (!seen.has(key) && this.#affected(key, change)) accept(key)
      }
    }
  }

  *#candidates(change: IndexedChange, column: string): Iterable<K> {
    const slot = `${change.source}\0${column}`
    const rows = [change.new, change.old].filter((row): row is Row => row !== undefined)
    if (rows.some((row) => !(column in row) || canonical(row[column]) === null)) {
      yield* this.#byColumn.get(slot)
      return
    }
    yield* this.#nulls.get(slot)
    for (const row of rows) {
      const normal = canonical(row[column])!
      yield* this.#byValue.get(`${slot}\0${typeof normal}:${normal}`)
    }
  }

  #affected(key: K, change: IndexedChange) {
    return this.#entries.get(key)?.reads?.tables.some((read) => changeAffects(read, change)) ?? true
  }

  #countColumn(table: string, column: string, delta: number) {
    let columns = this.#columns.get(table)
    if (!columns) this.#columns.set(table, (columns = new Map()))
    const count = (columns.get(column) ?? 0) + delta
    if (count > 0) columns.set(column, count)
    else columns.delete(column)
    if (!columns.size) this.#columns.delete(table)
  }
}
