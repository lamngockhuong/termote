import { FileType } from 'lucide-react'
import { useState } from 'react'
import type { FileEncoding } from '../hooks/use-mux-api'
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
  const [confirming, setConfirming] = useState(false)
  const name = encoding ? encodingLabel(encoding, bom) : undefined
  return (
    <>
      <Menu
        label={name ? `Encoding: ${name}` : 'Open with encoding'}
        trigger={name ?? 'Open with encoding…'}
        textTrigger="block max-w-full truncate rounded-control text-[11px] text-fg-muted underline decoration-dotted underline-offset-2 hover:text-fg pointer-coarse:py-1"
        align="start"
      >
        <MenuGroup
          label={encoding ? 'Reopen with encoding' : 'Open with encoding'}
        >
          {ENCODINGS.map((enc) => (
            <MenuItemRadio
              key={enc}
              checked={enc === encoding}
              disabled={dirty}
              title={dirty ? 'Save or discard your changes first' : undefined}
              onSelect={() => onReopen(enc)}
            >
              {encodingLabel(enc)}
            </MenuItemRadio>
          ))}
        </MenuGroup>
        {notEditable === 'lossy-encoding' && (
          <MenuItem disabled>
            Can't be edited in this encoding: saving would change bytes you did
            not edit. Save as UTF-8 to edit it.
          </MenuItem>
        )}
        {notEditable === 'invalid-encoding' && (
          <MenuItem disabled>
            Can't be edited: some bytes are not valid in this encoding, and
            saving would lose them. Try another encoding.
          </MenuItem>
        )}
        {onSaveAsUtf8 && (
          <MenuItem
            icon={<FileType size={15} />}
            onSelect={() => setConfirming(true)}
          >
            Save as UTF-8
          </MenuItem>
        )}
      </Menu>
      <ConfirmDialog
        isOpen={confirming}
        title="Save as UTF-8?"
        confirmLabel="Save as UTF-8"
        onConfirm={() => {
          setConfirming(false)
          onSaveAsUtf8!()
        }}
        onCancel={() => setConfirming(false)}
      >
        The file is written as UTF-8 instead of {name}
        {bom ? ', without its byte order mark' : ''}. Tools that read it as{' '}
        {name} will show its text wrongly.
      </ConfirmDialog>
    </>
  )
}
