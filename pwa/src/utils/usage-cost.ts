import type { HistoryAgent, UsageBucket } from '../hooks/use-mux-api'
import type { Locale } from '../i18n'

// Token totals and their estimated cost, as the overview, the history and
// an old session's transcript show them. The server sends 15-minute buckets
// in UTC; the days are this device's own.

// A total of tokens and their cost. priced: some of the tokens have a price
// (cost is then theirs); unpriced: tokens of models without one.
export interface UsageTotal {
  tokens: number
  cost: number
  priced: boolean
  unpriced: number
}

export interface AgentUsageDays {
  today: UsageTotal
  week: UsageTotal
}

const empty = (): UsageTotal => ({
  tokens: 0,
  cost: 0,
  priced: false,
  unpriced: 0,
})

// The calendar day (YYYY-MM-DD) of ms in timeZone.
function dayOf(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(ms)
}

// The day before day, n times, as a calendar date (no time zone in it).
function daysBefore(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10)
}

// Folds the buckets into today and the 7 days to today (today in), by
// agent, in timeZone (the device's when not given). An agent with no tokens
// in the 7 days is left out.
export function foldBuckets(
  buckets: readonly UsageBucket[],
  now: number,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): Partial<Record<HistoryAgent, AgentUsageDays>> {
  const today = dayOf(now, timeZone)
  const first = daysBefore(today, 6)
  const out: Partial<Record<HistoryAgent, AgentUsageDays>> = {}
  for (const b of buckets) {
    const at = Date.parse(b.t)
    if (!Number.isFinite(at)) continue
    const day = dayOf(at, timeZone)
    if (day < first || day > today) continue
    let a = out[b.agent]
    if (!a) {
      a = { today: empty(), week: empty() }
      out[b.agent] = a
    }
    add(a.week, b.tokens, b.costUsd, b.unpricedTokens)
    if (day === today) add(a.today, b.tokens, b.costUsd, b.unpricedTokens)
  }
  return out
}

function add(
  t: UsageTotal,
  tokens: number,
  cost: number | undefined,
  unpriced = 0,
) {
  t.tokens += tokens
  t.unpriced += unpriced
  if (cost !== undefined) {
    t.cost += cost
    t.priced = true
  }
}

// A token count, short: 950, 1.2k, 35k, 1.2M (the decimal mark the
// locale's).
export function formatTokenCount(n: number, locale: Locale): string {
  const short = (v: number, digits: number) =>
    new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(v)
  if (n < 1000) return short(n, 0)
  if (n < 10_000) return `${short(n / 1000, 1)}k`
  if (n < 1_000_000) return `${short(Math.round(n / 1000), 0)}k`
  return `${short(n / 1_000_000, 1)}M`
}

// An estimated cost: "~$3.40" ("~3,40 US$" in Vietnamese), "<$0.01" below a
// cent, and "+" after it when some tokens had no price.
export function formatCost(
  usd: number,
  locale: Locale,
  partial = false,
): string {
  const money = (v: number) =>
    new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(v)
  const text = usd > 0 && usd < 0.01 ? `<${money(0.01)}` : `~${money(usd)}`
  return partial ? `${text}+` : text
}

// The price table's date (YYYY-MM-DD) in the locale's words; as given when
// it is no date.
export function formatPriceDate(day: string, locale: Locale): string {
  const at = Date.parse(`${day}T00:00:00Z`)
  if (!Number.isFinite(at)) return day
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(at)
}
