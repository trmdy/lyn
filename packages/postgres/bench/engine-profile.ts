import { readFile } from 'node:fs/promises'

const [profileFile, resultFile] = process.argv.slice(2)
if (!profileFile) throw new Error('usage: node engine-profile.ts profile.cpuprofile [result.json]')
const profile = JSON.parse(await readFile(profileFile, 'utf8'))
const window = resultFile ? JSON.parse(await readFile(resultFile, 'utf8')) : undefined
const nodes = new Map<number, any>(profile.nodes.map((node: any) => [node.id, node]))
const parents = new Map<number, number>()
for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id)
const self = new Map<string, number>(), inclusive = new Map<string, number>()
const key = (id: number) => {
  const f = nodes.get(id).callFrame
  return `${f.functionName || '(anonymous)'} ${f.url}:${f.lineNumber + 1}`
}
const add = (map: Map<string, number>, key: string, dt: number) => map.set(key, (map.get(key) ?? 0) + dt)
let at = profile.startTime, total = 0
for (let i = 0; i < profile.samples.length; i++) {
  const dt = profile.timeDeltas[i]
  at += dt
  if (window && (at < window.startHrUs || at > window.endHrUs)) continue
  let id: number | undefined = profile.samples[i]
  total += dt
  add(self, key(id!), dt)
  const seen = new Set<string>()
  while (id !== undefined) {
    const frame = key(id)
    if (!seen.has(frame)) add(inclusive, frame, dt)
    seen.add(frame)
    id = parents.get(id)
  }
}
const ranked = (map: Map<string, number>) => [...map].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([frame, us]) => ({ frame, percent: Math.round(us / total * 10000) / 100 }))
console.log(JSON.stringify({ sampledSeconds: total / 1e6, window: window ? [window.startHrUs, window.endHrUs] : null, self: ranked(self), inclusive: ranked(inclusive) }, null, 2))
