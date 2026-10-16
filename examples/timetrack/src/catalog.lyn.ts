import { mutation, query } from "@lyn/core"
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { db, pg } from "./db"
import { customers, projectMembers, projects, tasks, timeEntries, users } from "./db/schema"
import { admin, signedIn } from "./session"

const color = z.string().regex(/^#[0-9a-f]{6}$/i)

export const overview = query({
  handler: async ({ session }) => {
    signedIn(session)
    const [customerRows, projectRows, taskRows, memberRows, usage] = await Promise.all([
      db.select().from(customers).orderBy(asc(customers.name)),
      db.select().from(projects).orderBy(asc(projects.name)),
      db.select().from(tasks).orderBy(asc(tasks.name)),
      db.select().from(projectMembers),
      pg.sql<{ projectId: string; hours: number; billableHours: number }>`
        select project_id as "projectId",
               sum(extract(epoch from ended_at - started_at))::float / 3600 as hours,
               coalesce(sum(extract(epoch from ended_at - started_at)) filter (where billable), 0)::float / 3600 as "billableHours"
        from time_entries
        where ended_at is not null
        group by project_id
      `,
    ])
    const used = new Map(usage.map((row) => [row.projectId, row]))
    return customerRows.map((customer) => ({
      ...customer,
      projects: projectRows
        .filter((project) => project.customerId === customer.id)
        .map((project) => ({
          ...project,
          rate: project.hourlyRate ?? customer.defaultRate,
          tasks: taskRows.filter((task) => task.projectId === project.id),
          memberIds: memberRows.filter((member) => member.projectId === project.id).map((member) => member.userId),
          usedHours: used.get(project.id)?.hours ?? 0,
          billableHours: used.get(project.id)?.billableHours ?? 0,
        })),
    }))
  },
})

export const pickable = query({
  handler: async ({ session }) => {
    const user = signedIn(session)
    const visible =
      user.role === "admin"
        ? undefined
        : inArray(
            projects.id,
            db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, user.userId)),
          )
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        code: projects.code,
        color: projects.color,
        billable: projects.billable,
        customerName: customers.name,
      })
      .from(projects)
      .innerJoin(customers, eq(customers.id, projects.customerId))
      .where(and(eq(projects.archived, false), visible))
      .orderBy(asc(customers.name), asc(projects.name))
    const taskRows = rows.length ? await db.select().from(tasks).where(inArray(tasks.projectId, rows.map((row) => row.id))) : []
    return rows.map((row) => ({ ...row, tasks: taskRows.filter((task) => task.projectId === row.id) }))
  },
})

export const createCustomer = mutation({
  args: z.object({ id: z.uuid(), name: z.string().trim().min(1), defaultRate: z.number().int().min(0) }),
  handler: async ({ session }, customer) => {
    admin(session)
    await db.insert(customers).values({ ...customer, currency: "NOK", archived: false })
  },
})

export const updateCustomer = mutation({
  args: z.object({
    id: z.uuid(),
    name: z.string().trim().min(1).optional(),
    defaultRate: z.number().int().min(0).optional(),
    archived: z.boolean().optional(),
  }),
  handler: async ({ session }, { id, ...changes }) => {
    admin(session)
    await db.update(customers).set(changes).where(eq(customers.id, id))
  },
})

export const createProject = mutation({
  args: z.object({
    id: z.uuid(),
    customerId: z.uuid(),
    name: z.string().trim().min(1),
    code: z.string().trim().min(1).max(12),
    color,
    billable: z.boolean(),
    hourlyRate: z.number().int().min(0).nullable(),
    budgetHours: z.number().int().min(1).nullable(),
  }),
  handler: async ({ session }, project) => {
    const user = admin(session)
    await db.insert(projects).values({ ...project, code: project.code.toUpperCase(), archived: false })
    await db.insert(projectMembers).values({ projectId: project.id, userId: user.userId })
    await db.insert(tasks).values(
      (project.billable ? ["Design", "Development", "Meetings", "QA"] : ["Planning", "Support"]).map((name) => ({
        projectId: project.id,
        name,
        billable: project.billable,
      })),
    )
  },
})

