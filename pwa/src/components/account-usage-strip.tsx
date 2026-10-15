import type { OverviewAccount } from '../hooks/use-mux-api'
import { formatAgo } from '../utils/format-ago'
import {
  percentLabel,
  resetLabel,
  USAGE_STALE_MS,
  windowLabel,
  windowRunning,
} from '../utils/usage-format'
import { UsageMeter } from './usage-meter'

interface Props {
  accounts: readonly OverviewAccount[]
  // Server time (ms)
  now: number
}

// The rate limits of every Codex account an agent uses: one line each, a
// bar per window with when it resets, and how old the numbers are. Numbers
// older than USAGE_STALE_MS are dimmed; a window past its reset is left out.
// Nothing without an account.
export function AccountUsageStrip({ accounts, now }: Props) {
  if (accounts.length === 0) return null
  return (
    <section
      aria-label="Accounts"
      className="mb-3 flex flex-col gap-2 rounded-panel border border-border bg-surface px-3 py-2 text-[12px] ui-terminal:bg-bg"
    >
      {accounts.map((a) => {
        const updated = Date.parse(a.updatedAt)
        const known = Number.isFinite(updated)
        const stale = !known || now - updated > USAGE_STALE_MS
        return (
          <div
            key={a.key}
            data-stale={stale || undefined}
            className={`flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 ${stale ? 'opacity-60' : ''}`}
          >
            <span className="shrink-0 font-semibold text-fg">
              Codex
              {a.plan && (
                <span className="font-normal text-fg-muted"> · {a.plan}</span>
              )}
            </span>
            {a.windows.map((w, i) => {
              if (!windowRunning(w.resetsAt, now)) return null
              const name = windowLabel(w.windowMinutes)
              const reset = resetLabel(w.resetsAt, now)
              return (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: two windows may share a length; the spans hold no state
                  key={`${i}-${w.windowMinutes}`}
                  className="flex min-w-0 items-center gap-1.5"
                >
                  <span className="shrink-0 text-fg-muted">{name}</span>
                  <UsageMeter
                    percent={w.usedPercent}
                    label={`Codex ${name} limit`}
                    valueText={`${percentLabel(w.usedPercent)} used${reset ? `, ${reset}` : ''}`}
                    className="w-16 shrink-0"
                  />
                  <span className="shrink-0 tabular-nums text-fg">
                    {percentLabel(w.usedPercent)}
                  </span>
                  {reset && (
                    <span className="truncate text-fg-subtle">{reset}</span>
                  )}
                </span>
              )
            })}
            {known && (
              <span className="shrink-0 text-fg-subtle">
                updated {formatAgo(Math.max(0, now - updated))}
              </span>
            )}
          </div>
        )
      })}
    </section>
  )
}
