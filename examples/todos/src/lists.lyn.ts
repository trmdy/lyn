import { mutation, query } from "lyn/server"
import { z } from "zod"
import type {} from "./schema"

export const all = query({
  handler: ({ db }) => db.sql<{ id: string; name: string; open: number }>`
    select l.id, l.name, count(t.id) filter (where not t.done)::int as open
    from lists l
    left join todos t on t.list_id = l.id
    group by l.id
    order by l.created_at
  `,
})

export const create = mutation({
  args: z.object({ id: z.uuid(), name: z.string().trim().min(1) }),
  handler: ({ db, session }, list) => {
    if (!session) throw new Error("Sign in to create lists")
    return db.lists.insert({ ...list, ownerId: session.userId })
  },
})

export const remove = mutation({
  args: z.object({ id: z.uuid() }),
  handler: ({ db }, { id }) => db.lists.where({ id }).delete(),
})
