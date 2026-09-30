// Static UI mockups for the PWA redesign (issue #232). Dev-only: served by
// `pnpm --filter termote dev` at /mockups/, never part of the production build.
// Nothing here talks to the server; the terminal output is hand-written HTML.
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronFirst,
  ChevronLast,
  ChevronsDown,
  ChevronsUp,
  CircleAlert,
  CircleCheck,
  CircleDot,
  Clipboard,
  Clock,
  CornerDownLeft,
  Delete,
  Expand,
  Eye,
  FolderGit2,
  GitBranch,
  History,
  Info,
  Keyboard,
  Languages,
  LifeBuoy,
  LoaderCircle,
  Maximize,
  MessageSquare,
  Minimize2,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Settings,
  SquareTerminal,
  Sun,
  Trash2,
  X,
  Zap,
} from 'lucide-react'
import { type ReactNode, StrictMode, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import currentSidebar from '../../docs/images/screenshots/mobile-sidebar.png'
import currentTerminal from '../../docs/images/screenshots/mobile-terminal.png'

type Direction = 'a' | 'b' | 'c'
type Theme = 'light' | 'dark'
type Frame = 'all' | 'mobile' | 'desktop'
type AgentStatus = 'blocked' | 'working' | 'done' | 'idle'

const DIRECTIONS: Record<Direction, { name: string; blurb: string }> = {
  a: {
    name: 'A · Terminal-native',
    blurb: 'Chrome trùng nền terminal, viền 1px, một accent, nhãn mono',
  },
  b: {
    name: 'B · Native mobile',
    blurb: 'Surface nổi, bo góc lớn, bottom sheet, xanh hệ thống',
  },
  c: {
    name: 'C · Neutral modern',
    blurb: 'Zinc trung tính, viền mảnh, indigo tiết chế',
  },
}

// ── state in the URL hash: #<direction>-<theme>-<frame> ──
function readHash(): { dir: Direction; theme: Theme; frame: Frame } {
  const [d, t, f] = window.location.hash.slice(1).split('-')
  return {
    dir: d === 'b' || d === 'c' ? d : 'a',
    theme: t === 'light' ? 'light' : 'dark',
    frame: f === 'mobile' || f === 'desktop' ? f : 'all',
  }
}

// ── shared bits ──

function Note({ n, className = '' }: { n: number; className?: string }) {
  return (
    <span
      className={`note pointer-events-none absolute z-50 flex size-5 items-center justify-center rounded-full bg-[#e11d48] text-[11px] font-bold text-white shadow ring-2 ring-white ${className}`}
    >
      {n}
    </span>
  )
}

const STATUS: Record<
  AgentStatus,
  { Icon: typeof CircleAlert; className: string; label: string }
> = {
  blocked: {
    Icon: CircleAlert,
    className: 'text-danger',
    label: 'Agent blocked',
  },
  working: {
    Icon: LoaderCircle,
    className: 'text-warning motion-safe:animate-spin',
    label: 'Agent working',
  },
  done: { Icon: CircleCheck, className: 'text-success', label: 'Agent done' },
  idle: { Icon: CircleDot, className: 'text-fg-subtle', label: 'Agent idle' },
}

function StatusIcon({
  status,
  size = 14,
}: {
  status?: AgentStatus
  size?: number
}) {
  if (!status) return null
  const { Icon, className, label } = STATUS[status]
  return (
    <span role="img" aria-label={label} className="inline-flex shrink-0">
      <Icon size={size} className={className} aria-hidden="true" />
    </span>
  )
}

function ConnDot({ label = false }: { label?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative flex size-2">
        <span className="absolute inset-0 rounded-full bg-success opacity-40 motion-safe:animate-ping" />
        <span className="relative size-2 rounded-full bg-success" />
      </span>
      {label && (
        <span className="font-label text-[11px] text-fg-muted">connected</span>
      )}
    </span>
  )
}

const iconBtn =
  'flex size-10 items-center justify-center rounded-control text-fg-muted hover:bg-surface hover:text-fg transition-colors duration-(--duration-fast) ease-standard'

// Keycap: the one component every toolbar key uses.
const keycap =
  'flex h-touch min-w-10 shrink-0 items-center justify-center px-2 text-fg transition duration-(--duration-fast) ease-standard ' +
  'dir-a:rounded-control dir-a:border dir-a:border-border dir-a:bg-bg dir-a:font-label dir-a:text-[12px] ' +
  'dir-b:rounded-control dir-b:bg-surface-raised dir-b:text-[15px] dir-b:font-medium dir-b:shadow-[0_1px_0_rgb(0_0_0/0.18)] dark:dir-b:shadow-[0_1px_0_rgb(0_0_0/0.8)] active:dir-b:scale-95 ' +
  'dir-c:rounded-control dir-c:border dir-c:border-border dir-c:bg-surface-raised dir-c:text-[13px] dir-c:font-medium'
const keycapOn = 'bg-accent! text-accent-fg! border-accent!'

function Key({
  children,
  on,
  label,
  onClick,
}: {
  children: ReactNode
  // Modifier keys (Ctrl, Shift) pass a boolean and expose it as aria-pressed
  on?: boolean
  label?: string
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={`${keycap} ${on ? keycapOn : ''}`}
    >
      {children}
    </button>
  )
}

// ── fake terminal output ──

function TerminalOutput({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={`font-term leading-[1.45] text-fg whitespace-pre overflow-hidden ${compact ? 'text-[11.5px]' : 'text-[13px]'} p-3`}
    >
      <div>
        <span className="text-ansi-blue">~/develop/termote</span>{' '}
        <span className="text-ansi-magenta">feat/232</span>{' '}
        <span className="text-ansi-green">✓</span>
      </div>
      <div>
        <span className="text-ansi-green">❯</span> claude
      </div>
      <div>
        <span className="text-ansi-magenta">✻</span> Welcome to{' '}
        <span className="font-bold">Claude Code</span>
      </div>
      <div> </div>
      <div>
        <span className="text-ansi-dim">&gt;</span> refactor toolbar keys into
      </div>
      <div>{'  '}one keycap component</div>
      <div> </div>
      <div>
        <span className="text-ansi-green">●</span>{' '}
        <span className="font-bold">Read</span>(keyboard-toolbar.tsx)
      </div>
      <div className="text-ansi-dim">{'  └  Read 538 lines'}</div>
      <div>
        <span className="text-ansi-green">●</span>{' '}
        <span className="font-bold">Update</span>(keyboard-toolbar.tsx)
      </div>
      <div>
        <span className="text-ansi-dim">{'  └  '}</span>
        <span className="text-ansi-green">+24</span>{' '}
        <span className="text-ansi-red">-61</span>
      </div>
      <div>
        <span className="text-ansi-green">●</span>{' '}
        <span className="font-bold">Bash</span>(pnpm test)
      </div>
      <div>
        <span className="text-ansi-dim">{'  └  '}</span>
        <span className="text-ansi-green">✓ 412 passed</span>
        <span className="text-ansi-dim"> (3.1s)</span>
      </div>
      <div> </div>
      <div>
        <span className="text-ansi-yellow">✻ Thinking…</span>{' '}
        <span className="text-ansi-dim">(esc to interrupt)</span>
      </div>
      {!compact && (
        <>
          <div> </div>
          <div className="text-ansi-dim">
            ──────────────────────────────────
          </div>
          <div>
            <span className="text-ansi-dim">&gt;</span>{' '}
            <span className="bg-fg text-bg"> </span>
          </div>
        </>
      )}
    </div>
  )
}

// ── mobile pieces ──

function PhoneFrame({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: ReactNode
}) {
  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">
        {title}
      </figcaption>
      <div
        data-screen={id}
        className="relative flex h-[844px] w-[390px] flex-col overflow-hidden rounded-[44px] bg-bg font-ui text-fg shadow-2xl ring-8 ring-zinc-900"
      >
        {/* status bar (safe-area-inset-top) */}
        <div className="flex h-11 shrink-0 items-end justify-between px-8 pb-1 text-[13px] font-semibold">
          <span>9:41</span>
          <span className="tracking-widest">▂▄▆ ■</span>
        </div>
        {children}
        {/* home indicator (safe-area-inset-bottom) */}
        <div className="flex h-6 shrink-0 items-center justify-center bg-surface dir-a:bg-bg">
          <span className="h-1 w-32 rounded-full bg-fg/80" />
        </div>
      </div>
    </figure>
  )
}

