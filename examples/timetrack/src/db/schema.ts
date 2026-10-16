import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core"

const timestamps = (name: string) => timestamp(name, { withTimezone: true })

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  role: text().$type<"admin" | "member">().notNull(),
  color: text().notNull(),
})

export const customers = pgTable("customers", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  defaultRate: integer("default_rate").notNull(),
  currency: text().notNull(),
  archived: boolean().notNull(),
  createdAt: timestamps("created_at").notNull().defaultNow(),
})

export const projects = pgTable("projects", {
  id: uuid().primaryKey().defaultRandom(),
  customerId: uuid("customer_id").notNull(),
  name: text().notNull(),
  code: text().notNull(),
  color: text().notNull(),
  billable: boolean().notNull(),
  hourlyRate: integer("hourly_rate"),
  budgetHours: integer("budget_hours"),
  archived: boolean().notNull(),
  createdAt: timestamps("created_at").notNull().defaultNow(),
})

export const tasks = pgTable("tasks", {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  name: text().notNull(),
  billable: boolean().notNull(),
})

export const projectMembers = pgTable(
  "project_members",
  { projectId: uuid("project_id").notNull(), userId: uuid("user_id").notNull() },
  (table) => [primaryKey({ columns: [table.projectId, table.userId] })],
)

export const timeEntries = pgTable("time_entries", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull(),
  projectId: uuid("project_id").notNull(),
  taskId: uuid("task_id"),
  description: text().notNull(),
  startedAt: timestamps("started_at").notNull(),
  endedAt: timestamps("ended_at"),
  billable: boolean().notNull(),
  createdAt: timestamps("created_at").notNull().defaultNow(),
})

export const alerts = pgTable("alerts", {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid("project_id").notNull(),
  threshold: integer().notNull(),
  createdAt: timestamps("created_at").notNull().defaultNow(),
})
