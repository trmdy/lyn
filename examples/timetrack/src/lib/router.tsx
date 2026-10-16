import { useNow } from "@lyn/react"
import { createContext, use, useCallback, useEffect, useState, useTransition, type AnchorHTMLAttributes, type ReactNode } from "react"
import { DAY_PATTERN, MONTH_PATTERN, addDays, monthOf, startOfWeek, today, type Day } from "./time"

export type Route =
  | { name: "week"; day: Day; user?: string }
  | { name: "month"; month: string; user?: string }
  | { name: "projects"; projectId?: string }
  | { name: "reports"; from: Day; to: Day; user?: string }

export function parseRoute(path: string, currentDay: Day): Route {
  const url = new URL(path, "http://lyn")
  const [section, param] = url.pathname.split("/").filter(Boolean)
  const user = url.searchParams.get("user") ?? undefined
  if (section === "month") return { name: "month", month: param && MONTH_PATTERN.test(param) ? param : monthOf(currentDay), user }
  if (section === "projects") return { name: "projects", projectId: param }
  if (section === "reports") {
    const from = url.searchParams.get("from") ?? ""
    const to = url.searchParams.get("to") ?? ""
    const start = DAY_PATTERN.test(from) ? from : startOfWeek(currentDay)
    return { name: "reports", from: start, to: DAY_PATTERN.test(to) ? to : addDays(start, 6), user }
  }
  return { name: "week", day: param && DAY_PATTERN.test(param) ? param : currentDay, user }
}

interface RouterValue {
  path: string
  route: Route
  pending: boolean
  navigate: (to: string) => void
}

const RouterContext = createContext<RouterValue | null>(null)

export function Router({ url, children }: { url: string; children: ReactNode }) {
  const [path, setPath] = useState(url)
  const currentDay = today(useNow(30_000))
  const [pending, startTransition] = useTransition()
  useEffect(() => {
    const onPop = () => startTransition(() => setPath(location.pathname + location.search))
    addEventListener("popstate", onPop)
    return () => removeEventListener("popstate", onPop)
  }, [])
  const navigate = useCallback((to: string) => {
    history.pushState(null, "", to)
    startTransition(() => setPath(to))
  }, [])
  const section = path.split(/[/?]/)[1]
  useEffect(() => {
    window.scrollTo({ top: 0 })
  }, [section])
  return <RouterContext value={{ path, route: parseRoute(path, currentDay), pending, navigate }}>{children}</RouterContext>
}

export function useRouter() {
  const router = use(RouterContext)
  if (!router) throw new Error("useRouter needs <Router>")
  return router
}

export function Link({ to, onClick, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const { navigate } = useRouter()
  return (
    <a
      {...props}
      href={to}
      onClick={(event) => {
        onClick?.(event)
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
        event.preventDefault()
        navigate(to)
      }}
    />
  )
}
