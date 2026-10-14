import { effect, mutation, query } from "lyn/server"
import { z } from "zod"
import type {} from "./schema"

export const list = query({
  args: z.object({ listId: z.uuid() }),
  handler: ({ db }, { listId }) => db.todos.where({ listId }).orderBy("createdAt").all(),
})

export const add = mutation({
  args: z.object({ id: z.uuid(), listId: z.uuid(), text: z.string().trim().min(1) }),
  handler: ({ db }, todo) => db.todos.insert(todo),
})

export const toggle = mutation({
  args: z.object({ id: z.uuid(), done: z.boolean() }),
  handler: ({ db }, { id, done }) => db.todos.where({ id }).update({ done }),
})

export const remove = mutation({
  args: z.object({ id: z.uuid() }),
  handler: ({ db }, { id }) => db.todos.where({ id }).delete(),
})

export const logCompleted = effect({
  table: "todos",
  on: ["update"],
  handler: async ({ db }, change) => {
    if (change.new?.done && change.old?.done === false) await db.activity.insert({ message: `Completed “${change.new.text}”` })
  },
})
