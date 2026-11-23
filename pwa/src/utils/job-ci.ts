import type { JobCIError, JobCISummary, JobPR } from '../hooks/use-mux-api'
import type { MessageKey } from '../i18n/messages/en'

// A job's pull requests as the PWA shows them. The server works out which
// one is worst (server/job_pr.go's ciSummary), so a full and a view-only
// device colour a job alike; this file only names and colours it.

export type CIWorst = NonNullable<JobCISummary['worst']>

export const CI_WORST_WORDS: Record<CIWorst, MessageKey> = {
  fail: 'jobs.ci.worst.fail',
  pending: 'jobs.ci.worst.pending',
  open: 'jobs.ci.worst.open',
  draft: 'jobs.ci.worst.draft',
  merged: 'jobs.ci.worst.merged',
}

// The chip's colours, by the worst pull request
export const CI_WORST_TONE: Record<CIWorst, string> = {
  fail: 'border-danger/40 text-danger',
  pending: 'border-warning/40 text-warning',
  open: 'border-success/40 text-success',
  draft: 'border-border text-fg-muted',
  merged: 'border-info/40 text-info',
}

// A failed read's words, by its ci_* code; one this version does not know
// reads as a failed read
const CI_ERROR_WORDS: Record<JobCIError, MessageKey> = {
  ci_gh_missing: 'errors.ci_gh_missing',
  ci_gh_auth: 'errors.ci_gh_auth',
  ci_no_repo: 'errors.ci_no_repo',
  ci_failed: 'errors.ci_failed',
}

export function ciErrorWords(code: string): MessageKey {
  return Object.hasOwn(CI_ERROR_WORDS, code)
    ? CI_ERROR_WORDS[code as JobCIError]
    : 'errors.ci_failed'
}

// What one pull request is: its state, or its checks while it is open
export function prStateWords(pr: JobPR): MessageKey {
  if (pr.state === 'merged') return 'jobs.ci.state.merged'
  if (pr.state === 'closed') return 'jobs.ci.state.closed'
  if (pr.draft) return 'jobs.ci.state.draft'
  return 'jobs.ci.state.open'
}

export function prChecksWords(pr: JobPR): MessageKey | undefined {
  if (pr.state !== 'open' || !pr.checks) return undefined
  return `jobs.ci.checks.${pr.checks}` as MessageKey
}

export function prChecksTone(pr: JobPR): string {
  if (pr.state !== 'open') return 'text-fg-muted'
  switch (pr.checks) {
    case 'fail':
      return 'text-danger'
    case 'pending':
      return 'text-warning'
    case 'pass':
      return 'text-success'
  }
  return 'text-fg-muted'
}

// The set of failures a job's agent is sent, as server/job_pr.go's
// ciFailKey names it: "fail:12@abc,15@def". A send the user makes takes the
// foreign pull requests too (foreign), one under a grant never does.
export function ciFailKey(prs: JobPR[], foreign = true): string {
  const parts = prs
    .filter(
      (p) =>
        p.state === 'open' && p.checks === 'fail' && (foreign || !p.foreign),
    )
    .map((p) => `${p.number}@${p.head ?? ''}`)
    .sort()
  return parts.length ? `fail:${parts.join(',')}` : ''
}

// "#12, #15" from a failing set ("12@abc,15@def", a ci grant's use)
export function ciSetNumbers(set: string): string {
  return set
    .replace(/^fail:/, '')
    .split(',')
    .filter(Boolean)
    .map((p) => `#${p.split('@')[0]}`)
    .join(', ')
}

// A pull request number typed by the user, or null
export function parsePRNumber(s: string): number | null {
  const v = s.trim().replace(/^#/, '')
  if (!/^\d{1,10}$/.test(v)) return null
  const n = Number(v)
  return n >= 1 && n <= 1_000_000_000 ? n : null
}
