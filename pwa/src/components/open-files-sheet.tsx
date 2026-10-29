import { Files, FolderTree, Pin, X } from 'lucide-react'
import { useT } from '../i18n/i18n-context'
import { type TabListProps, tabTitle } from './file-tab-bar'
import { FOCUS_RING, IconButton } from './ui/button'
import { Sheet } from './ui/sheet'

const ROW = `flex min-h-11 min-w-0 flex-1 items-center gap-2 px-4 text-left text-sm ${FOCUS_RING} focus-visible:-outline-offset-2 pointer-coarse:min-h-touch`

// The open files on a phone, where the header has no room for a tab bar: a
// button counting them opens a sheet to show, pin or close one. The sheet
// belongs to the view, not to the header the button sits in, so it stays
// open while the file shown changes under it.
export function OpenFilesButton({
  count,
  onClick,
}: {
  count: number
  onClick: () => void
}) {
  const { t } = useT()
  return (
    <IconButton
      size="sm"
      onClick={onClick}
      aria-label={t('files.tabs.openCount', { count })}
      title={t('files.tabs.open')}
      className="relative"
    >
      <Files size={15} aria-hidden="true" />
      <span
        aria-hidden="true"
        className="absolute top-0.5 right-0.5 min-w-3.5 rounded-full bg-accent px-0.5 text-center text-[9px] leading-3.5 font-semibold text-bg"
      >
        {count}
      </span>
    </IconButton>
  )
}

export function OpenFilesSheet({
  tabs,
  activeId,
  homeLabel,
  onActivate,
  onClose,
  onPin,
  isOpen,
  onDismiss,
}: TabListProps & { isOpen: boolean; onDismiss: () => void }) {
  const { t } = useT()
  const show = (id: string | null) => {
    onActivate(id)
    onDismiss()
  }
  return (
    <Sheet isOpen={isOpen} onClose={onDismiss} title={t('files.tabs.open')}>
      <ul className="pb-2">
        <li className="flex border-b border-border">
          <button
            type="button"
            aria-current={activeId === null ? 'true' : undefined}
            onClick={() => show(null)}
            className={`${ROW} ${activeId === null ? 'text-accent' : 'text-fg'}`}
          >
            <FolderTree size={16} aria-hidden="true" className="shrink-0" />
            {homeLabel}
          </button>
        </li>
        {tabs.map((tab) => (
          <li key={tab.id} className="flex items-center pr-2">
            <button
              type="button"
              aria-current={tab.id === activeId ? 'true' : undefined}
              title={tabTitle(tab, t)}
              onClick={() => show(tab.id)}
              className={ROW}
            >
              <span className="flex min-w-0 flex-1 flex-col py-1.5">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className={`truncate ${tab.id === activeId ? 'font-medium text-accent' : tab.missing ? 'text-fg-subtle' : 'text-fg'} ${tab.pinned ? '' : 'italic'} ${tab.missing ? 'line-through' : ''}`}
                  >
                    {tab.name}
                  </span>
                  {tab.missing && (
                    <span className="sr-only"> {t('files.tabs.notFound')}</span>
                  )}
                  {tab.dirty && (
                    <>
                      <span
                        aria-hidden="true"
                        className="size-1.5 shrink-0 rounded-full bg-accent"
                      />
                      <span className="sr-only">
                        {' '}
                        {t('files.tabs.unsaved')}
                      </span>
                    </>
                  )}
                  {!tab.pinned && (
                    <span className="shrink-0 text-[11px] text-fg-subtle">
                      {t('files.tabs.previewBadge')}
                    </span>
                  )}
                </span>
                {tab.detail && (
                  <span className="truncate text-[12px] text-fg-subtle">
                    {tab.detail}
                  </span>
                )}
              </span>
            </button>
            {!tab.pinned && (
              <IconButton
                size="sm"
                onClick={() => onPin(tab.id)}
                aria-label={t('files.tabs.keepName', { name: tab.name })}
                title={t('files.tabs.keep')}
              >
                <Pin size={15} aria-hidden="true" />
              </IconButton>
            )}
            <IconButton
              size="sm"
              onClick={() => onClose(tab.id)}
              aria-label={t('files.tabs.closeName', { name: tab.name })}
              title={t('common.close')}
            >
              <X size={15} aria-hidden="true" />
            </IconButton>
          </li>
        ))}
      </ul>
    </Sheet>
  )
}
