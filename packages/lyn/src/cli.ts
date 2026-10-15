#!/usr/bin/env node
import { build } from "vite"

const [command] = process.argv.slice(2)

if (command !== "build") {
  console.error("usage: lyn build")
  process.exit(1)
}

const root = process.cwd()
process.env.NODE_ENV = "production"

await build({ root, build: { outDir: "dist/client", emptyOutDir: true } })
await build({
  root,
  build: {
    ssr: true,
    outDir: "dist/server",
    emptyOutDir: true,
    rolldownOptions: { input: { entry: "virtual:lyn/server-entry" } },
  },
})
