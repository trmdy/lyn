# Lyn

Lyn is a React framework where server data is live: components read data through queries, and when the database changes, affected queries re-run and stream to the browser over SSE.

## Principles

Every change must respect these. If a change pulls against one, raise it instead of quietly trading it away.

1. **Database-agnostic core.** `@lyn/core` knows nothing about Postgres. Adapters (`@lyn/postgres`, later SQLite, MySQL, MongoDB) own change detection, read tracking, matching and consistent reads. Core owns subscriptions, diffing, sessions and transport.
2. **No vendor lock-in for schema or queries.** Users bring their own query layer (Drizzle, Kysely, Prisma, raw SQL) and their own migrations. Lyn observes queries at the driver level; it never requires its own ORM or migration tool.
3. **Hono is the server.** Lyn mounts as a Hono sub-app. Users own the app and can build full APIs next to it with plain Hono.
4. **Super lightweight.** Few dependencies, small modules, no hidden magic. Prefer deleting code to adding options.
5. **Standard React.** Hooks, Suspense and plain components. No server/client component split.
6. **Arbitrary styling.** Never constrain CSS: plain CSS, CSS modules, Tailwind and CSS-in-JS must all work, including with SSR.
7. **SSR by default.** Every page renders on the server with data, then hydrates.
8. **Fast.** Measure before claiming. Keep hot paths allocation-light and avoid extra round trips.
9. **Tiny client bundle.** Server code never ships to the browser. Track the `@lyn/react` runtime size and keep it small.

## Layout

- `packages/core`: engine, function definitions, adapter contract, wire protocol
- `packages/react`: browser client, hooks, `live()`, SSR renderer
- `packages/hono`: Hono sub-app (SSE, mutations, actions, SSR)
- `packages/vite`: Vite plugin and `lyn` CLI (`dev`, `build`, `start`)
- `packages/postgres`: Postgres adapter (logical replication, SQL read tracking, RLS sessions)
- `examples/todos`: reference app (Drizzle queries, raw SQL migrations, Hono auth routes)
- `docs/architecture.md`: how the pieces fit

## Working here

- Node 25+ and pnpm. `pnpm db start` runs a project-local Postgres 18 on port 54329; `pnpm --filter todos migrate` applies the example schema.
- `pnpm dev` runs the example; `pnpm typecheck` checks every package.
- Verify behavior by running the example and driving it in a browser, including direct `psql` writes.
- Run `pnpm fuzz` after touching the engine or an adapter. It applies random writes against `lyn_fuzz` and compares every live query with a fresh query after each step, and at the moment each mutation settles. Failures print a seed to replay with `pnpm fuzz --seed=<n>`.
- No code comments; make code clear through naming and structure.
