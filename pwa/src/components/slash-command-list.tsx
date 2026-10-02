import { useEffect, useRef } from 'react'
import type { SlashCommand } from '../utils/slash-commands'

interface Props {
  id: string
  commands: SlashCommand[]
  // Index of the highlighted row
  active: number
  onPick: (command: SlashCommand) => void
  onActive: (index: number) => void
}

export const slashOptionId = (listId: string, index: number) =>
  `${listId}-${index}`

const SOURCE_LABEL: Record<SlashCommand['source'], string> = {
  builtin: 'built-in',
  project: 'project',
  user: 'user',
}

function Tag({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded border border-border px-1.5 text-[11px] leading-[18px] text-fg-muted">
      {children}
    </span>
  )
}

// The suggestions shown while a message is only "/name": a listbox the
// textarea drives (aria-activedescendant), so focus stays in the composer.
// Rows keep a 44px touch target; the list scrolls past a few rows so it fits
// above a phone's keyboard.
export function SlashCommandList({
  id,
  commands,
  active,
  onPick,
  onActive,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null)

  // Keep the highlighted row in view as the arrow keys move it.
  useEffect(() => {
    const el = document.getElementById(slashOptionId(id, active))
    if (el && listRef.current?.contains(el)) {
      el.scrollIntoView?.({ block: 'nearest' })
    }
  }, [id, active])

  if (commands.length === 0) {
    return (
      <p className="border-b border-border px-3 py-2 text-[13px] text-fg-muted">
        No matching command
      </p>
    )
  }
  return (
    <div
      ref={listRef}
      id={id}
      role="listbox"
      aria-label="Commands"
      className="max-h-56 overflow-y-auto border-b border-border bg-surface-raised py-1"
    >
      {commands.map((c, i) => (
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
              /{c.name}
            </span>
            {c.description && (
              <span className="block truncate text-[12px] text-fg-muted">
                {c.description}
              </span>
            )}
          </span>
          {c.terminal && <Tag>opens in Terminal</Tag>}
          {c.kind === 'skill' && <Tag>skill</Tag>}
          <Tag>{SOURCE_LABEL[c.source]}</Tag>
        </div>
      ))}
    </div>
  )
}
