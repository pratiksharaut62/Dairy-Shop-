export const DAY = 86400000

export const startOfDay = (d: Date | number = Date.now()) => new Date(new Date(d).setHours(0, 0, 0, 0)).getTime()
export const endOfDay = (d: Date | number = Date.now()) => new Date(new Date(d).setHours(23, 59, 59, 999)).getTime()

export const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
export const fmtDateTime = (ms: number) =>
  new Date(ms).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
export const fmtTime = (ms: number) =>
  new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
export const fmtDayShort = (ms: number) =>
  new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })

export type RangeKey = 'today' | '7d' | '30d' | 'month' | 'all'

export const RANGE_OPTIONS: Array<{ value: RangeKey; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: 'month', label: 'This month' },
  { value: 'all', label: 'All' },
]

export function rangeBounds(key: RangeKey): [number, number] {
  const now = Date.now()
  switch (key) {
    case 'today': return [startOfDay(now), endOfDay(now)]
    case '7d': return [startOfDay(now - 6 * DAY), endOfDay(now)]
    case '30d': return [startOfDay(now - 29 * DAY), endOfDay(now)]
    case 'month': {
      const d = new Date()
      return [new Date(d.getFullYear(), d.getMonth(), 1).getTime(), endOfDay(now)]
    }
    default: return [0, endOfDay(now)]
  }
}

/** Converts a date input value (yyyy-mm-dd) to a timestamp and back. */
export const toInputDate = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60000).toISOString().slice(0, 10)
export const fromInputDate = (s: string) => new Date(s + 'T12:00:00').getTime()
