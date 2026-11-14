import { Download, ExternalLink } from 'lucide-react'
import { createContext, type ReactNode, useCallback, useState } from 'react'
import { agentImageUrl } from '../hooks/use-mux-api'
import { useT } from '../i18n/i18n-context'
import { FOCUS_RING } from './ui/button'
import { Sheet } from './ui/sheet'

// An image of the conversation (one pasted into the agent), shown again on a
// click on its chip. The server serves it by the signed reference the
// transcript gave the part; without a pane there is nothing to ask, and the
// chip stays plain text.
export const ChatImageContext = createContext<
  ((src: string) => void) | undefined
>(undefined)

const LINK = `inline-flex min-h-10 items-center gap-1.5 rounded-control px-3 text-sm text-accent hover:bg-surface-raised pointer-coarse:min-h-touch ${FOCUS_RING}`

export function ChatImageViewer({
  paneId,
  children,
}: {
  paneId: string
  children: ReactNode
}) {
  const { t } = useT()
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const open = useCallback((s: string) => {
    setFailed(false)
    setSrc(s)
  }, [])
  const url = src ? agentImageUrl(paneId, src) : ''
  return (
    <ChatImageContext.Provider value={paneId ? open : undefined}>
      {children}
      <Sheet
        isOpen={src !== null}
        onClose={() => setSrc(null)}
        title={t('chat.image.title')}
      >
        {url &&
          (failed ? (
            <p className="py-6 text-center text-fg-muted">
              {t('chat.image.failed')}
            </p>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <img
                src={url}
                alt={t('chat.image.title')}
                onError={() => setFailed(true)}
                className="max-h-[70vh] max-w-full rounded-control object-contain"
              />
              <div className="flex flex-wrap justify-center gap-1">
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={LINK}
                >
                  <ExternalLink size={15} aria-hidden="true" />
                  {t('chat.image.openTab')}
                </a>
                <a href={url} download className={LINK}>
                  <Download size={15} aria-hidden="true" />
                  {t('chat.image.download')}
                </a>
              </div>
            </div>
          ))}
      </Sheet>
    </ChatImageContext.Provider>
  )
}
