import { useQuery } from "@lyn/react"
import type { ReactNode } from "react"
import * as catalog from "../catalog.lyn"

export type Pickable = Awaited<ReturnType<typeof usePickable>>[number]

export function usePickable() {
  return useQuery(catalog.pickable)
}

export function Avatar({ name, color, size = 24 }: { name: string; color: string; size?: number }) {
  return (
    <span className="avatar" style={{ background: color, width: size, height: size, fontSize: size * 0.45 }} title={name}>
      {name[0]}
    </span>
  )
}

export function Dot({ color }: { color: string }) {
  return <span className="dot" style={{ background: color }} />
}

export function ProjectSelect({
  projects,
  value,
  onChange,
}: {
  projects: Pickable[]
  value: string
  onChange: (projectId: string) => void
}) {
  const customers = [...new Set(projects.map((project) => project.customerName))]
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label="Project">
      {customers.map((customer) => (
        <optgroup key={customer} label={customer}>
          {projects
            .filter((project) => project.customerName === customer)
            .map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  )
}

export function TaskSelect({ project, value, onChange }: { project?: Pickable; value: string | null; onChange: (taskId: string | null) => void }) {
  return (
    <select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)} aria-label="Task">
      <option value="">No task</option>
      {project?.tasks.map((task) => (
        <option key={task.id} value={task.id}>
          {task.name}
        </option>
      ))}
    </select>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>
}

export const currency = new Intl.NumberFormat("nb-NO", { style: "currency", currency: "NOK", maximumFractionDigits: 0 })
