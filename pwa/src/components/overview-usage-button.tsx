import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { agentLabel, reportedCostAgent } from '../chat-agents'
import type {
  HistoryAgent,
  OverviewAccount,
  UsageSummary,
} from '../hooks/use-mux-api'
import { useSettings } from '../hooks/use-settings'
import { useT } from '../i18n/i18n-context'
import {
  foldBuckets,
  formatCost,
  formatPriceDate,
  formatTokenCount,
  type UsageTotal,
} from '../utils/usage-cost'
import { AccountUsageStrip } from './account-usage-strip'
import { FOCUS_RING } from './ui/button'

const AGENTS: HistoryAgent[] = ['claude', 'codex', 'opencode']

interface Props {
  summary?: UsageSummary
  accounts: readonly OverviewAccount[]
  // Server time (ms)
  now: number
  // Server time minus this device's (ms): today is this device's
  clockOffset: number
}

// The overview header's tokens: today's, every agent's together, never a
// cost. It opens a panel with each agent's tokens today and in 7 days and
// the Codex accounts' rate limits. Nothing without a token in the 7 days or
// a Codex account.
export function OverviewUsageButton({
  summary,
  accounts,
  now,
  clockOffset,
}: Props) {
  const { t, locale } = useT()
  const { settings } = useSettings()
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const wrapRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const deviceNow = now - clockOffset
  const days = summary ? foldBuckets(summary.buckets, deviceNow) : {}
  const totals = Object.values(days)
  const shown = totals.length > 0 || accounts.length > 0

  // A tap outside closes the panel; focus moves into it once open
  useEffect(() => {
    if (!open) return
    panelRef.current?.focus({ preventScroll: true })
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])
  // Nothing left to show (the tokens aged out): the panel goes with the
  // button
  useEffect(() => {
    if (!shown) setOpen(false)
  }, [shown])

  if (!shown) return null
  const today = formatTokenCount(
    totals.reduce((n, d) => n + d.today.tokens, 0),
    locale,
  )
  const agents = AGENTS.filter((a) => days[a])
  const tokens = (v: UsageTotal) => formatTokenCount(v.tokens, locale)
  // The cost, unless Settings turns it off or there is none to tell: an
  // agent that records its own cost (OpenCode) and recorded none shows
  // its tokens alone
  const cost = (v: UsageTotal, reported: boolean) => {
    if (!settings.showCost || v.tokens === 0 || (reported && !v.priced))
      return undefined
    if (!v.priced) return t('usage.noPrice')
    return formatCost(v.cost, locale, v.unpriced > 0)
  }
  const notes = settings.showCost
    ? [
        agents.some((a) => !reportedCostAgent(a)) &&
          summary &&
          t('usage.estimate', {
            date: formatPriceDate(summary.pricesUpdated, locale),
          }),
        agents.some(reportedCostAgent) && t('usage.reported'),
        agents.some((a) => days[a]?.week.unpriced) && t('usage.unpricedSome'),
      ]
        .filter(Boolean)
        .join('\n')
    : ''
  return (
    <div
      ref={wrapRef}
      className="relative"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return
        e.preventDefault()
        e.stopPropagation()
        setOpen(false)
        buttonRef.current?.focus()
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('tasks.usage.buttonName', { tokens: today })}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        className={`flex h-9 items-center gap-2 rounded-control border border-border-strong bg-surface px-2.5 text-[12px] tabular-nums text-fg hover:bg-surface-raised pointer-coarse:h-touch ${FOCUS_RING}`}
      >
        {/* On a phone the number alone */}
        <span className="hidden text-fg-muted sm:inline">
          {t('usage.today')}
        </span>
        <span className="font-semibold">
          <span className="sm:hidden">{today}</span>
          <span className="hidden sm:inline">
            {t('tasks.card.tokens', { tokens: today })}
          </span>
        </span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`shrink-0 text-fg-muted transition-transform duration-(--duration-fast) ease-standard ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t('tasks.usage.panel')}
          tabIndex={-1}
          data-testid="overview-usage-panel"
          className="absolute right-0 top-full z-30 mt-1.5 flex w-[min(22rem,calc(100vw-24px))] flex-col gap-2.5 rounded-panel border border-border bg-surface p-3.5 text-[12px] shadow-xl outline-none ui-terminal:bg-bg"
        >
          <div className="flex flex-col gap-0.5">
            <span className="font-semibold text-fg-muted">
              {t('tasks.usage.panelTitle')}
            </span>
            <span className="text-[11px] text-fg-subtle">
              {t('tasks.usage.panelHint')}
            </span>
          </div>
          {agents.length > 0 && (
            <section
              aria-label={t('usage.title')}
              title={notes || undefined}
              data-testid="usage-totals"
              className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 tabular-nums"
            >
              <span />
              <span className="text-right text-fg-subtle">
                {t('usage.today')}
              </span>
              <span className="text-right text-fg-subtle">
                {t('usage.week')}
              </span>
              {agents.map((a) => {
                const d = days[a] as NonNullable<(typeof days)[HistoryAgent]>
                const reported = reportedCostAgent(a)
                const costs = [cost(d.today, reported), cost(d.week, reported)]
                return (
                  <div key={a} data-agent={a} className="contents">
                    <span className="pt-1 font-semibold text-fg">
                      {agentLabel(a)}
                    </span>
                    {costs.some(Boolean) ? (
                      <>
                        <span className="pt-1 text-right text-fg">
                          {costs[0] ?? '—'}
                        </span>
                        {/* The 7 days hold today: a cost today has one */}
                        <span className="pt-1 text-right text-fg">
                          {costs[1]}
                        </span>
                        <span className="text-fg-subtle">
                          {t('tasks.usage.tokensRow')}
                        </span>
                        <span className="text-right text-fg-subtle">
                          {tokens(d.today)}
                        </span>
                        <span className="text-right text-fg-subtle">
                          {tokens(d.week)}
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="pt-1 text-right text-fg">
                          {tokens(d.today)}
                        </span>
                        <span className="pt-1 text-right text-fg">
                          {tokens(d.week)}
                        </span>
                      </>
                    )}
                  </div>
                )
              })}
              {summary?.truncated && (
                <p className="col-span-3 m-0 pt-1 text-fg-subtle">
                  {t('usage.truncated')}
                </p>
              )}
            </section>
          )}
          {accounts.length > 0 && (
            <div className="border-t border-border pt-2.5 [&>section]:mb-0 [&>section]:border-0 [&>section]:bg-transparent [&>section]:p-0">
              <AccountUsageStrip accounts={accounts} now={now} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
