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
  const { module, program } = parseSync(file, code)
  const entries = module.staticExports.flatMap((statement) => statement.entries).filter((entry) => !entry.isType)
  const reexport = entries.find((entry) => entry.moduleRequest)
  if (reexport)
    throw new Error(
      `lyn: ${file} re-exports from "${reexport.moduleRequest!.value}". Server functions must be defined in the *.lyn.ts module that exports them.`,
    )
  const named = entries
    .filter((entry) => entry.exportName.kind === "Name" && entry.localName.name)
    .map((entry) => ({ exported: entry.exportName.name!, local: entry.localName.name! }))
  const defaultExport = (program.body as unknown as AstNode[]).find((node) => node.type === "ExportDefaultDeclaration")

  if (!ssr)
    return [
      ...named.map(({ exported }) => `export const ${exported} = { name: ${JSON.stringify(`${moduleId}:${exported}`)} };`),
      ...(defaultExport ? [`export default { name: ${JSON.stringify(`${moduleId}:default`)} };`] : []),
    ].join("\n")

  const output = new MagicString(code)
  const registrations = named.map(({ exported, local }) => `${JSON.stringify(exported)}: ${local}`)
  if (defaultExport) {
    const declaration = defaultExport.declaration as AstNode
    if (declaration.id?.name) registrations.push(`"default": ${declaration.id.name}`)
    else {
      output.overwrite(defaultExport.start, declaration.start, "const __lynDefault = ")
      output.append("\nexport default __lynDefault;")
      registrations.push(`"default": __lynDefault`)
    }
  }
  output.append(
    `\nimport { __register as __lynRegister } from "@lyn/core";\n__lynRegister(${JSON.stringify(moduleId)}, { ${registrations.join(", ")} });\n`,
  )
  return output.toString()
}

function bindingNames(pattern: AstNode | null | undefined, into: string[] = []): string[] {
  if (!pattern) return into
  if (pattern.type === "Identifier") into.push(pattern.name)
  else if (pattern.type === "ObjectPattern")
    for (const property of pattern.properties as AstNode[]) bindingNames(property.type === "RestElement" ? property.argument : property.value, into)
  else if (pattern.type === "ArrayPattern") for (const element of pattern.elements as AstNode[]) bindingNames(element, into)
  else if (pattern.type === "AssignmentPattern") bindingNames(pattern.left, into)
  else if (pattern.type === "RestElement") bindingNames(pattern.argument, into)
  else if (pattern.type === "TSParameterProperty") bindingNames(pattern.parameter, into)
  return into
}

function declaredIn(statements: AstNode[] = []): string[] {
  return statements.flatMap((statement) => {
    const node = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration" ? statement.declaration : statement
    if (!node) return []
    if (node.type === "VariableDeclaration") return (node.declarations as AstNode[]).flatMap((declarator) => bindingNames(declarator.id))
    if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id) return [node.id.name]
    return []
  })
}

