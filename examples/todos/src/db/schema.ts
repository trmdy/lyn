import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
})

export const lists = pgTable("lists", {
  id: uuid().primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull(),
  name: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const todos = pgTable("todos", {
  id: uuid().primaryKey().defaultRandom(),
  listId: uuid("list_id").notNull(),
  text: text().notNull(),
  done: boolean().notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export const activity = pgTable("activity", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  message: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

export type Todo = typeof todos.$inferSelect
