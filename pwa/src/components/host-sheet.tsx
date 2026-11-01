import type { ReactNode } from 'react'
import type {
  HostBattery,
  HostDisk,
  HostMemory,
  HostScope,
  HostStats,
} from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import {
  batteryLevel,
  formatBytes,
  formatMinutes,
  historySlots,
  hostLevel,
  hostPercent,
  peak,
} from '../utils/host-format'
import { Sparkline } from './sparkline'
import { Sheet } from './ui/sheet'
import { UsageMeter } from './usage-meter'

// Points of a full history: 15 minutes at one sample every 5 s
const HISTORY_SLOTS = 180

const LEVEL_TEXT = {
  normal: 'text-fg-muted',
  warning: 'text-warning',
  danger: 'text-danger',
} as const

interface Props {
  isOpen: boolean
  onClose: () => void
  // undefined: not read yet, or the read failed
  stats: HostStats | undefined
}

// The machine running termote in full: whose numbers they are, CPU and
// memory over the last 15 minutes, the load average, and meters for
// memory, swap, each disk and the battery. A part the server could not
// read is left out.
export function HostSheet({ isOpen, onClose, stats }: Props) {
  const { t } = useT()
  return (
    <Sheet isOpen={isOpen} onClose={onClose} title={t('shell.host.title')}>
      <div className="flex flex-col gap-5 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {stats ? (
          <HostDetails stats={stats} />
        ) : (
          <p className="m-0 text-sm text-fg-muted">
            {t('shell.host.unavailable')}
          </p>
        )}
      </div>
    </Sheet>
  )
}

const SCOPE_KEY = {
  host: 'shell.host.scope.host',
  wsl: 'shell.host.scope.wsl',
  container: 'shell.host.scope.container',
} as const

export function HostDetails({ stats }: { stats: HostStats }) {
  const { t } = useT()
  const scope: HostScope = stats.scope in SCOPE_KEY ? stats.scope : 'host'
  return (
    <>
      <div className="flex flex-col gap-1">
        <p className="m-0 text-sm font-medium text-fg" data-scope={scope}>
          {t(SCOPE_KEY[scope])}
        </p>
        {scope === 'wsl' && (
          <p className="m-0 text-xs text-fg-muted">{t('shell.host.wslNote')}</p>
        )}
        {scope === 'container' && (
          <p className="m-0 text-xs text-fg-muted">
            {t('shell.host.containerNote')}
          </p>
        )}
      </div>
      <Trend
        name={t('shell.host.cpuTitle')}
        detail={
          stats.cpu
            ? t('shell.host.cores', { count: stats.cpu.count })
            : undefined
        }
        values={historySlots(stats.history, (p) => p.cpu, stats.sampledAt)}
        current={stats.cpu?.percent}
      />
      <Trend
        name={t('shell.host.memory')}
        values={historySlots(stats.history, (p) => p.mem, stats.sampledAt)}
        current={stats.memory?.percent}
        approx={stats.memory?.approx}
      />
      {stats.load && stats.load.length >= 3 && (
        <Section title={t('shell.host.load')}>
          <p className="m-0 text-sm tabular-nums text-fg">
            {t('shell.host.loadValues', {
              a: stats.load[0].toFixed(2),
              b: stats.load[1].toFixed(2),
              c: stats.load[2].toFixed(2),
            })}
          </p>
        </Section>
      )}
      {stats.memory && (
        <MemoryMeter title={t('shell.host.memory')} m={stats.memory} />
      )}
      {stats.swap && (
        <MemoryMeter title={t('shell.host.swap')} m={stats.swap} />
      )}
      {stats.disks?.map((d) => (
        <DiskMeter key={d.label} disk={d} scope={scope} />
      ))}
      {stats.battery && <BatteryMeter b={stats.battery} />}
    </>
  )
}

