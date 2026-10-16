import { effect, LynError, mutation, query } from "@lyn/core"
import { and, asc, desc, eq, gt, isNull, lt, or } from "drizzle-orm"
import { z } from "zod"
import { db, pg } from "./db"
import { alerts, customers, projectMembers, projects, tasks, timeEntries } from "./db/schema"
import { addDays, DAY_PATTERN, instant, MONTH_PATTERN, startOfMonth, addMonths } from "./lib/time"
import { signedIn } from "./session"

const entryColumns = {
  id: timeEntries.id,
  userId: timeEntries.userId,
  projectId: timeEntries.projectId,
  taskId: timeEntries.taskId,
  description: timeEntries.description,
  startedAt: timeEntries.startedAt,
  endedAt: timeEntries.endedAt,
  billable: timeEntries.billable,
  projectName: projects.name,
  projectColor: projects.color,
  customerName: customers.name,
  taskName: tasks.name,
}

export const week = query({
  args: z.object({ userId: z.uuid(), start: z.string().regex(DAY_PATTERN) }),
  handler: ({ session }, { userId, start }) => {
    signedIn(session)
    return db
      .select(entryColumns)
      .from(timeEntries)
      .innerJoin(projects, eq(projects.id, timeEntries.projectId))
      .innerJoin(customers, eq(customers.id, projects.customerId))
      .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .where(
        and(
          eq(timeEntries.userId, userId),
          lt(timeEntries.startedAt, instant(addDays(start, 7), 0)),
          or(isNull(timeEntries.endedAt), gt(timeEntries.endedAt, instant(start, 0))),
        ),
      )
      .orderBy(asc(timeEntries.startedAt))
  },
})

export const month = query({
  args: z.object({ userId: z.uuid(), month: z.string().regex(MONTH_PATTERN) }),
  handler: ({ session }, args) => {
    signedIn(session)
    return pg.sql<{ day: string; hours: number; billableHours: number }>`
      select to_char(started_at at time zone 'Europe/Oslo', 'YYYY-MM-DD') as day,
             sum(extract(epoch from ended_at - started_at))::float / 3600 as hours,
             coalesce(sum(extract(epoch from ended_at - started_at)) filter (where billable), 0)::float / 3600 as "billableHours"
      from time_entries
      where user_id = ${args.userId}
        and ended_at is not null
        and started_at >= ${instant(startOfMonth(args.month), 0)}
        and started_at < ${instant(startOfMonth(addMonths(args.month, 1)), 0)}
      group by 1
      order by 1
    `
  },
})

export const running = query({
  handler: async ({ session }) => {
    const user = signedIn(session)
    const [entry] = await db
      .select(entryColumns)
      .from(timeEntries)
      .innerJoin(projects, eq(projects.id, timeEntries.projectId))
      .innerJoin(customers, eq(customers.id, projects.customerId))
      .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
      .where(and(eq(timeEntries.userId, user.userId), isNull(timeEntries.endedAt)))
    return entry ?? null
  },
})

async function billableFor(userId: string, role: string, projectId: string, taskId: string | null) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId))
  if (!project || project.archived) throw new LynError("That project is not available")
  if (role !== "admin") {
    const [membership] = await db
      .select()
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
    if (!membership) throw new LynError(`You are not on ${project.name}`)
  }
  if (!taskId) return project.billable
  const [task] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.projectId, projectId)))
  if (!task) throw new LynError("That task belongs to another project")
  return project.billable && task.billable
}

const work = { projectId: z.uuid(), taskId: z.uuid().nullable(), description: z.string().trim().max(200) }

export const startTimer = mutation({
  args: z.object({ id: z.uuid(), ...work }),
  handler: async ({ session }, entry) => {
    const user = signedIn(session)
    const billable = await billableFor(user.userId, user.role, entry.projectId, entry.taskId)
    await pg.sql`update time_entries set ended_at = greatest(now(), started_at + interval '1 minute')
                 where user_id = ${user.userId} and ended_at is null`
    await pg.sql`insert into time_entries (id, user_id, project_id, task_id, description, started_at, billable)
                 values (${entry.id}, ${user.userId}, ${entry.projectId}, ${entry.taskId}, ${entry.description}, now(), ${billable})`
  },
})

export const stopTimer = mutation({
  handler: async ({ session }) => {
    const user = signedIn(session)
    await pg.sql`update time_entries set ended_at = greatest(now(), started_at + interval '1 minute')
                 where user_id = ${user.userId} and ended_at is null`
  },
})

const span = z
  .object({ startedAt: z.date(), endedAt: z.date() })
  .refine((value) => value.endedAt > value.startedAt, "An entry must end after it starts")

export const createEntry = mutation({
  args: z.object({ id: z.uuid(), ...work }).and(span),
  handler: async ({ session }, entry) => {
    const user = signedIn(session)
    const billable = await billableFor(user.userId, user.role, entry.projectId, entry.taskId)
    await db.insert(timeEntries).values({ ...entry, userId: user.userId, billable })
  },
})

export const updateEntry = mutation({
  args: z.object({
    id: z.uuid(),
    projectId: z.uuid().optional(),
    taskId: z.uuid().nullable().optional(),
    description: work.description.optional(),
    startedAt: z.date().optional(),
    endedAt: z.date().optional(),
  }),
  handler: async ({ session }, { id, ...changes }) => {
    const user = signedIn(session)
    const [entry] = await db.select().from(timeEntries).where(and(eq(timeEntries.id, id), eq(timeEntries.userId, user.userId)))
    if (!entry) throw new LynError("You can only change your own entries")
    const next = { ...entry, ...changes }
    if (next.endedAt && next.endedAt <= next.startedAt) throw new LynError("An entry must end after it starts")
    const billable =
      changes.projectId !== undefined || changes.taskId !== undefined
        ? await billableFor(user.userId, user.role, next.projectId, next.taskId)
        : entry.billable
    await db.update(timeEntries).set({ ...changes, billable }).where(eq(timeEntries.id, id))
  },
})

export const deleteEntry = mutation({
  args: z.object({ id: z.uuid() }),
  handler: async ({ session }, { id }) => {
    const user = signedIn(session)
    await db.delete(timeEntries).where(and(eq(timeEntries.id, id), eq(timeEntries.userId, user.userId)))
  },
})

export const budgetWatch = effect({
  table: "time_entries",
  on: ["insert", "update"],
  handler: async (_, change) => {
    const projectId = change.new?.project_id
    if (!change.new?.ended_at || typeof projectId !== "string") return
    const [usage] = await pg.sql<{ budget: number | null; hours: number }>`
      select p.budget_hours as budget,
             coalesce(sum(extract(epoch from e.ended_at - e.started_at)), 0)::float / 3600 as hours
      from projects p left join time_entries e on e.project_id = p.id and e.ended_at is not null
      where p.id = ${projectId}
      group by p.id
    `
    if (!usage?.budget) return
    for (const threshold of [80, 100])
      if (usage.hours >= (usage.budget * threshold) / 100)
        await db.insert(alerts).values({ projectId, threshold }).onConflictDoNothing()
  },
})

export const recentAlerts = query({
  handler: ({ session }) => {
    signedIn(session)
    return db
      .select({
        id: alerts.id,
        threshold: alerts.threshold,
        createdAt: alerts.createdAt,
        projectId: projects.id,
        projectName: projects.name,
        projectColor: projects.color,
      })
      .from(alerts)
      .innerJoin(projects, eq(projects.id, alerts.projectId))
      .orderBy(desc(alerts.createdAt))
      .limit(5)
  },
})
