import { Battery, BatteryCharging, BatteryLow, Gauge } from 'lucide-react'
import { useState } from 'react'
import { useHostStats } from '../hooks/use-host-stats'
import type { HostStats } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { batteryLevel, hostLevel, hostPercent } from '../utils/host-format'
import type { UsageLevel } from '../utils/usage-format'
import { HostSheet } from './host-sheet'
import { FOCUS_RING } from './ui/button'

const LEVEL_CHIP: Record<UsageLevel, string> = {
  normal: 'border-border text-fg-muted',
  warning: 'border-warning/60 text-warning',
  danger: 'border-danger/60 text-danger',
}

const RANK: Record<UsageLevel, number> = { normal: 0, warning: 1, danger: 2 }

interface Part {
  kind: 'cpu' | 'ram'
  percent: number
  approx: boolean
}

// The chip's CPU and memory parts, nulls left out.
export function hostParts(stats: HostStats): Part[] {
  const parts: Part[] = []
  if (stats.cpu)
    parts.push({ kind: 'cpu', percent: stats.cpu.percent, approx: false })
  if (stats.memory)
    parts.push({
      kind: 'ram',
      percent: stats.memory.percent,
      approx: stats.memory.approx,
    })
  return parts
}

interface Props {
  stats: HostStats
  isMobile: boolean
  // The header also shows the agent usage chip: below 360 px a phone has no
  // room for both, and the chip hides (the session switcher and the menus
  // must stay whole)
  crowded?: boolean
  onOpen: () => void
}

// A small chip of how busy the machine running termote is: one value behind
// an icon, the worst part (a gauge with the higher of CPU and RAM, else the
// battery), coloured by its level. It stays this narrow on every screen: the
// header's session tabs need the room. Every value is in its tooltip and
// accessible name, and in the sheet it opens. Nothing when the server gave
// nothing to show.
export function HostChip({ stats, isMobile, crowded, onOpen }: Props) {
  const { t } = useT()
  const parts = hostParts(stats)
  const b = stats.battery
  if (parts.length === 0 && !b) return null
  const top = parts.reduce<Part | undefined>(
    (a, p) => (!a || p.percent > a.percent ? p : a),
    undefined,
  )
  const partLevel = top ? hostLevel(top.percent) : undefined
  const battLevel = b ? batteryLevel(b) : undefined
  const level = [partLevel, battLevel].reduce<UsageLevel>(
    (a, l) => (l && RANK[l] > RANK[a] ? l : a),
    'normal',
  )
  const values = parts.map((p) =>
    t(p.kind === 'cpu' ? 'shell.host.cpu' : 'shell.host.ram', {
      percent: hostPercent(p.percent, p.approx),
    }),
  )
  if (b)
    values.push(
      t(
        b.charging
          ? 'shell.host.chipBatteryCharging'
          : 'shell.host.chipBattery',
        { percent: hostPercent(b.percent) },
      ),
    )
  const all = values.join(', ')
  // Without CPU and RAM there is a battery (else nothing was returned above)
  const showBattery =
    !top || (!!battLevel && RANK[battLevel] > RANK[hostLevel(top.percent)])
  const BatteryIcon = b?.charging
    ? BatteryCharging
    : b && b.percent <= 20
      ? BatteryLow
      : Battery
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('shell.host.openLabel', { stats: all })}
      title={t('shell.host.label', { stats: all })}
      data-level={level}
      className={`group flex shrink-0 rounded-control border bg-surface p-0.5 ui-native:rounded-full ui-native:border-0 ${LEVEL_CHIP[level]} ${FOCUS_RING} ${isMobile && crowded ? 'max-[359px]:hidden' : ''}`}
    >
      <span className="flex h-7 items-center gap-1 rounded-[calc(var(--radius-control)-2px)] px-2 text-[12px] tabular-nums group-hover:bg-surface-raised pointer-coarse:h-9 ui-native:rounded-full ui-terminal:font-label">
        {showBattery ? (
          <>
            <BatteryIcon aria-hidden="true" className="size-3.5" />
            {hostPercent((b as NonNullable<typeof b>).percent)}
          </>
        ) : (
          <>
            <Gauge aria-hidden="true" className="size-3.5" />
            {hostPercent(top.percent, top.approx)}
          </>
        )}
      </span>
    </button>
  )
}

interface HeaderProps {
  // The setting: off, nothing is shown or read
  enabled: boolean
  isMobile: boolean
  // The agent usage chip shows beside it (see Props)
  crowded?: boolean
}

// The chip for the header and the Host sheet it opens: the server is read
// only while the chip is on or the sheet open.
export function HeaderHostChip({ enabled, isMobile, crowded }: HeaderProps) {
  const [open, setOpen] = useState(false)
  const stats = useHostStats(enabled || open)
  return (
    <>
      {enabled && stats && (
        <HostChip
          stats={stats}
          isMobile={isMobile}
          crowded={crowded}
          onOpen={() => setOpen(true)}
        />
      )}
      <HostSheet isOpen={open} onClose={() => setOpen(false)} stats={stats} />
    </>
  )
}
