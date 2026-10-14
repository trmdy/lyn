import { action, query } from "lyn/server"
import type {} from "./schema"

let pings = 0

export const recent = query({
  handler: ({ db }) => db.activity.orderBy("createdAt", "desc").limit(6).all(),
})

export const pingCount = query({
  handler: ({ depends }) => {
    depends("pings")
    return pings
  },
})

export const ping = action({
  handler: ({ invalidate }) => {
    pings++
    invalidate.tag("pings")
    return pings
  },
})
