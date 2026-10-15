import { lyn } from "@lyn/hono"
import { eq } from "drizzle-orm"
import { Hono, type Context } from "hono"
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie"
import App from "./App"
import { db, pg } from "./db"
import { lists } from "./db/schema"
import "./session"

const secret = process.env.SESSION_SECRET ?? "lyn-dev-secret"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const userIdOf = async (c: Context) => (await getSignedCookie(c, secret, "session")) || null

const app = new Hono()

app.post("/login", async (c) => {
  const { userId } = await c.req.json<{ userId?: string }>()
  if (!userId || !UUID.test(userId)) return c.body(null, 400)
  await setSignedCookie(c, "session", userId, secret, { path: "/", httpOnly: true, sameSite: "Lax" })
  return c.body(null, 204)
})

app.post("/logout", (c) => {
  deleteCookie(c, "session", { path: "/" })
  return c.body(null, 204)
})

app.get("/api/lists", async (c) => {
  const userId = await userIdOf(c)
  if (!userId) return c.json({ error: "Unauthorized" }, 401)
  return c.json(await db.select().from(lists).where(eq(lists.ownerId, userId)))
})

app.route(
  "/",
  lyn({
    adapter: pg,
    app: App,
    auth: async (c) => {
      const userId = await userIdOf(c)
      return userId ? { userId } : null
    },
  }),
)

export default app
