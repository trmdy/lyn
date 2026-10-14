import { query } from "lyn/server"
import type {} from "./schema"

export const all = query({
  handler: ({ db }) => db.users.orderBy("name").all(),
})

export const me = query({
  handler: ({ db, session }) => (session ? db.users.where({ id: session.userId }).first() : null),
})
