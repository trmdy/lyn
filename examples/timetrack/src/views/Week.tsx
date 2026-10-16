import { useNow, useMutation, useQuery, uuid, type OptimisticStore } from "@lyn/react"
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react"
import * as entries from "../entries.lyn"
import * as team from "../team.lyn"
import { Link, useRouter, type Route } from "../lib/router"
import {
  addDays,
  dayOf,
  formatDay,
  formatHours,
  formatTime,
  instant,
  minutesOf,
  startOfWeek,
  today,
  type Day,
} from "../lib/time"
import { EntryEditor, type Draft } from "./EntryEditor"
import { Avatar, usePickable, type Pickable } from "./shared"

const HOUR_START = 6
const HOUR_END = 22
const HOUR_PX = 52
const MINUTE_PX = HOUR_PX / 60
const SNAP = 15

export type Entry = Awaited<ReturnType<typeof useWeek>>[number]

function useWeek(userId: string, start: Day) {
  return useQuery(entries.week, { userId, start })
}

type Drag =
  | { kind: "create"; day: number; from: number; to: number }
  | { kind: "move"; entry: Entry; x: number; y: number; dx: number; dy: number; moved: boolean }
  | { kind: "resize"; entry: Entry; y: number; dy: number }

const snap = (minutes: number) => Math.round(minutes / SNAP) * SNAP
const clampMinutes = (minutes: number) => Math.max(HOUR_START * 60, Math.min(HOUR_END * 60, minutes))

function rowFor(entry: { id: string; projectId: string; taskId: string | null; description: string; startedAt: Date; endedAt: Date | null }, projects: Pickable[], userId: string): Entry {
  const project = projects.find((candidate) => candidate.id === entry.projectId)
  const task = project?.tasks.find((candidate) => candidate.id === entry.taskId)
  return {
    ...entry,
    userId,
    billable: (project?.billable ?? true) && (task?.billable ?? true),
    projectName: project?.name ?? "",
    projectColor: project?.color ?? "#999",
    customerName: project?.customerName ?? "",
    taskName: task?.name ?? null,
  }
}

function patchWeek(store: OptimisticStore, key: { userId: string; start: Day }, change: (rows: Entry[]) => Entry[]) {
  const current = store.get(entries.week, key)
  if (current) store.set(entries.week, key, change(current).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()))
}

function lanes(segments: { entry: Entry; top: number; bottom: number }[]) {
  const ends: number[] = []
  const placed = segments.map((segment) => {
    let lane = ends.findIndex((end) => end <= segment.top)
    if (lane === -1) lane = ends.length
    ends[lane] = segment.bottom
    return { ...segment, lane }
  })
  return placed.map((segment) => ({ ...segment, lanes: Math.max(1, ...placed.filter((other) => other.top < segment.bottom && other.bottom > segment.top).map((other) => other.lane + 1)) }))
}

