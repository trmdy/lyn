import { serve } from "@hono/node-server"
import { __register, mutation, query, type QueryRef } from "@lyn/core"
import { lyn, setTemplate } from "@lyn/hono"
import { postgres } from "@lyn/postgres"
import { useQuery } from "@lyn/react"
import { Hono } from "hono"
import pg from "pg"
import { createElement as h } from "react"

interface Item {
  id: number
  label: string
  val: number
}

const url = process.env.DATABASE_URL!
const rowsSql = "select id, label, val from items where grp = $1 order by id"
const adapter = postgres({ url, max: Number(process.env.POOL ?? 20), readers: Number(process.env.READERS ?? 4) })

__register("vs", {
  items: query({ handler: async (_, args: { grp: number }) => (await adapter.pool.query(rowsSql, [args.grp])).rows as Item[] }),
  rename: mutation({
    handler: async (_, args: { id: number; label: string }) => {
      await adapter.pool.query("update items set label = $2 where id = $1", [args.id, args.label])
    },
  }),
})

const items: QueryRef<{ grp: number }, Item[]> = { name: "vs:items" }

function App({ url }: { url: string }) {
  const grp = Number(new URL(url, "http://local").searchParams.get("grp") ?? 1)
  const rows = useQuery(items, { grp })
  return h(
    "main",
    null,
    h("h1", null, `Group ${grp}`),
    h("ul", null, rows.map((row) => h("li", { key: row.id, "data-id": row.id }, h("span", null, row.label), " ", h("b", null, row.val)))),
  )
}

setTemplate(
  async () =>
    '<!doctype html><html><head><meta charset="utf-8"><title>Items</title></head><body><div id="root"><!--lyn-app--></div><script type="module" src="/assets/app.js"></script></body></html>',
)

const plain = new pg.Pool({ connectionString: url, max: Number(process.env.POOL ?? 20) })
const app = new Hono()
app.get("/api/items", async (c) => c.json((await plain.query(rowsSql, [Number(c.req.query("grp"))])).rows))
app.route("/", lyn({ adapter, app: App, maxPendingFrames: 256 }))

const port = Number(process.env.PORT ?? 4601)
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => console.error(`[lyn] listening on 127.0.0.1:${port}`))
