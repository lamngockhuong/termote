import { useEffect, useState } from 'react'
import { imageErrorCode, useImageBlob } from '../hooks/use-image-blob'
import type { ChangeEntry } from '../hooks/use-mux-api'
import { ImagePreview } from './image-preview'
import { Banner } from './ui/banner'

// Which versions of an entry exist on one side, as server/files_raw.go
// (imageVersion) reads them: old.orig when the old version is the rename's
// source.
export function imageSides(
  entry: ChangeEntry,
  staged: boolean,
): { old: { orig: boolean } | null; new: boolean } {
  if (staged) {
    return {
      old:
        entry.staged === 'A'
          ? null
          : { orig: entry.staged === 'R' || entry.staged === 'C' },
      new: entry.staged !== 'D',
    }
  }
  if (entry.conflict) return { old: null, new: true }
  const u = entry.unstaged
  return {
    // Untracked and intent-to-add have no version in the index
    old: u === '?' || u === 'A' ? null : { orig: u === 'R' || u === 'C' },
    new: u !== 'D',
  }
}

interface Props {
  paneId: string
  entry: ChangeEntry
  staged: boolean
  root?: string
  reveal: boolean
  // What of the entry the images depend on; with reload, changing it reads
  // both again (a status poll with the same version does not)
  version: string
  reload: number
  oneColumn: boolean
  onRootChanged: (root: string) => void
  // The server asked to confirm a sensitive name first
  onSensitive: () => void
}

// A changed image, before and after, side by side (stacked on a phone).
// A side without a version shows why instead of reading anything.
export function ImageCompare({
  paneId,
  entry,
  staged,
  root,
  reveal,
  version,
  reload,
  oneColumn,
  onRootChanged,
  onSensitive,
}: Props) {
  const sides = imageSides(entry, staged)
  const orig = sides.old?.orig ? entry.orig : undefined
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {entry.conflict && (
        <Banner variant="warning">
          Unresolved conflict: the file as it is now
        </Banner>
      )}
      <div
        className={`grid gap-px bg-border ${oneColumn || entry.conflict ? 'grid-cols-1' : 'grid-cols-2'}`}
      >
        {!entry.conflict && (
          <Side
            paneId={paneId}
            on={sides.old !== null}
            query={{ path: entry.path, orig: entry.orig, side: 'old', staged }}
            root={root}
            reveal={reveal}
            reloadKey={`${version}:${reload}`}
            label={`Before · ${staged ? 'HEAD' : 'Index'}`}
            from={orig}
            missing="Added"
            onRootChanged={onRootChanged}
            onSensitive={onSensitive}
          />
        )}
        <Side
          paneId={paneId}
          on={sides.new}
          query={{ path: entry.path, orig: entry.orig, side: 'new', staged }}
          root={root}
          reveal={reveal}
          reloadKey={`${version}:${reload}`}
          label={`After · ${staged ? 'Index' : 'Working tree'}`}
          missing="Deleted"
          onRootChanged={onRootChanged}
          onSensitive={onSensitive}
        />
      </div>
    </div>
  )
}

function Side({
  paneId,
  on,
  query,
  root,
  reveal,
  reloadKey,
  label,
  from,
  missing,
  onRootChanged,
  onSensitive,
}: {
  paneId: string
  on: boolean
  query: { path: string; orig?: string; side: 'old' | 'new'; staged: boolean }
  root?: string
  reveal: boolean
  reloadKey: string
  label: string
  // The path the version was read from, when it is not the entry's
  from?: string
  missing: string
  onRootChanged: (root: string) => void
  onSensitive: () => void
}) {
  const [retry, setRetry] = useState(0)
  const image = useImageBlob(
    paneId,
    on ? { ...query, root, reveal } : null,
    `${reloadKey}:${retry}`,
    onRootChanged,
  )
  const sensitive = imageErrorCode(image) === 'sensitive'
  useEffect(() => {
    if (sensitive) onSensitive()
  }, [sensitive, onSensitive])
  return (
    <div className="flex min-w-0 flex-col bg-bg">
      <ImagePreview
        state={image}
        alt={`${query.path} (${label})`}
        label={from ? `${label} · ${from}` : label}
        missing={missing}
        onRetry={() => setRetry((n) => n + 1)}
      />
    </div>
  )
}
