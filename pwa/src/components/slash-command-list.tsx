import { useEffect, useRef } from 'react'
import type { PromptTemplate } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { firstLine } from '../utils/prompt-templates'
import {
  type CommandTrigger,
  commandDescription,
  type SlashCommand,
} from '../utils/slash-commands'
import { visibleUnsafe } from '../utils/unsafe-chars'

interface Props {
  id: string
  // What the rows are typed after: "/" commands or "$" skills
  trigger: CommandTrigger
  commands: SlashCommand[]
  // Prompt templates, after the commands: their rows are numbered on from
  // the commands', for aria-activedescendant
  templates?: PromptTemplate[]
  // Index of the highlighted row (-1: none)
  active: number
  onPick: (command: SlashCommand) => void
  onPickTemplate?: (template: PromptTemplate) => void
  onActive: (index: number) => void
}

export const slashOptionId = (listId: string, index: number) =>
  `${listId}-${index}`

const SOURCE_LABEL: Record<SlashCommand['source'], MessageKey> = {
  builtin: 'chat.slash.source.builtin',
  project: 'chat.slash.source.project',
  user: 'chat.slash.source.user',
  plugin: 'chat.slash.source.plugin',
  system: 'chat.slash.source.system',
}

function Tag({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded border border-border px-1.5 text-[11px] leading-[18px] text-fg-muted">
      {children}
    </span>
  )
}

// The suggestions shown while a message is only "/name", or while a "$name"
// word is typed for a Codex skill: a listbox the
// textarea drives (aria-activedescendant), so focus stays in the composer.
// Rows keep a 44px touch target; the list scrolls past a few rows so it fits
// above a phone's keyboard.
export function SlashCommandList({
  id,
  trigger,
  commands,
  templates = [],
  active,
  onPick,
  onPickTemplate,
  onActive,
}: Props) {
  const { t } = useT()
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row in view as the arrow keys move it.
  useEffect(() => {
    const el = document.getElementById(slashOptionId(id, active))
    if (el && listRef.current?.contains(el)) {
      el.scrollIntoView?.({ block: 'nearest' })
    }
  }, [id, active])

  if (commands.length === 0 && templates.length === 0) {
    return (
      <p className="border-b border-border px-3 py-2 text-[13px] text-fg-muted">
        {t(trigger === '$' ? 'chat.slash.noSkill' : 'chat.slash.noCommand')}
      </p>
    )
  }
  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label={t(
        trigger === '$'
          ? 'chat.slash.skills'
          : commands.length
            ? 'chat.slash.commands'
            : 'chat.slash.templates',
      )}
      className="max-h-56 overflow-y-auto border-b border-border bg-surface-raised py-1"
    >
      {commands.map((c, i) => {
        const description = commandDescription(c, t)
        return (
          <div
            key={`${c.source}:${c.name}`}
            id={slashOptionId(id, i)}
            role="option"
            // Focus stays in the textarea, which points here
            tabIndex={-1}
            aria-selected={i === active}
            // Keep the textarea focused (and the phone keyboard up)
            onMouseDown={(e) => e.preventDefault()}
            onMouseMove={() => i !== active && onActive(i)}
            onClick={() => onPick(c)}
            className={`flex min-h-touch cursor-pointer items-center gap-2 px-3 py-1 ${i === active ? 'bg-accent-soft' : ''}`}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate font-term text-[14px] text-fg">
                {trigger}
                {c.name}
              </span>
              {description && (
                <span className="block truncate text-[12px] text-fg-muted">
                  {description}
                </span>
              )}
            </span>
            {c.terminal && <Tag>{t('chat.slash.inTerminal')}</Tag>}
            {c.kind === 'skill' && <Tag>{t('chat.slash.skill')}</Tag>}
            <Tag>{t(SOURCE_LABEL[c.source])}</Tag>
          </div>
        )
      })}
      {templates.length > 0 && (
        // biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox, as WAI-ARIA has it; a <fieldset> holds form controls
        <div role="group" aria-labelledby={`${id}-templates`}>
          <div
            id={`${id}-templates`}
            className="px-3 pt-1.5 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-fg-muted"
          >
            {t('chat.slash.templates')}
          </div>
          {templates.map((tpl, j) => {
            const i = commands.length + j
            return (
              <div
                key={tpl.id}
                id={slashOptionId(id, i)}
                role="option"
                tabIndex={-1}
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                // No highlight on hover: a pointer resting here must not
                // make the next Enter pick a template
                onClick={() => onPickTemplate?.(tpl)}
                className={`flex min-h-touch cursor-pointer items-center gap-2 px-3 py-1 ${i === active ? 'bg-accent-soft' : ''}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-fg">
                    {visibleUnsafe(tpl.name)}
                  </span>
                  <span className="block truncate text-[12px] text-fg-muted">
                    {visibleUnsafe(firstLine(tpl.text))}
                  </span>
                </span>
                <Tag>{t('chat.slash.template')}</Tag>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
