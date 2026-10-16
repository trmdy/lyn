import { useLyn, useQuery } from "@lyn/react"
import * as entries from "../entries.lyn"
import * as team from "../team.lyn"
import { useNow } from "../lib/hooks"
import { Link, useRouter } from "../lib/router"
import { formatDuration, monthOf, startOfWeek, today } from "../lib/time"
import { Avatar, Dot } from "./shared"

export function useSignIn() {
  const client = useLyn()
  return async (userId: string | null) => {
    await fetch(userId ? "/login" : "/logout", { method: "POST", body: JSON.stringify({ userId }) })
    client.reconnect()
  }
}

export function Sidebar({ me }: { me: { id: string; name: string; role: string; color: string } }) {
  const { route } = useRouter()
  const members = useQuery(team.members)
  const signIn = useSignIn()
  const links = [
    { name: "week", label: "Week", to: `/week/${startOfWeek(today())}` },
    { name: "month", label: "Month", to: `/month/${monthOf(today())}` },
    { name: "projects", label: "Projects", to: "/projects" },
    { name: "reports", label: "Reports", to: "/reports" },
  ]
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
                <time suppressHydrationWarning>{formatDuration(now - entry.startedAt.getTime())}</time>
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
