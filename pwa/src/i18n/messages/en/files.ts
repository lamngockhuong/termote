// Files (components/files-view.tsx and the sheets it opens)
export default {
  // The Trash sheet (components/trash-sheet.tsx)
  'files.trash': 'Trash',
  'files.trash.scope':
    "Only what was deleted while this folder was the root shows here. Something deleted from another folder (before a cd, or from a place or repository holding this one) is in that folder's trash.",
  'files.trash.loading': 'Loading…',
  'files.trash.unreadable': "The trash can't be read",
  'files.trash.retry': 'Try again',
  'files.trash.empty':
    'The trash is empty. A file on another file system than the trash is deleted for good, so it is never here.',
  'files.trash.truncated': 'Showing the 500 newest',
  'files.trash.list': 'Deleted items',
  'files.trash.sensitive': 'Sensitive',
  'files.trash.kind.file': 'File',
  'files.trash.kind.dir': 'Folder',
  'files.trash.kind.discard': 'Discarded change',
  'files.trash.removedBy': 'Removed by {date} at the latest',
  'files.trash.discardNote':
    "Restoring replaces the file's current content; only while the file is unchanged since the discard",
  'files.trash.restore': 'Restore',
  'files.trash.restoreName': 'Restore {name}',
  'files.trash.restoreDiscard': 'Restore the discarded text',
  'files.trash.restoreDiscardName': 'Restore the discarded text of {name}',
  'files.trash.deleteForGood': 'Delete permanently',
  'files.trash.deleteForGoodName': 'Delete {name} permanently',
  'files.trash.emptyTrash': 'Empty trash',
  'files.trash.askSensitive': 'This is a sensitive file',
  'files.trash.askSensitiveBody': '{name} may contain secrets. Restore it?',
  'files.trash.askDelete': 'Delete permanently?',
  'files.trash.askDeleteBody': '{name} will be deleted. This cannot be undone.',
  'files.trash.askEmpty': 'Empty the trash?',
  'files.trash.askEmptyBody_one':
    'The {count} item shown will be deleted. This cannot be undone.',
  'files.trash.askEmptyBody_other':
    'All {count} items shown will be deleted. This cannot be undone.',
  'files.trash.askEmptyNewest':
    'Only the {count} newest items, the ones shown, will be deleted; older ones stay. This cannot be undone.',
  'files.trash.gone': 'Already restored or removed',
  'files.trash.restored': 'Restored {name}',
  'files.trash.deleted': 'Deleted {name} permanently',
  'files.trash.deleteFailed': 'Could not delete {name}',
  'files.trash.emptied': 'Deleted {count} permanently',
  'files.trash.emptyFailed': '{count} of them could not be deleted; try again',
  'files.trash.emptyError': 'Could not empty the trash',
} as const
