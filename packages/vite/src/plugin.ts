import { readFile } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import MagicString from "magic-string"
import { parseSync } from "oxc-parser"
import type { Plugin, ViteDevServer } from "vite"

const SERVER_MODULE = /\.lyn\.[cm]?[jt]sx?$/
const SOURCE_FILE = /\.[cm]?[jt]sx?$/
const MODULES_ID = "virtual:lyn/modules"
const TEMPLATE_ID = "virtual:lyn/template"
export const SERVER_ENTRY_ID = "virtual:lyn/server-entry"
const VIRTUAL_IDS = new Set([MODULES_ID, TEMPLATE_ID, SERVER_ENTRY_ID])
const SERVER_ONLY = new Set([
  "@lyn/core",
  "@lyn/hono",
  "@lyn/postgres",
  "@lyn/vite",
  "@lyn/react/server",
  "@hono/node-server",
  "pg",
  "pg-logical-replication",
  "libpg-query",
])

const isPackageImport = (id: string) => !/^[./\0]/.test(id) && !id.startsWith("virtual:") && !isAbsolute(id)

type AstNode = { type: string; start: number; end: number; [key: string]: any }

function walk(node: unknown, visit: (node: AstNode) => boolean | void) {
  if (Array.isArray(node)) return node.forEach((child) => walk(child, visit))
  if (!node || typeof node !== "object") return
  if (typeof (node as AstNode).type === "string" && visit(node as AstNode) === false) return
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
  return `${code}\nimport { __register as __lynRegister } from "@lyn/core";\n__lynRegister(${JSON.stringify(moduleId)}, { ${registrations} });\n`
}

function pruneUnusedImports(code: string, program: AstNode, output: MagicString, removed: AstNode[]) {
  const isRemoved = (node: AstNode) => removed.some((range) => node.start >= range.start && node.end <= range.end)
  const used = new Set<string>()
  walk(program, (node) => {
    if (node.type === "ImportDeclaration" || isRemoved(node)) return false
    if (node.type === "Identifier" || node.type === "JSXIdentifier") used.add(node.name)
  })
  for (const node of program.body as AstNode[]) {
    if (node.type !== "ImportDeclaration" || node.importKind === "type" || !node.specifiers?.length) continue
    const kept = (node.specifiers as AstNode[]).filter((specifier) => used.has(specifier.local.name))
    if (kept.length === node.specifiers.length) continue
    if (!kept.length) {
      output.remove(node.start, node.end)
      continue
    }
    const parts: string[] = []
    const defaultImport = kept.find((specifier) => specifier.type === "ImportDefaultSpecifier")
    const namespaceImport = kept.find((specifier) => specifier.type === "ImportNamespaceSpecifier")
    const named = kept.filter((specifier) => specifier.type === "ImportSpecifier")
    if (defaultImport) parts.push(defaultImport.local.name)
    if (namespaceImport) parts.push(code.slice(namespaceImport.start, namespaceImport.end))
    if (named.length) parts.push(`{ ${named.map((specifier) => code.slice(specifier.start, specifier.end)).join(", ")} }`)
    output.overwrite(node.start, node.end, `import ${parts.join(", ")} from ${code.slice(node.source.start, node.source.end)};`)
  }
}

function liveCalls(code: string, file: string, moduleId: string, ssr: boolean) {
  const { module, program } = parseSync(file, code)
  const liveName = module.staticImports
    .filter((statement) => statement.moduleRequest.value === "@lyn/react")
    .flatMap((statement) => statement.entries)
    .find((entry) => entry.importName.kind === "Name" && entry.importName.name === "live")?.localName.value
  if (!liveName) return null

  const output = new MagicString(code)
  const loaders: AstNode[] = []
  walk(program, (node) => {
    if (node.type !== "CallExpression" || node.callee.type !== "Identifier" || node.callee.name !== liveName) return
    const [loader, component] = node.arguments as AstNode[]
    if (!loader || !component) return
    const id = JSON.stringify(`${moduleId}#${loaders.length}`)
    loaders.push(loader)
    if (ssr) output.appendLeft(component.end, `, ${id}`)
    else output.overwrite(loader.start, loader.end, id)
  })
  if (!loaders.length) return null
  if (!ssr) pruneUnusedImports(code, program as unknown as AstNode, output, loaders)
  return { code: output.toString(), map: output.generateMap({ hires: true, source: file }) }
}

export interface LynPluginOptions {
  server?: string
  clientOutDir?: string
}

type GlobalWithTemplate = typeof globalThis & { __lynTemplate?: (url: string) => Promise<string> }

export function lyn(options: LynPluginOptions = {}): Plugin {
  const serverEntry = options.server ?? "/src/server.ts"
  const clientOutDir = options.clientOutDir ?? "dist/client"
  let root = process.cwd()
  let command: "serve" | "build" = "serve"

  return {
    name: "lyn",
    enforce: "pre",
    config: (_, env) => ({
      optimizeDeps: { include: ["@lyn/react > @lyn/core > devalue", "react-dom/client"] },
      build: env.isSsrBuild ? { rolldownOptions: { external: isPackageImport } } : undefined,
    }),
    configResolved(config) {
      root = config.root
      command = config.command
    },
    configureServer(server: ViteDevServer) {
      ;(globalThis as GlobalWithTemplate).__lynTemplate = async (url) =>
        server.transformIndexHtml(url, await readFile(resolve(root, "index.html"), "utf8"))
    },
    resolveId(id, importer, resolveOptions) {
      if (VIRTUAL_IDS.has(id)) return "\0" + id
      const scanning = (resolveOptions as { scan?: boolean } | undefined)?.scan
      if (scanning && importer && (SERVER_ONLY.has(id) || SERVER_MODULE.test(importer))) return { id, external: true }
      if (!resolveOptions?.ssr && importer && SERVER_ONLY.has(id))
        this.error(
          `lyn: "${id}" is server-only but is imported by browser code in ${relative(root, importer)}. ` +
            `Move server code into a *.lyn.ts module or a live() loader.`,
        )
    },
    async load(id) {
      if (id === "\0" + MODULES_ID)
        return `export default import.meta.glob(["/**/*.lyn.{ts,tsx,js,jsx}", "!**/node_modules/**", "!/dist/**"], { eager: true })`
      if (id === "\0" + SERVER_ENTRY_ID)
        return [
          `import ${JSON.stringify(MODULES_ID)}`,
          `import template from ${JSON.stringify(TEMPLATE_ID)}`,
          `import { setTemplate } from "@lyn/hono"`,
          `import app from ${JSON.stringify(serverEntry)}`,
          `setTemplate(template)`,
          `export default app`,
        ].join("\n")
      if (id === "\0" + TEMPLATE_ID) {
        if (command === "serve") return `export default (url) => globalThis.__lynTemplate(url)\n`
        const html = await readFile(resolve(root, clientOutDir, "index.html"), "utf8")
        return `const html = ${JSON.stringify(html)}\nexport default async () => html\n`
      }
    },
    transform(code, id, transformOptions) {
      const file = id.split("?")[0]!
      if (file.includes("/node_modules/") || file.startsWith("\0") || !SOURCE_FILE.test(file)) return
      const ssr = Boolean(transformOptions?.ssr)
      if (SERVER_MODULE.test(file)) {
        const moduleId = relative(root, file).replace(SERVER_MODULE, "")
        return { code: serverModule(code, file, moduleId, ssr), map: null }
      }
      if (!code.includes("live")) return
      return liveCalls(code, file, relative(root, file).replace(SOURCE_FILE, ""), ssr)
    },
  }
}
