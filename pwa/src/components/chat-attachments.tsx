import { ImageIcon, LoaderCircle, X } from 'lucide-react'
import type { ChatAttachment } from '../hooks/use-chat-attachments'
import { useT } from '../i18n/i18n-context'

interface ChatAttachmentsProps {
  items: ChatAttachment[]
  onRemove: (key: number) => void
  // While a message is being sent, nothing can be removed
  disabled?: boolean
}

// The images attached to the next message, above the composer's box.
export function ChatAttachments({
  items,
  onRemove,
  disabled,
}: ChatAttachmentsProps) {
  const { t } = useT()
  if (items.length === 0) return null
  return (
    <ul aria-label={t('chat.attach.list')} className="flex gap-2 px-2 pt-2">
      {items.map((a) => {
        // The number of its "[Image #n]" token in the text
        const n = a.n
        const state =
          a.status === 'failed'
            ? t(a.error)
            : t(
                a.status === 'uploading'
                  ? 'chat.attach.uploading'
                  : 'chat.attach.ready',
              )
        return (
          <li
            key={a.key}
            title={a.status === 'failed' ? t(a.error) : undefined}
            className={`relative size-12 shrink-0 overflow-hidden rounded-control border bg-bg ${
              a.status === 'failed' ? 'border-danger' : 'border-border'
            }`}
          >
            {a.thumb ? (
              <img
                src={a.thumb}
                alt={t('chat.attach.item', { n, state })}
                className="size-full object-cover"
              />
            ) : (
              <span
                role="img"
                aria-label={t('chat.attach.item', { n, state })}
                className="flex size-full items-center justify-center text-fg-muted"
              >
                <ImageIcon size={18} aria-hidden="true" />
              </span>
            )}
            {a.status === 'uploading' && (
              <span className="absolute inset-0 flex items-center justify-center bg-bg/60">
                <LoaderCircle
                  size={18}
                  aria-hidden="true"
                  className="text-fg motion-safe:animate-spin"
                />
              </span>
            )}
            <button
              type="button"
              aria-label={t('chat.attach.remove', { n })}
              disabled={disabled}
              onClick={() => onRemove(a.key)}
              className="absolute top-0 right-0 flex size-6 items-center justify-center rounded-bl-control bg-surface/90 text-fg disabled:opacity-50"
            >
              <X size={12} aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
