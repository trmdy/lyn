import { effect, mutation, query } from "@lyn/core"
import { eq } from "drizzle-orm"
import { z } from "zod"
import { db } from "./db"
import { activity, lists, todos } from "./db/schema"

export const list = query({
  args: z.object({ listId: z.uuid() }),
  handler: (_, { listId }) => db.select().from(todos).where(eq(todos.listId, listId)).orderBy(todos.createdAt),
})

export const add = mutation({
  args: z.object({ id: z.uuid(), listId: z.uuid(), text: z.string().trim().min(1) }),
  handler: async (_, todo) => {
    const [row] = await db.insert(todos).values(todo).returning()
    return row
  },
})

export const toggle = mutation({
  args: z.object({ id: z.uuid(), done: z.boolean() }),
  handler: async (_, { id, done }) => {
    await db.update(todos).set({ done }).where(eq(todos.id, id))
  },
})

export const remove = mutation({
  args: z.object({ id: z.uuid() }),
  handler: async (_, { id }) => {
    await db.delete(todos).where(eq(todos.id, id))
  },
})

export const logCompleted = effect({
  table: "todos",
  on: ["update"],
  handler: async (_, change) => {
    if (!change.new?.done || change.old?.done !== false) return
    const [list] = await db.select().from(lists).where(eq(lists.id, String(change.new.list_id)))
    if (list) await db.insert(activity).values({ userId: list.ownerId, message: `Completed “${change.new.text}”` })
  },
})