function Section({
  title,
  aside,
  children,
}: {
  title: string
  aside?: string
  children: ReactNode
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="m-0 text-xs font-medium uppercase tracking-wide text-fg-muted ui-terminal:font-label">
          {title}
        </h3>
        {aside && (
          <span className="text-xs tabular-nums text-fg-muted">{aside}</span>
        )}
      </div>
      {children}
    </section>
  )
}

// A value's last 15 minutes as a line, with its current value and peak
function Trend({
  name,
  detail,
  values,
  current,
  approx,
}: {
  name: string
  detail?: string
  values: (number | null)[]
  current: number | undefined
  approx?: boolean
}) {
  const { t } = useT()
  const top = peak(values)
  const now = current === undefined ? '–' : hostPercent(current, approx)
  const max = top === undefined ? '–' : hostPercent(top, approx)
  const label =
    top === undefined
      ? t('shell.host.sparkEmpty', { name })
      : t('shell.host.sparkLabel', { name, now, peak: max })
  const level = hostLevel(current ?? 0)
  return (
    <Section
      title={detail ? `${name} · ${detail}` : name}
      aside={t('shell.host.last15')}
    >
      <div className={LEVEL_TEXT[level]}>
        <Sparkline values={values} slots={HISTORY_SLOTS} label={label} />
      </div>
      <p className="m-0 text-xs tabular-nums text-fg-muted">
        {t('shell.host.nowPeak', { now, peak: max })}
      </p>
    </Section>
  )
}

function MemoryMeter({ title, m }: { title: string; m: HostMemory }) {
  const { t } = useT()
  const value = t('shell.host.used', {
    used: formatBytes(m.used),
    total: formatBytes(m.total),
  })
  const note = m.limit
    ? t('shell.host.limit')
    : m.approx
      ? t('shell.host.approx')
      : undefined
  return (
    <Section
      title={note ? `${title} · ${note}` : title}
      aside={hostPercent(m.percent, m.approx)}
    >
      <UsageMeter
        percent={m.percent}
        label={title}
        valueText={`${hostPercent(m.percent, m.approx)}, ${value}`}
        level={hostLevel(m.percent)}
      />
      <p className="m-0 text-xs tabular-nums text-fg-muted">{value}</p>
    </Section>
  )
}

function DiskMeter({ disk, scope }: { disk: HostDisk; scope: HostScope }) {
  const { t } = useT()
  const title =
    disk.label === 'windows'
      ? t('shell.host.diskWindows')
      : scope === 'wsl'
        ? t('shell.host.diskWsl')
        : t('shell.host.disk')
  const value = t('shell.host.free', {
    free: formatBytes(disk.free),
    total: formatBytes(disk.total),
  })
  return (
    <Section title={title} aside={hostPercent(disk.percent)}>
      <UsageMeter
        percent={disk.percent}
        label={title}
        valueText={`${hostPercent(disk.percent)}, ${value}`}
        level={hostLevel(disk.percent)}
      />
      <p className="m-0 text-xs tabular-nums text-fg-muted">{value}</p>
    </Section>
  )
}

function BatteryMeter({ b }: { b: HostBattery }) {
  const { t } = useT()
  const state = b.charging
    ? t('shell.host.charging')
    : b.plugged
      ? t('shell.host.plugged')
      : t('shell.host.onBattery')
  const time =
    b.minutesLeft === null
      ? undefined
      : t(b.charging ? 'shell.host.untilFull' : 'shell.host.left', {
          time: formatMinutes(b.minutesLeft, t),
        })
  const value = time ? `${state} · ${time}` : state
  const title = t('shell.host.battery')
  return (
    <Section title={title} aside={hostPercent(b.percent)}>
      <UsageMeter
        percent={b.percent}
        label={title}
        valueText={`${hostPercent(b.percent)}, ${value}`}
        level={batteryLevel(b)}
      />
      <p className="m-0 text-xs text-fg-muted">{value}</p>
    </Section>
  )
}
