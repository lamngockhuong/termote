import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { imageThumbnail } from '../utils/image-thumbnail'
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

// The images attached to the Chat view's next message. Each uploads as soon
// as it is added; the message carries the ids. A pane starts with none.
export function useChatAttachments(
  paneId: string,
  onError: (message: string) => void,
) {
  const [items, setItems] = useState<ChatAttachment[]>([])
  const count = useRef(0)
  const seq = useRef(0)
  count.current = items.length

  // biome-ignore lint/correctness/useExhaustiveDependencies: another pane starts without this one's images
  useEffect(() => setItems([]), [paneId])

  // A late answer for an image removed (or of another pane) changes nothing.
  const patch = useCallback(
    (key: number, p: Partial<ChatAttachment>) =>
      setItems((list) =>
        list.map((a) =>
          a.key === key ? ({ ...a, ...p } as ChatAttachment) : a,
        ),
      ),
    [],
  )

  const add = useCallback(
    async (file: File) => {
      if (count.current >= MAX_CHAT_IMAGES) {
        onError(`At most ${MAX_CHAT_IMAGES} images per message.`)
        return
      }
      count.current++
      const key = ++seq.current
      setItems((list) => [...list, { key, thumb: null, status: 'uploading' }])
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
    [onError, patch],
  )

  const remove = useCallback(
    (key: number) => setItems((list) => list.filter((a) => a.key !== key)),
    [],
  )
  const clear = useCallback(() => setItems([]), [])

  // The server no longer has these uploads (swept, or the host's cache
  // cleared): marked, so the user removes and attaches them again.
  const markGone = useCallback(
    (ids: string[]) =>
      setItems((list) =>
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
    [],
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
