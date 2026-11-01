import { Battery, BatteryCharging, BatteryLow, Gauge } from 'lucide-react'
import { type ReactNode, useState } from 'react'
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
  // The header also shows the agent usage chip: below 360 px there is no
  // room for both, and the chip hides (the session switcher and the menus
  // must stay whole)
  crowded?: boolean
  onOpen: () => void
}

// A small chip of how busy the machine running termote is:
// "CPU 23% · RAM 61% · [battery] 84%", coloured by the worst part. A phone's
// header has room for one value: the worst one, behind an icon (a gauge for
// the higher of CPU and RAM, else the battery). Nothing when the server gave
// nothing to show.
export function HostChip({ stats, isMobile, crowded, onOpen }: Props) {
  const { t } = useT()
  const parts = hostParts(stats, isMobile)
  const b = stats.battery
  if (parts.length === 0 && !b) return null
  const partLevel = parts.length
    ? hostLevel(Math.max(...parts.map((p) => p.percent)))
    : undefined
  const battLevel = b ? batteryLevel(b) : undefined
  const level = [partLevel, battLevel].reduce<UsageLevel>(
    (a, l) => (l && RANK[l] > RANK[a] ? l : a),
    'normal',
  )
  // The screen reader hears every value, the phone's hidden ones included
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
  const BatteryIcon = b?.charging
    ? BatteryCharging
    : b && b.percent <= 20
      ? BatteryLow
      : Battery
  const battery = b && (
    <>
      <BatteryIcon aria-hidden="true" className="size-3.5" />
      {hostPercent(b.percent)}
    </>
  )
  let content: ReactNode
  if (isMobile) {
    const top = parts[0]
    const showBattery =
      battery &&
      (!top ||
        (battLevel !== undefined &&
          partLevel !== undefined &&
          RANK[battLevel] > RANK[partLevel]))
    content = showBattery ? (
      battery
    ) : (
      <>
        <Gauge aria-hidden="true" className="size-3.5" />
        {hostPercent(top.percent, top.approx)}
      </>
    )
  } else {
    const text = parts
      .map((p) =>
        t(p.kind === 'cpu' ? 'shell.host.cpu' : 'shell.host.ram', {
          percent: hostPercent(p.percent, p.approx),
        }),
      )
      .join(' · ')
    content = (
      <>
        {text}
        {battery && (
          <>
            {text && <span aria-hidden="true">·</span>}
            {battery}
          </>
        )}
      </>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('shell.host.openLabel', { stats: spoken.join(', ') })}
      title={t('shell.host.openTitle')}
      data-level={level}
      className={`group flex shrink-0 rounded-control border bg-surface p-0.5 ui-native:rounded-full ui-native:border-0 ${LEVEL_CHIP[level]} ${FOCUS_RING} ${isMobile && crowded ? 'max-[359px]:hidden' : ''}`}
    >
      <span
        className={`flex h-7 items-center gap-1 rounded-[calc(var(--radius-control)-2px)] text-[12px] tabular-nums group-hover:bg-surface-raised pointer-coarse:h-9 ui-native:rounded-full ui-terminal:font-label ${isMobile ? 'px-2' : 'px-2.5'}`}
      >
        {content}
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
