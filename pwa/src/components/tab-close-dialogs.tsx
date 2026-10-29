import { useT } from '../i18n/i18n-context'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { ConfirmDialog } from './ui/confirm-dialog'

// Asks before a tab with unsaved changes closes (Files, Changes); shown
// while rendered
export function DiscardTabDialog({
  name,
  onConfirm,
  onCancel,
}: {
  // The file's name
  name: string
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useT()
  return (
    <ConfirmDialog
      isOpen
      title={t('shell.discardTab.title')}
      confirmLabel={t('shell.discardTab.confirm')}
      destructive
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      {t('shell.discardTab.body', { name: visibleUnsafe(name) })}
    </ConfirmDialog>
  )
}

// Asks what becomes of the tabs with unsaved changes opened under a root the
// pane has left: closed (their changes dropped) or kept
export function RootCloseDialog({
  count,
  onResolve,
}: {
  // How many tabs wait for the answer; none: the box is closed
  count: number
  onResolve: (close: boolean) => void
}) {
  const { t } = useT()
  return (
    <ConfirmDialog
      isOpen={count > 0}
      title={t('shell.rootClose.title', { count })}
      // Not "Close": the sheet's own close button has that name
      confirmLabel={t('shell.rootClose.confirm')}
      cancelLabel={t('shell.rootClose.keep')}
      destructive
      onConfirm={() => onResolve(true)}
      onCancel={() => onResolve(false)}
    >
      {t('shell.rootClose.body')}
    </ConfirmDialog>
  )
}
