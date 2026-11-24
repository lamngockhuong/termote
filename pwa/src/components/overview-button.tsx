import { LayoutDashboard } from 'lucide-react'
import { useOpenAsks } from '../hooks/use-jobs'
import { useT } from '../i18n/i18n-context'
import { IconButton } from './ui/button'

// How many questions orchestrators asked wait for the user, on whatever
// opens the agent overview (whose Plan answers them): a count on a button,
// a dot on a menu's trigger. Each reads the open asks itself, so only a
// screen that offers the overview polls them. hiddenGroupIds: the workspaces
// hidden from what is drawn, whose jobs' asks are not counted.

const NO_IDS: ReadonlySet<string> = new Set()

// The count as a badge; nothing while none wait. Hidden from screen
// readers: the control it sits on says the count in words.
export function AsksCountBadge({
  count,
  className = '',
}: {
  count: number
  className?: string
}) {
  if (count <= 0) return null
  return (
    <span
      aria-hidden="true"
      data-testid="asks-count"
      className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold leading-none text-white ${className}`}
    >
      {count > 9 ? '9+' : count}
    </span>
  )
}

// The sidebar's button that opens the overview, with the count of the
// questions waiting in its corner and in its name.
export function OverviewButton({
  onClick,
  pressed,
  hiddenGroupIds = NO_IDS,
}: {
  onClick: () => void
  pressed: boolean
  hiddenGroupIds?: ReadonlySet<string>
}) {
  const { t } = useT()
  const count = useOpenAsks(hiddenGroupIds).open.length
  const label =
    count > 0
      ? `${t('common.overview')}, ${t('common.asksWaiting', { count })}`
      : t('common.overview')
  return (
    <IconButton
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={`relative ${pressed ? 'bg-surface text-fg' : ''}`}
    >
      <LayoutDashboard size={18} aria-hidden="true" />
      <AsksCountBadge count={count} className="absolute -right-0.5 -top-0.5" />
    </IconButton>
  )
}

// A dot on the mobile view menu's trigger while questions wait.
export function AsksDot({
  hiddenGroupIds = NO_IDS,
}: {
  hiddenGroupIds?: ReadonlySet<string>
}) {
  const count = useOpenAsks(hiddenGroupIds).open.length
  if (count <= 0) return null
  return (
    <span
      aria-hidden="true"
      data-testid="asks-dot"
      className="absolute -right-1 -top-1 size-2 rounded-full bg-danger"
    />
  )
}

// The overview's entry in the mobile view menu: its name, then the count
// waiting, as a badge and in words.
export function OverviewMenuLabel({
  hiddenGroupIds = NO_IDS,
}: {
  hiddenGroupIds?: ReadonlySet<string>
}) {
  const { t } = useT()
  const count = useOpenAsks(hiddenGroupIds).open.length
  return (
    <span className="flex flex-1 items-center gap-2">
      {t('common.overview')}
      {count > 0 && (
        <>
          <AsksCountBadge count={count} />
          <span className="sr-only">{t('common.asksWaiting', { count })}</span>
        </>
      )}
    </span>
  )
}
