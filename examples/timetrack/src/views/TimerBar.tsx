import { useNow, useMutation, useQuery, uuid } from "@lyn/react"
import { useLayoutEffect, useRef, useState, type FormEvent } from "react"
import * as entries from "../entries.lyn"
import { formatDuration } from "../lib/time"
import { Dot, ProjectSelect, TaskSelect, usePickable } from "./shared"

export function TimerBar() {
  const running = useQuery(entries.running)
  const projects = usePickable()
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "")
  const [taskId, setTaskId] = useState<string | null>(null)
  const [description, setDescription] = useState("")
  const now = useNow()
  const project = projects.find((candidate) => candidate.id === projectId)
  const bar = useRef<HTMLFormElement>(null)
  useLayoutEffect(() => {
    const form = bar.current
    if (!form) return
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty("--timer-height", `${form.getBoundingClientRect().height}px`)
    })
    observer.observe(form)
    return () => observer.disconnect()
  }, [])

  const start = useMutation(entries.startTimer, {
    optimistic: (store, entry) => {
      const picked = projects.find((candidate) => candidate.id === entry.projectId)
      store.set(entries.running, {}, {
        ...entry,
        userId: "",
        startedAt: new Date(),
        endedAt: null,
        billable: picked?.billable ?? true,
        projectName: picked?.name ?? "",
        projectColor: picked?.color ?? "#999",
        customerName: picked?.customerName ?? "",
        taskName: picked?.tasks.find((task) => task.id === entry.taskId)?.name ?? null,
      })
    },
  })
  const stop = useMutation(entries.stopTimer, { optimistic: (store) => store.set(entries.running, {}, null) })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (running) return void stop()
    if (!projectId) return
    start({ id: uuid(), projectId, taskId, description })
    setDescription("")
  }

  return (
    <form ref={bar} className={`timer ${running ? "running" : ""}`} onSubmit={submit}>
      {running ? (
        <div className="timer-current">
          <Dot color={running.projectColor} />
          <strong>{running.description || "No description"}</strong>
          <span className="muted">
            {running.customerName} · {running.projectName}
            {running.taskName ? ` · ${running.taskName}` : ""}
          </span>
        </div>
      ) : (
        <>
          <input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What are you working on?" />
          <ProjectSelect
            projects={projects}
            value={projectId}
            onChange={(id) => {
              setProjectId(id)
              setTaskId(null)
            }}
          />
          <TaskSelect project={project} value={taskId} onChange={setTaskId} />
        </>
      )}
      <time className="elapsed">
        {running ? formatDuration(now - running.startedAt.getTime()) : "0:00:00"}
      </time>
      <button className={running ? "stop" : "start"} type="submit">
        {running ? "Stop" : "Start"}
      </button>
    </form>
  )
}
