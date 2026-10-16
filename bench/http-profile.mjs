import fs from 'node:fs'

const [profilePath, resultPath] = process.argv.slice(2)
if (!profilePath || !resultPath) throw Error('usage: node bench/http-profile.mjs PROFILE RESULT_JSONL')
const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'))
const result = fs.readFileSync(resultPath, 'utf8').trim().split('\n').map(JSON.parse).find(row => row.profileWindow)
if (!result) throw Error('Result has no monotonic profileWindow')
const { startUs, endUs } = result.profileWindow
const nodes = new Map(profile.nodes.map(node => [node.id, node]))
const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(id => [id, node.id])))
const self = new Map(), inclusive = new Map(), files = new Map(), categories = new Map()
let timestamp = profile.startTime, total = 0, idle = 0, samples = 0
const add = (map, key, weight) => map.set(key, (map.get(key) ?? 0) + weight)
const label = node => `${node.callFrame.functionName || '(anonymous)'} ${node.callFrame.url}:${node.callFrame.lineNumber + 1}`
for (let i = 0; i < profile.samples.length; i++) {
  const delta = profile.timeDeltas[i]
  const from = timestamp
  timestamp += delta
  const weight = Math.max(0, Math.min(timestamp, endUs) - Math.max(from, startUs))
  if (!weight) continue
  samples++
  const id = profile.samples[i], node = nodes.get(id)
  total += weight
  if (node.callFrame.functionName === '(idle)') { idle += weight; continue }
  add(self, label(node), weight)
  add(files, node.callFrame.url || node.callFrame.functionName, weight)
  const stack = []
  for (let at = id; at !== undefined; at = parents.get(at)) stack.push(nodes.get(at).callFrame)
  const has = pattern => stack.some(frame => pattern.test(frame.url + ' ' + frame.functionName))
  for (const [category, matches] of Object.entries({
    devalueInclusive: has(/devalue/),
    readTrackerInclusive: has(/packages\/postgres\/src\/reads.ts/),
    keyedDiffInclusive: stack.some(frame => frame.functionName === 'diffRows'),
    drizzleInclusive: has(/drizzle-orm/),
    reactRendererInclusive: has(/react-dom-server/),
    wallClockInclusive: stack.some(frame => frame.functionName === 'wallClock'),
    instantInclusive: stack.some(frame => frame.functionName === 'instant'),
    socketWriteSelf: ['writev', 'writeBuffer'].includes(node.callFrame.functionName),
    httpSocketWriteSelf: ['writev', 'writeBuffer'].includes(node.callFrame.functionName) && has(/node:_http_outgoing/),
    pgSocketWriteSelf: ['writev', 'writeBuffer'].includes(node.callFrame.functionName) && has(/node_modules\/pg\//),
  })) if (matches) add(categories, category, weight)
  const seen = new Set()
  for (let at = id; at !== undefined; at = parents.get(at)) {
    const key = label(nodes.get(at))
    if (!seen.has(key)) add(inclusive, key, weight)
    seen.add(key)
  }
}
if (!samples) throw Error('Profile does not overlap the measurement window')
const rows = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 35).map(([name, us]) => ({ name, milliseconds: us / 1000, percentActive: 100 * us / (total - idle), percentWindow: 100 * us / total }))
console.log(JSON.stringify({profilePath, resultPath, samples, windowMs: total / 1000, idlePercent: 100 * idle / total, categories: rows(categories), self: rows(self), inclusive: rows(inclusive), files: rows(files)}, null, 2))
