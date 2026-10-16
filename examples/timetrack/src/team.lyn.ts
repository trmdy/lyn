import { query } from "@lyn/core"
import { asc, eq, isNull } from "drizzle-orm"
import { db } from "./db"
import { projects, timeEntries, users } from "./db/schema"
import { signedIn } from "./session"

export const me = query({
  handler: async ({ session }) => {
    if (!session) return null
    const [user] = await db.select().from(users).where(eq(users.id, session.userId))
    return user ?? null
  },
})

export const members = query({
  handler: () => db.select().from(users).orderBy(asc(users.name)),
})

export const workingNow = query({
  handler: ({ session }) => {
    signedIn(session)
    return db
      .select({
        id: timeEntries.id,
        description: timeEntries.description,
        startedAt: timeEntries.startedAt,
        userId: users.id,
        userName: users.name,
        userColor: users.color,
        projectName: projects.name,
        projectColor: projects.color,
      })
      .from(timeEntries)
      .innerJoin(users, eq(users.id, timeEntries.userId))
      .innerJoin(projects, eq(projects.id, timeEntries.projectId))
      .where(isNull(timeEntries.endedAt))
      .orderBy(asc(timeEntries.startedAt))
  },
})
