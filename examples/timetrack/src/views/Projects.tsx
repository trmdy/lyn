import { useMutation, useQuery, uuid, type OptimisticStore } from "@lyn/react"
import { useState, type FormEvent } from "react"
import * as catalog from "../catalog.lyn"
import { Link, type Route } from "../lib/router"
import { dayOf, formatDay, formatHours, formatTime } from "../lib/time"
import { Avatar, currency, Dot, Empty } from "./shared"

type Overview = Awaited<ReturnType<typeof useOverview>>
type Customer = Overview[number]
type Project = Customer["projects"][number]
type Me = { id: string; role: string }

const PALETTE = ["#f59e0b", "#3b82f6", "#22c55e", "#ef4444", "#a855f7", "#06b6d4", "#ec4899", "#64748b"]

function useOverview() {
  return useQuery(catalog.overview)
}

function patchProject(store: OptimisticStore, id: string, change: (project: Project) => Project) {
  const current = store.get(catalog.overview)
  if (current)
    store.set(catalog.overview, {}, current.map((customer) => ({ ...customer, projects: customer.projects.map((project) => (project.id === id ? change(project) : project)) })))
}

export function ProjectsView({ route, me }: { route: Extract<Route, { name: "projects" }>; me: Me }) {
  if (route.projectId)
    return (
      <section>
        <header className="toolbar">
          <Link className="button" to="/projects">
            ← All projects
          </Link>
        </header>
        <ProjectDetail projectId={route.projectId} />
      </section>
    )
  return <Catalog me={me} />
}

function Catalog({ me }: { me: Me }) {
  const overview = useOverview()
  const people = useQuery(catalog.people)
  const isAdmin = me.role === "admin"
  const [showArchived, setShowArchived] = useState(false)
  const createCustomer = useMutation(catalog.createCustomer, {
    optimistic: (store, customer) => {
      const current = store.get(catalog.overview)
      if (current)
        store.set(catalog.overview, {}, [...current, { ...customer, currency: "NOK", archived: false, createdAt: new Date(), projects: [] }].sort((a, b) => a.name.localeCompare(b.name)))
    },
  })

  const submitCustomer = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get("name") ?? "").trim()
    if (!name) return
    createCustomer({ id: uuid(), name, defaultRate: Number(form.get("rate") || 0) })
    event.currentTarget.reset()
  }

  return (
    <section className="catalog">
      <header className="toolbar">
        <div className="toolbar-group">
          <h2>Customers & projects</h2>
        </div>
        <label className="toolbar-group muted">
          <input type="checkbox" checked={showArchived} onChange={(event) => setShowArchived(event.target.checked)} /> Show archived
        </label>
      </header>
      {overview
        .filter((customer) => showArchived || !customer.archived)
        .map((customer) => (
          <CustomerCard key={customer.id} customer={customer} people={people} isAdmin={isAdmin} showArchived={showArchived} />
        ))}
      {isAdmin && (
        <form className="card inline-form" onSubmit={submitCustomer}>
          <strong>New customer</strong>
          <input name="name" placeholder="Name" />
          <input name="rate" type="number" min={0} step={50} placeholder="Default rate (NOK/h)" />
          <button type="submit">Add customer</button>
        </form>
      )}
    </section>
  )
}

function CustomerCard({
  customer,
  people,
  isAdmin,
  showArchived,
}: {
  customer: Customer
  people: { id: string; name: string; color: string }[]
  isAdmin: boolean
  showArchived: boolean
}) {
  const [adding, setAdding] = useState(false)
  const createProject = useMutation(catalog.createProject)
  const updateCustomer = useMutation(catalog.updateCustomer)
  const used = customer.projects.reduce((sum, project) => sum + project.billableHours * project.rate, 0)

  const submitProject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const name = String(form.get("name") ?? "").trim()
    const code = String(form.get("code") ?? "").trim()
    if (!name || !code) return
    createProject({
      id: uuid(),
      customerId: customer.id,
      name,
      code,
      color: String(form.get("color")),
      billable: form.get("billable") === "on",
      hourlyRate: form.get("rate") ? Number(form.get("rate")) : null,
      budgetHours: form.get("budget") ? Number(form.get("budget")) : null,
    })
    setAdding(false)
  }

  return (
    <div className={`card customer ${customer.archived ? "archived" : ""}`}>
      <div className="customer-head">
        <div>
          <h3>{customer.name}</h3>
          <span className="muted small">
            Default rate {customer.defaultRate ? currency.format(customer.defaultRate) : "non-billable"} · billed to date {currency.format(used)}
          </span>
        </div>
        {isAdmin && (
          <div className="toolbar-group">
            <button className="ghost" onClick={() => setAdding(!adding)}>
              {adding ? "Cancel" : "New project"}
            </button>
            <button className="ghost" onClick={() => updateCustomer({ id: customer.id, archived: !customer.archived })}>
              {customer.archived ? "Restore" : "Archive"}
            </button>
          </div>
        )}
      </div>
      {adding && (
        <form className="inline-form" onSubmit={submitProject}>
          <input name="name" placeholder="Project name" autoFocus />
          <input name="code" placeholder="Code" maxLength={12} />
          <select name="color" defaultValue={PALETTE[customer.projects.length % PALETTE.length]}>
            {PALETTE.map((color) => (
              <option key={color} value={color}>
                {color}
              </option>
            ))}
          </select>
          <input name="rate" type="number" min={0} step={50} placeholder={`Rate (default ${customer.defaultRate})`} />
          <input name="budget" type="number" min={1} placeholder="Budget hours" />
          <label>
            <input name="billable" type="checkbox" defaultChecked={customer.defaultRate > 0} /> Billable
          </label>
          <button type="submit">Create</button>
        </form>
      )}
      <table className="projects">
        <tbody>
          {customer.projects
            .filter((project) => showArchived || !project.archived)
            .map((project) => (
              <ProjectRow key={project.id} project={project} people={people} isAdmin={isAdmin} />
            ))}
        </tbody>
      </table>
      {!customer.projects.length && <Empty>No projects yet.</Empty>}
    </div>
  )
}