function MobileTopBar({
  onChip,
  onMore,
  note = true,
}: {
  onChip?: () => void
  onMore?: () => void
  // Screens that explain other parts hide the top bar's marker
  note?: boolean
}) {
  return (
    <header className="relative flex h-12 shrink-0 items-center gap-2 px-2 dir-a:border-b dir-a:border-border dir-b:bg-bg dir-c:border-b dir-c:border-border">
      {note && <Note n={1} className="left-1 top-0" />}
      <button
        type="button"
        onClick={onChip}
        aria-label="Open sessions menu"
        className="flex min-w-0 flex-1 items-center gap-2 px-2 h-10 text-left transition-colors dir-a:rounded-control dir-a:hover:bg-surface dir-b:rounded-full dir-b:bg-surface dir-b:px-3 dir-c:rounded-control dir-c:hover:bg-surface"
      >
        <span className="text-[18px] leading-none">🤖</span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold dir-a:font-label dir-a:text-[14px]">
              claude
            </span>
            <StatusIcon status="working" size={13} />
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-fg-muted dir-a:font-label">
            <ConnDot /> termote · 3 sessions
          </span>
        </span>
        <ChevronDown size={16} className="ml-auto shrink-0 text-fg-subtle" />
      </button>
      <button
        type="button"
        onClick={onMore}
        aria-label="More"
        className={iconBtn}
      >
        <MoreHorizontal size={20} />
      </button>
    </header>
  )
}

// Collapsed row in the same order as keyboard-toolbar.tsx; Quick actions and
// expand stay pinned on the right while the rest scrolls
const ROW_MAIN: {
  k: ReactNode
  label?: string
  modifier?: 'ctrl' | 'shift'
}[] = [
  { k: <Keyboard size={18} />, label: 'Toggle keyboard' },
  { k: <Languages size={18} />, label: 'IME input' },
  { k: <Clock size={18} />, label: 'Command history' },
  { k: 'Tab' },
  { k: 'Esc' },
  { k: <CornerDownLeft size={18} />, label: 'Enter' },
  { k: 'Ctrl', modifier: 'ctrl' },
  { k: 'Shift', modifier: 'shift' },
  { k: <ArrowUp size={18} />, label: 'Up' },
  { k: <ArrowDown size={18} />, label: 'Down' },
  { k: <ArrowLeft size={18} />, label: 'Left' },
  { k: <ArrowRight size={18} />, label: 'Right' },
]

const CTRL_COMBOS = ['C', 'D', 'Z', 'L', 'A', 'E']
const CTRL_COMBOS_FULL = [
  ...CTRL_COMBOS,
  'B',
  'X',
  'K',
  'U',
  'W',
  'R',
  'P',
  'N',
]

