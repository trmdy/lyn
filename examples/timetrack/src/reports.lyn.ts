import { query } from "@lyn/core"
import { z } from "zod"
import { pg } from "./db"
import { addDays, DAY_PATTERN, instant } from "./lib/time"
import { signedIn } from "./session"

const hours = (filter = "") =>
  `coalesce(sum(extract(epoch from e.ended_at - e.started_at))${filter ? ` filter (where ${filter})` : ""}, 0)::float / 3600`

export const summary = query({
  args: z.object({ from: z.string().regex(DAY_PATTERN), to: z.string().regex(DAY_PATTERN), userId: z.uuid().nullable() }),
  handler: async ({ session }, { from, to, userId }) => {
    signedIn(session)
    const start = instant(from, 0)
    const end = instant(addDays(to, 1), 0)
    const [projects, people, days] = await Promise.all([
      pg.pool.query(
        `select p.id, p.name, p.code, p.color, c.name as customer_name, p.billable,
                coalesce(p.hourly_rate, c.default_rate) as rate,
                ${hours()} as hours, ${hours("e.billable")} as billable_hours
         from time_entries e
         join projects p on p.id = e.project_id
         join customers c on c.id = p.customer_id
         where e.ended_at is not null and e.started_at >= $1 and e.started_at < $2 and ($3::uuid is null or e.user_id = $3)
         group by p.id, c.id
         order by c.name, p.name`,
        [start, end, userId],
      ),
      pg.pool.query(
        `select u.id, u.name, u.color, ${hours()} as hours, ${hours("e.billable")} as billable_hours
         from time_entries e join users u on u.id = e.user_id
         where e.ended_at is not null and e.started_at >= $1 and e.started_at < $2 and ($3::uuid is null or e.user_id = $3)
         group by u.id
         order by u.name`,
        [start, end, userId],
      ),
      pg.pool.query(
        `select to_char(e.started_at at time zone 'Europe/Oslo', 'YYYY-MM-DD') as day, ${hours()} as hours
         from time_entries e
         where e.ended_at is not null and e.started_at >= $1 and e.started_at < $2 and ($3::uuid is null or e.user_id = $3)
         group by 1
         order by 1`,
        [start, end, userId],
      ),
    ])
    const camel = <T,>(rows: Record<string, unknown>[]) =>
      rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_(\w)/g, (_, c) => c.toUpperCase()), value]))) as T[]
    return {
      projects: camel<{ id: string; name: string; code: string; color: string; customerName: string; billable: boolean; rate: number; hours: number; billableHours: number }>(projects.rows),
      people: camel<{ id: string; name: string; color: string; hours: number; billableHours: number }>(people.rows),
      days: camel<{ day: string; hours: number }>(days.rows),
    }
  },
})
