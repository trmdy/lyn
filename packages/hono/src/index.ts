import { Engine, publicMessage, type Adapter, type Session } from "@lyn/core"
import { decode, encode } from "@lyn/core/wire"
import { renderPage } from "@lyn/react/server"
import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import type { ComponentType } from "react"

export interface LynOptions {
  adapter: Adapter
  app: ComponentType<{ url: string }>
  auth?: (c: Context) => Session | null | undefined | Promise<Session | null | undefined>
  maxPendingFrames?: number
}

type Template = (url: string) => Promise<string>

let template: Template = async () => {
  throw new Error("lyn: no HTML template registered; run through the lyn CLI or call setTemplate()")
}

export function setTemplate(next: Template) {
  template = next
}

const reply = (c: Context, status: number, body: unknown) =>
  c.body(encode(body), status as 200, { "content-type": "application/x-devalue" })

export function lyn(options: LynOptions) {
  const engine = Engine.for(options.adapter)
  const sessionOf = async (c: Context) => (options.auth ? ((await options.auth(c)) ?? null) : null)
  const maxPending = options.maxPendingFrames ?? 256
  const app = new Hono()

  app.use("/_lyn/*", async (c, next) => {
    await engine.ready
    const origin = c.req.header("origin")
    if (c.req.method !== "GET" && origin && new URL(origin).host !== c.req.header("host")) return c.text("Cross-origin request blocked", 403)
    return next()
  })

  app.get("/_lyn/events", async (c) => {
    const session = await sessionOf(c)
    return streamSSE(c, async (stream) => {
      let pending = 0
      let open = true
      const close = () => {
        if (!open) return
        open = false
        engine.disconnect(connection.id)
        stream.abort()
      }
      const connection = engine.connect((frame) => {
        if (!open) return
        if (pending >= maxPending) return close()
        pending++
        stream.writeSSE({ event: "frame", data: frame }).then(() => pending--, close)
      }, session)
      stream.onAbort(close)
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ clientId: connection.id }), retry: 1000 })
      while (open) {
        await stream.sleep(15_000)
        if (open) await stream.write(": ping\n\n").catch(close)
      }
    })
  })

  app.post("/_lyn/:route", async (c) => {
    try {
      const body = decode(await c.req.text())
      const session = await sessionOf(c)
      switch (c.req.param("route")) {
        case "subscribe":
          await engine.subscribe(body, session)
          return reply(c, 200, { ok: true })
        case "mutate":
          return reply(c, 200, await engine.mutate(body, session))
        case "action":
          return reply(c, 200, { result: await engine.act(body.name, body.args, session) })
        default:
          return reply(c, 404, { error: "Unknown route" })
      }
    } catch (error) {
      return reply(c, 400, { error: publicMessage(error) })
    }
  })

  app.get("*", async (c) => {
    await engine.ready
    const url = new URL(c.req.url)
    const path = url.pathname + url.search
    const session = await sessionOf(c)
    const [page, html] = await Promise.all([
      renderPage(options.app, { url: path, runQuery: (name, args) => engine.runQuery(name, args, session) }),
      template(path),
    ])
    return c.html(html.replace("<!--lyn-app-->", page.body).replace("</head>", `${page.head}</head>`))
  })

  return app
}
