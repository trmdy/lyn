import { useQuery } from "@lyn/react"
import { Suspense } from "react"
import * as team from "./team.lyn"
import { Router, useRouter } from "./lib/router"
import { MonthView } from "./views/Month"
import { ProjectsView } from "./views/Projects"
import { ReportsView } from "./views/Reports"
import { SignIn, Sidebar } from "./views/Sidebar"
import { TimerBar } from "./views/TimerBar"
import { WeekView } from "./views/Week"

export default function App({ url }: { url: string }) {
  return (
    <Router url={url}>
      <Shell />
    </Router>
  )
}

function Shell() {
  const me = useQuery(team.me)
  const { route, pending } = useRouter()
  if (!me) return <SignIn />
  return (
    <div className="shell">
      <Sidebar me={me} />
      <main className={pending ? "pending" : ""}>
        <TimerBar />
        <Suspense fallback={<div className="loading">Loading…</div>}>
          {route.name === "week" && <WeekView route={route} me={me} />}
          {route.name === "month" && <MonthView route={route} me={me} />}
          {route.name === "projects" && <ProjectsView route={route} me={me} />}
          {route.name === "reports" && <ReportsView route={route} />}
        </Suspense>
      </main>
    </div>
  )
}
