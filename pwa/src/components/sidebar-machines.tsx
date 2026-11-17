import {
  AppWindow,
  ChevronDown,
  ChevronRight,
  Monitor,
  Server,
} from 'lucide-react'
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useRef,
  useState,
} from 'react'
import type { MachineInfo, MachineStatus } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { OpenWindowEvent } from '../utils/open-window'
import { visibleUnsafe } from '../utils/unsafe-chars'
import {
  ACTIVE_ROW_CLASSES,
  ROW_CLASSES,
  ROW_PRESS,
} from './sidebar-row-classes'
import { FOCUS_RING } from './ui/button'
import { Menu, MenuItem } from './ui/menu'

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

// A status this version knows, else offline (a newer server's)
function knownStatus(s: string): MachineStatus {
  return Object.hasOwn(STATUS_LABEL, s) ? (s as MachineStatus) : 'offline'
}

// The agents that need the user or are working
export function busyCount(m: MachineInfo): number {
  let n = 0
  for (const g of m.groups ?? []) {
    for (const t of g.tabs) {
      for (const p of t.panes) {
        const s = p.agent?.status
        if (s === 'blocked' || s === 'working') n++
      }
    }
  }
  return n
}

interface Props {
  machines: MachineInfo[]
  // The machine open, '' for this one
  current: string
  onSelect: (id: string) => void
  // Opens a machine in a new window (desktop), keeping this one on screen
  onOpenWindow?: (id: string, e: OpenWindowEvent) => void
}

// The sidebar's Machines: this machine first, then each machine this server
// reaches over SSH with its status and how many of its agents need the user or
// work. The open machine's agents are in the Agents list, so none are listed
// here. A machine is picked by id only: it is added, removed and fixed with
// the CLI, which a broken one names under its row.
// A machine other than the one open also opens in a new window (desktop):
// from its menu (a right click, Shift+F10 or the menu key), Ctrl/Cmd+Click
// or a middle click; Shift asks for a popup.
// Nothing at all while there is no machine.
export function SidebarMachines({
  machines,
  current,
  onSelect,
  onOpenWindow,
}: Props) {
  const { t } = useT()
  const [collapsed, setCollapsed] = useState(false)
  // The row whose menu is open, and the point it was right clicked at
  const [menu, setMenu] = useState<{
    id: string
    label: string
    point: { x: number; y: number } | null
    byKey: boolean
  } | null>(null)
  const menuAnchor = useRef<HTMLElement | null>(null)
  if (machines.length === 0 && current === '') return null
  const row = (active: boolean) =>
    `flex h-8 w-full min-w-0 items-center gap-2 rounded-control px-2 text-left text-[13px] ${ROW_PRESS} ${
      active ? ACTIVE_ROW_CLASSES : ROW_CLASSES
    } ${FOCUS_RING} focus-visible:-outline-offset-2`
  // A row's button: switches, or opens a window from its menu or a modified click
  const machineRow = (
    id: string,
    label: string,
    title: string | undefined,
    children: ReactNode,
  ) => {
    const active = current === id
    const openWindow = active ? undefined : onOpenWindow
    const openMenu = (
      el: HTMLElement,
      point: { x: number; y: number } | null,
    ) => {
      menuAnchor.current = el
      setMenu({ id, label, point, byKey: point === null })
    }
    return (
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        aria-haspopup={openWindow ? 'menu' : undefined}
        title={title}
        onClick={(e: MouseEvent) => {
          if (openWindow && (e.ctrlKey || e.metaKey)) {
            openWindow(id, { shiftKey: e.shiftKey })
            return
          }
          onSelect(id)
        }}
        onMouseDown={(e) => {
          // No autoscroll: a middle click opens a window
          if (openWindow && e.button === 1) e.preventDefault()
        }}
        onAuxClick={(e) => {
          if (!openWindow || e.button !== 1) return
          e.preventDefault()
          openWindow(id, { shiftKey: e.shiftKey })
        }}
        onContextMenu={(e) => {
          if (!openWindow) return
          e.preventDefault()
          openMenu(e.currentTarget, { x: e.clientX, y: e.clientY })
        }}
        onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
          // Shift+F10 or the context menu key
          if (!openWindow) return
          if (e.key !== 'ContextMenu' && !(e.key === 'F10' && e.shiftKey))
            return
          e.preventDefault()
          openMenu(e.currentTarget, null)
        }}
        className={row(active)}
      >
        {children}
      </button>
    )
  }
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
          <li className="flex flex-col">
            {machineRow(
              '',
              t('shell.machines.local'),
              undefined,
              <>
                <Monitor size={14} aria-hidden="true" className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  {t('shell.machines.local')}
                </span>
              </>,
            )}
          </li>
          {machines.map((m) => {
            const status = knownStatus(m.status)
            const busy = busyCount(m)
            const failed =
              status === 'incompatible' ||
              status === 'unauthorized' ||
              status === 'hostkey' ||
              status === 'offline'
            const label = visibleUnsafe(m.label)
            return (
              <li key={m.id} className="flex flex-col">
                {machineRow(
                  m.id,
                  label,
                  t('shell.machines.open', { label }),
                  <>
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
                  </>,
                )}
                {failed && (
                  <p className="m-0 pb-1 pl-8 pr-2 text-[12px] text-fg-muted">
                    {t(STATUS_LABEL[status])}. {t('shell.machines.hint')}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {menu && onOpenWindow && (
        <Menu
          label={t('shell.tabs.menu', { name: menu.label })}
          trigger={null}
          anchorRef={menuAnchor}
          point={menu.point}
          focusFirst={menu.byKey}
          align="start"
          open
          onOpenChange={(open) => !open && setMenu(null)}
        >
          <MenuItem
            icon={<AppWindow size={17} />}
            title={t('shell.menu.popupHint')}
            onSelect={(e) => onOpenWindow(menu.id, { shiftKey: e.shiftKey })}
          >
            {t('shell.menu.newWindow')}
          </MenuItem>
        </Menu>
      )}
    </section>
  )
}

// Under the Machines, names the machine the list after it belongs to, so that
// list does not read as part of a machine opened just above. Nothing without
// a machine (no Machines either), or while the one open is not listed yet.
export function MachineListHeading({
  machines,
  current,
}: Pick<Props, 'machines' | 'current'>) {
  const { t } = useT()
  if (machines.length === 0 && current === '') return null
  const label =
    current === ''
      ? t('shell.machines.local')
      : machines.find((m) => m.id === current)?.label
  if (label === undefined) return null
  return (
    <h2 className="m-0 flex h-8 shrink-0 items-center px-3 pt-1 font-label text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
      <span className="min-w-0 truncate">
        {t('shell.machines.on', { label: visibleUnsafe(label) })}
      </span>
    </h2>
  )
}
