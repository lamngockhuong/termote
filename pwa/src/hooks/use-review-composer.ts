import { useState } from 'react'
import type { NotifyOptions } from '../app-views'
import type { LineRange } from '../utils/line-range'
import {
  addReviewComment,
  MAX_REVIEW_COMMENTS,
  type ReviewSource,
  type ReviewTarget,
} from '../utils/review-draft'
import { useReviewDraft } from './use-review-draft'

const FULL = `Review is full (${MAX_REVIEW_COMMENTS} comments)`

// A comment being written on lines of paneId's files (under root, its
// folder now), added to the pane's review once saved
export function useReviewComposer(
  paneId: string,
  root: string | undefined,
  notify: (message: string, opts?: NotifyOptions) => void,
) {
  const comments = useReviewDraft(paneId)
  const [target, setTarget] = useState<ReviewTarget | null>(null)

  const open = (
    path: string,
    source: ReviewSource,
    range: LineRange,
    orig?: string,
  ) => {
    if (root === undefined) return
    if (comments.length >= MAX_REVIEW_COMMENTS) {
      notify(FULL, { variant: 'warning' })
      return
    }
    setTarget({ root, path, ...(orig && { orig }), source, ...range })
  }

  const save = (text: string) => {
    const t = target as ReviewTarget
    setTarget(null)
    const added = addReviewComment(paneId, {
      ...t,
      // Not crypto.randomUUID: over plain HTTP (a LAN address) it is missing
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      text,
      at: Date.now(),
    })
    if (added === 'too_many') notify(FULL, { variant: 'warning' })
    else if (added === 'memory')
      notify('The browser cannot store the review: it is lost on reload', {
        variant: 'warning',
      })
  }

  return { comments, target, open, save, close: () => setTarget(null) }
}
