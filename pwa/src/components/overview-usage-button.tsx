import { Coins } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { OverviewAccount, UsageSummary } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { foldBuckets, formatTokenCount } from '../utils/usage-cost'
import { AccountUsageStrip } from './account-usage-strip'
import { FOCUS_RING } from './ui/button'
import { UsageTotalsStrip } from './usage-totals-strip'

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
        title={t('usage.title')}
        className={`flex min-h-touch items-center gap-1.5 rounded-control px-2 text-[12px] tabular-nums text-fg-muted hover:bg-surface-raised hover:text-fg ${FOCUS_RING}`}
      >
        <Coins size={16} aria-hidden="true" className="shrink-0" />
        <span className="truncate">
          {t('tasks.usage.button', { tokens: today })}
        </span>
      </button>
      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label={t('tasks.usage.panel')}
          tabIndex={-1}
          data-testid="overview-usage-panel"
          className="absolute right-0 top-full z-30 mt-1 flex w-[min(30rem,calc(100vw-24px))] flex-col gap-2 rounded-panel border border-border bg-surface-raised p-2 shadow-xl outline-none ui-terminal:bg-bg [&>section]:mb-0"
        >
          <UsageTotalsStrip summary={summary} now={deviceNow} />
          <AccountUsageStrip accounts={accounts} now={now} />
        </div>
      )}
    </div>
  )
}