export const updateProject = mutation({
  args: z.object({
    id: z.uuid(),
    name: z.string().trim().min(1).optional(),
    color: color.optional(),
    billable: z.boolean().optional(),
    hourlyRate: z.number().int().min(0).nullable().optional(),
    budgetHours: z.number().int().min(1).nullable().optional(),
    archived: z.boolean().optional(),
  }),
  handler: async ({ session }, { id, ...changes }) => {
    admin(session)
    await db.update(projects).set(changes).where(eq(projects.id, id))
  },
})

export const toggleMember = mutation({
  args: z.object({ projectId: z.uuid(), userId: z.uuid(), member: z.boolean() }),
  handler: async ({ session }, { projectId, userId, member }) => {
    admin(session)
    if (member) await db.insert(projectMembers).values({ projectId, userId }).onConflictDoNothing()
    else await db.delete(projectMembers).where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)))
  },
})

export const addTask = mutation({
  args: z.object({ id: z.uuid(), projectId: z.uuid(), name: z.string().trim().min(1), billable: z.boolean() }),
  handler: async ({ session }, task) => {
    admin(session)
    await db.insert(tasks).values(task)
  },
})

export const removeTask = mutation({
  args: z.object({ id: z.uuid() }),
  handler: async ({ session }, { id }) => {
    admin(session)
    await db.delete(tasks).where(eq(tasks.id, id))
  },
})

export const people = query({
  handler: ({ session }) => {
    signedIn(session)
    return db.select({ id: users.id, name: users.name, color: users.color }).from(users).orderBy(asc(users.name))
  },
})

export const detail = query({
  args: z.object({ projectId: z.uuid() }),
  handler: async ({ session }, { projectId }) => {
    signedIn(session)
    const [project, people, weeks, recent] = await Promise.all([
      db
        .select({
          id: projects.id,
          name: projects.name,
          code: projects.code,
          color: projects.color,
          billable: projects.billable,
          budgetHours: projects.budgetHours,
          hourlyRate: projects.hourlyRate,
          customerName: customers.name,
          defaultRate: customers.defaultRate,
        })
        .from(projects)
        .innerJoin(customers, eq(customers.id, projects.customerId))
        .where(eq(projects.id, projectId))
        .then(([row]) => row ?? null),
      pg.sql<{ id: string; name: string; color: string; hours: number }>`
        select u.id, u.name, u.color, sum(extract(epoch from e.ended_at - e.started_at))::float / 3600 as hours
        from time_entries e join users u on u.id = e.user_id
        where e.project_id = ${projectId} and e.ended_at is not null
        group by u.id
        order by hours desc
      `,
      pg.sql<{ week: string; hours: number }>`
        select to_char(date_trunc('week', e.started_at at time zone 'Europe/Oslo'), 'YYYY-MM-DD') as week,
               sum(extract(epoch from e.ended_at - e.started_at))::float / 3600 as hours
        from time_entries e
        where e.project_id = ${projectId} and e.ended_at is not null
        group by 1
        order by 1
      `,
      db
        .select({
          id: timeEntries.id,
          description: timeEntries.description,
          startedAt: timeEntries.startedAt,
          endedAt: timeEntries.endedAt,
          userName: users.name,
          userColor: users.color,
          taskName: tasks.name,
        })
        .from(timeEntries)
        .innerJoin(users, eq(users.id, timeEntries.userId))
        .leftJoin(tasks, eq(tasks.id, timeEntries.taskId))
        .where(eq(timeEntries.projectId, projectId))
        .orderBy(desc(timeEntries.startedAt))
        .limit(8),
    ])
    return { project, people, weeks, recent }
  },
})