function Toolbar({
  expanded = false,
  ctrlOn = false,
  onToggleExpand,
}: {
  expanded?: boolean
  ctrlOn?: boolean
  onToggleExpand?: () => void
}) {
  const groupLabel =
    'px-1 pt-2 pb-1 text-[10px] uppercase tracking-wider text-fg-subtle font-label'
  return (
    <div className="relative shrink-0 border-t border-border bg-surface dir-a:bg-bg dir-b:border-t-0 dir-b:pt-1">
      <Note n={expanded ? 6 : 3} className="-top-2.5 right-3" />
      {expanded && (
        <div className="px-2 pb-1">
          <div className={groupLabel}>Navigate</div>
          <div className="flex gap-1.5 overflow-x-auto">
            <Key label="Home">
              <ChevronFirst size={18} />
            </Key>
            <Key label="End">
              <ChevronLast size={18} />
            </Key>
            <Key label="Delete">
              <Delete size={18} />
            </Key>
            <Key>Bksp</Key>
            <Key>PgUp</Key>
            <Key>PgDn</Key>
            <Key>Ins</Key>
          </div>
          <div className={groupLabel}>Scroll · copy mode</div>
          <div className="flex gap-1.5">
            <Key label="Copy mode">
              <History size={18} />
            </Key>
            <Key label="Paste buffer">
              <Clipboard size={18} />
            </Key>
            <Key label="Scroll up">
              <ChevronsUp size={18} />
            </Key>
            <Key label="Scroll down">
              <ChevronsDown size={18} />
            </Key>
          </div>
          {/* Only while Ctrl is on, as today; Ctrl+Shift shows ^⇧C V Z X instead */}
          {ctrlOn && (
            <>
              <div className={groupLabel}>Ctrl + (while Ctrl is on)</div>
              <div className="grid grid-cols-7 gap-1.5">
                {CTRL_COMBOS_FULL.map((c) => (
                  <Key key={c}>
                    <span className="dir-a:text-fg-subtle">^</span>
                    {c}
                  </Key>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <div className="flex gap-1.5 overflow-x-auto pr-6 [scrollbar-width:none]">
            {ROW_MAIN.map((r, i) => (
              <Key
                key={i}
                label={r.label}
                on={r.modifier ? ctrlOn && r.modifier === 'ctrl' : undefined}
              >
                {r.k}
              </Key>
            ))}
            {/* Collapsed + Ctrl on: the 6 common combos follow in the same row */}
            {ctrlOn &&
              !expanded &&
              CTRL_COMBOS.map((c) => <Key key={c}>^{c}</Key>)}
          </div>
          {/* fade: the row scrolls sideways */}
          <span className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface dir-a:from-bg" />
        </div>
        <span className="relative">
          <Note n={4} className="-top-3 -left-1" />
          <Key label="Quick actions">
            <Zap size={18} />
          </Key>
        </span>
        <Key
          label={expanded ? 'Collapse keyboard' : 'Expand keyboard'}
          onClick={onToggleExpand}
        >
          {expanded ? <Minimize2 size={18} /> : <Expand size={18} />}
        </Key>
      </div>
    </div>
  )
}

function OverflowMenu() {
  const item =
    'flex h-11 w-full items-center gap-3 px-3 text-[14px] text-fg dir-a:font-label dir-a:text-[13px] hover:bg-surface'
  return (
    <div
      role="menu"
      aria-label="More"
      className="absolute right-2 top-[92px] z-40 w-64 border border-border bg-surface-raised shadow-xl rounded-panel dir-b:border-0"
    >
      <Note n={5} className="-left-2 -top-2" />
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[13px] text-fg-muted dir-a:font-label">
          Font size
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Decrease font size"
            className={`${keycap} h-9! min-w-9!`}
          >
            A−
          </button>
          <span className="w-7 text-center font-label text-[13px] text-fg">
            14
          </span>
          <button
            type="button"
            aria-label="Increase font size"
            className={`${keycap} h-9! min-w-9!`}
          >
            A+
          </button>
        </div>
      </div>
      <div className="flex items-center justify-between px-3 pb-2">
        <span className="text-[13px] text-fg-muted dir-a:font-label">
          Theme
        </span>
        <Segmented
          label="Theme"
          options={[
            { node: <Sun size={14} aria-hidden="true" />, label: 'Light' },
            { node: <Moon size={14} aria-hidden="true" />, label: 'Dark' },
            { node: <Monitor size={14} aria-hidden="true" />, label: 'System' },
          ]}
          active={1}
        />
      </div>
      <div className="border-t border-border" />
      <button type="button" role="menuitem" className={item}>
        <Settings size={17} className="text-fg-muted" /> Settings
      </button>
      <button type="button" role="menuitem" className={item}>
        <LifeBuoy size={17} className="text-fg-muted" /> Help &amp; gestures
      </button>
      <button type="button" role="menuitem" className={item}>
        <Info size={17} className="text-fg-muted" /> About
      </button>
      <div className="border-t border-border" />
      <button type="button" role="menuitem" className={`${item} text-danger!`}>
        <RotateCcw size={17} /> Clear cache &amp; reload
      </button>
    </div>
  )
}

type SegmentOption = string | { node: ReactNode; label: string }

function Segmented({
  label,
  options,
  active,
}: {
  label: string
  options: SegmentOption[]
  active: number
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex gap-0.5 p-0.5 bg-bg border border-border rounded-control dir-b:border-0 dir-b:bg-surface dark:dir-b:bg-bg"
    >
      {options.map((o, i) => (
        <button
          key={i}
          type="button"
          role="radio"
          aria-checked={i === active}
          aria-label={typeof o === 'string' ? undefined : o.label}
          // Roving tabindex: one tab stop per group, arrows move inside it
          tabIndex={i === active ? 0 : -1}
          className={`flex h-8 min-w-9 items-center justify-center px-2 text-[13px] rounded-[calc(var(--radius-control)-2px)] dir-a:font-label ${
            i === active
              ? 'bg-surface-raised text-fg shadow-sm dir-a:bg-accent-soft dir-a:text-accent dir-a:shadow-none'
              : 'text-fg-muted'
          }`}
        >
          {typeof o === 'string' ? o : o.node}
        </button>
      ))}
    </div>
  )
}

function Switch({ on, label }: { on: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors duration-(--duration-fast) dir-a:h-6 dir-a:w-10 dir-a:rounded-control ${on ? 'bg-accent' : 'bg-border-strong'}`}
    >
      <span
        className={`absolute size-5.5 rounded-full bg-white shadow transition-transform duration-(--duration-fast) ease-standard dir-a:size-4.5 dir-a:rounded-[2px] ${on ? 'translate-x-[23px] dir-a:translate-x-[19px]' : 'translate-x-[3px]'}`}
      />
    </button>
  )
}

interface MockSession {
  icon: string
  name: string
  desc?: string
  status?: AgentStatus
  active?: boolean
}

const GROUPS: {
  name: string
  status?: AgentStatus
  sessions: MockSession[]
}[] = [
  {
    name: 'termote',
    status: 'working',
    sessions: [
      {
        icon: '🤖',
        name: 'claude',
        desc: 'PWA redesign',
        status: 'working',
        active: true,
      },
      { icon: '🐚', name: 'shell', desc: 'pnpm dev' },
      { icon: '📜', name: 'logs', status: 'done' },
    ],
  },
  {
    name: 'blog',
    status: 'blocked',
    sessions: [
      { icon: '✍️', name: 'drafts', desc: 'Chirpy post', status: 'blocked' },
      { icon: '🧪', name: 'tests', status: 'idle' },
    ],
  },
]

function SessionRow({
  s,
  swiped = false,
}: {
  s: MockSession
  swiped?: boolean
}) {
  return (
    <div className="relative overflow-hidden rounded-control">
      {swiped && (
        <div className="absolute inset-y-0 right-0 flex">
          <span className="flex w-16 items-center justify-center bg-accent text-accent-fg">
            <Pencil size={18} />
          </span>
          <span className="flex w-16 items-center justify-center bg-danger text-white dark:text-bg">
            <Trash2 size={18} />
          </span>
        </div>
      )}
      <button
        type="button"
        aria-current={s.active ? 'true' : undefined}
        className={`relative flex h-14 w-full items-center gap-3 px-3 text-left ${swiped ? 'w-auto! mr-32' : ''} ${
          s.active
            ? 'bg-accent-soft dir-a:border-l-2 dir-a:border-accent dir-a:bg-surface'
            : 'bg-bg dir-b:bg-surface-raised'
        }`}
      >
        <span className="flex size-9 items-center justify-center text-[18px] rounded-control bg-surface dir-b:bg-bg">
          {s.icon}
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`block truncate text-[15px] dir-a:font-label dir-a:text-[14px] ${s.active ? 'font-semibold text-fg' : 'text-fg'}`}
          >
            {s.name}
          </span>
          {s.desc && (
            <span className="block truncate text-[12px] text-fg-muted">
              {s.desc}
            </span>
          )}
        </span>
        <StatusIcon status={s.status} size={16} />
      </button>
    </div>
  )
}

function SessionsSheet() {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="sessions-title"
      className="absolute inset-x-0 bottom-0 top-24 z-30 flex flex-col border-t border-border bg-bg shadow-[0_-12px_40px_rgb(0_0_0/0.25)] rounded-t-sheet dir-b:border-0 dir-b:bg-surface dark:dir-b:bg-surface"
    >
      <Note n={2} className="left-4 -top-2.5" />
      <div className="flex justify-center pt-2 dir-a:hidden dir-c:hidden">
        <span className="h-1.5 w-10 rounded-full bg-border-strong" />
      </div>
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <h2
          id="sessions-title"
          className="m-0 text-[17px] font-semibold dir-a:font-label dir-a:text-[14px] dir-a:uppercase dir-a:tracking-wider"
        >
          Sessions
        </h2>
        <div className="flex gap-1">
          <button
            type="button"
            aria-label="Add session"
            className="flex h-9 items-center gap-1.5 px-3 text-[14px] font-medium bg-accent text-accent-fg rounded-control dir-b:rounded-full"
          >
            <Plus size={16} /> New
          </button>
          <button type="button" aria-label="Close sessions" className={iconBtn}>
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-hidden px-2">
        {GROUPS.map((g, gi) => (
          <section key={g.name} className="pb-2">
            <div className="flex items-center gap-2 px-2 pb-1 pt-2 text-[11px] uppercase tracking-wider text-fg-subtle font-label">
              <ChevronDown size={12} /> {g.name}
              <span className="ml-auto">
                <StatusIcon status={g.status} size={12} />
              </span>
            </div>
            <div className="flex flex-col gap-1 dir-b:gap-px dir-b:overflow-hidden dir-b:rounded-panel">
              {g.sessions.map((s, si) => (
                <SessionRow key={s.name} s={s} swiped={gi === 1 && si === 0} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function SettingsRow({
  title,
  desc,
  children,
}: {
  title: string
  desc?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-14 items-center gap-3 px-4 py-2.5 dir-b:bg-surface-raised">
      <div className="min-w-0 flex-1">
        <div className="text-[15px] text-fg dir-a:font-label dir-a:text-[13px]">
          {title}
        </div>
        {desc && <div className="text-[12px] text-fg-muted">{desc}</div>}
      </div>
      {children}
    </div>
  )
}

function SettingsGroup({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <section className="pb-3">
      <h3 className="m-0 px-4 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle font-label">
        {title}
      </h3>
      <div className="divide-y divide-border border-y border-border dir-b:mx-4 dir-b:overflow-hidden dir-b:rounded-panel dir-b:border-0 dir-c:mx-4 dir-c:rounded-panel dir-c:border">
        {children}
      </div>
    </section>
  )
}

// Every control settings-modal.tsx has today, grouped, plus the uiStyle choice
function SettingsBody() {
  const textBtn =
    'h-9 px-3 text-[13px] font-medium border border-border rounded-control dir-b:border-0 dir-b:bg-bg'
  // The page's own direction switch stands in for the uiStyle setting
  const styleIndex = ['a', 'b', 'c'].indexOf(readHash().dir)
  return (
    <>
      <SettingsGroup title="Appearance">
        <SettingsRow title="Interface style" desc="Theme stays in the ⋯ menu">
          <Segmented
            label="Interface style"
            options={['Terminal', 'Native', 'Neutral']}
            active={styleIndex}
          />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Keyboard">
        <SettingsRow title="Text input send behavior">
          <Segmented
            label="Text input send behavior"
            options={['Send + Enter', 'Text only']}
            active={0}
          />
        </SettingsRow>
        <SettingsRow
          title="Paste button source"
          desc="tmux only; hidden on herdr"
        >
          <Segmented
            label="Paste button source"
            options={['System', 'tmux']}
            active={0}
          />
        </SettingsRow>
        <SettingsRow
          title="Toolbar default expanded"
          desc="Show all keys when toolbar loads"
        >
          <Switch on={false} label="Toolbar default expanded" />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Terminal">
        <SettingsRow title="Terminal font" desc="Saved on blur or Enter">
          <input
            aria-label="Terminal font"
            defaultValue="JetBrains Mono"
            className="h-9 w-36 px-2 text-[13px] text-fg bg-bg font-label border border-border rounded-control dir-b:border-0"
          />
        </SettingsRow>
        <SettingsRow
          title="Disable right-click menu"
          desc="Block context menu on terminal area"
        >
          <Switch on label="Disable right-click menu" />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Sessions">
        <SettingsRow
          title="Show session tabs"
          desc="Tab bar for quick switching (desktop)"
        >
          <Switch on label="Show session tabs" />
        </SettingsRow>
        <SettingsRow
          title="Session poll interval"
          desc="How often to sync the session list"
        >
          <span className="font-label text-[13px] text-fg-muted">5 s</span>
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title="Data &amp; help">
        <SettingsRow title="Command history" desc="23 commands on this device">
          <button type="button" className={`${textBtn} text-danger`}>
            Clear
          </button>
        </SettingsRow>
        <SettingsRow
          title="Gesture hints"
          desc="Show the first-run tutorial again"
        >
          <button type="button" className={`${textBtn} text-fg`}>
            Show
          </button>
        </SettingsRow>
        <SettingsRow title="Updates">
          <button type="button" className={`${textBtn} text-fg`}>
            Check for updates
          </button>
        </SettingsRow>
      </SettingsGroup>
    </>
  )
}

function SettingsSheet() {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      className="absolute inset-x-0 bottom-0 top-11 z-30 flex flex-col bg-bg dir-b:top-14 dir-b:rounded-t-sheet dir-b:shadow-[0_-12px_40px_rgb(0_0_0/0.25)]"
    >
      <Note n={1} className="left-32 top-3" />
      <div className="flex justify-center pt-2 dir-a:hidden dir-c:hidden">
        <span className="h-1.5 w-10 rounded-full bg-border-strong" />
      </div>
      <div className="flex h-12 items-center justify-between border-b border-border px-4 dir-b:border-0">
        <h2
          id="settings-title"
          className="m-0 text-[17px] font-semibold dir-a:font-label dir-a:text-[14px] dir-a:uppercase dir-a:tracking-wider"
        >
          Settings
        </h2>
        <button type="button" aria-label="Close settings" className={iconBtn}>
          <X size={18} />
        </button>
      </div>
      <div className="relative flex-1 overflow-hidden">
        <Note n={2} className="right-3 top-12" />
        <SettingsBody />
      </div>
    </div>
  )
}

function MobileTerminalScreen({
  interactive = false,
  expanded = false,
  menu = false,
}: {
  interactive?: boolean
  expanded?: boolean
  menu?: boolean
}) {
  const [open, setOpen] = useState<'none' | 'menu' | 'sessions'>(
    menu ? 'menu' : 'none',
  )
  const [exp, setExp] = useState(expanded)
  return (
    <>
      <MobileTopBar
        onChip={
          interactive
            ? () => setOpen(open === 'sessions' ? 'none' : 'sessions')
            : undefined
        }
        onMore={
          interactive
            ? () => setOpen(open === 'menu' ? 'none' : 'menu')
            : undefined
        }
      />
      <div className="relative min-h-0 flex-1 bg-term">
        {!expanded && <Note n={2} className="right-3 top-2" />}
        <TerminalOutput compact={expanded} />
      </div>
      <Toolbar
        expanded={exp}
        ctrlOn={expanded}
        onToggleExpand={interactive ? () => setExp(!exp) : undefined}
      />
      {open === 'menu' && (
        <>
          <div
            className="absolute inset-0 z-30"
            onClick={() => setOpen('none')}
          />
          <OverflowMenu />
        </>
      )}
      {open === 'sessions' && (
        <>
          <div
            className="absolute inset-0 z-20 bg-overlay animate-[fade_var(--duration-fast)_ease-out]"
            onClick={() => setOpen('none')}
          />
          <div className="animate-[sheet_var(--duration-base)_var(--ease-emphasized)]">
            <SessionsSheet />
          </div>
        </>
      )}
    </>
  )
}

function ImeScreen() {
  return (
    <>
      <MobileTopBar note={false} />
      <div className="relative min-h-0 flex-1 bg-term">
        <TerminalOutput compact />
      </div>
      <div className="relative shrink-0 border-t border-border bg-surface px-2 py-1.5 dir-a:bg-bg dir-b:border-t-0">
        <Note n={1} className="-top-2.5 left-3" />
        <div className="flex items-center gap-1.5">
          <Key label="Close IME input">
            <X size={18} />
          </Key>
          <input
            aria-label="IME input"
            defaultValue="sửa lỗi hiển thị tiếng Việt"
            className="h-touch min-w-0 flex-1 px-3 text-[15px] text-fg bg-bg border border-accent rounded-control outline-none dir-b:border-0 dir-b:bg-bg"
          />
          <Key label="Send text" on={undefined}>
            <Send size={18} />
          </Key>
        </div>
      </div>
      {/* OS keyboard: ~300px the page does not own */}
      <div className="relative flex h-[291px] shrink-0 items-center justify-center bg-[repeating-linear-gradient(135deg,transparent_0_10px,rgb(127_127_127/0.12)_10px_20px)] text-[12px] text-fg-muted">
        <Note n={2} className="left-3 top-3" />
        Bàn phím hệ điều hành (~300px)
      </div>
    </>
  )
}

// ── upcoming features (#233, #236, #237): drawn only to check the layout holds them ──

// Dashed outline + issue tag: this part is not built in #232
function Future({
  issue,
  children,
  className = '',
}: {
  issue: string
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={`future relative outline-2 outline-dashed outline-offset-[-2px] outline-[#a855f7] ${className}`}
    >
      <span className="pointer-events-none absolute -top-2 right-1 z-40 rounded bg-[#a855f7] px-1.5 py-px font-sans text-[10px] font-bold text-white">
        {issue}
      </span>
      {children}
    </div>
  )
}

type ViewId = 'terminal' | 'chat' | 'files'

const VIEWS: { id: ViewId; label: string; Icon: typeof CircleAlert }[] = [
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'files', label: 'Files', Icon: FolderGit2 },
]

// L8: one tab per available view; not rendered when only Terminal is available
function ViewSwitcher({
  view,
  compact = false,
}: {
  view: ViewId
  compact?: boolean
}) {
  return (
    <div
      role="tablist"
      aria-label="View"
      className="flex shrink-0 gap-0.5 p-0.5 bg-surface border border-border rounded-control dir-b:border-0 dir-b:rounded-full"
    >
      {VIEWS.map(({ id, label, Icon }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={id === view}
          aria-label={label}
          tabIndex={id === view ? 0 : -1}
          className={`flex items-center justify-center gap-1.5 rounded-[calc(var(--radius-control)-2px)] dir-b:rounded-full ${compact ? 'h-7 px-2.5 text-[12px]' : 'size-9'} ${
            id === view
              ? 'bg-surface-raised text-fg shadow-sm dir-a:bg-accent-soft dir-a:text-accent dir-a:shadow-none'
              : 'text-fg-muted'
          }`}
        >
          <Icon size={compact ? 14 : 17} aria-hidden="true" />
          {compact && <span className="dir-a:font-label">{label}</span>}
        </button>
      ))}
    </div>
  )
}

function FutureTopBar({
  view,
  readOnly = false,
}: {
  view: ViewId
  readOnly?: boolean
}) {
  return (
    <header className="relative flex h-12 shrink-0 items-center gap-1.5 px-2 dir-a:border-b dir-a:border-border dir-c:border-b dir-c:border-border">
      <button
        type="button"
        aria-label="Open sessions menu"
        className="flex min-w-0 flex-1 items-center gap-2 px-2 h-10 text-left dir-a:rounded-control dir-b:rounded-full dir-b:bg-surface dir-c:rounded-control"
      >
        <span className="text-[18px] leading-none">🤖</span>
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-[15px] font-semibold dir-a:font-label dir-a:text-[14px]">
              claude
            </span>
            <StatusIcon status="working" size={13} />
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-fg-muted dir-a:font-label">
            <ConnDot /> {readOnly ? 'view only' : 'termote'}
          </span>
        </span>
      </button>
      {!readOnly && (
        <Future issue="L8" className="rounded-control">
          <ViewSwitcher view={view} />
        </Future>
      )}
      <button type="button" aria-label="More" className={iconBtn}>
        <MoreHorizontal size={20} />
      </button>
    </header>
  )
}

function ToolCard({
  tool,
  target,
  meta,
  open = false,
}: {
  tool: string
  target: string
  meta: ReactNode
  open?: boolean
}) {
  return (
    <div className="border border-border bg-surface rounded-panel dir-b:border-0">
      <button
        type="button"
        aria-expanded={open}
        className="flex h-10 w-full items-center gap-2 px-3 text-left text-[13px]"
      >
        <CircleCheck
          size={14}
          className="shrink-0 text-success"
          aria-hidden="true"
        />
        <span className="font-semibold">{tool}</span>
        <span className="min-w-0 flex-1 truncate font-term text-[12px] text-fg-muted">
          {target}
        </span>
        <span className="shrink-0 font-term text-[12px]">{meta}</span>
        <ChevronDown
          size={14}
          className={`shrink-0 text-fg-subtle ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="border-t border-border font-term text-[11.5px] leading-[1.5]">
          <div className="bg-danger/10 px-3 text-danger">
            - {'<button className="min-w-11 h-11'}
          </div>
          <div className="bg-success/10 px-3 text-success">
            + {'<Key label={label} on={on}>'}
          </div>
          <div className="px-3 text-fg-subtle">{'  … 58 more lines'}</div>
        </div>
      )}
    </div>
  )
}

function ChatScreen() {
  return (
    <>
      <FutureTopBar view="chat" />
      <Future issue="#233" className="flex min-h-0 flex-1 flex-col">
        <div className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-hidden bg-bg px-3 py-3 text-[14px] leading-relaxed">
          <Note n={1} className="left-2 top-2" />
          <div className="ml-10 self-end bg-accent px-3 py-2 text-accent-fg rounded-panel dir-a:rounded-control">
            refactor the toolbar keys into one keycap component
          </div>
          <p className="m-0 text-fg">
            I'll read the toolbar first, then pull the shared styles out.
          </p>
          <ToolCard
            tool="Read"
            target="keyboard-toolbar.tsx"
            meta={<span className="text-fg-muted">538 lines</span>}
          />
          <div className="relative">
            <Note n={2} className="-left-1 -top-2" />
            <ToolCard
              tool="Update"
              target="keyboard-toolbar.tsx"
              meta={
                <>
                  <span className="text-success">+24</span>{' '}
                  <span className="text-danger">−61</span>
                </>
              }
              open
            />
          </div>
          <div className="relative border border-warning bg-warning/10 p-3 rounded-panel">
            <Note n={3} className="-left-1 -top-2" />
            <div className="flex items-center gap-2 text-[13px] font-semibold text-fg">
              <CircleAlert
                size={15}
                className="text-warning"
                aria-hidden="true"
              />{' '}
              Allow this command?
            </div>
            <div className="mt-1.5 bg-bg px-2 py-1.5 font-term text-[12px] text-fg rounded-control">
              pnpm --filter termote test
            </div>
            <div className="mt-2.5 flex gap-2">
              <button
                type="button"
                className="h-9 flex-1 bg-accent text-[13px] font-medium text-accent-fg rounded-control dir-b:rounded-full"
              >
                Allow once
              </button>
              <button
                type="button"
                className="h-9 flex-1 border border-border text-[13px] font-medium text-fg rounded-control dir-b:rounded-full dir-b:border-0 dir-b:bg-surface"
              >
                Always
              </button>
              <button
                type="button"
                className="h-9 flex-1 border border-border text-[13px] font-medium text-danger rounded-control dir-b:rounded-full dir-b:border-0 dir-b:bg-surface"
              >
                Deny
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[13px] text-fg-muted">
            <StatusIcon status="blocked" size={14} /> Waiting for your answer
          </div>
        </div>
        {/* the view owns the bottom input area: a composer instead of the key toolbar */}
        <div className="relative flex shrink-0 items-end gap-2 border-t border-border bg-surface px-2 py-2 dir-a:bg-bg">
          <Note n={4} className="-top-2.5 left-3" />
          <Key label="Interrupt">Esc</Key>
          <div className="flex min-h-11 flex-1 items-center px-3 text-[15px] text-fg-subtle bg-bg border border-border rounded-control dir-b:border-0 dir-b:rounded-[22px]">
            Message claude…
          </div>
          <button
            type="button"
            aria-label="Send"
            className="flex size-11 shrink-0 items-center justify-center bg-accent text-accent-fg rounded-control dir-b:rounded-full"
          >
            <Send size={18} />
          </button>
        </div>
      </Future>
    </>
  )
}

const CHANGES: {
  st: 'A' | 'M' | 'D' | 'U'
  path: string
  add?: number
  del?: number
  staged?: boolean
}[] = [
  { st: 'A', path: 'pwa/mockups/main.tsx', add: 1294, staged: true },
  {
    st: 'M',
    path: 'pwa/src/components/keyboard-toolbar.tsx',
    add: 24,
    del: 61,
  },
  { st: 'M', path: 'pwa/src/index.css', add: 3 },
  { st: 'D', path: 'pwa/tailwind.config.js', del: 14 },
  { st: 'U', path: 'pwa/e2e/capture-mockups.spec.ts' },
]

const ST_CLASS = {
  A: 'text-success bg-success/12',
  M: 'text-warning bg-warning/12',
  D: 'text-danger bg-danger/12',
  U: 'text-info bg-info/12',
}

function ChangeRow({ c }: { c: (typeof CHANGES)[number] }) {
  const slash = c.path.lastIndexOf('/')
  return (
    <button
      type="button"
      className="flex h-13 w-full items-center gap-3 px-3 text-left dir-b:bg-surface-raised"
    >
      <span
        className={`flex size-6 shrink-0 items-center justify-center font-label text-[12px] font-bold rounded-control ${ST_CLASS[c.st]}`}
      >
        {c.st}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] text-fg dir-a:font-label dir-a:text-[13px]">
          {c.path.slice(slash + 1)}
        </span>
        <span className="block truncate font-term text-[11px] text-fg-subtle">
          {c.path.slice(0, slash)}
        </span>
      </span>
      <span className="shrink-0 font-term text-[12px]">
        {c.add ? <span className="text-success">+{c.add}</span> : null}{' '}
        {c.del ? <span className="text-danger">−{c.del}</span> : null}
      </span>
    </button>
  )
}

function FilesTabs({ active }: { active: 'files' | 'changes' }) {
  return (
    <div className="flex items-center justify-between px-3 py-2">
      <Segmented
        label="Files view"
        options={['Files', 'Changes 5']}
        active={active === 'files' ? 0 : 1}
      />
      <span className="flex items-center gap-1 font-label text-[12px] text-fg-muted">
        <GitBranch size={13} aria-hidden="true" /> feat/232
      </span>
    </div>
  )
}

function ChangesScreen() {
  const group = (title: string, rows: typeof CHANGES) => (
    <section className="pb-2">
      <h3 className="m-0 px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wider text-fg-subtle font-label">
        {title} · {rows.length}
      </h3>
      <div className="divide-y divide-border dir-b:mx-3 dir-b:divide-y-0 dir-b:space-y-px dir-b:overflow-hidden dir-b:rounded-panel">
        {rows.map((c) => (
          <ChangeRow key={c.path} c={c} />
        ))}
      </div>
    </section>
  )
  return (
    <>
      <FutureTopBar view="files" />
      <Future
        issue="#237"
        className="relative flex min-h-0 flex-1 flex-col bg-bg"
      >
        <Note n={1} className="left-2 top-2" />
        <FilesTabs active="changes" />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <Note n={2} className="right-3 top-1" />
          {group(
            'Staged',
            CHANGES.filter((c) => c.staged),
          )}
          {group(
            'Unstaged',
            CHANGES.filter((c) => !c.staged),
          )}
        </div>
        <div className="shrink-0 border-t border-border px-3 py-2 text-[12px] text-fg-muted">
          Read-only · run git commands in the terminal
        </div>
      </Future>
    </>
  )
}

const DIFF: {
  t: ' ' | '+' | '-' | '@'
  a?: number
  b?: number
  text: string
}[] = [
  { t: '@', text: '@@ -145,12 +145,9 @@ const iconBtn' },
  { t: ' ', a: 145, b: 145, text: '// Keycap: every toolbar key' },
  { t: '-', a: 146, text: 'className={`min-w-11 h-11 px-3' },
  { t: '-', a: 147, text: '  rounded-xl text-sm font-mono' },
  { t: '-', a: 148, text: '  ${getKeyButtonBg(keyConfig)}`}' },
  { t: '+', b: 146, text: 'const keycap =' },
  { t: '+', b: 147, text: "  'flex h-touch min-w-10 px-2'" },
  { t: ' ', a: 149, b: 148, text: '' },
  { t: ' ', a: 150, b: 149, text: 'function Key({ children }) {' },
  { t: '-', a: 151, text: '  return <button className={cls}>' },
  { t: '+', b: 150, text: '  return <button className={keycap}>' },
  { t: ' ', a: 152, b: 151, text: '    {children}' },
  { t: '@', text: '@@ -480,7 +477,7 @@ export function' },
  { t: ' ', a: 480, b: 477, text: '<Key' },
  { t: '-', a: 481, text: '  className={btnClass}' },
  { t: '+', b: 478, text: '  on={ctrlActive}' },
]

function DiffLines({ lines = DIFF }: { lines?: typeof DIFF }) {
  return (
    <div className="font-term text-[11.5px] leading-[1.6]">
      {lines.map((l, i) =>
        l.t === '@' ? (
          <div key={i} className="bg-info/10 px-2 text-info">
            {l.text}
          </div>
        ) : (
          <div
            key={i}
            className={`flex ${l.t === '+' ? 'bg-success/12' : l.t === '-' ? 'bg-danger/12' : ''}`}
          >
            <span className="w-8 shrink-0 select-none pr-1 text-right text-fg-subtle">
              {l.a ?? ''}
            </span>
            <span className="w-8 shrink-0 select-none pr-1 text-right text-fg-subtle">
              {l.b ?? ''}
            </span>
            <span
              className={`w-4 shrink-0 text-center ${l.t === '+' ? 'text-success' : l.t === '-' ? 'text-danger' : 'text-fg-subtle'}`}
            >
              {l.t}
            </span>
            <span className="min-w-0 whitespace-pre-wrap break-all pr-2 text-fg">
              {l.text}
            </span>
          </div>
        ),
      )}
    </div>
  )
}

function DiffScreen() {
  return (
    <>
      <FutureTopBar view="files" />
      <Future
        issue="#237"
        className="relative flex min-h-0 flex-1 flex-col bg-bg"
      >
        <div className="relative flex h-12 shrink-0 items-center gap-1 border-b border-border px-1">
          <Note n={1} className="left-1 -top-1" />
          <button
            type="button"
            aria-label="Back to changes"
            className={iconBtn}
          >
            <ArrowLeft size={18} />
          </button>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-semibold dir-a:font-label">
              keyboard-toolbar.tsx
            </span>
            <span className="block font-term text-[11px] text-fg-muted">
              unstaged · <span className="text-success">+24</span>{' '}
              <span className="text-danger">−61</span>
            </span>
          </span>
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden bg-term py-1">
          <Note n={2} className="right-3 top-2" />
          <DiffLines />
        </div>
        <div className="relative flex shrink-0 items-center justify-between border-t border-border px-2 py-1.5">
          <Note n={3} className="-top-2.5 left-3" />
          <Key label="Previous file">
            <ArrowUp size={18} />
          </Key>
          <span className="font-label text-[12px] text-fg-muted">
            2 / 5 files
          </span>
          <Key label="Next file">
            <ArrowDown size={18} />
          </Key>
        </div>
      </Future>
    </>
  )
}

function LoginScreen() {
  return (
    <Future
      issue="#236"
      className="relative flex min-h-0 flex-1 flex-col items-stretch justify-center gap-6 bg-bg px-7"
    >
      <div className="flex flex-col items-center gap-3">
        <span className="flex size-14 items-center justify-center bg-accent text-[22px] font-bold text-accent-fg rounded-panel dir-b:rounded-[18px]">
          ›_
        </span>
        <div className="text-center">
          <div className="text-[22px] font-semibold dir-a:font-label">
            termote
          </div>
          <div className="font-label text-[12px] text-fg-muted">
            box.local:7680
          </div>
        </div>
      </div>
      <div className="relative flex flex-col gap-2.5">
        <Note n={1} className="-left-4 -top-2" />
        <label className="text-[13px] font-medium text-fg-muted" htmlFor="pw">
          Password
        </label>
        <input
          id="pw"
          type="password"
          defaultValue="correcthorse"
          className="h-12 px-3 text-[16px] text-fg bg-surface border border-border rounded-control outline-none dir-b:border-0"
        />
        <button
          type="button"
          className="h-12 bg-accent text-[15px] font-semibold text-accent-fg rounded-control dir-b:rounded-full"
        >
          Sign in
        </button>
      </div>
      <div className="flex items-center gap-3 text-[12px] text-fg-subtle">
        <span className="h-px flex-1 bg-border" /> or pair this device{' '}
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="relative flex flex-col gap-2.5">
        <Note n={2} className="-left-4 -top-2" />
        <div className="flex justify-between gap-2">
          {['4', '7', '1', '', '', ''].map((d, i) => (
            <span
              key={i}
              className={`flex h-13 flex-1 items-center justify-center font-label text-[22px] text-fg bg-surface border rounded-control dir-b:border-0 ${i === 3 ? 'border-accent ring-2 ring-accent/30' : 'border-border'}`}
            >
              {d}
            </span>
          ))}
        </div>
        <p className="m-0 text-center text-[12px] leading-relaxed text-fg-muted">
          Run <code className="font-term text-fg">termote pair</code> on the
          host, or scan the QR from a signed-in device
        </p>
      </div>
    </Future>
  )
}

function ViewOnlyScreen() {
  return (
    <>
      <FutureTopBar view="terminal" readOnly />
      <Future issue="#236" className="relative flex min-h-0 flex-1 flex-col">
        <div
          role="status"
          className="relative flex shrink-0 items-center gap-2 bg-info/12 px-3 py-2 text-[13px] text-fg"
        >
          <Note n={1} className="right-16 top-1" />
          <Eye size={15} className="shrink-0 text-info" aria-hidden="true" />
          View only: you can watch this terminal but not type
        </div>
        <div className="relative min-h-0 flex-1 bg-term">
          <TerminalOutput />
        </div>
        {/* no key toolbar, IME, quick actions or composer while view-only */}
        <div className="relative flex h-12 shrink-0 items-center gap-2 border-t border-border bg-surface px-3 dir-a:bg-bg">
          <Note n={2} className="-top-2.5 left-3" />
          <Eye size={16} className="text-fg-muted" aria-hidden="true" />
          <span className="flex-1 text-[13px] text-fg-muted dir-a:font-label">
            View only
          </span>
          <button
            type="button"
            aria-label="Decrease font size"
            className={`${keycap} h-9! min-w-9!`}
          >
            A−
          </button>
          <button
            type="button"
            aria-label="Increase font size"
            className={`${keycap} h-9! min-w-9!`}
          >
            A+
          </button>
        </div>
      </Future>
    </>
  )
}

// ── desktop ──

function DesktopScreen() {
  const tabs: MockSession[] = GROUPS[0].sessions
  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">
        6 · Desktop 1440×900 — sidebar + một hàng header/tab (L4) + pane strip
      </figcaption>
      <div
        data-screen="desktop"
        className="relative flex h-[900px] w-[1440px] overflow-hidden rounded-xl bg-bg font-ui text-fg shadow-2xl ring-1 ring-black/20"
      >
        {/* sidebar */}
        <aside className="relative flex w-64 shrink-0 flex-col border-r border-border bg-surface dir-a:bg-bg">
          <Note n={1} className="right-2 top-2" />
          <div className="flex h-12 items-center justify-between px-3">
            <span className="flex items-center gap-2 text-[15px] font-semibold dir-a:font-label">
              <span className="flex size-6 items-center justify-center rounded-control bg-accent text-[12px] font-bold text-accent-fg">
                ›_
              </span>
              termote
            </span>
            <button
              type="button"
              aria-label="Collapse sidebar"
              className={iconBtn}
            >
              <PanelLeftClose size={18} />
            </button>
          </div>
          <div className="px-3 pb-2">
            <button
              type="button"
              aria-label="Add session"
              className="flex h-9 w-full items-center justify-center gap-1.5 text-[14px] font-medium bg-accent text-accent-fg rounded-control dir-b:rounded-full"
            >
              <Plus size={16} /> New session
            </button>
          </div>
          <div className="flex-1 px-2">
            {GROUPS.map((g) => (
              <section key={g.name} className="pb-2">
                <div className="flex items-center gap-2 px-2 pb-1 pt-2 text-[11px] uppercase tracking-wider text-fg-subtle font-label">
                  <ChevronDown size={12} /> {g.name}
                </div>
                {g.sessions.map((s) => (
                  <div
                    key={s.name}
                    className={`flex h-9 items-center gap-2.5 px-2 text-[14px] rounded-control ${s.active ? 'bg-accent-soft text-fg font-medium dir-a:bg-surface dir-a:shadow-[inset_2px_0_0_var(--color-accent)]' : 'text-fg-muted hover:bg-surface-raised'}`}
                  >
                    <span className="text-[15px]">{s.icon}</span>
                    <span className="flex-1 truncate dir-a:font-label dir-a:text-[13px]">
                      {s.name}
                    </span>
                    <StatusIcon status={s.status} size={14} />
                  </div>
                ))}
              </section>
            ))}
          </div>
          <div className="flex items-center gap-2 border-t border-border px-3 py-2.5 text-[12px] text-fg-muted dir-a:font-label">
            <ConnDot label />
          </div>
        </aside>
        {/* main */}
        <main className="flex min-w-0 flex-1 flex-col">
          <header className="relative flex h-11 shrink-0 items-end gap-1 border-b border-border bg-surface px-2 dir-a:bg-bg">
            <Note n={2} className="left-2 -top-0.5" />
            {/* A tab is a button; its close button is a sibling, not a child, and
                Add sits outside the tablist */}
            <div className="flex min-w-0 flex-1 items-end gap-1">
              <div
                role="tablist"
                aria-label="Sessions"
                className="flex items-end gap-1"
              >
                {tabs.map((t) => (
                  <div
                    key={t.name}
                    className={`group flex h-9 items-center pr-1.5 text-[13px] ${
                      t.active
                        ? 'bg-bg text-fg border border-b-0 border-border rounded-t-control dir-a:shadow-[inset_0_2px_0_var(--color-accent)] dir-b:rounded-t-panel dir-b:border-0 dir-b:bg-term'
                        : 'text-fg-muted hover:text-fg mb-1 rounded-control hover:bg-surface-raised'
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={!!t.active}
                      tabIndex={t.active ? 0 : -1}
                      className="flex h-full items-center gap-2 pl-3 pr-1"
                    >
                      <span>{t.icon}</span>
                      <span className="dir-a:font-label">{t.name}</span>
                      <StatusIcon status={t.status} size={12} />
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${t.name}`}
                      className="flex size-5 items-center justify-center rounded text-fg-subtle hover:bg-surface hover:text-fg"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type="button"
                aria-label="Add session"
                className="mb-1.5 flex size-7 items-center justify-center rounded-control text-fg-muted hover:bg-surface-raised"
              >
                <Plus size={16} />
              </button>
            </div>
            <div className="relative mb-1 flex items-center gap-1">
              <Note n={3} className="-left-3 -top-1" />
              <Future issue="L8" className="mr-1 rounded-control">
                <ViewSwitcher view="terminal" compact />
              </Future>
              <div className="flex items-center gap-0.5 px-1 border border-border rounded-control dir-b:border-0 dir-b:bg-bg">
                <button
                  type="button"
                  aria-label="Decrease font size"
                  className="flex h-8 w-7 items-center justify-center text-[12px] text-fg-muted hover:text-fg"
                >
                  A−
                </button>
                <span className="w-6 text-center font-label text-[12px]">
                  14
                </span>
                <button
                  type="button"
                  aria-label="Increase font size"
                  className="flex h-8 w-7 items-center justify-center text-[12px] text-fg-muted hover:text-fg"
                >
                  A+
                </button>
              </div>
              <button
                type="button"
                aria-label="Enter fullscreen"
                className={`${iconBtn} size-8!`}
              >
                <Maximize size={16} />
              </button>
              <button
                type="button"
                aria-label="More"
                className={`${iconBtn} size-8!`}
              >
                <MoreHorizontal size={18} />
              </button>
            </div>
          </header>
          {/* pane strip (herdr split tab) */}
          <div className="relative flex h-9 shrink-0 items-center gap-1.5 border-b border-border bg-term px-3 text-[12px]">
            <Note n={4} className="-left-2 top-2" />
            <fieldset className="m-0 flex items-center gap-1.5 border-0 p-0">
              <legend className="float-left mr-1.5 p-0 font-label text-fg-subtle">
                panes
              </legend>
              {['1 claude', '2 shell', '3 vitest --watch'].map((p, i) => (
                <button
                  type="button"
                  key={p}
                  aria-pressed={i === 0}
                  className={`flex h-6 items-center gap-1.5 px-2 font-label rounded-control ${i === 0 ? 'bg-accent-soft text-accent' : 'text-fg-muted hover:bg-surface'}`}
                >
                  {p}
                  {i === 0 && <StatusIcon status="working" size={11} />}
                </button>
              ))}
            </fieldset>
          </div>
          <div className="flex min-h-0 flex-1">
            <div className="relative min-w-0 flex-1 bg-term">
              <TerminalOutput />
            </div>
            {/* L10: optional right panel (resizable), empty and hidden today */}
            <Future
              issue="L10 · #237"
              className="flex w-[440px] shrink-0 flex-col border-l border-border bg-bg"
            >
              <Note n={6} className="left-2 top-2" />
              <FilesTabs active="changes" />
              <div className="border-b border-border">
                {CHANGES.slice(1, 4).map((c) => (
                  <ChangeRow key={c.path} c={c} />
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-hidden bg-term py-1">
                <DiffLines />
              </div>
            </Future>
          </div>
          <div className="relative flex items-center gap-1.5 border-t border-border bg-surface px-3 py-1.5 dir-a:bg-bg">
            <Note n={5} className="-top-2.5 left-3" />
            {['Tab', 'Esc', 'Ctrl', 'Shift'].map((k) => (
              <span key={k} className={`${keycap} h-8! min-w-10! text-[12px]!`}>
                {k}
              </span>
            ))}
            {[
              <ArrowUp key="u" size={15} />,
              <ArrowDown key="d" size={15} />,
              <ArrowLeft key="l" size={15} />,
              <ArrowRight key="r" size={15} />,
            ].map((k, i) => (
              <span key={i} className={`${keycap} h-8! min-w-10!`}>
                {k}
              </span>
            ))}
          </div>
        </main>
      </div>
    </figure>
  )
}

// ── legends ──

const LEGENDS: { title: string; notes: string[] }[] = [
  {
    title: '1 · Terminal (thu gọn)',
    notes: [
      'L1 chip phiên: icon, tên, badge agent, chấm kết nối; chạm mở danh sách phiên. Token: surface, radius-control, warning (working)',
      'Terminal dùng token term; A trùng nền chrome, B/C tách nhẹ. Không còn bottom nav (L2): terminal cao thêm ~60px',
      'Toolbar: keycap chung, cùng thứ tự phím như hiện nay, hàng cuộn ngang; Quick actions và mở rộng ghim bên phải',
      'L5 Quick Actions thành một phím trong toolbar, bỏ FAB nổi đè lên terminal',
    ],
  },
  {
    title: '2 · Toolbar mở rộng + menu tràn',
    notes: [
      '',
      '',
      '',
      '',
      'L1 menu tràn: cỡ chữ (dời từ header), theme, Settings/Help/About, Clear cache — đúng các mục của settings-menu.tsx. Giữ accessible name “Decrease/Increase font size”',
      'L7 toolbar mở rộng chia hàng có nhãn thay vì một hàng cuộn dài như hiện nay. Combo Ctrl chỉ hiện khi Ctrl bật (như hiện nay); Ctrl+Shift thay bằng ^⇧C V Z X. Copy mode/paste buffer ẩn khi backend không hỗ trợ',
    ],
  },
  {
    title: '3 · Danh sách phiên (L3)',
    notes: [
      '',
      'Bottom sheet thay drawer trái: nút New (thay nút + ở bottom nav), nhóm thu gọn có badge agent của nhóm, vuốt để sửa/xoá. Grabber chỉ ở hướng B',
    ],
  },
  {
    title: '4 · Settings (L6)',
    notes: [
      'Sheet toàn màn (B: sheet chừa mép trên). Desktop dùng dialog 2 cột',
      'Nhóm Appearance mới: chọn kiểu giao diện Terminal / Native / Neutral (đã chốt). Còn lại đúng các setting của settings-modal.tsx, chỉ chia nhóm; Switch và SegmentedControl thay checkbox/select. Theme vẫn ở menu tràn. Paste source chỉ hiện với tmux',
    ],
  },
  {
    title: '6 · Desktop',
    notes: [
      'Sidebar: logo, New session, nhóm phiên, trạng thái kết nối ở đáy',
      'L4 tab gộp vào header; tab là button role=tab, nút đóng là phần tử cùng cấp nằm ngoài tab, Add nằm ngoài tablist (sửa button lồng button)',
      'Cỡ chữ, fullscreen, menu tràn ở phải header',
      'Pane strip (herdr) dùng accent-soft cho pane đang xem',
      'Toolbar desktop gọn 32px',
      'L10 panel phụ bên phải (Changes #237), kéo được độ rộng; L8 bộ chuyển view dạng có nhãn trong header',
    ],
  },
  {
    title: '5 · IME + bàn phím hệ điều hành',
    notes: [
      'Chế độ IME: ô nhập toàn chiều ngang thay hàng phím (như hiện nay), viền accent khi đang gõ, nút đóng và gửi dùng keycap chung',
      'Khi bàn phím mở, vùng terminal chỉ còn khoảng một nửa: lý do cần bỏ bớt chrome (L1, L2)',
    ],
  },
  {
    title: '7 · Agent mode (#233)',
    notes: [
      'View Chat của pane có agent: tin nhắn người dùng bên phải, trả lời của agent dạng văn bản đọc được, không phải output terminal',
      'Tool call là thẻ thu gọn được; mở ra thấy diff rút gọn',
      'Thẻ xin phép (Allow once / Always / Deny) dùng token warning; badge agent chuyển sang blocked',
      'View sở hữu vùng nhập ở đáy: ô soạn + Esc thay cho toolbar phím',
    ],
  },
  {
    title: '8 · Changes (#237)',
    notes: [
      'View Files có hai mục Files / Changes và nhánh hiện tại; L8 chuyển giữa Terminal / Chat / Files',
      'File đổi chia Staged / Unstaged; nhãn A/M/D/U theo token trạng thái; chỉ đọc',
    ],
  },
  {
    title: '9 · Diff một file (#237)',
    notes: [
      'Thanh tiêu đề: quay lại danh sách, tên file, số dòng thêm/bớt',
      'Diff unified, hai cột số dòng, dòng dài tự xuống dòng; nền dòng thêm/bớt là success/danger nhạt',
      'Chuyển file trước/sau bằng keycap chung',
    ],
  },
  {
    title: '10 · Đăng nhập + ghép thiết bị (#236)',
    notes: [
      'Trang đăng nhập trong app thay hộp thoại Basic auth của trình duyệt',
      'Ghép thiết bị bằng mã 6 số từ `termote pair` hoặc QR. Danh sách thiết bị + thu hồi sẽ là một nhóm "Devices" trong Settings',
    ],
  },
  {
    title: '11 · Chỉ xem (#236, L9)',
    notes: [
      'Banner info dưới top bar; chip ghi “view only”; bộ chuyển view ẩn nếu chỉ còn Terminal',
      'Không còn toolbar phím, IME, Quick Actions hay ô soạn; chỉ còn cỡ chữ',
    ],
  },
]

function Legend({ i }: { i: number }) {
  const l = LEGENDS[i]
  return (
    <ol className="m-0 w-[390px] list-none space-y-1.5 p-0 text-[12.5px] leading-snug text-zinc-700 dark:text-zinc-300">
      {l.notes.map((n, k) =>
        n ? (
          <li key={k} className="flex gap-2">
            <span className="mt-px flex size-4.5 shrink-0 items-center justify-center rounded-full bg-[#e11d48] text-[10px] font-bold text-white">
              {k + 1}
            </span>
            <span>{n}</span>
          </li>
        ) : null,
      )}
    </ol>
  )
}

function CurrentShot({ src, title }: { src: string; title: string }) {
  return (
    <figure className="m-0 flex flex-col gap-2">
      <figcaption className="text-[13px] font-semibold text-zinc-500">
        {title}
      </figcaption>
      <img
        src={src}
        alt={title}
        className="h-[844px] w-[390px] rounded-[44px] object-cover opacity-90 ring-8 ring-zinc-500"
      />
    </figure>
  )
}

// ── page ──

function App() {
  const [state, setState] = useState(readHash)
  const [showNotes, setShowNotes] = useState(true)
  const [showCurrent, setShowCurrent] = useState(true)
  const [showFuture, setShowFuture] = useState(true)

  useEffect(() => {
    const onHash = () => setState(readHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.dataset.direction = state.dir
    root.classList.toggle('dark', state.theme === 'dark')
    root.classList.toggle('hide-notes', !showNotes)
  }, [state, showNotes])

  const go = (patch: Partial<typeof state>) => {
    const next = { ...state, ...patch }
    window.location.hash = `${next.dir}-${next.theme}-${next.frame}`
  }

  const pill = (active: boolean) =>
    `h-8 px-3 rounded-md text-[13px] font-medium ${active ? 'bg-zinc-900 text-white dark:bg-white dark:text-zinc-900' : 'text-zinc-700 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-700'}`

  const mobile = state.frame !== 'desktop'
  const desktop = state.frame !== 'mobile'

  return (
    <div className="min-h-screen">
      <style>{`.hide-notes .note{display:none}
@keyframes fade{from{opacity:0}to{opacity:1}}
@keyframes sheet{from{transform:translateY(100%)}to{transform:none}}
[data-direction="a"] [class*="animate-[sheet"]{animation-duration:120ms}`}</style>
      <div className="sticky top-0 z-[100] flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-zinc-300 bg-zinc-100/95 px-5 py-2.5 backdrop-blur dark:border-zinc-700 dark:bg-zinc-900/95">
        <strong className="text-[14px] text-zinc-900 dark:text-white">
          Termote · mockup #232
        </strong>
        <div className="flex gap-1">
          {(['a', 'b', 'c'] as Direction[]).map((d) => (
            <button
              key={d}
              type="button"
              className={pill(state.dir === d)}
              onClick={() => go({ dir: d })}
            >
              {DIRECTIONS[d].name}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(['dark', 'light'] as Theme[]).map((t) => (
            <button
              key={t}
              type="button"
              className={pill(state.theme === t)}
              onClick={() => go({ theme: t })}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {(['all', 'mobile', 'desktop'] as Frame[]).map((f) => (
            <button
              key={f}
              type="button"
              className={pill(state.frame === f)}
              onClick={() => go({ frame: f })}
            >
              {f}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-[13px] text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={showNotes}
            onChange={(e) => setShowNotes(e.target.checked)}
          />{' '}
          chú thích
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={showCurrent}
            onChange={(e) => setShowCurrent(e.target.checked)}
          />{' '}
          hiện tại
        </label>
        <label className="flex items-center gap-1.5 text-[13px] text-zinc-700 dark:text-zinc-300">
          <input
            type="checkbox"
            checked={showFuture}
            onChange={(e) => setShowFuture(e.target.checked)}
          />{' '}
          sắp tới
        </label>
        <span className="text-[12.5px] text-zinc-500">
          {DIRECTIONS[state.dir].blurb}
        </span>
      </div>

      <div className="flex flex-col gap-10 p-8">
        {mobile && (
          <div className="flex gap-8 overflow-x-auto pb-4">
            {showCurrent && (
              <div className="flex flex-col gap-8">
                <CurrentShot
                  src={currentTerminal}
                  title="Hiện tại · terminal"
                />
                <CurrentShot src={currentSidebar} title="Hiện tại · sidebar" />
              </div>
            )}
            <div className="flex flex-col gap-4">
              <PhoneFrame
                id="m-terminal"
                title="1 · Terminal — bấm chip / ⋯ / toolbar để thử"
              >
                <MobileTerminalScreen interactive />
              </PhoneFrame>
              <Legend i={0} />
            </div>
            <div className="flex flex-col gap-4">
              <PhoneFrame
                id="m-terminal-expanded"
                title="2 · Toolbar mở rộng, Ctrl bật, menu tràn"
              >
                <MobileTerminalScreen expanded menu />
              </PhoneFrame>
              <Legend i={1} />
            </div>
            <div className="flex flex-col gap-4">
              <PhoneFrame
                id="m-sessions"
                title="3 · Danh sách phiên (bottom sheet)"
              >
                <MobileTopBar note={false} />
                <div className="relative min-h-0 flex-1 bg-term">
                  <TerminalOutput />
                </div>
                <div className="absolute inset-0 z-20 bg-overlay" />
                <SessionsSheet />
              </PhoneFrame>
              <Legend i={2} />
            </div>
            <div className="flex flex-col gap-4">
              <PhoneFrame id="m-settings" title="4 · Settings">
                <div className="min-h-0 flex-1 bg-term" />
                <SettingsSheet />
              </PhoneFrame>
              <Legend i={3} />
            </div>
            <div className="flex flex-col gap-4">
              <PhoneFrame id="m-ime" title="5 · IME + bàn phím hệ điều hành">
                <ImeScreen />
              </PhoneFrame>
              <Legend i={5} />
            </div>
          </div>
        )}
        {mobile && showFuture && (
          <div className="flex flex-col gap-3">
            <h2 className="m-0 text-[15px] font-semibold text-zinc-800 dark:text-zinc-200">
              Tính năng sắp tới: chỉ để kiểm layout chứa được (viền đứt tím =
              chưa làm trong #232)
            </h2>
            <div className="flex gap-8 overflow-x-auto pb-4">
              <div className="flex flex-col gap-4">
                <PhoneFrame id="m-chat" title="7 · Agent mode (#233)">
                  <ChatScreen />
                </PhoneFrame>
                <Legend i={6} />
              </div>
              <div className="flex flex-col gap-4">
                <PhoneFrame id="m-changes" title="8 · Changes (#237)">
                  <ChangesScreen />
                </PhoneFrame>
                <Legend i={7} />
              </div>
              <div className="flex flex-col gap-4">
                <PhoneFrame id="m-diff" title="9 · Diff (#237)">
                  <DiffScreen />
                </PhoneFrame>
                <Legend i={8} />
              </div>
              <div className="flex flex-col gap-4">
                <PhoneFrame
                  id="m-login"
                  title="10 · Đăng nhập + ghép thiết bị (#236)"
                >
                  <LoginScreen />
                </PhoneFrame>
                <Legend i={9} />
              </div>
              <div className="flex flex-col gap-4">
                <PhoneFrame id="m-viewonly" title="11 · Chỉ xem (#236)">
                  <ViewOnlyScreen />
                </PhoneFrame>
                <Legend i={10} />
              </div>
            </div>
          </div>
        )}
        {desktop && (
          <div className="flex flex-col gap-4 overflow-x-auto pb-4">
            <DesktopScreen />
            <div className="w-[900px] columns-2">
              <Legend i={4} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
