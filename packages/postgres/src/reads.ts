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

export interface Catalog {
  tables: Set<string>
  functions: Set<string>
}

type Node = Record<string, any>

const tableName = (schema: string | undefined, name: string) => (schema && schema !== "public" ? `${schema}.${name}` : name)

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

  const scoped = new Set<Node>()
  walk(tree, (key, value) => {
    if (key !== "SelectStmt") return
    const relations = fromRelations(value.fromClause).filter((relation) => !cteNames.has(relation.relname))
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
    for (const relation of relations)
      template.reads.push({ table: tableName(relation.schemaname, relation.relname), eq: eqByRelation.get(relation) ?? {} })
  })

  walk(tree, (key, value) => {
    if (key === "RangeVar" && !scoped.has(value) && !cteNames.has(value.relname))
      template.reads.push({ table: tableName(value.schemaname, value.relname), eq: {} })
    if (key === "FuncCall") {
      const name = (value.funcname as Node[]).map((part) => part.String?.sval).join(".")
      if (catalog.functions.has(name) || catalog.functions.has(name.split(".").at(-1)!)) template.any = true
    }
  })

  if (template.reads.some((read) => !catalog.tables.has(read.table))) template.any = true
  return template
}

const templates = new Map<string, Template>()

export function readsOf(sql: string, params: unknown[], catalog: Catalog): ReadSet {
  let template = templates.get(sql)
  if (!template) {
    template = analyze(sql, catalog)
    if (!template.any) templates.set(sql, template)
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

function sameValue(a: unknown, b: unknown) {
  if (a === b) return true
  if (a instanceof Date || b instanceof Date) return new Date(a as any).getTime() === new Date(b as any).getTime()
  return a != null && b != null && String(a) === String(b)
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
