# Lyn

A lightweight React framework where server data is live. Components read data through queries. When the database changes, Lyn re-runs only the affected queries and streams the new results to the browser over SSE, where they arrive as ordinary hook values or props.

- **Standard React.** Hooks, Suspense and plain components. There is no server/client component split.
- **Your server is a Hono app.** Lyn mounts as a sub-app, and you build any API you want next to it.
- **Your database tools.** Use Drizzle, Kysely, Prisma or raw SQL for queries, and any migration tool. Lyn tracks queries at the driver level.
- **Pluggable databases.** The core is database-agnostic. Postgres is the first adapter.

See [AGENTS.md](AGENTS.md) for the principles and [docs/architecture.md](docs/architecture.md) for how it works.

## Quick start

Requires Node 25+, pnpm and Postgres 18 (Homebrew `postgresql@18` or Linux `/usr/lib/postgresql/18`).

```sh
pnpm install
pnpm db start                   # project-local Postgres on :54329 with wal_level=logical
pnpm --filter todos migrate     # plain SQL migrations (db/schema.sql)
pnpm dev                        # http://127.0.0.1:3000
pnpm db psql                    # write to the database directly; the UI updates live
```

To run a production build:

```sh
pnpm build && pnpm start
```

## What an app looks like

**The server** is a Hono app. Lyn mounts as a sub-app; everything else is yours.

```ts
// src/server.ts
const app = new Hono()
app.post("/login", ...)
app.get("/api/lists", ...)
app.route("/", lyn({ adapter: pg, app: App, auth: async (c) => ({ userId: await userIdOf(c) }) }))
export default app
```

**The database** uses any query layer that accepts a `pg.Pool`:

```ts
// src/db/index.ts
export const pg = postgres({ url: process.env.DATABASE_URL!, role: "lyn_app" })
export const db = drizzle({ client: pg.pool, schema })
```

**Server functions** live in `*.lyn.ts` modules. They never reach the browser bundle.

```ts
// src/todos.lyn.ts
export const list = query({
  args: z.object({ listId: z.uuid() }),
  handler: (_, { listId }) => db.select().from(todos).where(eq(todos.listId, listId)),
})

export const toggle = mutation({
  args: z.object({ id: z.uuid(), done: z.boolean() }),
  handler: async (_, { id, done }) => {
    await db.update(todos).set({ done }).where(eq(todos.id, id))
  },
})
```

**Components** read live data with hooks:

```tsx
const items = useQuery(todos.list, { listId })
const toggle = useMutation(todos.toggle, { optimistic: (store, args) => ... })
```

Or a component can load its data next to its definition. The loader runs on the server, and its imports are removed from the browser bundle.

```tsx
const ListHeader = live(
  (_, { listId }: { listId: string }) => ({
    list: db.query.lists.findFirst({ where: eq(lists.id, listId) }),
    open: db.$count(todos, and(eq(todos.listId, listId), eq(todos.done, false))),
  }),
  function ListHeader({ list, open }) {
    return <h2>{list?.name} · {open} open</h2>
  },
)
```

Beyond these, Lyn has:

- `effect()`, which runs when rows change
- `action()`, for side effects
- `ctx.depends(tag)` with `invalidate.tag(tag)`, for data outside the database
- `LynError`, for messages that are safe to show users

## Packages

| Package | Purpose |
| --- | --- |
| `@lyn/core` | Engine, server functions and the adapter contract. Runtime-agnostic. |
| `@lyn/react` | Browser client, hooks, `live()` and the SSR renderer |
| `@lyn/hono` | The Hono sub-app: SSE, mutations, actions and SSR |
| `@lyn/vite` | The Vite plugin and the `lyn dev`, `lyn build` and `lyn start` commands |
| `@lyn/postgres` | Postgres adapter: logical replication, SQL read tracking, row-level security sessions |

## Behavior worth knowing

- **Precise invalidation.** The Postgres adapter parses each SQL statement once and records tables plus `=`, `IN` and `= ANY` filters. Adding a todo to one list does not re-run queries for other lists.
  - It follows hidden reads: views, SQL functions and row-level security policies expand to the tables they read. In the example, changing a list's owner re-runs that list's todo queries.
  - Functions in other languages (such as plpgsql) and SQL it cannot parse fall back to re-running on every change: slower, but never stale.
  - Value comparisons are deliberately loose (`1.5` matches `"1.50"`), so a mismatch can only cause an extra re-run, never a missed update.
- **Row-level security.** Each query and mutation runs with `lyn.session` set and, if you give it, a database role. Postgres row-level security policies then filter live data per user.
- **Consistency.** Lyn re-runs queries in a snapshot that includes the commit. Optimistic updates are dropped only after the patches caused by that mutation have arrived.
- **Hot data reload.** In dev, editing a `*.lyn.ts` file re-runs the affected live queries in open browsers.
- **Production.** Browser code that imports server-only packages fails the build. In production, error details are masked unless the error was thrown as a `LynError`. Effects run on one elected instance.

## Status

This is early, but it is verified end to end with two users in a browser, against both the dev and production servers.

`pnpm fuzz` checks the live-data guarantees. It applies random writes against about 30 query shapes, then checks that every live result equals a fresh query, both after each step and at the moment each mutation settles. The write mix includes:

- single and multi-statement transactions
- primary-key changes
- truncates
- concurrent bursts
- row-level security sessions, including policies that read other tables
- nested savepoints inside mutations
- subscription churn

Current results:

- **Soak:** 4,000 steps with no failures.
- **Bug injection:** the fuzzer caught 12 of 13 deliberately injected bugs. The miss was a race inside Postgres's commit path that can't be triggered on demand.
- **Precision:** about half of re-runs change a result. The rest come from deliberately conservative cases, which is the baseline for future performance work.

Sizes:

- `@lyn/react` runtime: 7.1 KB gzipped (React is extra)
- example server bundle: 14 KB, because dependencies stay external

Next up:

- packaging for npm (`lyn` and `lynjs` are taken; `@lyn/*` is the working scope)
- streaming SSR
- routing
- more adapters
