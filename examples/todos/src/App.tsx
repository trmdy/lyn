import { Suspense, useState, useTransition, type FormEvent } from "react"
import { live, useAction, useLyn, useMutation, useQuery, uuid } from "@lyn/react"
import { and, eq } from "drizzle-orm"
import { db } from "./db"
import { lists as listsTable, todos as todosTable } from "./db/schema"
import * as activity from "./activity.lyn"
import * as lists from "./lists.lyn"
import * as todos from "./todos.lyn"
import * as users from "./users.lyn"

const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" })

function selectedFromUrl(url: string) {
  return new URL(url, "http://lyn").searchParams.get("list")
}

export default function App({ url }: { url: string }) {
  const me = useQuery(users.me)
  if (!me) return <SignIn />
  return <Workspace url={url} />
}

function useSignIn() {
  const client = useLyn()
  return async (userId: string | null) => {
    await fetch(userId ? "/login" : "/logout", { method: "POST", body: JSON.stringify({ userId }) })
    client.reconnect()
  }
}

function SignIn() {
  const everyone = useQuery(users.all)
  const signIn = useSignIn()
  return (
    <div className="sign-in">
      <h1>Lyn todos</h1>
      <p className="muted">Sign in as</p>
      {everyone.map((user) => (
        <button key={user.id} onClick={() => signIn(user.id)}>
          {user.name}
        </button>
      ))}
    </div>
  )
}

function Account() {
  const me = useQuery(users.me)
  const everyone = useQuery(users.all)
  const signIn = useSignIn()
  return (
    <div className="account">
      <select aria-label="Signed in as" value={me?.id} onChange={(event) => signIn(event.target.value)}>
        {everyone.map((user) => (
          <option key={user.id} value={user.id}>
            {user.name}
          </option>
        ))}
      </select>
      <button onClick={() => signIn(null)}>Sign out</button>
    </div>
  )
}

function Workspace({ url }: { url: string }) {
  const allLists = useQuery(lists.all)
  const [selected, setSelected] = useState(() => selectedFromUrl(url))
  const [, startTransition] = useTransition()
  const listId = allLists.some((list) => list.id === selected) ? selected : (allLists[0]?.id ?? null)

  const select = (id: string) => {
    history.replaceState(null, "", `?list=${id}`)
    startTransition(() => setSelected(id))
  }

  return (
    <div className="app">
      <aside>
        <h1>Lyn todos</h1>
        <Account />
        <Lists selected={listId} onSelect={select} />
        <Activity />
      </aside>
      <main>
        {listId ? (
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <ListHeader listId={listId} />
            <Todos listId={listId} />
          </Suspense>
        ) : (
          <p className="muted">Create a list to get started.</p>
        )}
      </main>
    </div>
  )
}

function Lists({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  const allLists = useQuery(lists.all)
  const create = useMutation(lists.create, {
    optimistic: (store, list) => {
      const current = store.get(lists.all)
      if (current) store.set(lists.all, {}, [...current, { ...list, open: 0 }])
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem("name") as HTMLInputElement
    if (!input.value.trim()) return
    const id = uuid()
    create({ id, name: input.value })
    input.value = ""
    onSelect(id)
  }

  return (
    <nav>
      <ul>
        {allLists.map((list) => (
          <li key={list.id}>
            <button className={list.id === selected ? "active" : ""} onClick={() => onSelect(list.id)}>
              <span>{list.name}</span>
              {list.open > 0 && <span className="badge">{list.open}</span>}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={submit}>
        <input name="name" placeholder="New list" autoComplete="off" />
      </form>
    </nav>
  )
}

const ListHeader = live(
  (_, { listId }: { listId: string }) => ({
    list: db.query.lists.findFirst({ where: eq(listsTable.id, listId) }),
    open: db.$count(todosTable, and(eq(todosTable.listId, listId), eq(todosTable.done, false))),
    total: db.$count(todosTable, eq(todosTable.listId, listId)),
  }),
  function ListHeader({ list, open, total }) {
    return (
      <header>
        <h2>{list?.name ?? "Deleted list"}</h2>
        <p className="muted">
          {open} open · {total - open} done
        </p>
      </header>
    )
  },
)

function Todos({ listId }: { listId: string }) {
  const items = useQuery(todos.list, { listId })
  const add = useMutation(todos.add, {
    optimistic: (store, todo) => {
      const current = store.get(todos.list, { listId: todo.listId })
      if (current) store.set(todos.list, { listId: todo.listId }, [...current, { ...todo, done: false, createdAt: new Date() }])
    },
  })
  const toggle = useMutation(todos.toggle, {
    optimistic: (store, { id, done }) => {
      const current = store.get(todos.list, { listId })
      if (current) store.set(todos.list, { listId }, current.map((todo) => (todo.id === id ? { ...todo, done } : todo)))
    },
  })
  const remove = useMutation(todos.remove, {
    optimistic: (store, { id }) => {
      const current = store.get(todos.list, { listId })
      if (current) store.set(todos.list, { listId }, current.filter((todo) => todo.id !== id))
    },
  })

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const input = event.currentTarget.elements.namedItem("text") as HTMLInputElement
    if (!input.value.trim()) return
    add({ id: uuid(), listId, text: input.value })
    input.value = ""
  }

  return (
    <section>
      <form onSubmit={submit}>
        <input name="text" placeholder="What needs doing?" autoComplete="off" autoFocus />
      </form>
      <ul className="todos">
        {items.map((todo) => (
          <li key={todo.id} className={todo.done ? "done" : ""}>
            <label>
              <input type="checkbox" checked={todo.done} onChange={() => toggle({ id: todo.id, done: !todo.done })} />
              <span>{todo.text}</span>
            </label>
            <button className="remove" aria-label={`Delete ${todo.text}`} onClick={() => remove({ id: todo.id })}>
              ×
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Activity() {
  const recent = useQuery(activity.recent)
  const pings = useQuery(activity.pingCount)
  const ping = useAction(activity.ping)

  return (
    <section className="activity">
      <h3>Activity</h3>
      {recent.length ? (
        <ul>
          {recent.map((entry) => (
            <li key={entry.id}>
              {entry.message}{" "}
              <time className="muted" dateTime={entry.createdAt.toISOString()} suppressHydrationWarning>
                {timeFormat.format(entry.createdAt)}
              </time>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Complete a todo to see it here.</p>
      )}
      <button className="ping" onClick={() => ping()}>
        Ping server · {pings}
      </button>
    </section>
  )
}
