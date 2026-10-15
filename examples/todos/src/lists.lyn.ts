import { LynError, mutation, query } from "@lyn/core"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { db, pg } from "./db"
import { lists } from "./db/schema"

export const all = query({
  handler: () => pg.sql<{ id: string; name: string; open: number }>`
    select l.id, l.name, count(t.id) filter (where not t.done)::int as open
    from lists l
    left join todos t on t.list_id = l.id
    group by l.id
    order by l.created_at
  `,
})

export const create = mutation({
  args: z.object({ id: z.uuid(), name: z.string().trim().min(1) }),
  handler: async ({ session }, list) => {
    if (!session) throw new LynError("Sign in to create lists")
    const [row] = await db.insert(lists).values({ ...list, ownerId: session.userId }).returning()
    return row
  },
})

export const remove = mutation({
  args: z.object({ id: z.uuid() }),
  handler: async (_, { id }) => {
    await db.delete(lists).where(eq(lists.id, id))
  },
})
