import { useMemo, useSyncExternalStore } from "react"
import { useLyn } from "./index.ts"

export function useNow(intervalMs = 1000): number {
  const { renderTime } = useLyn()
  const clock = useMemo(() => {
    let now = Date.now()
    return {
      snapshot: () => now,
      subscribe: (listener: () => void) => {
        const tick = () => {
          now = Date.now()
          listener()
        }
        tick()
        const timer = setInterval(tick, intervalMs)
        return () => clearInterval(timer)
      },
    }
  }, [intervalMs])
  return useSyncExternalStore(clock.subscribe, clock.snapshot, () => renderTime)
}
