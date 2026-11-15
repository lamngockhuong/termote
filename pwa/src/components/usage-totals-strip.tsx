import { agentLabel } from '../chat-agents'
import type { HistoryAgent, UsageSummary } from '../hooks/use-mux-api'
import { useSettings } from '../hooks/use-settings'
import { useT } from '../i18n/i18n-context'
import {
  foldBuckets,
  formatCost,
  formatPriceDate,
  formatTokenCount,
  type UsageTotal,
} from '../utils/usage-cost'

interface Props {
  summary?: UsageSummary
  // Device time (ms): today is this device's
  now: number
  className?: string
}

const AGENTS: HistoryAgent[] = ['claude', 'codex']

// Today's tokens and the last 7 days', one line per agent (Claude Code,
// Codex), with their estimated cost unless Settings turns it off. Nothing
// before the first read, nor without tokens in the 7 days.
export function UsageTotalsStrip({ summary, now, className = '' }: Props) {
  const { t, locale } = useT()
  const { settings } = useSettings()
  if (!summary) return null
  const days = foldBuckets(summary.buckets, now)
  const agents = AGENTS.filter((a) => days[a])
  if (agents.length === 0) return null
  const value = (v: UsageTotal) => {
    const tokens = t('tasks.card.tokens', {
      tokens: formatTokenCount(v.tokens, locale),
    })
    if (!settings.showCost || v.tokens === 0) return tokens
    if (!v.priced) return `${tokens} · ${t('usage.noPrice')}`
    return `${tokens} · ${formatCost(v.cost, locale, v.unpriced > 0)}`
  }
  const unpriced = agents.some((a) => days[a]?.week.unpriced)
  const title = settings.showCost
    ? [
        t('usage.estimate', {
          date: formatPriceDate(summary.pricesUpdated, locale),
        }),
        unpriced && t('usage.unpricedSome'),
      ]
        .filter(Boolean)
        .join('\n')
    : undefined
  return (
    <section
      aria-label={t('usage.title')}
      title={title}
      data-testid="usage-totals"
      className={`mb-3 flex flex-col gap-1 rounded-panel border border-border bg-surface px-3 py-2 text-[12px] ui-terminal:bg-bg ${className}`}
    >
      {agents.map((a) => {
        const d = days[a] as NonNullable<(typeof days)[HistoryAgent]>
        return (
          <div
            key={a}
            data-agent={a}
            className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5"
          >
            <span className="shrink-0 font-semibold text-fg">
              {agentLabel(a)}
            </span>
            <span className="tabular-nums">
              <span className="text-fg-muted">{t('usage.today')} </span>
              <span className="text-fg">{value(d.today)}</span>
            </span>
            <span className="tabular-nums">
              <span className="text-fg-muted">{t('usage.week')} </span>
              <span className="text-fg">{value(d.week)}</span>
            </span>
          </div>
        )
      })}
      {summary.truncated && (
        <p className="text-fg-muted">{t('usage.truncated')}</p>
      )}
    </section>
  )
}
