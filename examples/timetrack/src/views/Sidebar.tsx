import { useNow, useLyn, useQuery } from "@lyn/react"
import * as entries from "../entries.lyn"
import * as team from "../team.lyn"
import { Link, useRouter } from "../lib/router"
import { formatDuration, monthOf, startOfWeek, today, type Day } from "../lib/time"
import { Avatar, Dot } from "./shared"

export function useSignIn() {
  const client = useLyn()
  return async (userId: string | null) => {
    await fetch(userId ? "/login" : "/logout", { method: "POST", body: JSON.stringify({ userId }) })
    client.reconnect()
  }
}

export const navLinks = (day: Day) => [
  { name: "week", label: "Week", icon: "▦", to: `/week/${startOfWeek(day)}` },
  { name: "month", label: "Month", icon: "▤", to: `/month/${monthOf(day)}` },
  { name: "projects", label: "Projects", icon: "◫", to: "/projects" },
  { name: "reports", label: "Reports", icon: "▥", to: "/reports" },
]

export function TabBar() {
  const { route } = useRouter()
  const currentDay = today(useNow(30_000))
  return (
    <nav className="tabbar">
      {navLinks(currentDay).map((link) => (
        <Link key={link.name} to={link.to} className={route.name === link.name ? "active" : ""}>
          <span aria-hidden>{link.icon}</span>
          {link.label}
        </Link>
      ))}
    </nav>
  )
}

export function MobileHeader({ onMenu }: { onMenu: () => void }) {
  const running = useQuery(team.workingNow)
  return (
    <header className="mobile-header">
      <button className="ghost" aria-label="Open menu" onClick={onMenu}>
        ☰
      </button>
      <div className="brand">
        <span className="logo">◷</span> Lyn Time
      </div>
      <button className="ghost working-badge" onClick={onMenu} aria-label={`${running.length} people tracking time`}>
        {running.slice(0, 3).map((entry) => (
          <Avatar key={entry.id} name={entry.userName} color={entry.userColor} size={22} />
        ))}
        {running.length ? <span className="live-dot" /> : null}
      </button>
    </header>
  )
}

export function Sidebar({ me }: { me: { id: string; name: string; role: string; color: string } }) {
  const { route } = useRouter()
  const currentDay = today(useNow(30_000))
  const members = useQuery(team.members)
  const signIn = useSignIn()
  const links = navLinks(currentDay)
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="logo">◷</span> Lyn Time
      </div>
      <nav>
        {links.map((link) => (
          <Link key={link.name} to={link.to} className={route.name === link.name ? "active" : ""}>
            {link.label}
          </Link>
        ))}
      </nav>
      <WorkingNow />
      <Alerts />
      <div className="account">
        <Avatar name={me.name} color={me.color} />
        <select aria-label="Signed in as" value={me.id} onChange={(event) => signIn(event.target.value)}>
          {members.map((member) => (
            <option key={member.id} value={member.id}>
              {member.name}
            </option>
          ))}
        </select>
        <button className="ghost" onClick={() => signIn(null)}>
          Sign out
        </button>
      </div>
    </aside>
  )
}

function WorkingNow() {
  const running = useQuery(team.workingNow)
  const now = useNow()
  return (
    <section className="panel">
      <h3>Working now</h3>
      {running.length ? (
        running.map((entry) => (
          <div key={entry.id} className="working">
            <Avatar name={entry.userName} color={entry.userColor} size={22} />
            <div>
              <div className="working-what">{entry.description || entry.projectName}</div>
              <div className="muted small working-meta">
                <Dot color={entry.projectColor} />
                <span>{entry.projectName}</span>
                <time>{formatDuration(now - entry.startedAt.getTime())}</time>
              </div>
            </div>
          </div>
        ))
      ) : (
        <p className="muted small">Nobody is tracking time.</p>
      )}
    </section>
  )
}

function Alerts() {
  const alerts = useQuery(entries.recentAlerts)
  if (!alerts.length) return null
  return (
    <section className="panel">
      <h3>Budget alerts</h3>
      {alerts.map((alert) => (
        <Link key={alert.id} to={`/projects/${alert.projectId}`} className={`alert ${alert.threshold >= 100 ? "over" : ""}`}>
          <Dot color={alert.projectColor} /> {alert.projectName} passed {alert.threshold}% of budget
        </Link>
      ))}
    </section>
  )
}

export function SignIn() {
  const members = useQuery(team.members)
  const signIn = useSignIn()
  return (
    <div className="sign-in">
      <div className="brand">
        <span className="logo">◷</span> Lyn Time
      </div>
      <p className="muted">Sign in as</p>
      {members.map((member) => (
        <button key={member.id} onClick={() => signIn(member.id)}>
          <Avatar name={member.name} color={member.color} /> {member.name}
          <span className="muted small">{member.role}</span>
        </button>
      ))}
    </div>
  )
}
