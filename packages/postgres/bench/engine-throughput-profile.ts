import { readFileSync } from 'node:fs'

const [file, logFile] = process.argv.slice(2)
if (!file || !logFile) throw Error('usage: node engine-throughput-profile.ts capture.cpuprofile trial.jsonl')
const profile = JSON.parse(readFileSync(file, 'utf8'))
const records = readFileSync(logFile, 'utf8').split('\n').flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
const start = records.find(r => r.ready)?.profileStartUs ?? profile.startTime
const end = records.find(r => r.mode === 'sustain')?.profileEndUs ?? profile.endTime
const nodes = new Map<number, any>(profile.nodes.map((node: any) => [node.id, node]))
const parent = new Map<number, number>()
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
const self = new Map<string, number>()
const inclusive = new Map<string, number>()
const key = (id: number) => { const f = nodes.get(id).callFrame; return `${f.functionName || '(anonymous)'} ${f.url}:${f.lineNumber + 1}` }
let time = profile.startTime, total = 0
for (let i = 0; i < profile.samples.length; i++) {
  const delta = profile.timeDeltas[i]
  time += delta
  if (time < start || time > end) continue
  total += delta
  const id = profile.samples[i]
  self.set(key(id), (self.get(key(id)) ?? 0) + delta)
  const ancestors = new Set<string>()
  for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) ancestors.add(key(at))
  for (const name of ancestors) inclusive.set(name, (inclusive.get(name) ?? 0) + delta)
}
for (const [kind, values] of [['self', self], ['inclusive', inclusive]] as const) {
  console.log(JSON.stringify({kind, totalMs: total / 1000, top: [...values].sort((a,b) => b[1]-a[1]).slice(0,25).map(([name,us]) => ({name,percent:100*us/total,ms:us/1000}))}))
}
