import { ChevronDown } from 'lucide-react'
import { useState } from 'react'
import type { ViewProps } from '../app-views'
import { agentLabel } from '../chat-agents'
import { fetchPaneText, RequestError } from '../hooks/use-mux-api'
import { useSettings } from '../hooks/use-settings'
import { useTaskGroupsCollapsed } from '../hooks/use-task-groups-collapsed'
import {
  type TaskItem,
  type TaskRunView,
  taskItems,
  taskTabName,
  useTasks,
} from '../hooks/use-tasks'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { sendToAgent } from '../utils/send-to-agent'
import { serverErrorText } from '../utils/server-error'
import {
  taskFailureMessage,
  taskRunOutput,
} from '../utils/task-failure-message'
import { CHAT_VIEW_ID } from '../view-ids'
import {
  type AgentPaneChoice,
  AgentPanePicker,
  agentPanes,
  rememberAgent,
  rememberedAgent,
} from './agent-pane-picker'
import { PaneDirHeader, ViewMessage } from './pane-dir-header'
import { TaskRow } from './task-row'
import { Banner } from './ui/banner'

// What a refused Run tells, by the server's code
const RUN_ERRORS: Record<string, MessageKey> = {
  no_client: 'tasks.runError.noClient',
  unsupported_shell: 'tasks.runError.unsupportedShell',
  shell_busy: 'tasks.runError.shellBusy',
  task_not_found: 'tasks.runError.notFound',
  unknown_task_kind: 'tasks.runError.unknownKind',
  tab_gone: 'tasks.runError.tabGone',
  invalid_task: 'tasks.runError.invalidTask',
  invalid_root: 'tasks.runError.invalidRoot',
}

const LIST_ERRORS: Record<number, MessageKey> = {
  400: 'tasks.listError.notFound',
  403: 'tasks.listError.forbidden',
  501: 'tasks.listError.unsupported',
}