function ProjectRow({ project, people, isAdmin }: { project: Project; people: { id: string; name: string; color: string }[]; isAdmin: boolean }) {
  const [open, setOpen] = useState(false)
  const update = useMutation(catalog.updateProject, {
    optimistic: (store, { id, ...changes }) => patchProject(store, id, (current) => ({ ...current, ...changes })),
  })
  const toggleMember = useMutation(catalog.toggleMember, {
    optimistic: (store, { projectId, userId, member }) =>
      patchProject(store, projectId, (current) => ({
        ...current,
        memberIds: member ? [...current.memberIds, userId] : current.memberIds.filter((id) => id !== userId),
      })),
  })
  const addTask = useMutation(catalog.addTask, {
    optimistic: (store, task) => patchProject(store, task.projectId, (current) => ({ ...current, tasks: [...current.tasks, task] })),
  })
  const removeTask = useMutation(catalog.removeTask, {
    optimistic: (store, { id }) => patchProject(store, project.id, (current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== id) })),
  })
  const ratio = project.budgetHours ? project.usedHours / project.budgetHours : 0

  return (
    <>
      <tr className={project.archived ? "archived" : ""}>
        <td>
          <Link to={`/projects/${project.id}`} className="project-name">
            <Dot color={project.color} /> {project.name}
          </Link>
          <span className="code">{project.code}</span>
          {!project.billable && <span className="tag">non-billable</span>}
        </td>
        <td className="budget-cell">
          {project.budgetHours ? (
            <>
              <div className={`budget ${ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : ""}`}>
                <div style={{ width: `${Math.min(ratio, 1) * 100}%` }} />
              </div>
              <span className="small muted">
                {formatHours(project.usedHours)} / {project.budgetHours} h
              </span>
            </>
          ) : (
            <span className="small muted">{formatHours(project.usedHours)} h · no budget</span>
          )}
        </td>
        <td className="number small">{project.billable && project.rate ? `${currency.format(project.rate)}/h` : "—"}</td>
        <td className="members">
          {people.map((person) => {
            const member = project.memberIds.includes(person.id)
            return (
              <button
                key={person.id}
                className={`member ${member ? "" : "absent"}`}
                disabled={!isAdmin}
                title={`${person.name}${member ? "" : " (not on project)"}`}
                onClick={() => toggleMember({ projectId: project.id, userId: person.id, member: !member })}
              >
                <Avatar name={person.name} color={person.color} size={22} />
              </button>
            )
          })}
        </td>
        <td className="number">
          {isAdmin && (
            <button className="ghost" onClick={() => setOpen(!open)}>
              {open ? "Done" : "Edit"}
            </button>
          )}
        </td>
      </tr>
      {open && (
        <tr className="project-edit">
          <td colSpan={5}>
            <div className="inline-form">
              <label>
                Budget (h)
                <input
                  type="number"
                  min={1}
                  defaultValue={project.budgetHours ?? ""}
                  onBlur={(event) => update({ id: project.id, budgetHours: event.target.value ? Number(event.target.value) : null })}
                />
              </label>
              <label>
                Rate override
                <input
                  type="number"
                  min={0}
                  step={50}
                  defaultValue={project.hourlyRate ?? ""}
                  onBlur={(event) => update({ id: project.id, hourlyRate: event.target.value ? Number(event.target.value) : null })}
                />
              </label>
              <label>
                <input type="checkbox" checked={project.billable} onChange={(event) => update({ id: project.id, billable: event.target.checked })} /> Billable
              </label>
              <label>
                <input type="checkbox" checked={project.archived} onChange={(event) => update({ id: project.id, archived: event.target.checked })} /> Archived
              </label>
            </div>
            <div className="tasks">
              {project.tasks.map((task) => (
                <span key={task.id} className="task">
                  {task.name}
                  {!task.billable && <em> · non-billable</em>}
                  <button className="ghost" aria-label={`Remove ${task.name}`} onClick={() => removeTask({ id: task.id })}>
                    ×
                  </button>
                </span>
              ))}
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  const input = event.currentTarget.elements.namedItem("task") as HTMLInputElement
                  if (!input.value.trim()) return
                  addTask({ id: uuid(), projectId: project.id, name: input.value.trim(), billable: project.billable })
                  input.value = ""
                }}
              >
                <input name="task" placeholder="Add task" />
              </form>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function ProjectDetail({ projectId }: { projectId: string }) {
  const { project, people, weeks, recent } = useQuery(catalog.detail, { projectId })
  if (!project) return <Empty>This project does not exist.</Empty>
  const used = people.reduce((sum, person) => sum + person.hours, 0)
  const rate = project.hourlyRate ?? project.defaultRate
  let running = 0
  const cumulative = weeks.map((week) => ({ week: week.week, total: (running += week.hours) }))
  const top = Math.max(project.budgetHours ?? 0, used, 1) * 1.1
  const width = 1100
  const height = 220
  const x = (index: number) => (cumulative.length > 1 ? (index / (cumulative.length - 1)) * width : width / 2)
  const y = (hours: number) => height - (hours / top) * height
  return (
    <div className="detail">
      <div className="detail-head">
        <Dot color={project.color} />
        <div>
          <h2>{project.name}</h2>
          <span className="muted">
            {project.customerName} · {project.code} · {project.billable && rate ? `${currency.format(rate)}/h` : "non-billable"}
          </span>
        </div>
      </div>
      <div className="stats">
        <div>
          <span className="muted">Used</span>
          <strong>{formatHours(used)} h</strong>
        </div>
        <div>
          <span className="muted">Budget</span>
          <strong>{project.budgetHours ? `${project.budgetHours} h` : "—"}</strong>
        </div>
        <div>
          <span className="muted">Remaining</span>
          <strong className={project.budgetHours && used > project.budgetHours ? "over-text" : ""}>
            {project.budgetHours ? `${formatHours(project.budgetHours - used)} h` : "—"}
          </strong>
        </div>
        <div>
          <span className="muted">Value</span>
          <strong>{currency.format(project.billable ? used * rate : 0)}</strong>
        </div>
      </div>
      <div className="card">
        <h3>Burn-up</h3>
        <svg viewBox={`-30 -10 ${width + 40} ${height + 30}`} className="burnup">
          {project.budgetHours && (
            <>
              <line x1={0} x2={width} y1={y(project.budgetHours)} y2={y(project.budgetHours)} className="budget-line" />
              <text x={width} y={y(project.budgetHours) - 4} textAnchor="end" className="axis">
                budget {project.budgetHours} h
              </text>
            </>
          )}
          <polyline points={cumulative.map((point, index) => `${x(index)},${y(point.total)}`).join(" ")} style={{ stroke: project.color }} />
          {cumulative.map((point, index) => (
            <g key={point.week}>
              <circle cx={x(index)} cy={y(point.total)} r={3} style={{ fill: project.color }} />
              <text x={x(index)} y={height + 16} textAnchor="middle" className="axis">
                {formatDay(point.week).replace(/^\w+ /, "")}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="detail-grid">
        <div className="card">
          <h3>People</h3>
          {people.map((person) => (
            <div key={person.id} className="person">
              <Avatar name={person.name} color={person.color} />
              <div className="person-bar">
                <div style={{ width: `${(person.hours / Math.max(used, 1)) * 100}%`, background: person.color }} />
              </div>
              <span>{formatHours(person.hours)}</span>
            </div>
          ))}
          {!people.length && <Empty>No time yet.</Empty>}
        </div>
        <div className="card">
          <h3>Latest entries</h3>
          {recent.map((entry) => (
            <div key={entry.id} className="recent">
              <Avatar name={entry.userName} color={entry.userColor} size={20} />
              <span className="recent-what">{entry.description || entry.taskName || "—"}</span>
              <span className="muted small">
                {formatDay(dayOf(entry.startedAt))} {formatTime(entry.startedAt)}
                {entry.endedAt ? `–${formatTime(entry.endedAt)}` : " · running"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
