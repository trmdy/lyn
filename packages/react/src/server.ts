import { createElement, type ComponentType } from "react"
import { prerender } from "react-dom/static"
import { LynClient, LynProvider } from "./index.ts"

export async function renderPage(
  App: ComponentType<{ url: string }>,
  options: { url: string; runQuery: (name: string, args: unknown) => Promise<unknown> },
) {
  const client = new LynClient({ fetchQuery: options.runQuery })
  const { prelude } = await prerender(createElement(LynProvider, { client }, createElement(App, { url: options.url })))
  const body = await new Response(prelude).text()
  const state = JSON.stringify(client.dehydrate()).replace(/</g, "\\u003c")
  return { body, head: `<script>window.__LYN_STATE__=${state}</script>` }
}
