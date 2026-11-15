import { useSettings } from '../hooks/use-settings'
import { useT } from '../i18n/i18n-context'
import { visibleUnsafe } from '../utils/unsafe-chars'
import {
  formatCost,
  formatPriceDate,
  formatTokenCount,
} from '../utils/usage-cost'

interface Props {
  tokens: number
  // Absent: none of the tokens has a price
  costUsd?: number
  unpricedTokens?: number
  // The models without a price, when the server named them
  unpricedModels?: readonly string[]
  // The subagents' share, when there is one
  subTokens?: number
  subCostUsd?: number
  pricesUpdated: string
  // An old session (a fork counts what it copied)
  history?: boolean
  className?: string
}

// A session's tokens and their estimated cost ("1.2M tokens · ~$3.40"),
// and its subagents' share on a line of its own. The cost is left out when
// Settings turns it off; the tooltip says it is an estimate.
export function SessionUsageLine({
  tokens,
  costUsd,
  unpricedTokens,
  unpricedModels,
  subTokens,
  subCostUsd,
  pricesUpdated,
  history,
  className = '',
}: Props) {
  const { t, locale } = useT()
  const { settings } = useSettings()
  const showCost = settings.showCost
  const partial = !!unpricedTokens
  const value = (n: number, cost: number | undefined, some: boolean) => {
    const text = t('tasks.card.tokens', { tokens: formatTokenCount(n, locale) })
    if (!showCost || n === 0) return text
    if (cost === undefined) return `${text} · ${t('usage.noPrice')}`
    return `${text} · ${formatCost(cost, locale, some)}`
  }
  const notes = showCost
    ? [
        t('usage.estimate', { date: formatPriceDate(pricesUpdated, locale) }),
        partial &&
          (unpricedModels?.length
            ? t('usage.unpriced', {
                models: unpricedModels.map((m) => visibleUnsafe(m)).join(', '),
              })
            : t('usage.unpricedSome')),
      ]
    : []
  if (history) notes.push(t('usage.forked'))
  const title = notes.filter(Boolean).join('\n') || undefined
  return (
    <span
      className={`flex min-w-0 flex-col tabular-nums ${className}`}
      title={title}
      data-testid="session-usage"
    >
      <span className="truncate">
        <span className="sr-only">{t('tasks.card.usageLabel')}: </span>
        {value(tokens, costUsd, partial)}
      </span>
      {subTokens !== undefined && subTokens > 0 && (
        <span className="truncate">
          {t('tasks.card.sub', {
            usage: value(subTokens, subCostUsd, false),
          })}
        </span>
      )}
    </span>
  )
}
