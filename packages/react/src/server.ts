import { createElement, type ComponentType } from "react"
import { prerender } from "react-dom/static"
import { LynClient, LynProvider } from "./index.ts"

export async function renderPage(
  App: ComponentType<{ url: string }>,
  options: { url: string; baseUrl?: string; runQuery: (name: string, args: unknown) => Promise<unknown> },
) {
  const client = new LynClient({ fetchQuery: options.runQuery })
  const { prelude } = await prerender(createElement(LynProvider, { client }, createElement(App, { url: options.url })))
  const body = await new Response(prelude).text()
  const script = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c")
  const base = options.baseUrl ? `window.__LYN_BASE__=${script(options.baseUrl)};` : ""
  return { body, head: `<script>${base}window.__LYN_STATE__=${script(client.dehydrate())}</script>` }
}
