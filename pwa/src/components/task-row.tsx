import { Play, Send, SquareArrowOutUpRight } from 'lucide-react'
import type { TaskItem, TaskRunView } from '../hooks/use-tasks'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button, IconButton } from './ui/button'

// What a run's badge says, and its tone
export function runBadge(
  run: TaskRunView,
  t: Translate<MessageKey>,
): { text: string; tone: string } {
  switch (run.state) {
    case 'running':
      return { text: t('tasks.badge.running'), tone: 'text-info' }
    case 'exited':
      return {
        text: t('tasks.badge.exit', { code: String(run.code) }),
        tone: run.code === 0 ? 'text-success' : 'text-danger',
      }
    case 'ended':
      return { text: t('tasks.badge.ended'), tone: 'text-fg-muted' }
    case 'gone':
      return { text: t('tasks.badge.gone'), tone: 'text-fg-muted' }
    default:
      return { text: t('tasks.badge.unknown'), tone: 'text-fg-muted' }
  }
}

interface Props {
  item: TaskItem
  run?: TaskRunView
  // Run pressed and not answered yet
  starting: boolean
  sending: boolean
  // Send to agent is offered (pane text and the agent routes work)
  canSend: boolean
  onRun: () => void
  onOpen: () => void
  onSend: () => void
}

// One task: its name, what runs (with the hooks its package manager adds),
// its last run, and Run, Open and Send to agent. Send is offered once the
// run ended, whatever its code: a marker can be printed by the task itself.
export function TaskRow({
  item,
  run,
  starting,
  sending,
  canSend,
  onRun,
  onOpen,
  onSend,
}: Props) {
  const { t } = useT()
  const badge = run && runBadge(run, t)
  const ended = run && run.state !== 'running' && run.state !== 'gone'
  const failed = run?.state === 'exited' && run.code !== 0
  return (
    <li
      className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2"
      data-testid="task-row"
    >
      <div className="flex min-w-48 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm text-fg">
            {visibleUnsafe(item.name)}
          </span>
          {badge && (
            <span
              className={`shrink-0 text-[11px] ${badge.tone}`}
              data-testid="task-run-state"
            >
              {badge.text}
            </span>
          )}
        </span>
        <span
          className="truncate font-term text-[12px] text-fg-muted"
          title={visibleUnsafe(item.command)}
        >
          {visibleUnsafe(item.command)}
          {item.truncated ? '…' : ''}
        </span>
        {item.hooks && item.hooks.length > 0 && (
          <span className="truncate text-[11px] text-fg-muted">
            {t('tasks.alsoRuns', { hooks: item.hooks.join(', ') })}
          </span>
        )}
      </div>
      {run && run.state !== 'gone' && run.state !== 'unknown' && (
        <IconButton
          size="sm"
          aria-label={t('tasks.openTabOf', { name: item.name })}
          title={t('tasks.openTab')}
          onClick={onOpen}
        >
          <SquareArrowOutUpRight size={15} aria-hidden="true" />
        </IconButton>
      )}
      {canSend && ended && (
        <Button
          size="sm"
          variant={failed ? 'primary' : 'secondary'}
          disabled={sending}
          onClick={onSend}
          aria-label={t('tasks.sendOf', { name: item.name })}
        >
          <Send size={14} aria-hidden="true" />
          {t('tasks.send')}
        </Button>
      )}
      <Button
        size="sm"
        disabled={starting}
        onClick={onRun}
        aria-label={t('tasks.runName', { name: item.name })}
      >
        <Play size={14} aria-hidden="true" />
        {t('tasks.run')}
      </Button>
    </li>
  )
}