// Tasks: what the pane's root offers to run (package.json scripts, Makefile
// targets, other build tools' and task runners' tasks, the user's tasks),
// each run in a tab at that root, and the output of a finished run sent to
// an agent pane. A full client only. Each section folds from its header.
export function TasksView({
  session,
  mux,
  notify,
  sessions,
  openTab,
  refreshSessions,
}: ViewProps) {
  const { settings } = useSettings()
  const { t } = useT()
  const { data, error, loading, runs, reload, run } = useTasks(session.paneId)
  const [filter, setFilter] = useState('')
  const { isCollapsed, toggle } = useTaskGroupsCollapsed()
  const [starting, setStarting] = useState<string | null>(null)
  const [sending, setSending] = useState<string | null>(null)
  const [picking, setPicking] = useState<{
    item: TaskItem
    run: TaskRunView
  } | null>(null)
  const canSend = !!mux.caps.paneText && !!mux.caps.agentChat
  const groupId = session.groupId ?? ''

  if (!session.paneId) return <ViewMessage>{t('tasks.loading')}</ViewMessage>

  const onRun = async (item: TaskItem, newTab = false) => {
    setStarting(item.key)
    try {
      const start = await run(item, newTab)
      void refreshSessions?.()
      notify(t('tasks.running', { name: taskTabName(item) }), {
        variant: 'success',
        action: {
          label: t('tasks.open'),
          onClick: () => openTab?.(start.tabId, start.paneId),
        },
      })
    } catch (err) {
      const code = err instanceof RequestError ? err.code : ''
      if (code === 'task_running') {
        notify(t('tasks.alreadyRunning'), {
          action: {
            label: t('tasks.runInNewTab'),
            onClick: () => void onRun(item, true),
          },
        })
      } else if (err instanceof RequestError && err.root) {
        notify(t('tasks.rootChanged'), {
          variant: 'warning',
        })
      } else {
        if (code === 'task_not_found' || code === 'unknown_task_kind')
          void reload()
        notify(t(RUN_ERRORS[code] ?? 'tasks.runFailed'), {
          variant: 'danger',
        })
      }
    } finally {
      setStarting(null)
    }
  }

  // The output of r, between its markers, as one message to the agent pane
  // root: the root the task was listed in
  const send = async (
    item: TaskItem,
    r: TaskRunView,
    to: AgentPaneChoice,
    root: string,
  ) => {
    rememberAgent(groupId, to.paneId)
    setPicking(null)
    setSending(item.key)
    const openChat = {
      label: t('tasks.openChat'),
      onClick: () => openTab?.(to.sessionId, to.paneId, CHAT_VIEW_ID),
    }
    try {
      const text = await fetchPaneText(r.paneId, settings.taskHistoryLines)
      const output = taskRunOutput(text.text, r.nonce)
      if (!output) {
        notify(t('tasks.outputGone'), {
          variant: 'warning',
        })
        return
      }
      const message = taskFailureMessage({
        label: item.label,
        root,
        code: r.state === 'exited' ? r.code : undefined,
        output,
      })
      await sendToAgent(to.paneId, message)
      notify(t('tasks.sent', { agent: agentLabel(to.agentName) }), {
        variant: 'success',
        action: openChat,
      })
    } catch (err) {
      notify(
        err instanceof RequestError
          ? t('tasks.notSent', { message: serverErrorText(err, t) })
          : t('tasks.sendFailed'),
        { variant: 'danger', action: openChat },
      )
    } finally {
      setSending(null)
    }
  }

  const onSend = (item: TaskItem, r: TaskRunView, root: string) => {
    const choices = agentPanes(sessions ?? [], r.paneId)
    const last = rememberedAgent(groupId)
    const known = choices.find((c) => c.paneId === last)
    if (known) void send(item, r, known, root)
    else setPicking({ item, run: r })
  }

  if (!data) {
    if (error) {
      const status = error instanceof RequestError ? error.status : 0
      return (
        <ViewMessage>
          {t(LIST_ERRORS[status] ?? 'tasks.listFailed')}
        </ViewMessage>
      )
    }
    return <ViewMessage>{t('tasks.loading')}</ViewMessage>
  }

  const items = taskItems(data)
  const needle = filter.trim().toLowerCase()
  const shown = (list: TaskItem[]) =>
    needle
      ? list.filter(
          (task) =>
            task.name.toLowerCase().includes(needle) ||
            task.command.toLowerCase().includes(needle),
        )
      : list
  // Sections: id (what is folded), title, the tasks the filter shows
  const groups: [string, string, TaskItem[]][] = [
    [
      'script',
      t('tasks.group.scripts', { tool: data.packageManager || 'npm' }),
      shown(items.scripts),
    ],
    ['make', t('tasks.group.make', { file: data.makefile }), shown(items.make)],
    ...items.tools.map((g): [string, string, TaskItem[]] => [
      g.id,
      g.title,
      shown(g.items),
    ]),
    ['user', t('tasks.group.user'), shown(items.user)],
  ]
  const total =
    items.scripts.length +
    items.make.length +
    items.user.length +
    items.tools.reduce((n, g) => n + g.items.length, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="tasks-view">
      <PaneDirHeader
        root={data.root}
        onRefresh={() => void reload()}
        refreshing={loading}
      />
      {data.tooLarge.length > 0 && (
        <Banner variant="warning" live={false}>
          {t('tasks.tooLarge', { files: data.tooLarge.join(', ') })}
        </Banner>
      )}
      {data.unreadable.length > 0 && (
        <Banner variant="warning" live={false}>
          {t('tasks.unreadable', { files: data.unreadable.join(', ') })}
        </Banner>
      )}
      {total > 0 && (
        <div className="shrink-0 border-b border-border px-3 py-1.5">
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('tasks.filterTasks')}
            aria-label={t('tasks.filterTasks')}
            className="h-8 w-full rounded-control border border-border bg-surface px-2 text-sm text-fg pointer-coarse:h-touch"
          />
        </div>
      )}
      {total === 0 ? (
        <ViewMessage>{t('tasks.none')}</ViewMessage>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          {groups
            .filter(([, , list]) => list.length > 0)
            .map(([id, title, list]) => {
              // A filter shows every section with a match
              const open = !!needle || !isCollapsed(id)
              return (
                <section key={id} aria-label={title}>
                  <h3>
                    <button
                      type="button"
                      aria-expanded={open}
                      disabled={!!needle}
                      onClick={() => toggle(id)}
                      className="flex w-full items-center gap-1.5 bg-surface px-3 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-fg-muted hover:text-fg pointer-coarse:min-h-touch"
                    >
                      <ChevronDown
                        size={12}
                        aria-hidden="true"
                        className={`shrink-0 transition-transform duration-(--duration-fast) ease-standard ${open ? '' : '-rotate-90'}`}
                      />
                      <span className="min-w-0 flex-1 truncate">{title}</span>
                      <span className="shrink-0 tabular-nums">
                        {list.length}
                      </span>
                    </button>
                  </h3>
                  {open && (
                    <ul>
                      {list.map((item) => (
                        <TaskRow
                          key={item.key}
                          item={item}
                          run={runs[item.key]}
                          starting={starting === item.key}
                          sending={sending === item.key}
                          canSend={canSend}
                          onRun={() => void onRun(item)}
                          onOpen={() => {
                            const r = runs[item.key]
                            openTab?.(r.tabId, r.paneId)
                          }}
                          onSend={() => onSend(item, runs[item.key], data.root)}
                        />
                      ))}
                    </ul>
                  )}
                </section>
              )
            })}
          {data.skipped > 0 && (
            <p className="px-3 py-2 text-[12px] text-fg-muted">
              {t('tasks.skipped', { count: data.skipped })}
            </p>
          )}
        </div>
      )}
      <AgentPanePicker
        isOpen={!!picking}
        choices={picking ? agentPanes(sessions ?? [], picking.run.paneId) : []}
        onPick={(c) =>
          picking && void send(picking.item, picking.run, c, data.root)
        }
        onClose={() => setPicking(null)}
      />
    </div>
  )
}

export default TasksView
