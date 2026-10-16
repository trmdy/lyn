import { lyn } from "@lyn/hono"
import { and, asc, eq, gte, lt } from "drizzle-orm"
import { Hono, type Context } from "hono"
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie"
import App from "./App"
import { db, pg } from "./db"
import { customers, projects, tasks, timeEntries, users } from "./db/schema"
import { DAY_PATTERN, addDays, instant, startOfWeek, today } from "./lib/time"
import "./session"

const secret = process.env.SESSION_SECRET ?? "lyn-dev-secret"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function currentUser(c: Context) {
  const userId = await getSignedCookie(c, secret, "session")
  if (!userId) return null
  const [user] = await db.select().from(users).where(eq(users.id, userId))
  return user ?? null
}

const csvCell = (value: unknown) => {
  const text = value instanceof Date ? value.toISOString() : String(value ?? "")
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

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

app.get("/api/export.csv", async (c) => {
  const user = await currentUser(c)
  if (!user) return c.text("Unauthorized", 401)
  const from = DAY_PATTERN.test(c.req.query("from") ?? "") ? c.req.query("from")! : startOfWeek(today())
  const to = DAY_PATTERN.test(c.req.query("to") ?? "") ? c.req.query("to")! : addDays(from, 6)
  const rows = await db
    .select({
      person: users.name,
      customer: customers.name,
      project: projects.name,
      task: tasks.name,
      description: timeEntries.description,
      startedAt: timeEntries.startedAt,
      endedAt: timeEntries.endedAt,
      billable: timeEntries.billable,
    })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .innerJoin(projects, eq(projects.id, timeEntries.projectId))
    .innerJoin(customers, eq(customers.id, projects.customerId))
    .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
    .where(
      and(
        gte(timeEntries.startedAt, instant(from, 0)),
        lt(timeEntries.startedAt, instant(addDays(to, 1), 0)),
        user.role === "admin" ? undefined : eq(timeEntries.userId, user.id),
      ),
    )
    .orderBy(asc(timeEntries.startedAt))
  const header = ["person", "customer", "project", "task", "description", "started_at", "ended_at", "hours", "billable"]
  const lines = rows.map((row) =>
    [
      row.person,
      row.customer,
      row.project,
      row.task,
      row.description,
      row.startedAt,
      row.endedAt,
      row.endedAt ? ((row.endedAt.getTime() - row.startedAt.getTime()) / 3_600_000).toFixed(2) : "",
      row.billable,
    ]
      .map(csvCell)
      .join(","),
  )
  c.header("content-type", "text/csv; charset=utf-8")
  c.header("content-disposition", `attachment; filename="time-${from}-to-${to}.csv"`)
  return c.body([header.join(","), ...lines].join("\n"))
})

app.route(
  "/",
  lyn({
    adapter: pg,
    app: App,
    auth: async (c) => {
      const user = await currentUser(c)
      return user ? { userId: user.id, role: user.role } : null
    },
  }),
)

export default app
