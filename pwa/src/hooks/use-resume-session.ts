import { useCallback, useState } from 'react'
import type { NotifyOptions } from '../app-views'
import { useT } from '../i18n/i18n-context'
import { serverErrorText } from '../utils/server-error'
import {
  type HistorySession,
  RequestError,
  type ResumeWhere,
  resumeAgentSession,
} from './use-mux-api'

export interface ResumeOptions {
  notify: (message: string, options?: NotifyOptions) => void
  // The session runs where the result says
  onResumed: (
    result: { tabId: string; paneId: string },
    where: ResumeWhere,
  ) => void
  // The session turned out to run in a pane already (a list read before
  // it was opened elsewhere)
  onLive?: (id: string, live: { tabId: string; paneId: string }) => void
}

// Resuming a session of the history from a pane: one request at a time, the
// refusal told in a toast with the server's sentence for its code.
export function useResumeSession({ notify, onResumed, onLive }: ResumeOptions) {
  const { t } = useT()
  // The id of the session being resumed
  const [pending, setPending] = useState<string>()
  const resume = useCallback(
    async (
      paneId: string,
      s: HistorySession,
      where: ResumeWhere,
      fork = false,
    ) => {
      if (pending) return
      setPending(s.id)
      try {
        const result = await resumeAgentSession(paneId, {
          agent: s.agent,
          session: s.id,
          where,
          ...(fork && { fork }),
        })
        onResumed(result, where)
      } catch (err) {
        if (
          err instanceof RequestError &&
          err.code === 'session_live' &&
          err.tabId &&
          err.paneId
        ) {
          onLive?.(s.id, { tabId: err.tabId, paneId: err.paneId })
        }
        const message =
          err instanceof RequestError
            ? serverErrorText(err, t)
            : t(
                err instanceof DOMException && err.name === 'TimeoutError'
                  ? 'errors.timeout'
                  : 'errors.unknown',
              )
        notify(message, { variant: 'danger' })
      } finally {
        setPending(undefined)
      }
    },
    [pending, notify, onResumed, onLive, t],
  )
  return { pending, resume }
}
