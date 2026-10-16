import { LynError, publicMessage } from "@lyn/core"
import { encode } from "@lyn/core/wire"
import { createElement, type ComponentType } from "react"
import { renderToReadableStream } from "react-dom/server"
import { LynClient, LynProvider } from "./index.ts"

const script = (value: string) => JSON.stringify(value).replace(/</g, "\\u003c")
const voidTag = /^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/i
const rawTag = /^(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)$/i

function htmlSegments() {
  let html = ""
  let position = 0
  let depth = 0
  let raw = ""
  return (chunk: string) => {
    html += chunk
    let end = 0
    while (position < html.length) {
      if (raw) {
        const close = new RegExp(`</${raw}\\s*>`, "ig")
        close.lastIndex = position
        const match = close.exec(html)
        if (!match) break
        position = close.lastIndex
        raw = ""
        depth--
      } else {
        const start = html.indexOf("<", position)
        if (start < 0) break
        let stop: number
        if (html.startsWith("<!--", start)) {
          stop = html.indexOf("-->", start + 4)
          if (stop < 0) break
          const marker = html.slice(start + 4, stop)
          if (/^\$[?!]?$/.test(marker)) depth++
          else if (marker === "/$") depth--
          stop += 3
        } else {
          const tag = /^<([^>"']|"[^"]*"|'[^']*')*>/.exec(html.slice(start))
          if (!tag) break
          stop = start + tag[0].length
          const name = /^<(\/?)([a-z][\w:-]*)/i.exec(tag[0])
          if (name) {
            if (name[1]) depth--
            else if (!voidTag.test(name[2]!) && !tag[0].endsWith("/>")) {
              depth++
              if (rawTag.test(name[2]!)) raw = name[2]!
            }
          }
        }
        position = stop
      }
      if (!depth) end = position
    }
    const complete = html.slice(0, end)
    html = html.slice(end)
    position -= end
    return { complete, remaining: html }
  }
}

export async function renderPage(
  App: ComponentType<{ url: string }>,
  options: { url: string; baseUrl?: string; signal?: AbortSignal; runQuery: (name: string, args: unknown) => Promise<unknown> },
) {
  let pending: string[] = []
  const client = new LynClient({
    fetchQuery: async (name, args) => {
      try {
        const value = await options.runQuery(name, args)
        pending.push(encode([[name, args, value]]))
        return value
      } catch (error) {
        const message = publicMessage(error)
        pending.push(encode([[name, args, undefined, message]]))
        throw new LynError(message)
      }
    },
  })
  const rendered = await renderToReadableStream(createElement(LynProvider, { client }, createElement(App, { url: options.url })), {
    signal: options.signal,
    onError: publicMessage,
  })
  const reader = rendered.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const segments = htmlSegments()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { value, done } = await reader.read()
          const { complete, remaining } = segments(decoder.decode(value, { stream: !done }))
          if (!complete && !done) continue
          const data = pending.map((entry) => `<script>window.__LYN_QUEUE__.push(${script(entry)})</script>`).join("")
          pending = []
          controller.enqueue(encoder.encode(data + complete + (done ? remaining : "")))
          if (done) controller.close()
          return
        }
      } catch (error) {
        controller.error(error)
        await reader.cancel(error)
      }
    },
    cancel: (reason) => reader.cancel(reason),
  })
  const base = options.baseUrl ? `window.__LYN_BASE__=${script(options.baseUrl)};` : ""
  return { body, head: `<script>${base}window.__LYN_QUEUE__=[];</script>` }
}
