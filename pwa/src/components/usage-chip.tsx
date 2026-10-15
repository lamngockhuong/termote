import type { OverviewAccount, OverviewPane } from '../hooks/use-mux-api'
import { usePaneOverview } from '../hooks/use-pane-overview'
import {
  percentLabel,
  USAGE_STALE_MS,
  type UsageLevel,
  usageLevel,
  windowLabel,
  windowRunning,
} from '../utils/usage-format'
import { FOCUS_RING } from './ui/button'

const LEVEL_CHIP: Record<UsageLevel, string> = {
  normal: 'border-border text-fg-muted',
  warning: 'border-warning/60 text-warning',
  danger: 'border-danger/60 text-danger',
}

interface Part {
  // "ctx", or the limit window ("7d")
  name: string
  // What a screen reader calls it
  spoken: string
  percent: number
  exact: boolean
}

// What the chip has to say about a pane: its context share, and the fullest
// rate limit window of the Codex account it uses, left out when its numbers
// are stale or every window has reset since.
export function usageParts(
  pane: OverviewPane | undefined,
  accounts: readonly OverviewAccount[],
  now: number,
): Part[] {
  const parts: Part[] = []
  const u = pane?.usage
  if (u?.contextWindow && u.contextPercent !== undefined) {
    parts.push({
      name: 'ctx',
      spoken: 'context',
      percent: u.contextPercent,
      exact: u.exact !== false,
    })
  }
  const account = pane?.accountKey
    ? accounts.find((a) => a.key === pane.accountKey)
    : undefined
  const fresh = account && now - Date.parse(account.updatedAt) <= USAGE_STALE_MS
  const running = fresh
    ? account.windows.filter((w) => windowRunning(w.resetsAt, now))
    : []
  const fullest = running.reduce<(typeof running)[number] | undefined>(
    (a, b) => (!a || b.usedPercent > a.usedPercent ? b : a),
    undefined,
  )
  if (fullest) {
    const name = windowLabel(fullest.windowMinutes)
    parts.push({
      name,
      spoken: `Codex ${name} limit`,
      percent: fullest.usedPercent,
      exact: true,
    })
  }
  return parts
}

interface Props {
  pane: OverviewPane | undefined
  accounts: readonly OverviewAccount[]
  // Mobile: only the fuller of the two, the header has no room for both
  isMobile: boolean
  // Opens the overview; unset, the chip only shows
  onOpen?: () => void
}

// A small chip of how full the open pane's agent is: "ctx 72% · 7d 95%",
// coloured by the fuller part. Nothing until the overview has read it.
export function UsageChip({ pane, accounts, isMobile, onOpen }: Props) {
  const all = usageParts(pane, accounts, Date.now())
  if (all.length === 0) return null
  const parts = isMobile
    ? [all.reduce((a, b) => (b.percent > a.percent ? b : a))]
    : all
  const level = usageLevel(Math.max(...parts.map((p) => p.percent)))
  const text = parts
    .map((p) => `${p.name} ${percentLabel(p.percent, p.exact)}`)
    .join(' · ')
  const spoken = parts
    .map((p) => `${p.spoken} ${percentLabel(p.percent, p.exact)}`)
    .join(', ')
  // The frame and size of the view switcher beside it, so both line up
  const frame = `flex shrink-0 rounded-control border bg-surface p-0.5 ui-native:rounded-full ui-native:border-0 ${LEVEL_CHIP[level]}`
  const inner =
    'flex h-7 items-center rounded-[calc(var(--radius-control)-2px)] px-2.5 text-[12px] tabular-nums pointer-coarse:h-9 ui-native:rounded-full ui-terminal:font-label'
  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Agent usage: ${spoken}. Open the agent overview`}
      title="Agent usage: open the overview"
      data-level={level}
      className={`group ${frame} ${FOCUS_RING}`}
    >
      <span className={`${inner} group-hover:bg-surface-raised`}>{text}</span>
    </button>
  ) : (
    <span
      role="note"
      aria-label={`Agent usage: ${spoken}`}
      data-level={level}
      className={frame}
    >
      <span className={inner}>{text}</span>
    </span>
  )
}

interface HeaderProps {
  // The pane the header shows, and whether an agent runs in it
  paneId?: string
  hasAgent?: boolean
  // The setting: off, nothing is shown or read
  enabled: boolean
  // Milliseconds between reads of the overview
  pollInterval: number
  isMobile: boolean
  // Opens the overview on this pane's card
  onOpen?: (paneId: string) => void
}

// The chip for the header: reads its pane's overview only while it is on
// and the pane runs an agent.
export function HeaderUsageChip({
  paneId,
  hasAgent,
  enabled,
  pollInterval,
  isMobile,
  onOpen,
}: HeaderProps) {
  const on = enabled && !!hasAgent && !!paneId
  const overview = usePaneOverview(paneId, pollInterval, on)
  if (!overview) return null
  return (
    <UsageChip
      pane={overview.panes.find((p) => p.paneId === paneId)}
      accounts={overview.accounts ?? []}
      isMobile={isMobile}
      onOpen={onOpen && paneId ? () => onOpen(paneId) : undefined}
    />
  )
}
