# Architecture

## Request flow

```
Browser                    Hono app (yours)                    Adapter (e.g. Postgres)
───────                    ────────────────                    ───────────────────────
GET /_lyn/events  ───────▶ @lyn/hono: SSE stream ◀──── frames ── @lyn/core Engine
POST /_lyn/subscribe ────▶ engine.subscribe  ──── read() ───────▶ run handler, record reads
POST /_lyn/mutate ───────▶ engine.mutate     ──── write() ──────▶ transaction, write token
                                                 ◀── change batches ── change feed (WAL)
                           engine: affects()? ─── snapshot(after) ──▶ consistent re-run
GET /anything-else ──────▶ SSR: render App with data, embed state
```

## The adapter contract

`@lyn/core` defines `Adapter`. An adapter is responsible for everything database-specific:

| Method | Responsibility |
| --- | --- |
| `start(onChanges)` / `stop()` | Open the change feed; deliver committed changes in commit order as `ChangeBatch`es. |
| `snapshot(after, run)` | Give `run` a reader that executes handlers against one consistent state that includes every batch in `after`. |
| `write(context, run)` | Run a mutation in a transaction; return a write token that will appear in the batch containing its commit. |
| `affects(reads, batch)` | Decide whether a batch can change the result of a query that recorded `reads`. Must never return a false negative. |
| `isLeader()` | Whether this instance should run effects (elected across instances). |

`reads` is opaque to core. A SQL adapter records tables and equality predicates; a document adapter could record collections and filters. Core only stores it and asks `affects`.

A `context` carries the session (or marks a system call for effects). Adapters apply it however their database supports, for example Postgres sets `lyn.session` and a role so row-level security applies.

## Postgres adapter

- **Driver-level tracking.** `postgres({ url })` exposes `pool`, a `pg.Pool` subclass. Inside a Lyn handler, AsyncLocalStorage routes every query on that pool to the handler's transaction and records it. Any query layer that accepts a `pg.Pool` works unchanged.
- **Read sets from SQL.** Each statement is parsed with libpg_query (cached per SQL string). Every relation becomes a table dependency; top-level `col = value`, `col IN (...)` and `col = ANY($n)` conjuncts narrow it. A catalog of views, SQL function bodies and row-level security policies expands hidden reads into extra table dependencies. Opaque functions (plpgsql, C) and unknown relations make the read set match every change: correct, never precise-but-wrong. The catalog refreshes every 30 seconds, when an unknown table appears in the change stream, or on `adapter.refreshCatalog()`.
- **Isolation.** A pool only serves the adapter it belongs to; querying another Lyn database inside a handler throws. Engines are shared per URL, role and publication.
- **Settling.** Every mutation that writes emits a transactional logical message, so its commit always appears in the change stream, even when savepoint rollbacks leave no row changes.
- **Change feed.** Logical replication (`pgoutput`) over a temporary slot that disappears with the process.
- **Consistency.** Re-runs happen in a repeatable-read snapshot verified to include the batch's transactions. Mutations report their transaction id; core sends `settled` after the patches it caused.

## Client

`@lyn/react` keeps one SSE connection per tab, a cache of query entries, and an optimistic layer replayed over server values. All messages from one batch apply in one render.

## Build and runtime

- `lyn dev` runs Vite in middleware mode and loads `virtual:lyn/server-entry` per request, so the Hono app and server modules hot-reload. Editing a `*.lyn.ts` file re-runs open live queries.
- `virtual:lyn/server-entry` imports every `*.lyn.ts` module (registering them), registers the HTML template with `@lyn/hono`, and re-exports the app's default Hono app.
- `lyn build` produces `dist/client` and `dist/server/entry.js`. The server bundle contains only app code; every package import stays external and is resolved by Node at runtime.
- `lyn start` serves `dist/client` (hashed assets cached immutably) in front of the app with `@hono/node-server`. Because the entry exports a plain Hono app, other runtimes can serve it directly.
