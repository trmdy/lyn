#!/usr/bin/env node
import http from "node:http"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

type Engines = { invalidate(invalidation: { kind: "all" }): void; stop(): Promise<void> }
type GlobalWithEngines = typeof globalThis & { __lynEngines?: Map<string, Engines> }

const SERVER_ENTRY_ID = "virtual:lyn/server-entry"
const root = process.cwd()
const port = Number(process.env.PORT ?? 3000)
const host = process.env.HOST ?? "127.0.0.1"
const engines = () => [...((globalThis as GlobalWithEngines).__lynEngines?.values() ?? [])]

function stopOnSignal(close: () => Promise<unknown>) {
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      Promise.allSettled([close(), ...engines().map((engine) => engine.stop())]).finally(() => process.exit(0))
    })
}

async function dev() {
  const { createServer } = await import("vite")
  const { getRequestListener } = await import("@hono/node-server")
  const server = http.createServer()
  const vite = await createServer({ root, appType: "custom", server: { middlewareMode: true, hmr: { server } } })
  const loadApp = async () => (await vite.ssrLoadModule(SERVER_ENTRY_ID)).default as { fetch: (request: Request) => Response | Promise<Response> }

  const listener = getRequestListener(async (request) => {
    try {
      return await (await loadApp()).fetch(request)
    } catch (error) {
      if (error instanceof Error) vite.ssrFixStacktrace(error)
      console.error(error)
      return new Response(error instanceof Error ? (error.stack ?? error.message) : String(error), { status: 500 })
    }
  })
  server.on("request", (request, response) => vite.middlewares(request, response, () => listener(request, response)))

  vite.watcher.on("change", (file) => {
    if (!/\.lyn\.[cm]?[jt]sx?$/.test(file)) return
    setTimeout(async () => {
      await loadApp().catch(() => {})
      for (const engine of engines()) engine.invalidate({ kind: "all" })
    }, 50)
  })

  await loadApp()
  server.listen(port, host, () => console.log(`[lyn] dev server ready on http://${host}:${port}`))
  stopOnSignal(async () => {
    server.close()
    await vite.close()
  })
}

async function build() {
  const { build } = await import("vite")
  process.env.NODE_ENV = "production"
  await build({ root, build: { outDir: "dist/client", emptyOutDir: true } })
  await build({
    root,
    build: { ssr: true, outDir: "dist/server", emptyOutDir: true, rolldownOptions: { input: { entry: SERVER_ENTRY_ID } } },
  })
}

async function start() {
  process.env.NODE_ENV = "production"
  const { Hono } = await import("hono")
  const { serve } = await import("@hono/node-server")
  const { serveStatic } = await import("@hono/node-server/serve-static")
  const { default: app } = await import(pathToFileURL(resolve(root, "dist/server/entry.js")).href)
  const server = new Hono()
  server.use(
    "/assets/*",
    serveStatic({ root: "dist/client", onFound: (_path, c) => c.header("cache-control", "public, max-age=31536000, immutable") }),
  )
  server.get("/assets/*", (c) => c.notFound())
  const files = serveStatic({ root: "dist/client", index: "\0" })
  server.use("*", (c, next) => (c.req.path === "/index.html" ? next() : files(c, next)))
  server.route("/", app)
  const listening = serve({ fetch: server.fetch, port, hostname: host }, () =>
    console.log(`[lyn] production server ready on http://${host}:${port}`),
  )
  stopOnSignal(async () => listening.close())
}

const commands: Record<string, () => Promise<void>> = { dev, build, start }
const command = commands[process.argv[2] ?? ""]
if (!command) {
  console.error("usage: lyn <dev|build|start>")
  process.exit(1)
}
await command()
