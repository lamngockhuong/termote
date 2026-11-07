import {
  AtSign,
  Copy,
  Download,
  FilePlus,
  FolderPlus,
  TextCursorInput,
  Trash2,
  Upload,
} from 'lucide-react'
import type { ReactElement } from 'react'
import type { ViewProps } from '../app-views'
import { useT } from '../i18n/i18n-context'
import type { MessageKey } from '../i18n/messages/en'
import { copyText } from '../utils/copy-text'
import { absolutePath, fileName, mentionPath } from '../utils/file-paths'
import { visibleUnsafe } from '../utils/unsafe-chars'
import { MenuItem, MenuSeparator } from './ui/menu'

export interface FileActionsProps {
  // The entry's path in the tree ("/"-separated, under root)
  path: string
  // The root the tree route returned, the pane's directory under it and the
  // Place shown: what the copied and typed paths are made from
  root: string
  // null: not known (the @path is absolute then)
  dir?: string | null
  place?: string
  notify: ViewProps['notify']
  // Each action is offered only when given: the caller decides by role
  insertText?: ViewProps['insertText']
  onNewFile?: () => void
  onNewFolder?: () => void
  onUpload?: () => void
  onDownload?: () => void
  onRename?: () => void
  onDelete?: () => void
  // A folder that holds something: Delete stays, off, and says why
  deleteBlocked?: boolean
}

// The items of a file's or folder's menu, for a Menu the caller owns (a tree
// row's, a file tab's, a Changes row's): copy its path or name, type its
// @path at the agent, make a file or folder in it or upload into it, then
// Download, Rename and Delete. Groups with nothing in them are left out with
// their separator.
export function FileActionItems({
  path,
  root,
  dir,
  place,
  notify,
  insertText,
  onNewFile,
  onNewFolder,
  onUpload,
  onDownload,
  onRename,
  onDelete,
  deleteBlocked = false,
}: FileActionsProps) {
  const { t } = useT()
  // Called from the item's click: the clipboard takes it only in a gesture
  const copy = (text: string, done: MessageKey, failed: MessageKey) => {
    void copyText(text).then((r) =>
      r === 'ok' ? notify(t(done)) : notify(t(failed), { variant: 'danger' }),
    )
  }
  const copyPath = (text: string) =>
    copy(text, 'files.viewer.pathCopied', 'files.viewer.pathCopyFailed')
  const insert =
    insertText &&
    (() => {
      const at = mentionPath({ root, dir, place, path })
      if (insertText(at)) return
      notify(t('files.actions.notInserted', { path: visibleUnsafe(at) }), {
        variant: 'warning',
        action: {
          label: t('shell.selectText.copy'),
          onClick: () => copyPath(at),
        },
      })
    })
  const groups: (ReactElement | undefined)[][] = [
    [
      <MenuItem
        key="rel"
        icon={<Copy size={16} />}
        onSelect={() => copyPath(path)}
      >
        {t('files.actions.copyRelative')}
      </MenuItem>,
      <MenuItem
        key="abs"
        icon={<Copy size={16} />}
        onSelect={() => copyPath(absolutePath(root, path))}
      >
        {t('files.actions.copyAbsolute')}
      </MenuItem>,
      <MenuItem
        key="name"
        icon={<Copy size={16} />}
        onSelect={() =>
          copy(
            fileName(path),
            'files.actions.nameCopied',
            'files.actions.nameCopyFailed',
          )
        }
      >
        {t('files.actions.copyName')}
      </MenuItem>,
    ],
    insert
      ? [
          <MenuItem key="insert" icon={<AtSign size={16} />} onSelect={insert}>
            {t('files.actions.insert')}
          </MenuItem>,
        ]
      : [],
    [
      onNewFile && (
        <MenuItem key="file" icon={<FilePlus size={16} />} onSelect={onNewFile}>
          {t('files.new.title')}
        </MenuItem>
      ),
      onNewFolder && (
        <MenuItem
          key="folder"
          icon={<FolderPlus size={16} />}
          onSelect={onNewFolder}
        >
          {t('files.actions.newFolder')}
        </MenuItem>
      ),
      onUpload && (
        <MenuItem key="upload" icon={<Upload size={16} />} onSelect={onUpload}>
          {t('files.actions.uploadHere')}
        </MenuItem>
      ),
    ],
    [
      onDownload && (
        <MenuItem
          key="download"
          icon={<Download size={16} />}
          onSelect={onDownload}
        >
          {t('files.download')}
        </MenuItem>
      ),
      onRename && (
        <MenuItem
          key="rename"
          icon={<TextCursorInput size={16} />}
          onSelect={onRename}
        >
          {t('files.rename.title')}
        </MenuItem>
      ),
    ],
    [
      onDelete && (
        <MenuItem
          key="delete"
          icon={<Trash2 size={16} />}
          danger
          disabled={deleteBlocked}
          onSelect={onDelete}
        >
          {deleteBlocked ? t('files.tree.deleteNotEmpty') : t('files.delete')}
        </MenuItem>
      ),
    ],
  ]
  return groups
    .map((g) => g.filter((item) => item !== undefined))
    .filter((g) => g.length > 0)
    .flatMap((g, i) =>
      i ? [<MenuSeparator key={`before-${g[0].key}`} />, ...g] : g,
    )
}
