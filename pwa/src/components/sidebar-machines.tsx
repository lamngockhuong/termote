import { ChevronDown, ChevronRight, Monitor, Server } from 'lucide-react'
import { useState } from 'react'
import type { MachineInfo, MachineStatus } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { AgentStatus } from '../types/session'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { AgentStatusBadge } from './agent-status-badge'
import {
  ACTIVE_ROW_CLASSES,
  ROW_CLASSES,
  ROW_PRESS,
} from './sidebar-row-classes'
import { FOCUS_RING } from './ui/button'

const STATUS_LABEL: Record<MachineStatus, MessageKey> = {
  online: 'shell.machines.status.online',
  offline: 'shell.machines.status.offline',
  connecting: 'shell.machines.status.connecting',
  incompatible: 'shell.machines.status.incompatible',
  unauthorized: 'shell.machines.status.unauthorized',
  hostkey: 'shell.machines.status.hostkey',
}

const STATUS_DOT: Record<MachineStatus, string> = {
  online: 'bg-success',
  offline: 'bg-fg-subtle',
  connecting: 'bg-warning',
  incompatible: 'bg-danger',
  unauthorized: 'bg-danger',
  hostkey: 'bg-danger',
}

const AGENT_STATUSES = new Set<string>(['blocked', 'working', 'done', 'idle'])

// A status this version knows, else offline (a newer server's)
function knownStatus(s: string): MachineStatus {
  return Object.hasOwn(STATUS_LABEL, s) ? (s as MachineStatus) : 'offline'
}

interface MachineAgent {
  key: string
  // Its group and tab names
  place: string
  // The pane's own name, else its agent's
  name: string
  status: string
}

// Every pane of the machine running an agent, with where it runs
export function machineAgents(m: MachineInfo): MachineAgent[] {
  const out: MachineAgent[] = []
  for (const g of m.groups ?? []) {
    for (const t of g.tabs) {
      for (const p of t.panes) {
        if (!p.agent) continue
        out.push({
          key: `${g.id}/${t.id}/${p.id}`,
          place: [g.name, t.name].filter(Boolean).join(' / '),
          name: p.name || p.agent.name,
          status: p.agent.status,
        })
      }
    }
  }
  return out
}

// The agents that need the user or are working
export function busyCount(m: MachineInfo): number {
  return machineAgents(m).filter(
    ({ status }) => status === 'blocked' || status === 'working',
  ).length
}

interface Props {
  machines: MachineInfo[]
  // The machine open, '' for this one
  current: string
  onSelect: (id: string) => void
}

// The sidebar's Machines: this machine first, then each machine this server
// reaches over SSH with its status, how many of its agents need the user or
// work, and (opened) those agents. A machine is picked by id only: it is
// added, removed and fixed with the CLI, which a broken one names.
// Nothing at all while there is no machine.
export function SidebarMachines({ machines, current, onSelect }: Props) {
  const { t } = useT()
  const [collapsed, setCollapsed] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  if (machines.length === 0 && current === '') return null
  const row = (active: boolean) =>
    `flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left text-[13px] ${ROW_PRESS} ${
      active ? ACTIVE_ROW_CLASSES : ROW_CLASSES
    } ${FOCUS_RING} focus-visible:-outline-offset-2`
  return (
    <section
      aria-label={t('shell.machines.title')}
      className="flex shrink-0 flex-col border-b border-border"
    >
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        title={t('shell.machines.toggle')}
        className={`flex h-9 shrink-0 items-center gap-1.5 px-3 font-label text-[11px] font-semibold uppercase tracking-wider text-fg ${FOCUS_RING} focus-visible:-outline-offset-2`}
      >
        {collapsed ? (
          <ChevronRight size={12} aria-hidden="true" />
        ) : (
          <ChevronDown size={12} aria-hidden="true" />
        )}
        {t('shell.machines.title')}
        <span className="ml-auto font-normal tabular-nums text-fg-muted">
          {machines.length + 1}
        </span>
      </button>
      {!collapsed && (
        <ul className="m-0 flex list-none flex-col gap-px px-2 pb-2">
          <li className="flex">
            <button
              type="button"
              aria-current={current === '' ? 'true' : undefined}
              onClick={() => onSelect('')}
              className={row(current === '')}
            >
              <Monitor size={14} aria-hidden="true" className="shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {t('shell.machines.local')}
              </span>
            </button>
          </li>
          {machines.map((m) => {
            const status = knownStatus(m.status)
            const agents = machineAgents(m)
            const busy = busyCount(m)
            const isOpen = !!open[m.id]
            const failed =
              status === 'incompatible' ||
              status === 'unauthorized' ||
              status === 'hostkey' ||
              status === 'offline'
            const label = visibleUnsafe(m.label)
            return (
              <li key={m.id} className="flex flex-col">
                <div className="flex items-center gap-px">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    aria-label={t('shell.machines.expand', { label })}
                    onClick={() => setOpen((o) => ({ ...o, [m.id]: !o[m.id] }))}
                    className={`flex h-8 w-6 shrink-0 items-center justify-center rounded-control text-fg-muted hover:bg-surface-raised ${FOCUS_RING}`}
                  >
                    {isOpen ? (
                      <ChevronDown size={12} aria-hidden="true" />
                    ) : (
                      <ChevronRight size={12} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    aria-current={current === m.id ? 'true' : undefined}
                    onClick={() => onSelect(m.id)}
                    title={t('shell.machines.open', { label })}
                    className={row(current === m.id)}
                  >
                    <Server size={14} aria-hidden="true" className="shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {busy > 0 && (
                      <span
                        className="shrink-0 text-[11px] tabular-nums text-warning"
                        title={t('shell.machines.busy', { count: busy })}
                      >
                        {busy}
                      </span>
                    )}
                    <span
                      role="img"
                      data-status={status}
                      aria-label={t(STATUS_LABEL[status])}
                      title={t(STATUS_LABEL[status])}
                      className={`size-2 shrink-0 rounded-full ${STATUS_DOT[status]}`}
                    />
                  </button>
                </div>
                {isOpen && (
                  <div className="pl-8 text-[12px]">
                    {failed ? (
                      <p className="m-0 px-2 py-1 text-fg-muted">
                        {t(STATUS_LABEL[status])}. {t('shell.machines.hint')}
                      </p>
                    ) : agents.length === 0 ? (
                      <p className="m-0 px-2 py-1 text-fg-subtle">
                        {t('shell.machines.noAgents')}
                      </p>
                    ) : (
                      <ul className="m-0 flex list-none flex-col p-0">
                        {agents.map(({ key, place, name, status: s }) => {
                          return (
                            <li
                              key={key}
                              className="flex h-7 min-w-0 items-center gap-2 px-2 text-fg-muted"
                            >
                              <AgentStatusBadge
                                status={
                                  AGENT_STATUSES.has(s)
                                    ? (s as AgentStatus)
                                    : undefined
                                }
                                size={12}
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {visibleUnsafe(name)}
                                {place && (
                                  <span className="text-fg-subtle">
                                    {' · '}
                                    {visibleUnsafe(place)}
                                  </span>
                                )}
                              </span>
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
