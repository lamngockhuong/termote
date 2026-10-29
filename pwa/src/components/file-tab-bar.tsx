import { FolderTree, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef } from 'react'
import { useWheelScrollX } from '../hooks/use-wheel-scroll-x'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import type { Translate } from '../i18n/translate'
import { FOCUS_RING } from './ui/button'

// A tab as the tab bar and the open-files sheet show it
export interface TabEntry {
  id: string
  // The file's name, and its whole path (the tooltip)
  name: string
  title: string
  // Shown under the name in the sheet: the file's directory
  detail?: string
  // Not pinned: the preview tab, replaced by the next file opened
  pinned: boolean
  // Has unsaved changes
  dirty: boolean
  // Its file was not found when last read (deleted or renamed elsewhere)
  missing?: boolean
}

// The tooltip of tab t: its path, and why it is struck through
export const tabTitle = (tab: TabEntry, t: Translate<MessageKey>) =>
  tab.missing ? t('files.tabs.missingTitle', { path: tab.title }) : tab.title

// What the tab bar (desktop) and the open-files sheet (mobile) both take
export interface TabListProps {
  tabs: TabEntry[]
  // null: the list (tree, changes) is shown
  activeId: string | null
  // The list's own entry, first: "Files", "Changes"
  homeLabel: string
  onActivate: (id: string | null) => void
  // Asks first when the tab has unsaved changes
  onClose: (id: string) => void
  onPin: (id: string) => void
  // The element showing the tab (desktop): each tab controls it, and its
  // id names it
  panelId?: string
}

// The id of tab id's element (null: the list's entry), under panelId
export const tabElementId = (panelId: string, id: string | null) =>
  `${panelId}-tab-${id ?? 'list'}`

const TAB = `flex h-8 shrink-0 items-center gap-1.5 px-2.5 text-[12px] ${FOCUS_RING} focus-visible:-outline-offset-2`

// The open files above the viewer (desktop): the list's entry first, then a
// tab per file. Arrow keys, Home and End move between tabs, Enter or Space
// shows one, Delete closes it; a middle click closes, a double click pins.
export function FileTabBar({
  tabs,
  activeId,
  homeLabel,
  onActivate,
  onClose,
  onPin,
  panelId,
}: TabListProps) {
  const tabIds = (id: string | null) =>
    panelId ? { id: tabElementId(panelId, id), 'aria-controls': panelId } : {}
  const { t } = useT()
  const items = useRef(new Map<string | null, HTMLElement>())
  const barRef = useRef<HTMLDivElement>(null)
  useWheelScrollX(barRef)
  const ids: (string | null)[] = [null, ...tabs.map((tab) => tab.id)]

  // The tab shown stays in view as the bar scrolls sideways
  useEffect(() => {
    items.current
      .get(activeId)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [activeId])

  const onKeyDown = (e: KeyboardEvent, id: string | null) => {
    const at = ids.indexOf(id)
    let next: string | null | undefined
    switch (e.key) {
      case 'ArrowRight':
        next = ids[(at + 1) % ids.length]
        break
      case 'ArrowLeft':
        next = ids[(at - 1 + ids.length) % ids.length]
        break
      case 'Home':
        next = ids[0]
        break
      case 'End':
        next = ids[ids.length - 1]
        break
      case 'Enter':
      case ' ':
        onActivate(id)
        break
      case 'Delete':
        if (id === null) return
        onClose(id)
        break
      default:
        return
    }
    e.preventDefault()
    if (next !== undefined) items.current.get(next)?.focus()
  }

  const ref = (id: string | null) => (el: HTMLElement | null) => {
    if (el) items.current.set(id, el)
    else items.current.delete(id)
  }
  // Keyboard focus stays on the tab shown (else the list's entry)
  const tabbable = ids.includes(activeId) ? activeId : null

  return (
    <div
      ref={barRef}
      role="tablist"
      aria-label={t('files.tabs.open')}
      className="flex shrink-0 overflow-x-auto scrollbar-hide border-b border-border bg-surface ui-terminal:bg-bg"
    >
      <button
        ref={ref(null)}
        type="button"
        role="tab"
        {...tabIds(null)}
        aria-selected={activeId === null}
        tabIndex={tabbable === null ? 0 : -1}
        onClick={() => onActivate(null)}
        onKeyDown={(e) => onKeyDown(e, null)}
        className={`${TAB} border-r border-border ${activeId === null ? 'bg-bg text-fg' : 'text-fg-muted hover:text-fg'}`}
      >
        <FolderTree size={14} aria-hidden="true" />
        {homeLabel}
      </button>
      {tabs.map((tab) => {
        const shown = tab.id === activeId
        return (
          <div
            key={tab.id}
            role="presentation"
            className={`group flex shrink-0 items-center border-r border-border ${shown ? 'bg-bg text-fg' : 'text-fg-muted hover:text-fg'}`}
          >
            <button
              ref={ref(tab.id)}
              type="button"
              role="tab"
              {...tabIds(tab.id)}
              aria-selected={shown}
              aria-keyshortcuts="Delete"
              tabIndex={tabbable === tab.id ? 0 : -1}
              title={tabTitle(tab, t)}
              onClick={() => onActivate(tab.id)}
              onDoubleClick={() => onPin(tab.id)}
              // No autoscroll: a middle click closes the tab
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault()
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return
                e.preventDefault()
                onClose(tab.id)
              }}
              onKeyDown={(e) => onKeyDown(e, tab.id)}
              className={`${TAB} max-w-48 pr-1`}
            >
              <span
                className={`truncate ${tab.pinned ? '' : 'italic'} ${tab.missing ? 'text-fg-subtle line-through' : ''}`}
              >
                {tab.name}
              </span>
              {!tab.pinned && (
                <span className="sr-only"> {t('files.tabs.preview')}</span>
              )}
              {tab.missing && (
                <span className="sr-only"> {t('files.tabs.notFound')}</span>
              )}
              {tab.dirty && (
                <>
                  <span
                    aria-hidden="true"
                    className="size-1.5 shrink-0 rounded-full bg-accent"
                  />
                  <span className="sr-only"> {t('files.tabs.unsaved')}</span>
                </>
              )}
            </button>
            <button
              type="button"
              // For the mouse: a tablist holds only tabs, and the tab's
              // Delete key closes it from the keyboard
              tabIndex={-1}
              aria-hidden="true"
              aria-label={t('files.tabs.closeName', { name: tab.name })}
              title={t('common.close')}
              onClick={() => onClose(tab.id)}
              className={`mr-1 flex size-5 shrink-0 items-center justify-center rounded-control hover:bg-surface ${FOCUS_RING} ${shown ? '' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'}`}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