export function WeekView({ route, me }: { route: Extract<Route, { name: "week" }>; me: { id: string; name: string } }) {
  const { navigate } = useRouter()
  const members = useQuery(team.members)
  const projects = usePickable()
  const userId = route.user ?? me.id
  const start = startOfWeek(route.day)
  const key = { userId, start }
  const rows = useWeek(userId, start)
  const editable = userId === me.id
  const now = useNow(30_000)
  const currentDay = today(now)
  const days = Array.from({ length: 7 }, (_, index) => addDays(start, index))
  const [drag, setDrag] = useState<Drag | null>(null)
  const latestDrag = useRef(drag)
  latestDrag.current = drag
  const [draft, setDraft] = useState<Draft | null>(null)
  const [focusDay, setFocusDay] = useState(route.day)
  const focus = days.includes(focusDay) ? focusDay : days.includes(currentDay) ? currentDay : start
  const tap = useRef<{ x: number; y: number; action: () => void } | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const create = useMutation(entries.createEntry, {
    optimistic: (store, entry) => patchWeek(store, key, (current) => [...current, rowFor(entry, projects, userId)]),
  })
  const update = useMutation(entries.updateEntry, {
    optimistic: (store, changes) =>
      patchWeek(store, key, (current) =>
        current.map((row) => (row.id === changes.id ? rowFor({ ...row, ...changes }, projects, userId) : row)),
      ),
  })
  const remove = useMutation(entries.deleteEntry, {
    optimistic: (store, { id }) => patchWeek(store, key, (current) => current.filter((row) => row.id !== id)),
  })

  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const offset = (8 - HOUR_START) * HOUR_PX
    if (element.scrollHeight > element.clientHeight) element.scrollTop = offset
    else {
      const sticky = [...document.querySelectorAll(".mobile-header, .timer, .week-head")].reduce((sum, bar) => sum + bar.getBoundingClientRect().height, 0)
      window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY + offset - sticky - 8 })
    }
  }, [])

  const minuteAt = (clientY: number) => {
    const box = grid.current!.getBoundingClientRect()
    return clampMinutes(snap(HOUR_START * 60 + (clientY - box.top) / MINUTE_PX))
  }
  const visibleColumns = () => [...grid.current!.children].filter((element) => (element as HTMLElement).offsetWidth > 0).length
  const columnWidth = () => grid.current!.getBoundingClientRect().width / Math.max(1, visibleColumns())

  useEffect(() => {
    if (!drag) return
    const move = (event: PointerEvent) => {
      setDrag((current) => {
        if (!current) return current
        if (current.kind === "create") return { ...current, to: Math.max(current.from + SNAP, minuteAt(event.clientY)) }
        if (current.kind === "move") {
          const dy = snap((event.clientY - current.y) / MINUTE_PX)
          const dx = visibleColumns() > 1 ? Math.round((event.clientX - current.x) / columnWidth()) : 0
          return { ...current, dy, dx, moved: current.moved || Math.abs(event.clientY - current.y) > 3 || dx !== 0 }
        }
        return { ...current, dy: snap((event.clientY - current.y) / MINUTE_PX) }
      })
    }
    const up = () => {
      const drag = latestDrag.current
      setDrag(null)
      if (!drag) return
      if (drag.kind === "create") {
        const to = drag.to - drag.from < 30 ? drag.from + 60 : drag.to
        setDraft({ day: days[drag.day]!, from: drag.from, to, projectId: projects[0]?.id ?? "", taskId: null, description: "" })
      } else if (drag.kind === "move") {
        if (!drag.moved) return setDraft(draftOf(drag.entry))
        const { from, to, day } = shifted(drag.entry, drag.dx, drag.dy)
        update({ id: drag.entry.id, startedAt: instant(day, from), endedAt: instant(day, to) })
      } else if (drag.dy) {
        const { day, from, to } = spanOf(drag.entry)
        update({ id: drag.entry.id, endedAt: instant(day, Math.max(from + SNAP, to + drag.dy)) })
      }
    }
    addEventListener("pointermove", move)
    addEventListener("pointerup", up, { once: true })
    return () => {
      removeEventListener("pointermove", move)
      removeEventListener("pointerup", up)
    }
  }, [drag?.kind])

  const spanOf = (entry: Entry) => {
    const day = dayOf(entry.startedAt)
    const from = minutesOf(entry.startedAt)
    const end = entry.endedAt ?? new Date(now)
    const to = dayOf(end) === day ? minutesOf(end) : 24 * 60
    return { day, from, to }
  }
  const shifted = (entry: Entry, dx: number, dy: number) => {
    const { day, from, to } = spanOf(entry)
    return { day: addDays(day, dx), from: from + dy, to: to + dy }
  }
  const draftOf = (entry: Entry): Draft => {
    const { day, from, to } = spanOf(entry)
    return { id: entry.id, day, from, to, projectId: entry.projectId, taskId: entry.taskId, description: entry.description, running: !entry.endedAt }
  }

  const visible = rows.map((entry) => {
    if (drag?.kind === "move" && drag.entry.id === entry.id && drag.moved) return { entry, ...shifted(entry, drag.dx, drag.dy) }
    if (drag?.kind === "resize" && drag.entry.id === entry.id) {
      const span = spanOf(entry)
      return { entry, ...span, to: Math.max(span.from + SNAP, span.to + drag.dy) }
    }
    return { entry, ...spanOf(entry) }
  })
  const totals = days.map((day) => visible.filter((item) => item.day === day).reduce((sum, item) => sum + (item.to - item.from) / 60, 0))
  const user = members.find((member) => member.id === userId)
  const query = route.user ? `?user=${route.user}` : ""

  return (
    <section className="week">
      <header className="toolbar">
        <div className="toolbar-group">
          <Link className="button" to={`/week/${addDays(start, -7)}${query}`}>
            ←
          </Link>
          <Link className="button" to={`/week/${startOfWeek(currentDay)}${query}`}>
            Today
          </Link>
          <Link className="button" to={`/week/${addDays(start, 7)}${query}`}>
            →
          </Link>
          <h2>
            {formatDay(start)} – {formatDay(addDays(start, 6))}
          </h2>
        </div>
        <div className="toolbar-group">
          <span className="total">{formatHours(totals.reduce((a, b) => a + b, 0))} h</span>
          {user && <Avatar name={user.name} color={user.color} />}
          <select
            aria-label="Person"
            value={userId}
            onChange={(event) => navigate(`/week/${start}${event.target.value === me.id ? "" : `?user=${event.target.value}`}`)}
          >
            {members.map((member) => (
              <option key={member.id} value={member.id}>
                {member.id === me.id ? `${member.name} (you)` : member.name}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="week-head">
        <div />
        {days.map((day, index) => (
          <button
            key={day}
            type="button"
            className={`${day === currentDay ? "today" : ""} ${day === focus ? "focus" : ""}`}
            onClick={() => setFocusDay(day)}
          >
            <span>
              {formatDay(day).replace(/ \S+$/, "")}
              <em> {formatDay(day).split(" ").at(-1)}</em>
            </span>
            <strong>{formatHours(totals[index]!)}</strong>
          </button>
        ))}
      </div>

      <div className="week-scroll" ref={scroller}>
        <div className="week-body">
          <div className="hours">
            {Array.from({ length: HOUR_END - HOUR_START }, (_, index) => (
              <div key={index} style={{ height: HOUR_PX }}>
                {String(HOUR_START + index).padStart(2, "0")}:00
              </div>
            ))}
          </div>
          <div
            className="columns"
            ref={grid}
            style={{ height: (HOUR_END - HOUR_START) * HOUR_PX }}
            onPointerUp={(event) => {
              const pending = tap.current
              tap.current = null
              if (pending && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) < 10) pending.action()
            }}
            onPointerCancel={() => (tap.current = null)}
          >
            {days.map((day, index) => {
              const segments = lanes(
                visible
                  .filter((item) => item.day === day)
                  .map((item) => ({
                    entry: item.entry,
                    top: (Math.max(item.from, HOUR_START * 60) - HOUR_START * 60) * MINUTE_PX,
                    bottom: (Math.min(item.to, HOUR_END * 60) - HOUR_START * 60) * MINUTE_PX,
                  }))
                  .filter((segment) => segment.bottom > segment.top),
              )
              return (
                <div
                  key={day}
                  className={`column ${day === currentDay ? "today" : ""} ${day === focus ? "focus" : ""} ${editable ? "editable" : ""}`}
                  onPointerDown={(event: ReactPointerEvent) => {
                    if (!editable || event.target !== event.currentTarget) return
                    const from = minuteAt(event.clientY)
                    if (event.pointerType === "touch") {
                      tap.current = {
                        x: event.clientX,
                        y: event.clientY,
                        action: () => setDraft({ day, from, to: from + 60, projectId: projects[0]?.id ?? "", taskId: null, description: "" }),
                      }
                      return
                    }
                    setDrag({ kind: "create", day: index, from, to: from + SNAP })
                  }}
                >
                  {segments.map(({ entry, top, bottom, lane, lanes }) => (
                    <div
                      key={entry.id}
                      className={`entry ${entry.endedAt ? "" : "live"} ${entry.billable ? "" : "nonbillable"} ${drag && "entry" in drag && drag.entry.id === entry.id ? "dragging" : ""}`}
                      style={{
                        top,
                        height: Math.max(bottom - top, 14),
                        left: `calc(${(lane / lanes) * 100}% + 2px)`,
                        width: `calc(${100 / lanes}% - 4px)`,
                        "--color": entry.projectColor,
                      } as CSSProperties}
                      onPointerDown={(event) => {
                        event.stopPropagation()
                        if (!editable) return
                        if (event.pointerType === "touch") {
                          tap.current = { x: event.clientX, y: event.clientY, action: () => setDraft(draftOf(entry)) }
                          return
                        }
                        if (!entry.endedAt) return setDraft(draftOf(entry))
                        setDrag({ kind: "move", entry, x: event.clientX, y: event.clientY, dx: 0, dy: 0, moved: false })
                      }}
                    >
                      <strong>{entry.description || entry.taskName || entry.projectName}</strong>
                      <span>
                        {entry.projectName}
                        {entry.taskName ? ` · ${entry.taskName}` : ""}
                      </span>
                      <span className="entry-time">
                        {formatTime(entry.startedAt)}–{entry.endedAt ? formatTime(entry.endedAt) : "now"}
                      </span>
                      {editable && entry.endedAt && (
                        <div
                          className="resize"
                          onPointerDown={(event) => {
                            event.stopPropagation()
                            setDrag({ kind: "resize", entry, y: event.clientY, dy: 0 })
                          }}
                        />
                      )}
                    </div>
                  ))}
                  {drag?.kind === "create" && drag.day === index && (
                    <div
                      className="entry ghost"
                      style={{ top: (drag.from - HOUR_START * 60) * MINUTE_PX, height: (drag.to - drag.from) * MINUTE_PX }}
                    >
                      {formatHours((drag.to - drag.from) / 60)} h
                    </div>
                  )}
                  {day === dayOf(new Date(now)) && (
                    <div className="now-line" style={{ top: (minutesOf(new Date(now)) - HOUR_START * 60) * MINUTE_PX }} />
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {draft && (
        <EntryEditor
          draft={draft}
          projects={projects}
          onClose={() => setDraft(null)}
          onSave={(saved) => {
            const startedAt = instant(saved.day, saved.from)
            const endedAt = instant(saved.day, saved.to)
            const work = { projectId: saved.projectId, taskId: saved.taskId, description: saved.description }
            if (saved.id) update({ id: saved.id, ...work, ...(saved.running ? {} : { startedAt, endedAt }) })
            else create({ id: uuid(), ...work, startedAt, endedAt })
            setDraft(null)
          }}
          onDelete={(id) => {
            remove({ id })
            setDraft(null)
          }}
        />
      )}
    </section>
  )
}
