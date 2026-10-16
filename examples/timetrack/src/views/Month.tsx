import { useQuery } from "@lyn/react"
import type { CSSProperties } from "react"
import * as entries from "../entries.lyn"
import * as team from "../team.lyn"
import { Link, useRouter, type Route } from "../lib/router"
import { addDays, addMonths, daysInMonth, formatHours, formatMonth, monthOf, startOfMonth, startOfWeek, today, weekday } from "../lib/time"

export function MonthView({ route, me }: { route: Extract<Route, { name: "month" }>; me: { id: string } }) {
  const { navigate } = useRouter()
  const members = useQuery(team.members)
  const userId = route.user ?? me.id
  const totals = useQuery(entries.month, { userId, month: route.month })
  const byDay = new Map(totals.map((row) => [row.day, row]))
  const days = daysInMonth(route.month)
  const first = startOfWeek(startOfMonth(route.month))
  const cells = Array.from({ length: Math.ceil((weekday(days[0]!) + days.length) / 7) * 7 }, (_, index) => addDays(first, index))
  const total = totals.reduce((sum, row) => sum + row.hours, 0)
  const billable = totals.reduce((sum, row) => sum + row.billableHours, 0)
  const query = route.user ? `?user=${route.user}` : ""
  const max = Math.max(8, ...totals.map((row) => row.hours))

  return (
    <section>
      <header className="toolbar">
        <div className="toolbar-group">
          <Link className="button" to={`/month/${addMonths(route.month, -1)}${query}`}>
            ←
          </Link>
          <Link className="button" to={`/month/${monthOf(today())}${query}`}>
            This month
          </Link>
          <Link className="button" to={`/month/${addMonths(route.month, 1)}${query}`}>
            →
          </Link>
          <h2>{formatMonth(route.month)}</h2>
        </div>
        <div className="toolbar-group">
          <span className="total">
            {formatHours(total)} h <span className="muted">· {total ? Math.round((billable / total) * 100) : 0}% billable</span>
          </span>
          <select
            aria-label="Person"
            value={userId}
            onChange={(event) => navigate(`/month/${route.month}${event.target.value === me.id ? "" : `?user=${event.target.value}`}`)}
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </div>
      </header>
      <div className="month">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((name) => (
          <div key={name} className="month-weekday">
            {name}
          </div>
        ))}
        {cells.map((day) => {
          const row = byDay.get(day)
          const inMonth = monthOf(day) === route.month
          return (
            <Link
              key={day}
              to={`/week/${day}${query}`}
              className={`month-day ${inMonth ? "" : "outside"} ${day === today() ? "today" : ""}`}
              style={{ "--fill": row ? row.hours / max : 0 } as CSSProperties}
            >
              <span className="month-date">{Number(day.slice(8))}</span>
              {row && (
                <>
                  <strong>{formatHours(row.hours)}</strong>
                  <span className="muted small">{formatHours(row.billableHours)} billable</span>
                </>
              )}
            </Link>
          )
        })}
      </div>
    </section>
  )
}
