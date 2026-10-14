import { readFile } from "node:fs/promises"
import http from "node:http"
import { join } from "node:path"
import type { ComponentType } from "react"
import { decode, encode } from "../shared/wire.ts"
import { Engine } from "./engine.ts"
import type { Session } from "./index.ts"
import { renderPage } from "./ssr.ts"

export { Engine } from "./engine.ts"
export { renderPage } from "./ssr.ts"

export interface AuthRequest {
  headers: http.IncomingHttpHeaders
  cookies: Record<string, string>
}

export type Auth = (request: AuthRequest) => Session | null | Promise<Session | null>

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=")
    if (separator < 0) continue
    const name = part.slice(0, separator).trim()
    const value = part.slice(separator + 1).trim()
    try {
      cookies[name] = decodeURIComponent(value)
    } catch {
      cookies[name] = value
    }
  }
  return cookies
}

const sessionFor = async (auth: Auth | undefined, request: http.IncomingMessage) =>
  auth ? ((await auth({ headers: request.headers, cookies: parseCookies(request.headers.cookie) })) ?? null) : null

export async function readBody(request: http.IncomingMessage) {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8")
}

function reply(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/x-devalue" })
  response.end(encode(body))
}

export async function handleLynRequest(
  engine: Engine,
  request: http.IncomingMessage,
  response: http.ServerResponse,
  auth?: Auth,
) {
  const url = new URL(request.url ?? "/", "http://lyn")
  if (!url.pathname.startsWith("/_lyn/")) return false
  const route = url.pathname.slice("/_lyn/".length)

  if (route === "events" && request.method === "GET") {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    })
    const session = await sessionFor(auth, request)
    const connection = engine.connect((frame) => response.write(`event: frame\ndata: ${frame}\n\n`), session)
    response.write(`retry: 1000\nevent: hello\ndata: ${JSON.stringify({ clientId: connection.id })}\n\n`)
    const ping = setInterval(() => response.write(": ping\n\n"), 15_000)
    request.on("close", () => {
      clearInterval(ping)
      engine.disconnect(connection.id)
    })
    return true
  }

  if (request.method !== "POST") {
    reply(response, 405, { error: "Method not allowed" })
    return true
  }

  try {
    const body = decode(await readBody(request))
    const session = await sessionFor(auth, request)
    if (route === "subscribe") {
      await engine.subscribe(body, session)
      reply(response, 200, { ok: true })
    } else if (route === "mutate") {
      reply(response, 200, await engine.mutate(body, session))
    } else if (route === "action") {
      reply(response, 200, { result: await engine.act(body.name, body.args, session) })
    } else {
      reply(response, 404, { error: `Unknown route ${route}` })
    }
  } catch (error) {
    reply(response, 400, { error: error instanceof Error ? error.message : String(error) })
  }
  return true
}

export interface LynServerOptions {
  databaseUrl: string
  port?: number
  host?: string
  root?: string
  app?: string
  auth?: Auth
  role?: string
  onRequest?: (request: http.IncomingMessage, response: http.ServerResponse) => boolean | Promise<boolean>
}

export async function createLynServer(options: LynServerOptions) {
  const root = options.root ?? process.cwd()
  const appPath = options.app ?? "/src/App.tsx"
  const engine = new Engine(options.databaseUrl, { role: options.role })
  await engine.start()

  const server = http.createServer()
  const { createServer } = await import("vite")
  const vite = await createServer({
    root,
    appType: "custom",
    server: { middlewareMode: true, hmr: { server } },
  })

  const loadApp = async () => {
    await vite.ssrLoadModule("virtual:lyn/modules")
    return (await vite.ssrLoadModule(appPath)).default as ComponentType<{ url: string }>
  }
  await loadApp()

  server.on("request", async (request, response) => {
    try {
      if (await handleLynRequest(engine, request, response, options.auth)) return
      if (await options.onRequest?.(request, response)) return
      vite.middlewares(request, response, async () => {
        try {
          const url = request.url ?? "/"
          const App = await loadApp()
          const template = await vite.transformIndexHtml(url, await readFile(join(root, "index.html"), "utf8"))
          const session = await sessionFor(options.auth, request)
          const page = await renderPage(App, { url, runQuery: (name, args) => engine.runQuery(name, args, session) })
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
          response.end(template.replace("<!--lyn-app-->", page.body).replace("</head>", `${page.head}</head>`))
        } catch (error) {
          vite.ssrFixStacktrace(error as Error)
          console.error(error)
          response.writeHead(500, { "content-type": "text/plain" })
          response.end(error instanceof Error ? error.stack : String(error))
        }
      })
    } catch (error) {
      console.error(error)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })

  const port = options.port ?? 3000
  await new Promise<void>((resolve) => server.listen(port, options.host ?? "127.0.0.1", resolve))
  console.log(`[lyn] ready on http://${options.host ?? "127.0.0.1"}:${port}`)

  const close = async () => {
    server.close()
    await vite.close()
    await engine.close()
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => close().finally(() => process.exit(0)))
  return { server, engine, vite, close }
}
