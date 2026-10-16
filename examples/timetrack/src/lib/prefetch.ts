import type { LynClient } from "@lyn/react"
import * as catalog from "../catalog.lyn"
import * as entries from "../entries.lyn"
import * as reports from "../reports.lyn"
import * as team from "../team.lyn"
import type { Route } from "./router"
import { startOfWeek } from "./time"

export function prefetchRoute(client: LynClient, route: Route) {
  client.prefetch(team.me)
  client.prefetch(team.members)
  client.prefetch(team.workingNow)
  client.prefetch(entries.recentAlerts)
  client.prefetch(entries.running)
  client.prefetch(catalog.pickable)
  switch (route.name) {
    case "week":
      client.prefetch(entries.week, { userId: route.user, start: startOfWeek(route.day) })
      break
    case "month":
      client.prefetch(entries.month, { userId: route.user, month: route.month })
      break
    case "projects":
      if (route.projectId) client.prefetch(catalog.detail, { projectId: route.projectId })
      else {
        client.prefetch(catalog.overview)
        client.prefetch(catalog.people)
      }
      break
    case "reports":
      client.prefetch(reports.summary, { from: route.from, to: route.to, userId: route.user ?? null })
      break
  }
}
