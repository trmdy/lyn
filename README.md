# Lyn.js

A React framework where server data is live. Components declare what they read; when Postgres changes, the affected queries re-run and the new data streams to the browser over SSE as ordinary prop and hook updates. Lyn has no server or client components: every component works the same way.

## Quick start

Requires Node 25+, pnpm, and Postgres 18 (Homebrew `postgresql@18` or Linux `/usr/lib/postgresql/18`).

```sh
pnpm install
pnpm db start        # project-local Postgres on :54329 with wal_level=logical
pnpm dev             # http://127.0.0.1:3000 (set PORT to change)
pnpm db psql         # poke the database; the UI updates live
```

For production:

```sh
pnpm --filter todos build   # dist/client (browser) + dist/server/entry.js (SSR + server modules)
pnpm --filter todos start   # NODE_ENV=production; serves dist/, no Vite at runtime
```

## The API

Server code lives in `*.lyn.ts` files. The Vite plugin replaces them with tiny references in the browser bundle.

```ts
// src/todos.lyn.ts
export const list = query({
  args: z.object({ listId: z.uuid() }),
  handler: ({ db }, { listId }) => db.todos.where({ listId }).orderBy("createdAt").all(),
})

export const add = mutation({
  args: z.object({ id: z.uuid(), listId: z.uuid(), text: z.string() }),
  handler: ({ db }, todo) => db.todos.insert(todo),
})

export const logCompleted = effect({
  table: "todos",
  on: ["update"],
  handler: ({ db }, { new: row, old }) => row.done && !old?.done && db.activity.insert({ message: `Completed ${row.text}` }),
})
```

Read the data with a hook:

```tsx
const items = useQuery(todos.list, { listId })
const add = useMutation(todos.add, {
  optimistic: (store, todo) => {
    const current = store.get(todos.list, { listId })
    if (current) store.set(todos.list, { listId }, [...current, { ...todo, done: false, createdAt: new Date() }])
  },
})
```

Or put the loader next to the component, so the data arrives as props:

```tsx
const ListHeader = live(
  ({ db }, { listId }: { listId: string }) => ({
    list: db.lists.where({ id: listId }).first(),
    open: db.todos.where({ listId, done: false }).count(),
  }),
  function ListHeader({ list, open }) {
    return <h2>{list?.name} · {open} open</h2>
  },
)
```

For data that doesn't live in Postgres, invalidate manually: call `ctx.depends("tag")` in a query and `invalidate.tag("tag")` anywhere on the server. `invalidate(query, args)`, `invalidate.table("todos")` and `invalidate.all()` also exist.

Declare table types once with module augmentation (`declare module "lyn/server" { interface Tables { todos: Todo } }`). Columns are camelCase in JavaScript and snake_case in SQL.

## Auth

Pass an `auth` hook that turns a request into a session. Every query, mutation and action then runs as that user, with the session available as `ctx.session`.

```ts
await createLynServer({
  databaseUrl,
  role: "lyn_app",
  auth: ({ cookies }) => (verify(cookies.session) ? { userId } : null),
  onRequest: (request, response) => handleLoginRoutes(request, response),
})
```

Inside each transaction, Lyn sets `lyn.session` to the session as JSON and, if `role` is given, switches to that database role. That means Postgres row-level security works on live queries too:

```sql
create function current_user_id() returns uuid language sql stable
as $$ select (nullif(current_setting('lyn.session', true), '')::jsonb ->> 'userId')::uuid $$;

create policy owner on lists using (owner_id = current_user_id()) with check (owner_id = current_user_id());
```

Subscriptions are shared only between connections with the same session. A change to another user's rows can trigger a re-run, but row-level security filters it out and nothing is sent. Effects run as the system, with no role and no session, because they react to the database rather than to a user.

When the session changes (sign in, sign out, switching user), call `useLyn().reconnect()`. The event stream reconnects with the new cookie and every subscription refreshes in place. The example signs sessions with HMAC cookies; see `examples/todos/server.ts`.

## Production

`lyn build` runs two Vite builds:

- `dist/client` holds the browser bundle. `*.lyn.ts` modules are replaced with name references and `live()` loaders with ids, so SQL, validators and handlers never ship to the browser.
- `dist/server/entry.js` holds the app and every server module. It imports `lyn` at runtime instead of bundling it, so the renderer and the app share one React context and one registry.

`createLynServer` switches to production when `NODE_ENV=production`. It serves `dist/client`, with immutable caching for hashed `/assets/*`, renders pages from the server bundle and hides error details from responses.

Browser code that imports `lyn/server`, `lyn/node` or `pg` fails the build with a message pointing at the file. The app entry defaults to `/src/App.tsx`; change it with `lyn({ app })` in `vite.config.ts`.

You can run several server instances against one database. Each instance has its own temporary replication slot and serves its own clients. Effects run on exactly one instance, elected with a Postgres advisory lock. If that instance dies, another takes over within about 5 seconds.

## How it works

1. **Change stream.** On startup the server creates a publication and a temporary logical replication slot (`pgoutput`). The slot disappears when the server stops, so a crashed server can't fill the disk with old WAL.
2. **Read sets.** Every query records what it read. The query builder records the table plus its equality filters (`todos where list_id = X`). Raw `db.sql` records each table it reads.
3. **Matching.** When a change is committed, Lyn compares the changed rows (old and new values) with each subscription's read set. With `REPLICA IDENTITY FULL`, moving a todo from list A to list B re-runs both lists' queries and nothing else. Without it, matching falls back to a coarser check that is still correct.
4. **Re-run and diff.** Identical subscriptions (same query and arguments) share one query run. Lyn re-runs the affected queries together in one repeatable-read snapshot, after confirming the snapshot contains the commit. It sends keyed row patches when results are arrays of `{ id }` rows, and full values otherwise.
5. **One ordered stream.** Each browser tab has one SSE connection. All updates caused by one batch of commits arrive in a single frame, so React applies them together.
6. **Optimistic updates without flicker.** A mutation records its transaction id. The `settled` message for that mutation is sent after the patches its commit caused. Only then does the client drop its optimistic version.
7. **SSR.** The first request renders the whole tree on the server and embeds the data in the page. The client hydrates from that data and then subscribes.

## Status: spike

These work and have been verified end to end:

- live queries, `live()` components and SSR/hydration
- per-user sessions with row-level security, including switching users without a reload
- production build and server, the browser-import guard, and effects running once across instances with failover
- optimistic mutations, effects, actions and tag invalidation
- precise invalidation, and changes made directly in `psql`

Not built yet:

- publishing `lyn` to npm (the package ships TypeScript source, which Node 23+ runs directly)
- a durable effect queue (an effect is lost if the leader dies between the commit and running the effect)
- streaming SSR (pages wait for all data before sending)
- incremental view maintenance instead of re-running queries
- non-equality filters in the query builder
- resuming a dropped SSE stream (reconnecting currently re-subscribes everything)
- HMR for the `lyn` package itself (restart the server after changing it)

The arguments to `live()` loaders are the component's serializable props, and they are not validated. Treat them as untrusted input.
