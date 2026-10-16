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
GET /anything-else ──────▶ SSR: stream shell, query data, Suspense boundaries
```

SSR uses React's `renderToReadableStream`. Hono sends the template head and shell as soon as the shell is ready, then forwards completed Suspense boundaries and finally the template suffix. Queries outside Suspense still hold up the shell. Once streaming starts, later failures cannot change the HTTP status; shell failures return 500.

`engine.render(session)` lazily opens one adapter snapshot on the first query and shares its concurrent reader across the request, including queries discovered by later Suspense boundaries. The renderer closes it when React finishes rendering, on shell failure, or on cancellation; it does not retain connections while completed HTML drains to a slow browser. Closing rejects new reads and waits for already-started handlers before releasing the snapshot. The adapter contract is unchanged; it cannot cancel a running handler.

Each query queues a devalue payload before waking React. The renderer emits queued payloads before the next complete top-level HTML segment, buffering partial tags and raw-text elements so scripts never split React markup. The browser drains this queue during hydration and accepts later entries directly into its cache. Hydration reads the original SSR snapshot even if SSE has already delivered a newer value. Query errors carry `publicMessage` text and recover through client error boundaries. React's streamed boundary reveal requires JavaScript; without it, a pending boundary keeps its fallback.

## The adapter contract

`@lyn/core` defines `Adapter`. An adapter is responsible for everything database-specific:

| Method | Responsibility |
| --- | --- |
| `start(onChanges)` / `stop()` | Open the change feed; deliver committed changes in commit order as `ChangeBatch`es. |
| `snapshot(after, run)` | Give `run` a reader that executes handlers against one consistent state that includes every batch in `after`. The reader must be safe to call concurrently. |
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
- **Consistency.** Re-runs happen in a repeatable-read snapshot verified to include the batch's transactions. Concurrent reads share that snapshot: extra connections import it with `pg_export_snapshot()` / `SET TRANSACTION SNAPSHOT` (up to `readers`, default 4). Mutations report their transaction id and emit a transactional logical message so even row-less commits reach the change stream.

## Scheduling live queries

Each live query (a "group": one query, arguments and session) runs independently, so a slow query never delays others.

- **Invalidation.** When a change batch arrives, every idle group whose read set it affects is queued. A group that is already running queues every batch, because its read set may change; when the run finishes, the queued batches are checked against the new read set and the group re-runs once if any match.
- **Waves.** Groups queued in the same tick run together in one snapshot (concurrently, through the adapter's reader) and each delivers its result as soon as it finishes. Updates are coalesced per connection into one SSE frame per tick.
- **Settling.** A mutation settles once every query its connection subscribes to that the commit affected has a result that includes it. Until then, that connection's updates for those queries are held back, then released together with `settled` in one frame, so optimistic updates never double up or flicker. Other connections and other queries are not held.
- **Failure.** A failed snapshot re-queues its groups with backoff; a failed query matches every change until it recovers.

`pnpm bench` measures this: fan-out to many queries, a fast query next to a slow one, and subscribing while slow queries run.

## Client

`@lyn/react` keeps one SSE connection per tab, a cache of query entries, and an optimistic layer replayed over server values. All messages from one batch apply in one render.

SSR payloads carry a SHA-256 fingerprint of each value’s devalue encoding. The browser includes it in the initial subscription. Core evaluates new groups to establish their current value and read dependencies, or uses an existing group’s value. If its fingerprint matches, an `unchanged` message supplies only the subscription id and group version. The client retains its hydrated value and snapshot identity without notifying listeners. A stale fingerprint receives full `data`; subsequent patches still require the exact `from` version. Fingerprints are cleared when data or patches replace the value, so a later subscription cannot claim an obsolete fingerprint.

## Build and runtime

- `lyn dev` runs Vite in middleware mode and loads `virtual:lyn/server-entry` per request, so the Hono app and server modules hot-reload. Editing a `*.lyn.ts` file re-runs open live queries.
- `virtual:lyn/server-entry` imports every `*.lyn.ts` module (registering them), registers the HTML template with `@lyn/hono`, and re-exports the app's default Hono app.
- `lyn build` produces `dist/client` and `dist/server/entry.js`. The server bundle contains only app code; every package import stays external and is resolved by Node at runtime.
- `lyn start` serves `dist/client` (hashed assets cached immutably) in front of the app with `@hono/node-server`. Because the entry exports a plain Hono app, other runtimes can serve it directly.
