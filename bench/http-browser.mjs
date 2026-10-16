import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../examples/timetrack/package.json', import.meta.url))
const { Pool } = require('pg')
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const base = process.env.BASE_URL ?? 'http://127.0.0.1:14501'
const output = process.env.RESULTS_DIR ?? '/tmp/lyn-perf-http'
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH })
const errors = []
try {
  const user = (await pool.query("select id from users where name='Ada'")).rows[0]
  const entry = (await pool.query("select id from time_entries where user_id=$1 and started_at >= '2026-10-12' and ended_at < '2026-10-19' order by started_at limit 1", [user.id])).rows[0]
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } })
  const login = await context.request.post(base + '/login', { data: { userId: user.id } })
  if (login.status() !== 204) throw Error('Login failed')
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  const subscribed = page.waitForResponse(response => response.url().endsWith('/_lyn/subscribe') && response.status() === 200)
  const response = await page.goto(base + '/week/2026-10-12', { waitUntil: 'domcontentloaded' })
  if (response.status() !== 200) throw Error('SSR failed')
  await subscribed
  const token = 'browser-sql-' + process.pid
  await pool.query('update time_entries set description=$1 where id=$2', [token, entry.id])
  await page.getByText(token, { exact: true }).waitFor()
  await page.getByText(token, { exact: true }).click()
  const next = 'browser-ui-' + process.pid
  await page.getByLabel('Description', { exact: true }).fill(next)
  const mutation = page.waitForResponse(response => response.url().endsWith('/_lyn/mutate'))
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  if ((await mutation).status() !== 200) throw Error('Mutation failed')
  await page.getByText(next, { exact: true }).waitFor()
  const final = (await pool.query('select description from time_entries where id=$1', [entry.id])).rows[0].description
  if (final !== next) throw Error('UI update did not persist')
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByText(next, { exact: true }).waitFor()
  await page.screenshot({ path: output + '/browser-week.png', fullPage: true })
  if (errors.length) throw Error(JSON.stringify(errors))
  const result = { signedInSSR: true, hydration: true, directSQLToDOM: true, uiMutationPersisted: true, reloadVerified: true, browserErrors: errors }
  fs.writeFileSync(output + '/browser.json', JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
  await pool.end()
}
