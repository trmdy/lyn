import { readFile } from "node:fs/promises"
import pg from "pg"
import { createLynServer } from "lyn/node"

const databaseUrl = process.env.DATABASE_URL ?? "postgres://postgres@localhost:54329/lyn_todos"

const migrator = new pg.Client(databaseUrl)
await migrator.connect()
await migrator.query(await readFile(new URL("./db/schema.sql", import.meta.url), "utf8"))
await migrator.end()

await createLynServer({ databaseUrl, port: Number(process.env.PORT ?? 3000) })
