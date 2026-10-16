export const ZONE = "Europe/Oslo"

export type Day = string

const partsFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
})

const DAY_MS = 86_400_000
const dayOffsets = new Map<number, number | null>()

function exactOffset(time: number) {
  const parts = Object.fromEntries(partsFormat.formatToParts(new Date(time)).map((part) => [part.type, Number(part.value)]))
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - (time - (time % 1000))
}

function zoneOffset(time: number) {
  const utcDay = Math.floor(time / DAY_MS)
  let offset = dayOffsets.get(utcDay)
  if (offset === undefined) {
    const start = exactOffset(utcDay * DAY_MS)
    offset = start === exactOffset((utcDay + 1) * DAY_MS - 1000) ? start : null
    if (dayOffsets.size > 10_000) dayOffsets.clear()
    dayOffsets.set(utcDay, offset)
  }
  return offset ?? exactOffset(time)
}

function wallClock(date: Date) {
  const shifted = new Date(date.getTime() + zoneOffset(date.getTime()))
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  }
}

const pad = (value: number) => String(value).padStart(2, "0")

export function dayOf(date: Date): Day {
  const clock = wallClock(date)
  return `${clock.year}-${pad(clock.month)}-${pad(clock.day)}`
}

export function minutesOf(date: Date) {
  const clock = wallClock(date)
  return clock.hour * 60 + clock.minute + clock.second / 60
}

const utcOf = (day: Day) => {
  const [year, month, date] = day.split("-").map(Number)
  return Date.UTC(year!, month! - 1, date!)
}

const fromUtc = (time: number): Day => new Date(time).toISOString().slice(0, 10)

export const addDays = (day: Day, count: number): Day => fromUtc(utcOf(day) + count * 86_400_000)

export const weekday = (day: Day) => (new Date(utcOf(day)).getUTCDay() + 6) % 7

export const startOfWeek = (day: Day): Day => addDays(day, -weekday(day))

export const monthOf = (day: Day) => day.slice(0, 7)

export const startOfMonth = (month: string): Day => `${month}-01`

export function addMonths(month: string, count: number) {
  const [year, index] = month.split("-").map(Number)
  const date = new Date(Date.UTC(year!, index! - 1 + count, 1))
  return date.toISOString().slice(0, 7)
}

export function daysInMonth(month: string): Day[] {
  const days: Day[] = []
  for (let day = startOfMonth(month); monthOf(day) === month; day = addDays(day, 1)) days.push(day)
  return days
}

export function instant(day: Day, minutes: number): Date {
  const target = utcOf(day) + minutes * 60_000
  let guess = target
  for (let i = 0; i < 3; i++) {
    const clock = wallClock(new Date(guess))
    const shown = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second)
    guess += target - shown
  }
  return new Date(guess)
}

const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
const dayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
const longDayFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" })
const monthFormat = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long", year: "numeric" })

export const formatTime = (date: Date) => timeFormat.format(date)
export const formatDay = (day: Day) => dayFormat.format(new Date(utcOf(day)))
export const formatLongDay = (day: Day) => longDayFormat.format(new Date(utcOf(day)))
export const formatMonth = (month: string) => monthFormat.format(new Date(utcOf(startOfMonth(month))))

export function formatHours(hours: number) {
  const minutes = Math.round(hours * 60)
  return `${Math.floor(minutes / 60)}:${pad(minutes % 60)}`
}

export function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`
}

export const today = (now: number) => dayOf(new Date(now))

export const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/
export const MONTH_PATTERN = /^\d{4}-\d{2}$/
