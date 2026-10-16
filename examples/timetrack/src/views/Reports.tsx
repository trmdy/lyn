import { useQuery } from "@lyn/react"
import * as reports from "../reports.lyn"
import * as team from "../team.lyn"
import { Link, useRouter, type Route } from "../lib/router"
import { addDays, addMonths, daysInMonth, formatDay, formatHours, monthOf, startOfWeek, today } from "../lib/time"
import { Avatar, currency, Dot, Empty } from "./shared"

export function ReportsView({ route }: { route: Extract<Route, { name: "reports" }> }) {
  const { navigate } = useRouter()
  const members = useQuery(team.members)
  const data = useQuery(reports.summary, { from: route.from, to: route.to, userId: route.user ?? null })
  const thisWeek = startOfWeek(today())
  const thisMonth = monthOf(today())
  const presets = [
    { label: "This week", from: thisWeek, to: addDays(thisWeek, 6) },
    { label: "Last week", from: addDays(thisWeek, -7), to: addDays(thisWeek, -1) },
    { label: "This month", from: daysInMonth(thisMonth)[0]!, to: daysInMonth(thisMonth).at(-1)! },
    { label: "Last month", from: daysInMonth(addMonths(thisMonth, -1))[0]!, to: daysInMonth(addMonths(thisMonth, -1)).at(-1)! },
  ]
  const link = (from: string, to: string, user = route.user) => `/reports?from=${from}&to=${to}${user ? `&user=${user}` : ""}`
  const hours = data.projects.reduce((sum, row) => sum + row.hours, 0)
  const billableHours = data.projects.reduce((sum, row) => sum + row.billableHours, 0)
  const amount = data.projects.reduce((sum, row) => sum + row.billableHours * row.rate, 0)
  const customers = [...new Set(data.projects.map((row) => row.customerName))]
  const maxDay = Math.max(1, ...data.days.map((row) => row.hours))
  const maxPerson = Math.max(1, ...data.people.map((row) => row.hours))

  return (
    <section className="reports">
      <header className="toolbar">
        <div className="toolbar-group">
          {presets.map((preset) => (
            <Link key={preset.label} to={link(preset.from, preset.to)} className={`button ${preset.from === route.from && preset.to === route.to ? "selected" : ""}`}>
              {preset.label}
            </Link>
          ))}
          <h2>
            {formatDay(route.from)} – {formatDay(route.to)}
          </h2>
        </div>
        <div className="toolbar-group">
          <select aria-label="Person" value={route.user ?? ""} onChange={(event) => navigate(link(route.from, route.to, event.target.value || undefined))}>
            <option value="">Everyone</option>
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
          <a className="button" href={`/api/export.csv?from=${route.from}&to=${route.to}`}>
            Export CSV
          </a>
        </div>
      </header>

      <div className="stats">
        <div>
          <span className="muted">Tracked</span>
          <strong>{formatHours(hours)} h</strong>
        </div>
        <div>
          <span className="muted">Billable</span>
          <strong>{formatHours(billableHours)} h</strong>
        </div>
        <div>
          <span className="muted">Billable share</span>
          <strong>{hours ? Math.round((billableHours / hours) * 100) : 0}%</strong>
        </div>
        <div>
          <span className="muted">Amount</span>
          <strong>{currency.format(amount)}</strong>
        </div>
      </div>

      <div className="chart">
        {data.days.map((row) => (
          <div key={row.day} className="bar" title={`${formatDay(row.day)}: ${formatHours(row.hours)} h`}>
            <div style={{ height: `${(row.hours / maxDay) * 100}%` }} />
            <span>{row.day.slice(8)}</span>
          </div>
        ))}
      </div>

      <div className="report-grid">
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th className="number">Hours</th>
              <th className="number">Billable</th>
              <th className="number">Rate</th>
              <th className="number">Amount</th>
            </tr>
          </thead>
          <tbody>
            {customers.map((customer) => (
              <CustomerRows key={customer} customer={customer} rows={data.projects.filter((row) => row.customerName === customer)} />
            ))}
          </tbody>
        </table>
        <div className="people">
          <h3>People</h3>
          {data.people.length ? (
            data.people.map((person) => (
              <div key={person.id} className="person">
                <Avatar name={person.name} color={person.color} />
                <div className="person-bar">
                  <div style={{ width: `${(person.hours / maxPerson) * 100}%`, background: person.color }} />
                  <div style={{ width: `${(person.billableHours / maxPerson) * 100}%`, background: person.color }} className="billable" />
                </div>
                <span>{formatHours(person.hours)}</span>
              </div>
            ))
          ) : (
            <Empty>No time tracked in this period.</Empty>
          )}
        </div>
      </div>
    </section>
  )
}

function CustomerRows({ customer, rows }: { customer: string; rows: { id: string; name: string; color: string; rate: number; hours: number; billableHours: number }[] }) {
  return (
    <>
      <tr className="customer-row">
        <td>{customer}</td>
        <td className="number">{formatHours(rows.reduce((sum, row) => sum + row.hours, 0))}</td>
        <td className="number">{formatHours(rows.reduce((sum, row) => sum + row.billableHours, 0))}</td>
        <td />
        <td className="number">{currency.format(rows.reduce((sum, row) => sum + row.billableHours * row.rate, 0))}</td>
      </tr>
      {rows.map((row) => (
        <tr key={row.id}>
          <td>
            <Link to={`/projects/${row.id}`}>
              <Dot color={row.color} /> {row.name}
            </Link>
          </td>
          <td className="number">{formatHours(row.hours)}</td>
          <td className="number">{formatHours(row.billableHours)}</td>
          <td className="number">{row.rate ? currency.format(row.rate) : "—"}</td>
          <td className="number">{currency.format(row.billableHours * row.rate)}</td>
        </tr>
      ))}
    </>
  )
}
