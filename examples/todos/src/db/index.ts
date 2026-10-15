import { postgres } from "@lyn/postgres"
import { drizzle } from "drizzle-orm/node-postgres"
import * as schema from "./schema"

export const pg = postgres({
  url: process.env.DATABASE_URL ?? "postgres://postgres@localhost:54329/lyn_todos",
  role: "lyn_app",
})

export const db = drizzle({ client: pg.pool, schema })
