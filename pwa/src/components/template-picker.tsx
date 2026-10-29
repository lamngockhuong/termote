import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import type { PromptTemplate } from '../hooks/use-mux-api'
import { usePromptTemplates } from '../hooks/use-prompt-templates'
import { useT } from '../i18n/i18n-context'
import { firstLine, matchTemplates } from '../utils/prompt-templates'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { Button } from './ui/button'
import { Sheet } from './ui/sheet'

interface Props {
  isOpen: boolean
  onClose: () => void
  onPick: (template: PromptTemplate) => void
  // Opens Settings at Prompt templates (absent: no way there)
  onManage?: () => void
}

// Picks a prompt template for the Chat: a search box driving a listbox
// (aria-activedescendant), so the focus stays in the box. Read again each
// time it opens: another device may have changed them.
export function TemplatePicker({ isOpen, onClose, onPick, onManage }: Props) {
  if (!isOpen) return null
  return <OpenPicker onClose={onClose} onPick={onPick} onManage={onManage} />
}

function OpenPicker({ onClose, onPick, onManage }: Omit<Props, 'isOpen'>) {
  const { t } = useT()
  const prompts = usePromptTemplates()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()
  const optionId = (i: number) => `${listId}-${i}`
  const matches = matchTemplates(prompts.templates, query)
  const { refresh } = prompts

  useEffect(() => {
    void refresh()
  }, [refresh])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new query starts at the top
  useEffect(() => setActive(0), [query])

  const at = Math.min(active, matches.length - 1)
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = matches.length
    if (n === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      onPick(matches[at])
    }
  }

  return (
    <Sheet
      isOpen
      onClose={onClose}
      title={t('chat.picker.title')}
      focusOnOpen={() => inputRef.current?.focus()}
    >
      <div className="flex flex-col gap-2 p-4">
        <input
          ref={inputRef}
          type="search"
          aria-label={t('chat.picker.search')}
          placeholder={t('chat.picker.search')}
          value={query}
          role="combobox"
          aria-expanded={matches.length > 0}
          aria-controls={matches.length ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={matches.length ? optionId(at) : undefined}
          autoComplete="off"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-9 w-full min-w-0 rounded-control border border-border bg-bg px-2.5 text-sm text-fg outline-none placeholder:text-fg-subtle focus:border-accent pointer-coarse:h-touch"
        />
        {prompts.templates.length === 0 ? (
          <p className="m-0 py-2 text-sm text-fg-muted">
            {prompts.loaded
              ? t('chat.picker.none')
              : prompts.error
                ? t('chat.picker.readFailed')
                : t('chat.picker.loading')}
          </p>
        ) : matches.length === 0 ? (
          <p className="m-0 py-2 text-sm text-fg-muted">
            {t('chat.picker.noMatch')}
          </p>
        ) : null}
        {matches.length > 0 && (
          <div
            id={listId}
            role="listbox"
            aria-label={t('chat.picker.list')}
            className="max-h-72 overflow-y-auto"
          >
            {matches.map((m, i) => (
              <div
                key={m.id}
                id={optionId(i)}
                role="option"
                tabIndex={-1}
                aria-selected={i === at}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== at && setActive(i)}
                onClick={() => onPick(m)}
                className={`flex min-h-touch cursor-pointer flex-col justify-center rounded-control px-3 py-1 ${i === at ? 'bg-accent-soft' : ''}`}
              >
                <span className="truncate text-[14px] text-fg">
                  {visibleUnsafe(m.name)}
                </span>
                <span className="truncate text-[12px] text-fg-muted">
                  {visibleUnsafe(firstLine(m.text))}
                </span>
              </div>
            ))}
          </div>
        )}
        {onManage && (
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={onManage}>
              {prompts.loaded && prompts.templates.length === 0
                ? t('chat.picker.create')
                : t('chat.picker.manage')}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  )
}
