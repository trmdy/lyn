import { query } from "@lyn/core"
import { eq } from "drizzle-orm"
import { db } from "./db"
import { users } from "./db/schema"

export const all = query({
  handler: () => db.select().from(users).orderBy(users.name),
})

export const me = query({
  handler: async ({ session }) => {
    if (!session) return null
    const [user] = await db.select().from(users).where(eq(users.id, session.userId))
    return user ?? null
  },
})
