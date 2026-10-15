import {
  createContext,
  createElement,
  use,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react"
import { hydrateRoot } from "react-dom/client"
import type { ActionRef, MutationRef, QueryCtx, QueryRef } from "@lyn/core"
import { registry } from "@lyn/core/registry"
import { LynClient, type OptimisticUpdate } from "./client.ts"

export { LynClient, uuid, type OptimisticStore, type OptimisticUpdate } from "./client.ts"

const LynContext = createContext<LynClient | null>(null)

export function LynProvider({ client, children }: { client: LynClient; children?: ReactNode }) {
  return createElement(LynContext.Provider, { value: client }, children)
}

export function useLyn(): LynClient {
  const client = useContext(LynContext)
  if (!client) throw new Error("lyn: wrap your app in <LynProvider>")
  return client
}

type ArgsParam<A> = Record<string, never> extends A ? [args?: A] : [args: A]

export function useQuery<A, R>(query: QueryRef<A, R>, ...[args]: ArgsParam<A>): Awaited<R> {
  const client = useLyn()
  const entry = client.entry(query.name, args ?? {})
  useEffect(() => client.retain(entry), [client, entry])
  const snapshot = useSyncExternalStore(entry.subscribe, () => entry.snapshot, () => entry.snapshot)
  use(entry.ready)
  if (snapshot.error) throw snapshot.error
  return snapshot.value as Awaited<R>
}

export function useMutation<A, R>(
  mutation: MutationRef<A, R>,
  options: { optimistic?: OptimisticUpdate<A> } = {},
): (...args: ArgsParam<A>) => Promise<Awaited<R>> {
  const client = useLyn()
  const optimistic = useRef(options.optimistic)
  optimistic.current = options.optimistic
  return useCallback(
    (...[args]: ArgsParam<A>) => client.mutate(mutation.name, args ?? ({} as A), optimistic.current),
    [client, mutation.name],
  ) as any
}

export function useAction<A, R>(action: ActionRef<A, R>): (...args: ArgsParam<A>) => Promise<Awaited<R>> {
  const client = useLyn()
  return useCallback((...[args]: ArgsParam<A>) => client.action(action.name, args ?? {}), [client, action.name]) as any
}

type Resolved<R> = { [K in keyof R]: Awaited<R[K]> }

function serializableProps(props: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(props).filter(
      ([key, value]) =>
        key !== "children" && typeof value !== "function" && !(value && typeof value === "object" && "$$typeof" in value),
    ),
  )
}

export function live<P extends object, R extends object>(
  loader: (ctx: QueryCtx, props: P) => R | Promise<R>,
  Component: (props: P & Resolved<R>) => ReactNode,
): ComponentType<P>
export function live(loaderOrId: unknown, Component: ComponentType<any>, compiledId?: string): ComponentType<any> {
  const id = typeof loaderOrId === "string" ? loaderOrId : compiledId
  if (!id) throw new Error("lyn: live() needs the lyn Vite plugin")
  if (typeof loaderOrId === "function") registry.set(id, { kind: "query", name: id, handler: loaderOrId as any })
  const query: QueryRef = { name: id }
  function Live(props: Record<string, unknown>) {
    const data = useQuery(query, serializableProps(props))
    return createElement(Component, { ...props, ...data })
  }
  Live.displayName = `live(${Component.displayName || Component.name || "Component"})`
  return Live
}

declare global {
  interface Window {
    __LYN_STATE__?: string
    __LYN_BASE__?: string
  }
}

export function hydrate(
  App: ComponentType<{ url: string }>,
  options: { container?: Element; baseUrl?: string } = {},
) {
  const container = options.container ?? document.getElementById("root")!
  const client = new LynClient({ initial: window.__LYN_STATE__, baseUrl: options.baseUrl ?? window.__LYN_BASE__ ?? "" })
  hydrateRoot(container, createElement(LynProvider, { client }, createElement(App, { url: location.pathname + location.search })))
  return client
}
