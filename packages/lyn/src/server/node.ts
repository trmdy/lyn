import { createReadStream } from "node:fs"
import { readFile, stat } from "node:fs/promises"
import http from "node:http"
import { extname, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
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
  production?: boolean
  auth?: Auth
  role?: string
  onRequest?: (request: http.IncomingMessage, response: http.ServerResponse) => boolean | Promise<boolean>
}

type App = ComponentType<{ url: string }>

interface Frontend {
  serveAsset(request: http.IncomingMessage, response: http.ServerResponse, next: () => void): void
  loadApp(): Promise<App>
  template(url: string): Promise<string>
  describeError(error: unknown): string
  close(): Promise<void>
}

const SERVER_ENTRY = "virtual:lyn/server-entry"

async function developmentFrontend(root: string, server: http.Server): Promise<Frontend> {
  const { createServer } = await import("vite")
  const vite = await createServer({ root, appType: "custom", server: { middlewareMode: true, hmr: { server } } })
  return {
    serveAsset: (request, response, next) => vite.middlewares(request, response, next),
    loadApp: async () => (await vite.ssrLoadModule(SERVER_ENTRY)).App,
    template: async (url) => vite.transformIndexHtml(url, await readFile(join(root, "index.html"), "utf8")),
    describeError: (error) => {
      if (error instanceof Error) vite.ssrFixStacktrace(error)
      return error instanceof Error ? (error.stack ?? error.message) : String(error)
    },
    close: () => vite.close(),
  }
}

async function productionFrontend(root: string): Promise<Frontend> {
  const clientDir = join(root, "dist/client")
  const entry = join(root, "dist/server/entry.js")
  const [template, { App }] = await Promise.all([
    readFile(join(clientDir, "index.html"), "utf8"),
    import(pathToFileURL(entry).href),
  ]).catch((error) => {
    throw new Error(`lyn: no production build in ${join(root, "dist")}; run \`lyn build\` first`, { cause: error })
  })
  return {
    serveAsset: (request, response, next) => serveStatic(clientDir, request, response).then((served) => served || next()),
    loadApp: async () => App,
    template: async () => template,
    describeError: () => "Internal Server Error",
    close: async () => {},
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
}

async function serveStatic(dir: string, request: http.IncomingMessage, response: http.ServerResponse) {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  let pathname: string
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://lyn").pathname)
  } catch {
    return false
  }
  const file = resolve(dir, "." + pathname)
  if (!file.startsWith(dir + sep) || file === join(dir, "index.html")) return false
  const info = await stat(file).catch(() => null)
  if (!info?.isFile()) return false
  response.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "content-length": info.size,
    "cache-control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
  })
  if (request.method === "HEAD") response.end()
  else createReadStream(file).pipe(response)
  return true
}

export async function createLynServer(options: LynServerOptions) {
  const root = options.root ?? process.cwd()
  const production = options.production ?? process.env.NODE_ENV === "production"
  const engine = new Engine(options.databaseUrl, { role: options.role })
  await engine.start()

  const server = http.createServer()
  const frontend = production ? await productionFrontend(root) : await developmentFrontend(root, server)
  await frontend.loadApp()

  const renderHtml = async (request: http.IncomingMessage, response: http.ServerResponse) => {
    try {
      const url = request.url ?? "/"
      const [App, template, session] = await Promise.all([
        frontend.loadApp(),
        frontend.template(url),
        sessionFor(options.auth, request),
      ])
      const page = await renderPage(App, { url, runQuery: (name, args) => engine.runQuery(name, args, session) })
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      response.end(template.replace("<!--lyn-app-->", page.body).replace("</head>", `${page.head}</head>`))
    } catch (error) {
      console.error(error)
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" })
      response.end(frontend.describeError(error))
    }
  }

  server.on("request", async (request, response) => {
    try {
      if (await handleLynRequest(engine, request, response, options.auth)) return
      if (await options.onRequest?.(request, response)) return
      frontend.serveAsset(request, response, () => renderHtml(request, response))
    } catch (error) {
      console.error(error)
      if (!response.headersSent) response.writeHead(500)
      response.end()
    }
  })

  const port = options.port ?? 3000
  const host = options.host ?? "127.0.0.1"
  await new Promise<void>((done) => server.listen(port, host, done))
  console.log(`[lyn] ${production ? "production" : "development"} server ready on http://${host}:${port}`)

  const close = async () => {
    server.close()
    server.closeAllConnections()
    await frontend.close()
    await engine.close()
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => close().finally(() => process.exit(0)))
  return { server, engine, close }
}
