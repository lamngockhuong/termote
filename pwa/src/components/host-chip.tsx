import { Battery, BatteryCharging, BatteryLow } from 'lucide-react'
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

// The chip's CPU and memory parts, nulls left out; on a phone only the
// higher of the two.
export function hostParts(stats: HostStats, isMobile: boolean): Part[] {
  const parts: Part[] = []
  if (stats.cpu)
    parts.push({ kind: 'cpu', percent: stats.cpu.percent, approx: false })
  if (stats.memory)
    parts.push({
      kind: 'ram',
      percent: stats.memory.percent,
      approx: stats.memory.approx,
    })
  if (isMobile && parts.length > 1)
    return [parts.reduce((a, b) => (b.percent > a.percent ? b : a))]
  return parts
}

interface Props {
  stats: HostStats
  isMobile: boolean
  onOpen: () => void
}

// A small chip of how busy the machine running termote is:
// "CPU 23% · RAM 61% · [battery] 84%", coloured by the worst part. Nothing
// when the server gave nothing to show.
export function HostChip({ stats, isMobile, onOpen }: Props) {
  const { t } = useT()
  const parts = hostParts(stats, isMobile)
  const b = stats.battery
  if (parts.length === 0 && !b) return null
  const levels = parts.map((p) => hostLevel(p.percent))
  if (b) levels.push(batteryLevel(b))
  const level = levels.reduce<UsageLevel>(
    (a, l) => (RANK[l] > RANK[a] ? l : a),
    'normal',
  )
  // The screen reader hears every value, the phone's hidden one included
  const spoken = hostParts(stats, false).map((p) =>
    t(p.kind === 'cpu' ? 'shell.host.cpu' : 'shell.host.ram', {
      percent: hostPercent(p.percent, p.approx),
    }),
  )
  if (b)
    spoken.push(
      t(
        b.charging
          ? 'shell.host.chipBatteryCharging'
          : 'shell.host.chipBattery',
        { percent: hostPercent(b.percent) },
      ),
    )
  const text = parts
    .map((p) =>
      t(p.kind === 'cpu' ? 'shell.host.cpu' : 'shell.host.ram', {
        percent: hostPercent(p.percent, p.approx),
      }),
    )
    .join(' · ')
  const Icon = b?.charging
    ? BatteryCharging
    : b && b.percent <= 20
      ? BatteryLow
      : Battery
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('shell.host.openLabel', { stats: spoken.join(', ') })}
      title={t('shell.host.openTitle')}
      data-level={level}
      className={`group flex shrink-0 rounded-control border bg-surface p-0.5 ui-native:rounded-full ui-native:border-0 ${LEVEL_CHIP[level]} ${FOCUS_RING}`}
    >
      <span className="flex h-7 items-center gap-1 rounded-[calc(var(--radius-control)-2px)] px-2.5 text-[12px] tabular-nums group-hover:bg-surface-raised pointer-coarse:h-9 ui-native:rounded-full ui-terminal:font-label">
        {text}
        {b && (
          <>
            {text && <span aria-hidden="true">·</span>}
            <Icon aria-hidden="true" className="size-3.5" />
            {hostPercent(b.percent)}
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
}

// The chip for the header and the Host sheet it opens: the server is read
// only while the chip is on or the sheet open.
export function HeaderHostChip({ enabled, isMobile }: HeaderProps) {
  const [open, setOpen] = useState(false)
  const stats = useHostStats(enabled || open)
  return (
    <>
      {enabled && stats && (
        <HostChip
          stats={stats}
          isMobile={isMobile}
          onOpen={() => setOpen(true)}
        />
      )}
      <HostSheet isOpen={open} onClose={() => setOpen(false)} stats={stats} />
    </>
  )
}
