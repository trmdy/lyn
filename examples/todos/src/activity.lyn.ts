import { action, query } from "@lyn/core"
import { desc } from "drizzle-orm"
import { db } from "./db"
import { activity } from "./db/schema"

let pings = 0

export const recent = query({
  handler: () => db.select().from(activity).orderBy(desc(activity.createdAt)).limit(6),
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
