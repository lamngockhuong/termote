import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { imageThumbnail } from '../utils/image-thumbnail'
import { onPaneRemap, remapEntries } from '../utils/pane-remap'
import { uploadErrorMessage, uploadImage } from '../utils/upload-image'

// The server's limit on the images of one message.
export const MAX_CHAT_IMAGES = 5

export type ChatAttachment = {
  key: number
  // A small data: URL preview; null until drawn, or when it cannot be
  thumb: string | null
  // The upload id, once the host has the file
  id?: string
} & (
  | { status: 'uploading' | 'ready' }
  // error: why the upload failed, or why the server refused the image
  | { status: 'failed'; error: string }
)

// Each pane's attached images, out of the composer so they survive its
// remount and follow their pane when its id shifts (a tmux window move).
const lists = new Map<string, ChatAttachment[]>()
const listeners = new Set<() => void>()
const NONE: ChatAttachment[] = []
// Keys are unique across panes, so a late answer finds its image wherever
// it is now.
let seq = 0

function notify() {
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function setList(
  paneId: string,
  update: (list: ChatAttachment[]) => ChatAttachment[],
) {
  const next = update(lists.get(paneId) ?? NONE)
  if (next.length) lists.set(paneId, next)
  else lists.delete(paneId)
  notify()
}

// A late answer for an image removed changes nothing.
function patch(key: number, p: Partial<ChatAttachment>) {
  for (const [paneId, list] of lists) {
    if (!list.some((a) => a.key === key)) continue
    setList(paneId, (l) =>
      l.map((a) => (a.key === key ? ({ ...a, ...p } as ChatAttachment) : a)),
    )
  }
}

onPaneRemap((shift) => {
  remapEntries(lists, shift)
  notify()
})

// For tests: forget every pane's images.
export function resetChatAttachments() {
  lists.clear()
  seq = 0
}

// The images attached to the Chat view's next message. Each uploads as soon
// as it is added; the message carries the ids. Each pane has its own.
export function useChatAttachments(
  paneId: string,
  onError: (message: string) => void,
) {
  const items = useSyncExternalStore(subscribe, () => lists.get(paneId) ?? NONE)

  const add = useCallback(
    async (file: File) => {
      if ((lists.get(paneId)?.length ?? 0) >= MAX_CHAT_IMAGES) {
        onError(`At most ${MAX_CHAT_IMAGES} images per message.`)
        return
      }
      const key = ++seq
      setList(paneId, (list) => [
        ...list,
        { key, thumb: null, status: 'uploading' },
      ])
      imageThumbnail(file).then((thumb) => thumb && patch(key, { thumb }))
      const result = await uploadImage(file)
      if (result.ok) {
        patch(key, { status: 'ready', id: result.upload.id })
        return
      }
      const error = uploadErrorMessage(result.reason)
      patch(key, { status: 'failed', error })
      onError(`${error}.`)
    },
    [paneId, onError],
  )

  const remove = useCallback(
    (key: number) =>
      setList(paneId, (list) => list.filter((a) => a.key !== key)),
    [paneId],
  )
  const clear = useCallback(() => setList(paneId, () => []), [paneId])

  // The server no longer has these uploads (swept, or the host's cache
  // cleared): marked, so the user removes and attaches them again.
  const markGone = useCallback(
    (ids: string[]) =>
      setList(paneId, (list) =>
        list.map((a) =>
          a.id && ids.includes(a.id)
            ? {
                ...a,
                status: 'failed' as const,
                error: 'No longer on the host',
              }
            : a,
        ),
      ),
    [paneId],
  )

  return useMemo(
    () => ({
      items,
      ids: items.flatMap((a) => (a.status === 'ready' && a.id ? [a.id] : [])),
      uploading: items.some((a) => a.status === 'uploading'),
      failed: items.some((a) => a.status === 'failed'),
      full: items.length >= MAX_CHAT_IMAGES,
      add,
      remove,
      clear,
      markGone,
    }),
    [items, add, remove, clear, markGone],
  )
}
