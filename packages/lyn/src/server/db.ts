export interface Tables {}

export type Dep = { table: string; eq?: Record<string, unknown> } | { tag: string }

export interface Executor {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>
}

export interface DbSession {
  exec: Executor
  deps: Dep[]
  readOnly: boolean
}

type Direction = "asc" | "desc"

export interface ReadQuery<T> {
  where(eq: Partial<T>): ReadQuery<T>
  orderBy(column: keyof T & string, direction?: Direction): ReadQuery<T>
  limit(count: number): ReadQuery<T>
  all(): Promise<T[]>
  first(): Promise<T | null>
  count(): Promise<number>
}

export interface WriteQuery<T> extends ReadQuery<T> {
  where(eq: Partial<T>): WriteQuery<T>
  orderBy(column: keyof T & string, direction?: Direction): WriteQuery<T>
  limit(count: number): WriteQuery<T>
  insert(row: Partial<T>): Promise<T>
  update(patch: Partial<T>): Promise<T[]>
  delete(): Promise<number>
}

export type SqlTag = <R = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<R[]>

export type ReadDb = { [K in keyof Tables]: ReadQuery<Tables[K]> } & { sql: SqlTag }
export type WriteDb = { [K in keyof Tables]: WriteQuery<Tables[K]> } & { sql: SqlTag }

export const toSnake = (name: string) => name.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase())
export const toCamel = (name: string) => name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
const ident = (name: string) => '"' + toSnake(name).replace(/"/g, '""') + '"'

export const rowToCamel = (row: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(row).map(([key, value]) => [toCamel(key), value]))

const snakeKeys = (record: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [toSnake(key), value]))

interface QueryState {
  table: string
  eq: Record<string, unknown>
  order: { column: string; direction: Direction }[]
  limit?: number
}

class TableQuery {
  #session: DbSession
  #state: QueryState

  constructor(session: DbSession, state: QueryState) {
    this.#session = session
    this.#state = state
  }

  where(eq: Record<string, unknown>) {
    return new TableQuery(this.#session, { ...this.#state, eq: { ...this.#state.eq, ...eq } })
  }

  orderBy(column: string, direction: Direction = "asc") {
    return new TableQuery(this.#session, { ...this.#state, order: [...this.#state.order, { column, direction }] })
  }

  limit(count: number) {
    return new TableQuery(this.#session, { ...this.#state, limit: count })
  }

  async all() {
    const params: unknown[] = []
    const { table, order, limit } = this.#state
    const orderSql = order.length ? ` order by ${order.map((o) => `${ident(o.column)} ${o.direction}`).join(", ")}` : ""
    const limitSql = limit === undefined ? "" : ` limit ${Number(limit)}`
    return this.#read(`select * from ${ident(table)}${this.#whereSql(params)}${orderSql}${limitSql}`, params)
  }

  async first() {
    const [row] = await this.limit(1).all()
    return row ?? null
  }

  async count() {
    const params: unknown[] = []
    const [row] = await this.#read(`select count(*)::int as n from ${ident(this.#state.table)}${this.#whereSql(params)}`, params)
    return row!.n as number
  }

  async insert(row: Record<string, unknown>) {
    this.#assertWritable()
    const entries = Object.entries(row).filter(([, value]) => value !== undefined)
    const columns = entries.map(([key]) => ident(key)).join(", ")
    const placeholders = entries.map((_, i) => `$${i + 1}`).join(", ")
    const sql = entries.length
      ? `insert into ${ident(this.#state.table)} (${columns}) values (${placeholders}) returning *`
      : `insert into ${ident(this.#state.table)} default values returning *`
    const { rows } = await this.#session.exec.query(sql, entries.map(([, value]) => value))
    return rowToCamel(rows[0])
  }

  async update(patch: Record<string, unknown>) {
    this.#assertWritable()
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (!entries.length) return []
    const params = entries.map(([, value]) => value)
    const sets = entries.map(([key], i) => `${ident(key)} = $${i + 1}`).join(", ")
    const { rows } = await this.#session.exec.query(
      `update ${ident(this.#state.table)} set ${sets}${this.#whereSql(params)} returning *`,
      params,
    )
    return rows.map(rowToCamel)
  }

  async delete() {
    this.#assertWritable()
    const params: unknown[] = []
    const { rowCount } = await this.#session.exec.query(`delete from ${ident(this.#state.table)}${this.#whereSql(params)}`, params)
    return rowCount ?? 0
  }

  #whereSql(params: unknown[]) {
    const clauses = Object.entries(this.#state.eq).map(([key, value]) => {
      if (value === null) return `${ident(key)} is null`
      params.push(value)
      return `${ident(key)} = $${params.length}`
    })
    return clauses.length ? ` where ${clauses.join(" and ")}` : ""
  }

  async #read(sql: string, params: unknown[]) {
    const { table, eq } = this.#state
    this.#session.deps.push(Object.keys(eq).length ? { table: toSnake(table), eq: snakeKeys(eq) } : { table: toSnake(table) })
    const { rows } = await this.#session.exec.query(sql, params)
    return rows.map(rowToCamel)
  }

  #assertWritable() {
    if (this.#session.readOnly) throw new Error(`lyn: queries are read-only; write to "${this.#state.table}" from a mutation`)
  }
}

const TABLE_REFERENCE = /\b(?:from|join)\s+(?:only\s+)?(?:"?[\w$]+"?\s*\.\s*)?"?([a-z_][\w$]*)"?/gi

export function tablesIn(sql: string): string[] {
  return [...new Set([...sql.matchAll(TABLE_REFERENCE)].map((match) => match[1]!.toLowerCase()))]
}

export function createDb(session: DbSession): WriteDb {
  const sql: SqlTag = async (strings, ...values) => {
    const text = strings.reduce((acc, part, i) => acc + `$${i}` + part)
    for (const table of tablesIn(text)) session.deps.push({ table })
    const { rows } = await session.exec.query(text, values)
    return rows.map(rowToCamel) as any
  }
  return new Proxy({} as WriteDb, {
    get(_, property) {
      if (property === "sql") return sql
      if (typeof property !== "string") return undefined
      return new TableQuery(session, { table: property, eq: {}, order: [] })
    },
  })
}
