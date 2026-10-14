import { relative } from "node:path"
import MagicString from "magic-string"
import { parseSync } from "oxc-parser"
import type { Plugin } from "vite"

const SERVER_MODULE = /\.lyn\.[cm]?[jt]sx?$/
const SOURCE_FILE = /\.[cm]?[jt]sx?$/
const MODULES_ID = "virtual:lyn/modules"

type AstNode = { type: string; start: number; end: number; [key: string]: any }

function walk(node: unknown, visit: (node: AstNode) => void) {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit))
  if (!node || typeof node !== "object") return
  if (typeof (node as AstNode).type === "string") visit(node as AstNode)
  for (const value of Object.values(node)) if (value && typeof value === "object") walk(value, visit)
}

function serverModule(code: string, file: string, moduleId: string, ssr: boolean) {
  const { module } = parseSync(file, code)
  const exports = module.staticExports
    .flatMap((statement) => statement.entries)
    .filter((entry) => !entry.isType && !entry.moduleRequest && entry.exportName.kind === "Name" && entry.localName.name)
    .map((entry) => ({ exported: entry.exportName.name!, local: entry.localName.name! }))

  if (!ssr)
    return exports
      .map(({ exported }) => `export const ${exported} = { name: ${JSON.stringify(`${moduleId}:${exported}`)} };`)
      .join("\n")

  const registrations = exports.map(({ exported, local }) => `${JSON.stringify(exported)}: ${local}`).join(", ")
  return `${code}\nimport { __register as __lynRegister } from "lyn/server";\n__lynRegister(${JSON.stringify(moduleId)}, { ${registrations} });\n`
}

function liveCalls(code: string, file: string, moduleId: string, ssr: boolean) {
  const { module, program } = parseSync(file, code)
  const liveName = module.staticImports
    .filter((statement) => statement.moduleRequest.value === "lyn")
    .flatMap((statement) => statement.entries)
    .find((entry) => entry.importName.kind === "Name" && entry.importName.name === "live")?.localName.value
  if (!liveName) return null

  const output = new MagicString(code)
  let index = 0
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== liveName) return
    const [loader, component] = node.arguments as AstNode[]
    if (!loader || !component) return
    const id = JSON.stringify(`${moduleId}#${index++}`)
    if (ssr) output.appendLeft(component.end, `, ${id}`)
    else output.overwrite(loader.start, loader.end, id)
  })
  if (!index) return null
  return { code: output.toString(), map: output.generateMap({ hires: true, source: file }) }
}

export function lyn(): Plugin {
  let root = process.cwd()
  return {
    name: "lyn",
    enforce: "pre",
    config: () => ({
      ssr: { external: ["lyn"] },
      optimizeDeps: { exclude: ["lyn"], include: ["lyn > devalue", "react-dom/client"] },
    }),
    configResolved(config) {
      root = config.root
    },
    resolveId(id) {
      if (id === MODULES_ID) return "\0" + MODULES_ID
    },
    load(id) {
      if (id === "\0" + MODULES_ID)
        return `export default import.meta.glob(["/**/*.lyn.{ts,tsx,js,jsx}", "!**/node_modules/**"], { eager: true })`
    },
    transform(code, id, options) {
      const file = id.split("?")[0]!
      if (file.includes("/node_modules/") || file.startsWith("\0") || !SOURCE_FILE.test(file)) return
      const ssr = Boolean(options?.ssr)
      if (SERVER_MODULE.test(file)) {
        const moduleId = relative(root, file).replace(SERVER_MODULE, "")
        return { code: serverModule(code, file, moduleId, ssr), map: null }
      }
      if (!code.includes("live")) return
      return liveCalls(code, file, relative(root, file).replace(SOURCE_FILE, ""), ssr)
    },
  }
}
