import { FileType } from 'lucide-react'
import { useState } from 'react'
import type { FileEncoding } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { ENCODINGS, encodingLabel } from '../utils/file-encoding'
import { ConfirmDialog } from './ui/confirm-dialog'
import { Menu, MenuGroup, MenuItem, MenuItemRadio } from './ui/menu'

interface Props {
  // What the text shown was read as; absent for a file read as binary,
  // which the menu offers to open as text
  encoding?: FileEncoding
  bom?: boolean
  // The draft has changes: reading the file again would lose them
  dirty: boolean
  // Why the file cannot be edited in its encoding: it would not encode back
  // to the same bytes (lossy-encoding), or holds bytes not valid in it
  // (invalid-encoding), which saving as UTF-8 would lose too
  notEditable?: string
  onReopen: (encoding: FileEncoding) => void
  // Offered for a file not in UTF-8 without a BOM, asked about first
  onSaveAsUtf8?: () => void
}

// The encoding of a file in the Files header: its name opens a menu to read
// the file again as another one, or to save it as UTF-8. Never converts
// anything itself: the server decodes and encodes.
export function FileEncodingMenu({
  encoding,
  bom = false,
  dirty,
  notEditable,
  onReopen,
  onSaveAsUtf8,
}: Props) {
  const { t } = useT()
  const [confirming, setConfirming] = useState(false)
  const name = encoding ? encodingLabel(encoding, t, bom) : undefined
  return (
    <>
      <Menu
        label={
          name ? t('files.encoding.shown', { name }) : t('files.encoding.open')
        }
        trigger={name ?? t('files.encoding.openMenu')}
        textTrigger="block max-w-full truncate rounded-control text-[11px] text-fg-muted underline decoration-dotted underline-offset-2 hover:text-fg pointer-coarse:py-1"
        align="start"
      >
        <MenuGroup
          label={
            encoding ? t('files.encoding.reopen') : t('files.encoding.open')
          }
        >
          {ENCODINGS.map((enc) => (
            <MenuItemRadio
              key={enc}
              checked={enc === encoding}
              disabled={dirty}
              title={dirty ? t('files.encoding.dirty') : undefined}
              onSelect={() => onReopen(enc)}
            >
              {encodingLabel(enc, t)}
            </MenuItemRadio>
          ))}
        </MenuGroup>
        {notEditable === 'lossy-encoding' && (
          <MenuItem disabled>{t('files.encoding.lossy')}</MenuItem>
        )}
        {notEditable === 'invalid-encoding' && (
          <MenuItem disabled>{t('files.encoding.invalid')}</MenuItem>
        )}
        {onSaveAsUtf8 && (
          <MenuItem
            icon={<FileType size={15} />}
            onSelect={() => setConfirming(true)}
          >
            {t('files.encoding.saveUtf8')}
          </MenuItem>
        )}
      </Menu>
      <ConfirmDialog
        isOpen={confirming}
        title={t('files.encoding.askSaveUtf8')}
        confirmLabel={t('files.encoding.saveUtf8')}
        onConfirm={() => {
          setConfirming(false)
          onSaveAsUtf8!()
        }}
        onCancel={() => setConfirming(false)}
      >
        {t(
          bom
            ? 'files.encoding.saveUtf8BodyBom'
            : 'files.encoding.saveUtf8Body',
          { name: name ?? '' },
        )}
      </ConfirmDialog>
    </>
  )
}