function moduleReferences(program: AstNode, skip: (node: AstNode) => boolean): Set<string> {
  const used = new Set<string>()
  const scopes: Set<string>[] = []
  const reference = (name: string) => {
    if (!scopes.some((scope) => scope.has(name))) used.add(name)
  }
  const inScope = (names: string[], body: () => void) => {
    scopes.push(new Set(names))
    body()
    scopes.pop()
  }
  const visitPattern = (pattern: AstNode | null | undefined): void => {
    if (!pattern) return
    if (pattern.type === "AssignmentPattern") {
      visitPattern(pattern.left)
      visit(pattern.right)
    } else if (pattern.type === "ObjectPattern")
      for (const property of pattern.properties as AstNode[]) {
        if (property.type === "RestElement") visitPattern(property.argument)
        else {
          if (property.computed) visit(property.key)
          visitPattern(property.value)
        }
      }
    else if (pattern.type === "ArrayPattern") (pattern.elements as AstNode[]).forEach(visitPattern)
    else if (pattern.type === "RestElement") visitPattern(pattern.argument)
    else if (pattern.type === "TSParameterProperty") visitPattern(pattern.parameter)
    else if (pattern.type !== "Identifier") visit(pattern)
  }
  const visitJsxName = (name: AstNode): void => {
    if (name.type === "JSXIdentifier") reference(name.name)
    else if (name.type === "JSXMemberExpression") visitJsxName(name.object)
  }
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== "object") return
    const current = node as AstNode
    if (typeof current.type !== "string" || skip(current)) return
    switch (current.type) {
      case "ImportDeclaration":
      case "BreakStatement":
      case "ContinueStatement":
        return
      case "Identifier":
        return reference(current.name)
      case "JSXOpeningElement":
        if (current.name.type !== "JSXIdentifier" || /^[A-Z_$]/.test(current.name.name)) visitJsxName(current.name)
        return visit(current.attributes)
      case "JSXClosingElement":
        return
      case "JSXAttribute":
        return visit(current.value)
      case "MemberExpression":
        visit(current.object)
        if (current.computed) visit(current.property)
        return
      case "Property":
      case "MethodDefinition":
      case "PropertyDefinition":
      case "AccessorProperty":
        if (current.computed) visit(current.key)
        return visit(current.value)
      case "LabeledStatement":
        return visit(current.body)
      case "VariableDeclarator":
        visitPattern(current.id)
        return visit(current.init)
      case "ExportNamedDeclaration":
        if (current.source) return
        visit(current.declaration)
        return (current.specifiers as AstNode[]).forEach((specifier) => visit(specifier.local))
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        const body = current.body as AstNode | null
        const names = [
          ...(current.params as AstNode[]).flatMap((param) => bindingNames(param)),
          ...(current.type === "FunctionExpression" && current.id ? [current.id.name] : []),
          ...(body?.type === "BlockStatement" ? declaredIn(body.body) : []),
        ]
        return inScope(names, () => {
          ;(current.params as AstNode[]).forEach(visitPattern)
          if (body?.type === "BlockStatement") visit(body.body)
          else visit(body)
        })
      }
      case "ClassDeclaration":
      case "ClassExpression":
        visit(current.superClass)
        return visit(current.body)
      case "BlockStatement":
      case "StaticBlock":
        return inScope(declaredIn(current.body), () => visit(current.body))
      case "CatchClause":
        return inScope(bindingNames(current.param), () => visit(current.body))
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        const head = (current.init ?? current.left) as AstNode | null
        const names = head?.type === "VariableDeclaration" ? declaredIn([head]) : []
        return inScope(names, () => {
          for (const [key, value] of Object.entries(current)) if (key !== "type") visit(value)
        })
      }
      case "SwitchStatement":
        visit(current.discriminant)
        return inScope(
          (current.cases as AstNode[]).flatMap((switchCase) => declaredIn(switchCase.consequent)),
          () => visit(current.cases),
        )
      default:
        for (const [key, value] of Object.entries(current)) if (key !== "type" && value && typeof value === "object") visit(value)
    }
  }
  visit(program.body)
  return used
}

function pruneUnusedImports(code: string, program: AstNode, output: MagicString, removed: AstNode[]) {
  const used = moduleReferences(program, (node) => removed.includes(node))
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
    const namedImports = kept.filter((specifier) => specifier.type === "ImportSpecifier")
    if (defaultImport) parts.push(defaultImport.local.name)
    if (namespaceImport) parts.push(code.slice(namespaceImport.start, namespaceImport.end))
    if (namedImports.length) parts.push(`{ ${namedImports.map((specifier) => code.slice(specifier.start, specifier.end)).join(", ")} }`)
    output.overwrite(node.start, node.end, `import ${parts.join(", ")} from ${code.slice(node.source.start, node.source.end)};`)
  }
}

const INLINE_FUNCTION = new Set(["ArrowFunctionExpression", "FunctionExpression"])

function liveCalls(code: string, file: string, moduleId: string, ssr: boolean) {
  const { module, program } = parseSync(file, code)
  const entries = module.staticImports.filter((statement) => statement.moduleRequest.value === "@lyn/react").flatMap((statement) => statement.entries)
  const liveNames = new Set(
    entries.filter((entry) => entry.importName.kind === "Name" && entry.importName.name === "live").map((entry) => entry.localName.value),
  )
  const namespaces = new Set(entries.filter((entry) => entry.importName.kind === "NamespaceObject").map((entry) => entry.localName.value))
  if (!liveNames.size && !namespaces.size) return null
  const isLive = (callee: AstNode) =>
    (callee.type === "Identifier" && liveNames.has(callee.name)) ||
    (callee.type === "MemberExpression" &&
      !callee.computed &&
      callee.object.type === "Identifier" &&
      namespaces.has(callee.object.name) &&
      callee.property.name === "live")

  const output = new MagicString(code)
  const loaders: AstNode[] = []
  walk(program, (node) => {
    if (node.type !== "CallExpression" || !isLive(node.callee)) return
    const [loader, component] = node.arguments as AstNode[]
    if (!loader || !component) return
    if (!INLINE_FUNCTION.has(loader.type))
      throw new Error(
        `lyn: ${file}: pass the live() loader inline as a function so its server code can be removed from the browser bundle.`,
      )
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
        return `export default import.meta.glob(["/**/*.lyn.{ts,tsx,mts,cts,js,jsx,mjs,cjs}", "!**/node_modules/**", "!/dist/**"], { eager: true })`
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
