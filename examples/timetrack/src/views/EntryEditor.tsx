import { useState, type FormEvent } from "react"
import { formatHours, formatLongDay, type Day } from "../lib/time"
import { ProjectSelect, TaskSelect, type Pickable } from "./shared"

export interface Draft {
  id?: string
  day: Day
  from: number
  to: number
  projectId: string
  taskId: string | null
  description: string
  running?: boolean
}

const toClock = (minutes: number) =>
  `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(Math.round(minutes % 60)).padStart(2, "0")}`
const fromClock = (value: string) => {
  const [hours, minutes] = value.split(":").map(Number)
  return hours! * 60 + minutes!
}

export function EntryEditor({
  draft,
  projects,
  onSave,
  onDelete,
  onClose,
}: {
  draft: Draft
  projects: Pickable[]
  onSave: (draft: Draft) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(draft)
  const project = projects.find((candidate) => candidate.id === value.projectId)
  const invalid = !value.running && value.to <= value.from
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!invalid && value.projectId) onSave(value)
  }

  return (
    <div className="overlay" onPointerDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="editor" onSubmit={submit}>
        <h3>{draft.id ? (draft.running ? "Running timer" : "Edit entry") : "New entry"}</h3>
        <p className="muted">{formatLongDay(value.day)}</p>
        <label>
          Description
          <input autoFocus value={value.description} onChange={(event) => setValue({ ...value, description: event.target.value })} />
        </label>
        <label>
          Project
          <ProjectSelect projects={projects} value={value.projectId} onChange={(projectId) => setValue({ ...value, projectId, taskId: null })} />
        </label>
        <label>
          Task
          <TaskSelect project={project} value={value.taskId} onChange={(taskId) => setValue({ ...value, taskId })} />
        </label>
        {!value.running && (
          <div className="row">
            <label>
              Date
              <input type="date" value={value.day} onChange={(event) => event.target.value && setValue({ ...value, day: event.target.value })} />
            </label>
            <label>
              From
              <input type="time" step={900} value={toClock(value.from)} onChange={(event) => event.target.value && setValue({ ...value, from: fromClock(event.target.value) })} />
            </label>
            <label>
              To
              <input type="time" step={900} value={toClock(value.to)} onChange={(event) => event.target.value && setValue({ ...value, to: fromClock(event.target.value) })} />
            </label>
          </div>
        )}
        <div className="editor-actions">
          {draft.id && (
            <button type="button" className="danger" onClick={() => onDelete(draft.id!)}>
              Delete
            </button>
          )}
          <span className="muted">{invalid ? "End must be after start" : value.running ? "" : `${formatHours((value.to - value.from) / 60)} h`}</span>
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" disabled={invalid}>
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
