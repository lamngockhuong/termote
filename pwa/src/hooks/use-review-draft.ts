import { useSyncExternalStore } from 'react'
import {
  loadReview,
  onReviewChange,
  type ReviewComment,
} from '../utils/review-draft'

const NONE: ReviewComment[] = []

// paneId's review comments, oldest first; none without a pane
export function useReviewDraft(paneId?: string): ReviewComment[] {
  return useSyncExternalStore(onReviewChange, () =>
    paneId ? loadReview(paneId) : NONE,
  )
}
