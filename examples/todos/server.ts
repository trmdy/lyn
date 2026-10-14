import { createHmac, timingSafeEqual } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { ServerResponse } from "node:http"
import pg from "pg"
import { createLynServer, readBody } from "lyn/node"

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres@localhost:54329/lyn_todos"
const secret = process.env.SESSION_SECRET ?? "lyn-dev-secret"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const migrator = new pg.Client(databaseUrl)
await migrator.connect()
await migrator.query(await readFile(new URL("./db/schema.sql", import.meta.url), "utf8"))
await migrator.end()

const sign = (value: string) => `${value}.${createHmac("sha256", secret).update(value).digest("base64url")}`

function verify(signed: string) {
  const value = signed.slice(0, signed.lastIndexOf("."))
  const expected = Buffer.from(sign(value))
  const actual = Buffer.from(signed)
  return value && expected.length === actual.length && timingSafeEqual(expected, actual) ? value : null
}

function setSession(response: ServerResponse, cookie: string) {
  response.writeHead(204, { "set-cookie": `session=${cookie}; Path=/; HttpOnly; SameSite=Lax` })
  response.end()
}

await createLynServer({
  databaseUrl,
  port: Number(process.env.PORT ?? 3000),
  role: "lyn_app",
  auth: ({ cookies }) => {
    const userId = cookies.session ? verify(cookies.session) : null
    return userId ? { userId } : null
  },
  onRequest: async (request, response) => {
    if (request.method !== "POST") return false
    if (request.url === "/login") {
      const { userId } = JSON.parse(await readBody(request))
      if (typeof userId !== "string" || !UUID.test(userId)) {
        response.writeHead(400).end()
        return true
      }
      setSession(response, sign(userId))
      return true
    }
    if (request.url === "/logout") {
      setSession(response, "; Max-Age=0")
      return true
    }
    return false
  },
})
